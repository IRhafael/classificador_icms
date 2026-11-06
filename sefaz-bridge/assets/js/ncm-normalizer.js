// ════════════════════════════════════════════════════════════════════
// REVISÃO DE NCM POR PRODUTO (código + descrição)
// Encontra produtos cujo NCM precisa de revisão e guarda a decisão do
// usuário. Nada é trocado sozinho: o NCM só muda depois de confirmado, e o
// código original fica na coluna "NCM INFORMADO".
//   Motivos de revisão:
//   • multiplo   → o mesmo produto aparece com NCMs diferentes na planilha
//   • descricao  → o NCM não combina com a descrição (ver ncm-rules.js)
//   Quando o produto tem GTIN com NCM na base (gtin.js), esse NCM é a
//   sugestão prioritária e não é tratado como suspeito.
//
// opts.gtinProduct(rawGtin) → { desc, fonte } — descrição vinda do GTIN. Deve
// ser passado igual em analyze, apply e isConfirmed para a chave do produto
// ser a mesma nas três (planilhas sem coluna de descrição dependem disso).
// ════════════════════════════════════════════════════════════════════
const NcmNormalizer = (() => {
  const STORAGE_KEY = 'ncm_product_corrections_v1';
  let corrections = null;

  const cellStr = v => String(v == null ? '' : v).trim();
  const productKey = (code, description) => `${cellStr(code)}|${normTxt(description)}`;

  // Chave do produto: código + descrição da planilha (ou do GTIN, ou o próprio GTIN)
  function describe(sku, sheetDescription, rawGtin, gtinProduct) {
    const info = (gtinProduct && gtinProduct(rawGtin)) || {};
    const description = cellStr(sheetDescription) || cellStr(info.desc);
    const gtinDigits = String(rawGtin == null ? '' : rawGtin).replace(/\D/g, '');
    return { sku: cellStr(sku), description, info, key: productKey(sku, description || gtinDigits) };
  }

  function readCorrections() {
    if (!corrections) {
      corrections = {};
      try { Object.assign(corrections, JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}')); }
      catch (e) { /* O navegador pode bloquear armazenamento em páginas file://. */ }
    }
    return corrections;
  }
  function persist() {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(readCorrections())); }
    catch (e) { /* A correção vale nesta sessão mesmo sem persistência local. */ }
  }

  function locate(rows) {
    const headerIndex = findHeader(rows);
    if (headerIndex < 0) return null;
    const columns = columnsOf(rows, headerIndex);
    if (columns.NCM == null || (columns.DESC == null && columns.COD == null)) return null;
    return { headerIndex, columns };
  }
  const rowDescribe = (row, C, gtinProduct) =>
    describe(C.COD != null ? row[C.COD] : '', C.DESC != null ? row[C.DESC] : '', C.GTIN != null ? row[C.GTIN] : '', gtinProduct);

  // opts.check(ncm, desc) → resultado de checkNcmCoherence (ou null)
  // opts.gtinNcm(rawGtin, desc) → { ncm, fonte } quando o GTIN tem NCM aplicável
  function analyze(rowsIn, opts) {
    opts = opts || {};
    const check = opts.check || (() => null);
    const gtinNcm = opts.gtinNcm || (() => null);
    const rows = rowsIn.map(row => row || []);
    const loc = locate(rows);
    if (!loc) return [];
    const { headerIndex, columns } = loc;
    const saved = readCorrections();

    const products = new Map();
    for (let i = headerIndex + 1; i < rows.length; i++) {
      const row = rows[i];
      const rawNcm = row[columns.NCM];
      if (rawNcm == null || String(rawNcm).replace(/\D/g, '') === '') continue;
      const d = rowDescribe(row, columns, opts.gtinProduct);
      if (!d.sku && !d.description) continue;
      const sheetDescription = columns.DESC != null ? cellStr(row[columns.DESC]) : '';
      if (!products.has(d.key)) products.set(d.key, { key: d.key, sku: d.sku, description: d.description, sheetDescription, descriptionGtin: new Map(), counts: new Map(), gtin: new Map() });
      const ncm = pad8(rawNcm);
      const prod = products.get(d.key);
      if (sheetDescription && !prod.sheetDescription) prod.sheetDescription = sheetDescription;
      if (d.info.desc) prod.descriptionGtin.set(cellStr(d.info.desc), d.info.fonte || 'GTIN');
      prod.counts.set(ncm, (prod.counts.get(ncm) || 0) + 1);
      if (columns.GTIN != null) {
        const gn = gtinNcm(row[columns.GTIN], d.description);
        if (gn && gn.ncm) prod.gtin.set(gn.ncm, gn.fonte || 'GTIN');
      }
    }

    const out = [];
    for (const p of products.values()) {
      const counts = [...p.counts.entries()].sort((a, b) => b[1] - a[1]);
      // NCM do GTIN só vale como sugestão se for único para o produto
      const ncmGtin = p.gtin.size === 1 ? [...p.gtin.keys()][0] : '';
      const coh = new Map(counts.map(([n]) => [n, n === ncmGtin ? null : check(n, p.description)]));
      const suspeitos = counts.filter(([n]) => coh.get(n));
      const multiplo = counts.length > 1;
      if (!multiplo && !suspeitos.length && p.gtin.size < 2) continue;

      const decided = saved[p.key] || '';
      // Sugestão: decisão salva › NCM do GTIN › NCM do próprio produto que combina com a descrição
      // › NCM sugerido pela categoria › NCM mais frequente (quando há mais de um)
      const coerente = counts.find(([n]) => !coh.get(n));
      const primeiroCoh = suspeitos.length ? coh.get(suspeitos[0][0]) : null;
      let suggestion = '', fonte = '';
      if (decided) { suggestion = decided; fonte = 'revisado'; }
      else if (ncmGtin) { suggestion = ncmGtin; fonte = 'GTIN: ' + p.gtin.get(ncmGtin); }
      else if (suspeitos.length && coerente) { suggestion = coerente[0]; fonte = 'NCM do próprio produto compatível com a descrição'; }
      else if (primeiroCoh && primeiroCoh.sugerido) { suggestion = primeiroCoh.sugerido; fonte = 'categoria: ' + primeiroCoh.nome; }
      else if (multiplo) { suggestion = counts[0][0]; fonte = 'NCM mais frequente do produto'; }

      const motivos = [];
      if (multiplo) motivos.push(`${counts.length} NCMs diferentes para o mesmo produto`);
      if (p.gtin.size > 1) motivos.push(`GTINs do produto indicam NCMs diferentes: ${[...p.gtin.keys()].map(fmtNcm).join(', ')}`);
      for (const [n] of suspeitos) motivos.push(`${fmtNcm(n)}: ${coh.get(n).msg}`);

      out.push({ key: p.key, sku: p.sku, description: p.description, counts, multiplo,
                 descriptionSheet: p.sheetDescription || '', descriptionGtin: [...p.descriptionGtin.entries()].map(([desc, f]) => ({ desc, fonte: f })),
                 suspeitos: suspeitos.map(([n]) => ({ ncm: n, ...coh.get(n) })), motivos,
                 suggestion, fonte, reviewed: !!decided, ncmGtin });
    }
    return out.sort((a, b) => a.description.localeCompare(b.description, 'pt-BR'));
  }

  function apply(rowsIn, opts) {
    opts = opts || {};
    const rows = rowsIn.map(row => (row || []).slice());
    const saved = readCorrections();
    if (!Object.keys(saved).length) return rows;
    const loc = locate(rows);
    if (!loc) return rows;
    const { headerIndex, columns } = loc;

    let originalIndex = rows[headerIndex].findIndex(cell => /^NCM (INFORMADO|ORIGINAL)$/.test(normTxt(cell)));
    const applicable = [];
    for (let i = headerIndex + 1; i < rows.length; i++) {
      const row = rows[i];
      if (row[columns.NCM] == null || String(row[columns.NCM]).replace(/\D/g, '') === '') continue;
      const corrected = saved[rowDescribe(row, columns, opts.gtinProduct).key];
      if (corrected && pad8(row[columns.NCM]) !== corrected) applicable.push({ row, corrected });
    }
    if (!applicable.length) return rows;

    if (originalIndex < 0) {
      originalIndex = rows[headerIndex].length;
      rows[headerIndex][originalIndex] = 'NCM INFORMADO';
      for (let i = headerIndex + 1; i < rows.length; i++) rows[i][originalIndex] = '';
    }
    for (const { row, corrected } of applicable) {
      if (row[originalIndex] == null || row[originalIndex] === '') row[originalIndex] = pad8(row[columns.NCM]);
      row[columns.NCM] = corrected;
    }
    return rows;
  }

  function normalizeValue(value) {
    const digits = String(value || '').replace(/\D/g, '');
    if (digits.length < 7 || digits.length > 8) throw new Error('Informe um NCM com 8 dígitos.');
    return digits.padStart(8, '0');
  }

  function save(key, value) {
    const v = normalizeValue(value);
    readCorrections()[key] = v;
    persist();
    return v;
  }

  // entries: [[key, valor], ...] — ignora valores inválidos e devolve quantos salvou
  function saveMany(entries) {
    const c = readCorrections();
    let n = 0;
    for (const [key, value] of entries) {
      try { c[key] = normalizeValue(value); n++; } catch (e) { /* valor vazio/ inválido */ }
    }
    persist();
    return n;
  }

  function remove(key) {
    delete readCorrections()[key];
    persist();
  }

  // Para a classificação: o usuário confirmou este NCM para este produto?
  function isConfirmed(code, description, ncm, rawGtin, gtinProduct) {
    const saved = readCorrections()[describe(code, description, rawGtin, gtinProduct).key];
    return !!saved && saved === pad8(ncm);
  }

  return { analyze, apply, save, saveMany, remove, isConfirmed };
})();
