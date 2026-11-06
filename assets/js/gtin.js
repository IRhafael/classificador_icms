// ════════════════════════════════════════════════════════════════════
// BASE GTIN → NCM (consulta prioritária)
// Ordem de consulta de cada GTIN:
//   1. Base própria (neste navegador): importada de XML de NF-e de entrada
//      ou de planilha GTIN × NCM (cadastro do ERP, relatório do CCG etc.)
//   2. Tabela fixa assets/js/gtin-data.js (window.GTIN_TABLE), se existir
//   3. PreçoMelhor (consulta gratuita sem chave; cache local por até 30 dias)
//   4. SEFAZ CCG oficial (opcional, via conector local com certificado A1)
// Se o GTIN não estiver em nenhuma delas, a linha segue com o NCM informado.
// ════════════════════════════════════════════════════════════════════
const GtinBase = (() => {
  const BASE_KEY   = 'gtin_ncm_base_v1';
  const FREE_KEY   = 'gtin_precomelhor_cache_v1';
  const TTL_MS     = 30 * 24 * 3600 * 1000;
  const FREE_MAX   = 60;           // PreçoMelhor publica uso justo de ~60 consultas/minuto
  const FREE_GAP   = 1100;         // espaçamento para respeitar o limite por IP
  const dig = s => String(s == null ? '' : s).replace(/\D/g, '');

  const load = (k, def) => { try { return JSON.parse(localStorage.getItem(k) || 'null') || def; } catch (e) { return def; } };
  const store = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); return true; } catch (e) { return false; } };
  try { localStorage.removeItem('gtin_cosmos_cache_v1'); localStorage.removeItem('gtin_cosmos_token'); } catch (e) {}

  // base: gtin14 → { ncm, desc, cest, fonte, cont: {ncm: ocorrências} }
  let base = load(BASE_KEY, {});
  let freeCache = load(FREE_KEY, {});
  let lastMode = { free: 'off', sefaz: 'off', msg: '' };
  let freeNextAt = 0;
  let freeQueue = Promise.resolve();
  const inputLengths = new Map();

  // Tabela fixa opcional (gerada fora do navegador)
  let fileTable = null;
  function getFileTable() {
    if (fileTable) return fileTable;
    fileTable = new Map();
    const t = typeof window !== 'undefined' ? window.GTIN_TABLE : null;
    const add = (g, it) => { const p = gtinParse(g); if (p && p.ok && it && dig(it.ncm)) fileTable.set(p.gtin, it); };
    if (Array.isArray(t)) for (const it of t) add(it.gtin, it);
    else if (t && typeof t === 'object') for (const [g, it] of Object.entries(t)) add(g, typeof it === 'string' ? { ncm: it } : it);
    return fileTable;
  }

  let bridgeToken = '';
  function setBridgeToken(v) { bridgeToken = String(v || '').trim(); }

  // ── Alimentação da base ─────────────────────────────────────────────
  function addEntry(gtinRaw, ncmRaw, desc, cest, fonte) {
    const p = gtinParse(gtinRaw);
    const nd = dig(ncmRaw);
    if (!p || !p.ok || nd.length < 7 || nd.length > 8) return false;
    const ncm = pad8(nd);
    const e = base[p.gtin] || (base[p.gtin] = { ncm, desc: '', cest: '', fonte: '', cont: {} });
    e.cont[ncm] = (e.cont[ncm] || 0) + 1;
    e.ncm = Object.entries(e.cont).sort((a, b) => b[1] - a[1])[0][0];   // NCM mais frequente
    if (desc && (!e.desc || e.ncm === ncm)) e.desc = String(desc).trim().slice(0, 120);
    if (cest) e.cest = dig(cest);
    if (fonte && e.ncm === ncm) e.fonte = fonte;
    return true;
  }

  // XML de NF-e/NFC-e (nfeProc ou NFe). Use preferencialmente XML de ENTRADA (fornecedor).
  function importXml(text) {
    const doc = new DOMParser().parseFromString(text, 'application/xml');
    if (doc.getElementsByTagName('parsererror').length) return { itens: 0, erro: 'XML inválido' };
    const tag = (el, n) => { const x = el.getElementsByTagNameNS('*', n)[0] || el.getElementsByTagName(n)[0]; return x ? x.textContent.trim() : ''; };
    const emit = doc.getElementsByTagNameNS('*', 'emit')[0];
    const emitNome = emit ? (tag(emit, 'xFant') || tag(emit, 'xNome')) : '';
    const nNF = tag(doc, 'nNF');
    const fonte = `XML NF-e ${nNF ? 'nº ' + nNF + ' ' : ''}${emitNome ? '— ' + emitNome.slice(0, 30) : ''}`.trim();
    let itens = 0;
    for (const prod of doc.getElementsByTagNameNS('*', 'prod')) {
      const ncm = tag(prod, 'NCM'), desc = tag(prod, 'xProd'), cest = tag(prod, 'CEST');
      const g1 = tag(prod, 'cEAN'), g2 = tag(prod, 'cEANTrib');
      if (addEntry(g1, ncm, desc, cest, fonte)) itens++;
      if (dig(g2) && dig(g2) !== dig(g1) && addEntry(g2, ncm, desc, cest, fonte)) itens++;
    }
    return { itens };
  }

  // Planilha com colunas GTIN/EAN/código de barras e NCM (descrição opcional)
  function importRows(rows, fileName) {
    const hIdx = findHeader(rows);
    if (hIdx < 0) return { itens: 0, erro: 'coluna NCM não encontrada' };
    const C = mapColumns(rows[hIdx]);
    if (C.GTIN == null) return { itens: 0, erro: 'coluna GTIN/EAN/código de barras não encontrada' };
    const colNcm = C.NCM_GTIN != null ? C.NCM_GTIN : C.NCM;
    let itens = 0;
    for (let i = hIdx + 1; i < rows.length; i++) {
      const r = rows[i] || [];
      if (addEntry(r[C.GTIN], r[colNcm], C.DESC != null ? r[C.DESC] : '', '', 'Planilha ' + String(fileName || '').slice(0, 40))) itens++;
    }
    return { itens };
  }

  // Arquivos escolhidos pelo usuário: .xml, .zip com XMLs, .xlsx/.xls/.csv
  async function importFiles(files) {
    let itens = 0, xmls = 0, planilhas = 0;
    const erros = [];
    const readXml = (name, text) => { const r = importXml(text); if (r.erro) erros.push(`${name}: ${r.erro}`); else { xmls++; itens += r.itens; } };
    for (const f of files) {
      const name = f.name || '';
      try {
        if (/\.xml$/i.test(name)) readXml(name, await f.text());
        else if (/\.zip$/i.test(name)) {
          const zip = XLSX.CFB.read(new Uint8Array(await f.arrayBuffer()), { type: 'array' });
          const dec = new TextDecoder('utf-8');
          zip.FileIndex.forEach((e, i) => {
            if (e.type === 2 && /\.xml$/i.test(e.name) && e.content) readXml(zip.FullPaths[i], dec.decode(e.content));
          });
        } else if (/\.(xlsx|xls|csv)$/i.test(name)) {
          const wb = XLSX.read(new Uint8Array(await f.arrayBuffer()), { type: 'array' });
          for (const sn of wb.SheetNames) {
            const r = importRows(XLSX.utils.sheet_to_json(wb.Sheets[sn], { header: 1, defval: null }), name);
            if (r.erro) { if (wb.SheetNames.length === 1) erros.push(`${name}: ${r.erro}`); } else { planilhas++; itens += r.itens; }
          }
        } else erros.push(`${name}: formato não suportado`);
      } catch (e) { erros.push(`${name}: ${e.message}`); }
    }
    const salvo = store(BASE_KEY, base);
    return { itens, xmls, planilhas, erros, salvo, total: count() };
  }

  function exportRows() {
    const head = ['GTIN', 'NCM', 'DESCRIÇÃO', 'CEST', 'FONTE', 'NCMs ENCONTRADOS (OCORRÊNCIAS)'];
    return [head, ...Object.entries(base).map(([g, e]) =>
      [fmtGtin(g), fmtNcm(e.ncm), e.desc, e.cest || '', e.fonte || '', Object.entries(e.cont || {}).map(([n, c]) => `${fmtNcm(n)} (${c})`).join(' · ')])];
  }
  function clear() { base = {}; store(BASE_KEY, base); }
  function remove(g14) { delete base[g14]; store(BASE_KEY, base); }
  function count() { return Object.keys(base).length; }

  // ── Consulta ────────────────────────────────────────────────────────
  function fromLocal(g14) {
    const e = base[g14];
    if (e) {
      const outros = Object.keys(e.cont || {}).filter(n => n !== e.ncm);
      return { found: true, ncm: e.ncm, desc: e.desc, cest: e.cest, fonte: e.fonte || 'base GTIN própria', conflito: outros.length ? outros : null };
    }
    const f = getFileTable().get(g14);
    if (f) return { found: true, ncm: pad8(f.ncm), desc: f.desc || f.descricao || '', cest: dig(f.cest), fonte: f.fonte || 'tabela GTIN local' };
    const fc = freeCache[g14];
    const freeFresh = fc && Date.now() - fc.t < (fc.found ? TTL_MS : 24 * 3600 * 1000);
    if (freeFresh && fc.found && fc.ncm) return { found: true, ncm: fc.ncm, desc: fc.desc || '', cest: fc.cest || '', fonte: 'PreçoMelhor (cache)', precomelhor: true };
    if (freeFresh && fc.found) return { found: true, ncm: fc.ncm || '', desc: fc.desc || '', cest: fc.cest || '', fonte: 'PreçoMelhor (cache)', precomelhor: true };
    if (freeFresh) return { found: false, precomelhor: true };
    return null;
  }

  async function fetchPrecoMelhor(g14) {
    const inputLength = inputLengths.get(g14) || 14;
    const code = g14.slice(-inputLength);
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 12000);
    try {
      const res = await fetch(`https://www.precomelhor.com.br/api/product/${encodeURIComponent(code)}`, {
        headers: { Accept: 'application/json' }, signal: ctl.signal, credentials: 'omit'
      });
      if (res.status === 404) return { found: false };
      if (res.status === 429) return { error: true, rateLimited: true, message: 'limite de consultas gratuitas do PreçoMelhor atingido' };
      if (!res.ok) return { error: true, message: `PreçoMelhor respondeu HTTP ${res.status}` };
      const json = await res.json();
      const item = json && (json.product || json);
      if (!item || !(item.ean || item.product_name || item.name)) return { found: false };
      const ncm = dig(item.ncm);
      return {
        found: true,
        ncm: ncm.length >= 7 && ncm.length <= 8 ? pad8(ncm) : '',
        desc: item.product_name || item.name || item.description || '',
        cest: dig(item.cest),
        fonte: 'PreçoMelhor'
      };
    } catch (error) {
      return { error: true, message: error.name === 'AbortError' ? 'tempo esgotado no PreçoMelhor' : 'PreçoMelhor indisponível (rede ou CORS)' };
    } finally { clearTimeout(timer); }
  }

  function fetchPrecoMelhorQueued(g14) {
    const request = freeQueue.then(async () => {
      const wait = Math.max(0, freeNextAt - Date.now());
      if (wait) await new Promise(resolve => setTimeout(resolve, wait));
      freeNextAt = Date.now() + FREE_GAP;
      return fetchPrecoMelhor(g14);
    });
    freeQueue = request.catch(() => null);
    return request;
  }

  async function fetchSefaz(g14) {
    const code = g14.slice(- (inputLengths.get(g14) || 14));
    try {
      const res = await fetch(`http://127.0.0.1:8787/api/gtin/${encodeURIComponent(code)}`, {
        headers: { Authorization: `Bearer ${bridgeToken}`, Accept: 'application/json' }, credentials: 'omit'
      });
      const data = await res.json();
      if (!res.ok) return { error: true, message: data.error || `Conector respondeu HTTP ${res.status}` };
      return Object.assign({ fonte: 'SEFAZ CCG' }, data);
    } catch (e) { return { error: true, message: 'Conector local indisponível; inicie sefaz-bridge.' }; }
  }

  // gtins: chaves de 14 dígitos. Retorna Map gtin14 → { found, ncm, desc, cest, fonte } | { found:false } | { error }
  async function lookupMany(gtins, onProgress, opts) {
    opts = opts || {};
    const out = new Map(), pending = [];
    for (const g of gtins) {
      const r = fromLocal(g);
      if (r) out.set(g, r);
      if (!r || !r.found || !r.ncm) pending.push(g);
    }
    lastMode = { free: 'off', sefaz: 'off', msg: '' };
    const messages = [];

    if (pending.length && opts.free) {
      const freeEligible = pending.filter(g => !out.get(g)?.precomelhor);
      const fila = freeEligible.slice(0, FREE_MAX);
      let done = 0, encontrados = 0, freeError = '';
      for (const g of fila) {
        const result = await fetchPrecoMelhorQueued(g);
        if (result.error) {
          freeError = result.message || 'erro na consulta gratuita';
          out.set(g, result);
          if (result.rateLimited) break;
          // Falhas de rede/CORS costumam afetar toda a fila; não repetir a falha em cada GTIN.
          break;
        }
        freeCache[g] = Object.assign({ t: Date.now() }, result);
        out.set(g, Object.assign({ fonte: 'PreçoMelhor' }, result));
        if (result.found) encontrados++;
        done++;
        onProgress && onProgress(done, fila.length, `Consultando GTINs grátis… ${done}/${fila.length}`);
      }
      store(FREE_KEY, freeCache);
      lastMode.free = freeError ? 'erro' : 'ok';
      messages.push(`PreçoMelhor: ${done} consulta(s) gratuita(s); ${encontrados} produto(s) encontrado(s).`);
      if (freeError) messages.push(freeError + '.');
      if (freeEligible.length > fila.length) messages.push(`${freeEligible.length - fila.length} GTIN(s) ficaram fora do lote gratuito de ${FREE_MAX}; importe-os na base ou consulte-os depois.`);
    }

    const sefazPending = pending.filter(g => { const r = out.get(g); return !r || r.error || !r.found || !r.ncm; });
    if (sefazPending.length && opts.sefaz && bridgeToken) {
      let done = 0, encontrados = 0, stop = '';
      for (const g of sefazPending.slice(0, 100)) {
        const r = await fetchSefaz(g);
        if (r.error) { stop = r.message; break; }
        if (r.found && r.ncm) { out.set(g, r); encontrados++; }
        else out.set(g, r);
        done++;
        onProgress && onProgress(done, sefazPending.length, `Consultando GTINs na SEFAZ… ${done}/${sefazPending.length}`);
        if (done < Math.min(sefazPending.length, 100)) await new Promise(resolve => setTimeout(resolve, 1100));
      }
      lastMode.sefaz = stop ? 'erro' : 'ok';
      messages.push(`SEFAZ CCG: ${done} consulta(s); ${encontrados} produto(s) com NCM.`);
      if (stop) messages.push(stop);
      if (sefazPending.length > 100) messages.push('Limite de 100 consultas por lote para evitar consumo indevido; reclassifique em lotes menores.');
    }
    for (const g of pending) if (!out.has(g)) out.set(g, { found: false });
    lastMode.msg = messages.join(' ');
    return out;
  }

  async function lookup(g14, opts) {
    opts = opts || {};
    const inputDigits = dig(opts.input || '');
    if (inputDigits.length) inputLengths.set(g14, inputDigits.length);
    return (await lookupMany([g14], null, opts)).get(g14);
  }

  // ── Aplicação nas linhas ────────────────────────────────────────────
  function locate(rows) {
    const h = findHeader(rows);
    if (h < 0) return null;
    const C = mapColumns(rows[h]);
    return C.GTIN == null || C.NCM == null ? null : { h, C };
  }

  function collect(rows) {
    const loc = locate(rows), set = new Set();
    if (!loc) return [];
    for (let i = loc.h + 1; i < rows.length; i++) {
      const p = gtinParse((rows[i] || [])[loc.C.GTIN]);
      if (p && p.ok) { set.add(p.gtin); inputLengths.set(p.gtin, p.inputLength); }
    }
    return [...set];
  }

  // GTIN usado para produtos claramente diferentes (sem palavra em comum) não é confiável
  function sharedGtins(rows) {
    const loc = locate(rows), shared = new Set();
    if (!loc || loc.C.DESC == null) return shared;
    const descs = new Map();
    for (let i = loc.h + 1; i < rows.length; i++) {
      const r = rows[i] || [], p = gtinParse(r[loc.C.GTIN]);
      if (!p || !p.ok) continue;
      const d = normTxt(r[loc.C.DESC]);
      if (!d) continue;
      if (!descs.has(p.gtin)) descs.set(p.gtin, new Set());
      descs.get(p.gtin).add(d);
    }
    for (const [g, set] of descs) {
      const l = [...set];
      outer: for (let a = 0; a < l.length; a++) for (let b = a + 1; b < l.length; b++)
        if (!descCompat(l[a], l[b])) { shared.add(g); break outer; }
    }
    return shared;
  }

  // Troca o NCM da linha pelo NCM do GTIN (quando aplicável) e guarda o original em "NCM INFORMADO"
  function apply(rowsIn, info) {
    const rows = rowsIn.map(r => (r || []).slice());
    const shared = sharedGtins(rows);
    const loc = locate(rows);
    if (!loc || !info || !info.size) return { rows, shared };
    const { h, C } = loc;
    const changes = [];
    for (let i = h + 1; i < rows.length; i++) {
      const r = rows[i];
      if (r[C.NCM] == null || dig(r[C.NCM]) === '') continue;
      const gd = gtinDecision(r[C.GTIN], C.DESC != null ? r[C.DESC] : '', info, shared);
      if (gd.situacao === 'ok' && gd.ncm !== pad8(r[C.NCM])) changes.push([r, gd.ncm]);
    }
    if (!changes.length) return { rows, shared };
    let oi = rows[h].findIndex(c => /^NCM (INFORMADO|ORIGINAL)$/.test(normTxt(c)));
    if (oi < 0) {
      oi = rows[h].length;
      rows[h][oi] = 'NCM INFORMADO';
      for (let i = h + 1; i < rows.length; i++) rows[i][oi] = '';
    }
    for (const [r, ncm] of changes) {
      if (r[oi] == null || r[oi] === '') r[oi] = pad8(r[C.NCM]);
      r[C.NCM] = ncm;
    }
    return { rows, shared };
  }

  return { importFiles, importXml, importRows, exportRows, addEntry, clear, remove, count,
           lookupMany, lookup, collect, apply, sharedGtins, setBridgeToken, mode: () => lastMode,
           save: () => store(BASE_KEY, base) };
})();

if (typeof module !== 'undefined') module.exports = { GtinBase };
