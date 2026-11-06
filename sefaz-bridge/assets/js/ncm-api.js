// ════════════════════════════════════════════════════════════════════
// Consulta da tabela NCM oficial (Siscomex) empacotada em ncm-data.js.
// Tudo local: nenhuma chamada de rede.
// ════════════════════════════════════════════════════════════════════
const NcmAPI = (() => {
  const digits = s => String(s == null ? '' : s).replace(/\D/g, '');
  const clean  = s => String(s || '').replace(/<[^>]*>/g, '').replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&').replace(/^[\s\-–—]+/, '').replace(/\s+/g, ' ').replace(/[:;.\s]+$/, '').trim();
  const today  = () => new Date().toISOString().slice(0, 10);
  const toISO  = s => { const m = String(s || '').match(/^(\d{2})\/(\d{2})\/(\d{4})/); return m ? `${m[3]}-${m[2]}-${m[1]}` : String(s || '').slice(0, 10); };
  const toBR   = iso => /^\d{4}-\d{2}-\d{2}$/.test(iso || '') ? iso.split('-').reverse().join('/') : iso;
  try { localStorage.removeItem('ncm_api_cache_v1'); } catch (e) {}   // cache da antiga consulta online

  let table = null;            // Map código(dígitos) -> {d, fim}
  let lastMode = 'idle';

  function loadTable() {
    if (table) return true;
    const arr = typeof window !== 'undefined' ? window.NCM_OFFICIAL_TABLE : null;
    if (!Array.isArray(arr) || arr.length < 1000) return false;
    table = new Map();
    for (const it of arr) {
      const c = digits(it.codigo);
      if (c) table.set(c, { d: clean(it.descricao), fim: toISO(it.data_fim) });
    }
    return true;
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
    return { found: true, desc: parts.join(' › '), leaf: leaf.d, fim: toBR(leaf.fim), expired: !!leaf.fim && leaf.fim < today() };
  }

  const lookupOne = raw => { const c = digits(raw).padStart(8, '0'); return [c, table ? fromTable(c) : { error: true }]; };

  // Consulta vários NCMs. Retorna Map código(8 dígitos) -> info ({found, desc, leaf, fim, expired} | {error})
  async function lookupMany(codes, onProgress) {
    lastMode = loadTable() ? 'local' : 'offline';
    const out = new Map(codes.map(lookupOne));
    onProgress && onProgress(codes.length, codes.length, 'Consulta concluída na tabela NCM local.');
    return out;
  }

  async function lookup(code) { loadTable(); return lookupOne(code)[1]; }

  return { lookupMany, lookup, mode: () => lastMode };
})();
