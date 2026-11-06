// ════════════════════════════════════════════════════════════════════
// BASE GTIN → NCM (consulta prioritária)
// Ordem de consulta de cada GTIN:
//   1. Base própria (neste navegador): importada de XML de NF-e de entrada
//      ou de planilha GTIN × NCM (cadastro do ERP, relatório do CCG etc.)
//   2. Tabela fixa assets/js/gtin-data.js (window.GTIN_TABLE), se existir
//   3. Respostas já guardadas (cache de 30 dias) da SEFAZ e do PreçoMelhor
//   4. SEFAZ CCG oficial (opcional, conector local com certificado A1) —
//      só GTINs brasileiros (prefixo 789/790), máx. 100 por lote
//   5. PreçoMelhor (consulta gratuita, máx. 60 por lote) para o que sobrar
// Se o GTIN não estiver em nenhuma delas, a linha segue com o NCM informado.
// ════════════════════════════════════════════════════════════════════
const GtinBase = (() => {
  const BASE_KEY   = 'gtin_ncm_base_v1';
  const FREE_KEY   = 'gtin_precomelhor_cache_v1';
  const SEFAZ_KEY  = 'gtin_sefaz_cache_v1';
  const BRIDGE     = 'http://127.0.0.1:8787';
  const TTL_MS     = 30 * 24 * 3600 * 1000;
  const TTL_MISS   = 24 * 3600 * 1000;    // "não encontrado" é consultado de novo no dia seguinte
  const FREE_MAX   = 60;           // PreçoMelhor publica uso justo de ~60 consultas/minuto
  const FREE_GAP   = 1100;         // espaçamento para respeitar o limite por IP
  const SEFAZ_MAX  = 100;
  const SEFAZ_GAP  = 1100;         // o conector aceita no máximo 1 consulta por segundo
  const dig = s => String(s == null ? '' : s).replace(/\D/g, '');

  const load = (k, def) => { try { return JSON.parse(localStorage.getItem(k) || 'null') || def; } catch (e) { return def; } };
  const store = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); return true; } catch (e) { return false; } };
  const fresh = c => c && Date.now() - c.t < (c.found ? TTL_MS : TTL_MISS);

  // base: gtin14 → { ncm, desc, cest, fonte, cont: {ncm: ocorrências} }
  let base = load(BASE_KEY, {});
  let freeCache = load(FREE_KEY, {});
  let sefazCache = load(SEFAZ_KEY, {});
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
    const C = columnsOf(rows, hIdx);
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
    // Cache das consultas externas: SEFAZ (oficial) antes do PreçoMelhor
    const sc = sefazCache[g14], fc = freeCache[g14];
    const hit = fresh(sc) && sc.found && sc.ncm ? ['SEFAZ CCG (cache)', sc, 'sefaz']
              : fresh(fc) && fc.found && fc.ncm ? ['PreçoMelhor (cache)', fc, 'precomelhor']
              : fresh(sc) && sc.found ? ['SEFAZ CCG (cache)', sc, 'sefaz']
              : fresh(fc) && fc.found ? ['PreçoMelhor (cache)', fc, 'precomelhor'] : null;
    const tried = { sefaz: fresh(sc), precomelhor: fresh(fc) };
    if (hit) return Object.assign({ found: true, ncm: hit[1].ncm || '', desc: hit[1].desc || '', cest: hit[1].cest || '', fonte: hit[0], viaFree: hit[2] === 'precomelhor' }, tried);
    if (tried.sefaz || tried.precomelhor) return Object.assign({ found: false }, tried);
    return null;
  }

  // Código como foi digitado na planilha (GTIN-8/12/13/14)
  const asTyped = g14 => g14.slice(-(inputLengths.get(g14) || 14));
  // A CCG só tem GTINs concedidos pela GS1 Brasil (rejeição 9492 para os demais)
  const isBrazilian = g14 => { const c = asTyped(g14); return /^(789|790)/.test(c.length === 14 ? c.slice(1) : c); };

  async function fetchPrecoMelhor(g14) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 12000);
    try {
      const res = await fetch(`https://www.precomelhor.com.br/api/product/${encodeURIComponent(asTyped(g14))}`, {
        headers: { Accept: 'application/json' }, signal: ctl.signal, credentials: 'omit'
      });
      if (res.status === 404) return { found: false };
      if (res.status === 429) return { error: true, message: 'limite de consultas gratuitas do PreçoMelhor atingido' };
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
      return { error: true, message: error.name === 'AbortError' ? 'tempo esgotado no PreçoMelhor' : 'PreçoMelhor indisponível (rede ou bloqueio do navegador)' };
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
    try {
      const res = await fetch(`${BRIDGE}/api/gtin/${encodeURIComponent(asTyped(g14))}`, {
        headers: { Authorization: `Bearer ${bridgeToken}`, Accept: 'application/json' }, credentials: 'omit'
      });
      const data = await res.json();
      if (!res.ok) return { error: true, message: data.error || `Conector respondeu HTTP ${res.status}` };
      return Object.assign({ fonte: 'SEFAZ CCG' }, data);
    } catch (e) { return { error: true, message: 'Conector SEFAZ local indisponível — confirme que node sefaz-bridge/server.mjs está rodando.' }; }
  }

  const precisa = r => !r || r.error || !r.found || !r.ncm;

  // gtins: chaves de 14 dígitos. Retorna Map gtin14 → { found, ncm, desc, cest, fonte } | { found:false } | { error }
  async function lookupMany(gtins, onProgress, opts) {
    opts = opts || {};
    const out = new Map();
    for (const g of gtins) { const r = fromLocal(g); if (r) out.set(g, r); }
    lastMode = { free: 'off', sefaz: 'off', msg: '' };
    const messages = [];

    // 1º SEFAZ CCG (oficial), só para GTIN brasileiro ainda sem NCM
    if (opts.sefaz) {
      // NCM vindo só do PreçoMelhor também é conferido na fonte oficial
      const fila = gtins.filter(g => { const r = out.get(g); return (precisa(r) || r.viaFree) && !(r || {}).sefaz && isBrazilian(g); });
      if (!bridgeToken) {
        if (fila.length) { lastMode.sefaz = 'erro'; messages.push('SEFAZ: conector não conectado — informe o token e clique em Conectar.'); }
      } else if (fila.length) {
        let done = 0, encontrados = 0, stop = '';
        const lote = fila.slice(0, SEFAZ_MAX);
        for (const g of lote) {
          if (done) await new Promise(resolve => setTimeout(resolve, SEFAZ_GAP));
          const r = await fetchSefaz(g);
          if (r.error) { stop = r.message; break; }
          sefazCache[g] = { t: Date.now(), found: !!r.found, ncm: r.ncm ? pad8(r.ncm) : '', desc: r.desc || '', cest: dig(r.cest), cStat: r.cStat || '' };
          const prev = out.get(g) || {};
          if (r.found) out.set(g, Object.assign({}, prev, { found: true, viaFree: !r.ncm && prev.viaFree, ncm: r.ncm ? pad8(r.ncm) : prev.ncm || '', desc: r.desc || prev.desc || '',
                                                             cest: dig(r.cest) || prev.cest || '', fonte: r.ncm ? 'SEFAZ CCG' : prev.fonte || 'SEFAZ CCG', sefaz: true }));
          else out.set(g, Object.assign({}, prev, { found: !!prev.found, sefaz: true, motivo: r.motivo || r.error || '' }));
          if (r.found && r.ncm) encontrados++;
          done++;
          onProgress && onProgress(done, lote.length, `Consultando GTINs na SEFAZ… ${done}/${lote.length}`);
        }
        store(SEFAZ_KEY, sefazCache);
        lastMode.sefaz = stop ? 'erro' : 'ok';
        messages.push(`SEFAZ CCG: ${done} consulta(s); ${encontrados} com NCM.`);
        if (stop) messages.push(stop);
        if (fila.length > lote.length) messages.push(`${fila.length - lote.length} GTIN(s) ficaram para o próximo lote (limite de ${SEFAZ_MAX} por vez, para não caracterizar consumo indevido).`);
      }
    }

    // 2º PreçoMelhor (gratuito) para o que ainda estiver sem NCM
    if (opts.free) {
      const fila = gtins.filter(g => precisa(out.get(g)) && !(out.get(g) || {}).precomelhor);
      const lote = fila.slice(0, FREE_MAX);
      let done = 0, encontrados = 0, freeError = '';
      for (const g of lote) {
        const r = await fetchPrecoMelhorQueued(g);
        // Falhas de rede/bloqueio costumam afetar toda a fila; não repetir a falha em cada GTIN.
        if (r.error) { freeError = r.message || 'erro na consulta gratuita'; break; }
        freeCache[g] = Object.assign({ t: Date.now() }, r);
        const prev = out.get(g);
        if (r.found || !prev) out.set(g, Object.assign({}, prev, r, { fonte: 'PreçoMelhor', precomelhor: true }));
        if (r.found && r.ncm) encontrados++;
        done++;
        onProgress && onProgress(done, lote.length, `Consultando GTINs grátis… ${done}/${lote.length}`);
      }
      if (lote.length) {
        store(FREE_KEY, freeCache);
        lastMode.free = freeError ? 'erro' : 'ok';
        messages.push(`PreçoMelhor: ${done} consulta(s); ${encontrados} com NCM.`);
        if (freeError) messages.push(freeError + '.');
        if (fila.length > lote.length) messages.push(`${fila.length - lote.length} GTIN(s) ficaram fora do lote gratuito de ${FREE_MAX}; reclassifique depois ou importe-os na base.`);
      }
    }
    for (const g of gtins) if (!out.has(g)) out.set(g, { found: false });
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
    const C = columnsOf(rows, h);
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

  return { importFiles, importXml, importRows, exportRows, addEntry, clear, count, bridgeUrl: BRIDGE,
           lookupMany, lookup, collect, apply, sharedGtins, setBridgeToken, mode: () => lastMode };
})();

if (typeof module !== 'undefined') module.exports = { GtinBase };
