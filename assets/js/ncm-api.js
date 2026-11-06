// ════════════════════════════════════════════════════════════════════
// Consulta local da tabela NCM oficial baixada do Siscomex.
// ════════════════════════════════════════════════════════════════════
const NcmAPI = (() => {
  const BASE_URL  = 'https://brasilapi.com.br/api/ncm/v1';
  const CACHE_KEY = 'ncm_api_cache_v1';
  const TTL_MS    = 30 * 24 * 3600 * 1000;
  const digits = s => String(s == null ? '' : s).replace(/\D/g, '');
  const clean  = s => String(s || '').replace(/<[^>]*>/g, '').replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&').replace(/^[\s\-–—]+/, '').replace(/\s+/g, ' ').replace(/[:;.\s]+$/, '').trim();
  const today  = () => new Date().toISOString().slice(0, 10);
  const toISO  = s => {
    if (!s) return '';
    const m = String(s).match(/^(\d{2})\/(\d{2})\/(\d{4})/);
    return m ? `${m[3]}-${m[2]}-${m[1]}` : String(s).slice(0, 10);
  };
  const toBR = iso => iso && /^\d{4}-\d{2}-\d{2}$/.test(iso) ? iso.split('-').reverse().join('/') : iso;

  let table = null;            // Map código(dígitos) -> {d, fim}
  let lastMode = 'idle';
  let cache = { ts: 0, items: {} };
  try { const c = JSON.parse(localStorage.getItem(CACHE_KEY) || 'null'); if (c && c.items) cache = c; } catch (e) {}
  const saveCache = () => { try { cache.ts = Date.now(); localStorage.setItem(CACHE_KEY, JSON.stringify(cache)); } catch (e) {} };
  const cacheFresh = () => Date.now() - (cache.ts || 0) < TTL_MS;

  async function fetchJSON(url, ms) {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), ms);
    try {
      const res = await fetch(url, { signal: ctl.signal, headers: { Accept: 'application/json' } });
      if (res.status === 404) { const e = new Error('404'); e.notFound = true; throw e; }
      if (!res.ok) throw new Error('HTTP ' + res.status);
      return await res.json();
    } finally { clearTimeout(t); }
  }

  async function loadTable() {
    if (table) return true;
    try {
      const arr = typeof window !== 'undefined' ? window.NCM_OFFICIAL_TABLE : null;
      if (!Array.isArray(arr) || arr.length < 1000) return false;
      table = new Map();
      for (const it of arr) {
        const c = digits(it.codigo);
        if (c) table.set(c, { d: clean(it.descricao), fim: toISO(it.data_fim) });
      }
      return true;
    } catch (e) { return false; }
  }

  // Descrição hierárquica: Posição › Subposição › Item › Subitem
  function fromTable(code) {
    const leaf = table.get(code);
    if (!leaf) return { found: false };
    const parts = [];
    for (const len of [4, 5, 6, 7]) {
      const p = table.get(code.slice(0, len));
      if (p && p.d && !parts.includes(p.d)) parts.push(p.d);
    }
    if (!parts.includes(leaf.d)) parts.push(leaf.d);
    const fim = leaf.fim;
    return { found: true, desc: parts.join(' › '), leaf: leaf.d, fim: toBR(fim), expired: !!fim && fim < today() };
  }

  async function fetchOne(code) {
    try {
      const it = await fetchJSON(`${BASE_URL}/${code}`, 15000);
      const fim = toISO(it.data_fim);
      return { found: true, desc: clean(it.descricao), leaf: clean(it.descricao), fim: toBR(fim), expired: !!fim && fim < today() };
    } catch (e) {
      if (e.notFound) return { found: false };
      return { error: true };
    }
  }

  // Consulta vários NCMs (8 dígitos). Retorna Map código -> info.
  async function lookupMany(codes, onProgress) {
    const out = new Map();
    // A base local vigente sempre prevalece sobre caches antigos ou APIs externas.
    if (await loadTable()) {
      for (const raw of codes) {
        const code = digits(raw).padStart(8, '0');
        out.set(code, fromTable(code));
      }
      lastMode = 'local';
      onProgress && onProgress(codes.length, codes.length, 'Consulta concluída na tabela NCM local.');
      return out;
    }
    const pending = [];
    for (const c of codes) {
      const hit = cacheFresh() && cache.items[c];
      if (hit) out.set(c, hit); else pending.push(c);
    }
    if (!pending.length) { lastMode = 'cache'; return out; }

    onProgress && onProgress(0, pending.length, 'Baixando tabela NCM oficial…');
    // Tabela completa indisponível: consulta individual (6 em paralelo)
    let done = 0, errors = 0, idx = 0;
    const worker = async () => {
      while (idx < pending.length) {
        const c = pending[idx++];
        const i = await fetchOne(c);
        if (i.error) errors++; else cache.items[c] = i;
        out.set(c, i);
        done++;
        onProgress && onProgress(done, pending.length, `Consultando NCMs… ${done}/${pending.length}`);
        if (errors >= 8 && errors === done) { idx = pending.length; } // API fora do ar: desiste cedo
      }
    };
    await Promise.all(Array.from({ length: 6 }, worker));
    for (const c of pending) if (!out.has(c)) out.set(c, { error: true });
    saveCache();
    const nErr = pending.filter(c => out.get(c).error).length;
    lastMode = nErr === pending.length ? 'offline' : nErr ? 'parcial' : 'individual';
    return out;
  }

  async function lookup(code) {
    const c = digits(code).padStart(8, '0');
    await loadTable();
    if (table) return fromTable(c);
    if (cacheFresh() && cache.items[c]) return cache.items[c];
    const i = await fetchOne(c);   // consulta rápida de um único código
    if (!i.error) { cache.items[c] = i; saveCache(); }
    return i;
  }

  return { lookupMany, lookup, mode: () => lastMode, clearCache: () => { cache = { ts: 0, items: {} }; table = null; try { localStorage.removeItem(CACHE_KEY); } catch (e) {} } };
})();
