// ════════════════════════════════════════════════════════════════════
// INTERFACE
// ════════════════════════════════════════════════════════════════════

// ── NCMs personalizados (localStorage) ──────────────────────────────
const CUSTOM_KEY = 'ncm_custom_pi';
(function loadCustom() {
  try {
    const custom = JSON.parse(localStorage.getItem(CUSTOM_KEY) || '{}');
    let count = 0;
    for (const [ncm, rule] of Object.entries(custom)) {
      NCM_DB[pad8(ncm)] = Object.assign({}, rule, { cst: cst2(rule.cst) });
      count++;
    }
    if (count > 0) console.log(`[Banco] ${count} NCM(s) personalizados carregados.`);
  } catch (e) { console.warn('Erro ao carregar banco personalizado:', e); }
})();

// ── Estado ──────────────────────────────────────────────────────────
let resultWorkbook = null;
let resultFileName = '';
let lastInput = null;      // { rows, sheetName, fileName, ncmInfo }

const $ = id => document.getElementById(id);
function updateDbCount() { $('db-count').textContent = Object.keys(NCM_DB).length.toLocaleString('pt-BR'); }
updateDbCount();

try { const v = localStorage.getItem('ncm_api_on'); if (v === '0') $('api-toggle').checked = false; } catch (e) {}
$('api-toggle').addEventListener('change', e => { try { localStorage.setItem('ncm_api_on', e.target.checked ? '1' : '0'); } catch (x) {} });
for (const [id, key] of [['gtin-toggle', 'gtin_on'], ['gtin-free-toggle', 'gtin_precomelhor_on'], ['gtin-sefaz-toggle', 'gtin_sefaz_on']]) {
  try { const v = localStorage.getItem(key); if (v != null) $(id).checked = v === '1'; } catch (e) {}
  $(id).addEventListener('change', e => { try { localStorage.setItem(key, e.target.checked ? '1' : '0'); } catch (x) {} });
}

// ── Upload / Drag ───────────────────────────────────────────────────
const dropZone = $('drop-zone');
const fileInput = $('file-input');
dropZone.addEventListener('dragover', e => { e.preventDefault(); dropZone.classList.add('drag-over'); });
dropZone.addEventListener('dragleave', () => dropZone.classList.remove('drag-over'));
dropZone.addEventListener('drop', e => {
  e.preventDefault();
  dropZone.classList.remove('drag-over');
  const file = e.dataTransfer.files[0];
  if (file && /\.xlsx?$/i.test(file.name)) processFile(file);
  else alert('Por favor, selecione um arquivo .xlsx');
});
fileInput.addEventListener('change', () => { if (fileInput.files[0]) processFile(fileInput.files[0]); });
$('btn-reset').addEventListener('click', () => {
  $('results-section').hidden = true;
  $('progress-section').hidden = true;
  dropZone.hidden = false;
  fileInput.value = '';
  resultWorkbook = null;
});
$('btn-download').addEventListener('click', () => { if (resultWorkbook) XLSX.writeFile(resultWorkbook, resultFileName); });
$('btn-reclassify').addEventListener('click', () => reclassifyWithCustom());

function setProgress(pct, msg) {
  $('pbar').style.width = pct + '%';
  $('status-msg').textContent = msg;
}
function fail(msg, err) {
  alert(msg);
  if (err) console.error(err);
  dropZone.hidden = false;
  $('progress-section').hidden = true;
}

// ── Processamento ───────────────────────────────────────────────────
function processFile(file) {
  dropZone.hidden = true;
  $('progress-section').hidden = false;
  $('results-section').hidden = true;
  setProgress(10, 'Lendo arquivo…');
  const reader = new FileReader();
  reader.onload = async e => {
    try {
      setProgress(25, 'Analisando planilha…');
      const wb = XLSX.read(new Uint8Array(e.target.result), { type: 'array' });
      const sheetName = wb.SheetNames[0];
      const rows = XLSX.utils.sheet_to_json(wb.Sheets[sheetName], { header: 1, defval: null });

      // 1º GTIN (prioritário): o NCM da base GTIN substitui o informado
      let gtinInfo = null;
      if ($('gtin-toggle').checked) {
        const gtins = GtinBase.collect(rows);
        setProgress(28, `Consultando ${gtins.length} GTIN(s)…`);
        gtinInfo = await GtinBase.lookupMany(gtins, (d, t, msg) => setProgress(28 + Math.round(10 * (t ? d / t : 0)), msg),
                                             gtinLookupOptions());
      }
      lastInput = { rows, sheetName, fileName: file.name, ncmInfo: new Map(), gtinInfo };

      // 2º NCMs distintos (informados, do GTIN e sugeridos) para a consulta na tabela oficial
      let ncmInfo = new Map();
      if ($('api-toggle').checked) {
        const prep = prepareRows();
        const codes = new Set();
        for (const set of [rows, prep.gtinRows, prep.finalRows]) for (const c of ncmCodesOf(set)) codes.add(c);
        for (const p of prep.review) if (p.suggestion) codes.add(pad8(p.suggestion));
        setProgress(40, `Consultando ${codes.size} NCMs na tabela oficial…`);
        ncmInfo = await NcmAPI.lookupMany([...codes], (d, t, msg) => setProgress(40 + Math.round(25 * (t ? d / t : 0)), msg));
      }

      setProgress(70, 'Aplicando classificações…');
      lastInput.ncmInfo = ncmInfo;
      runClassification();
    } catch (err) {
      fail('Erro ao processar o arquivo: ' + err.message, err);
    }
  };
  reader.readAsArrayBuffer(file);
}

function ncmCodesOf(rows) {
  const out = new Set(), h = findHeader(rows);
  if (h < 0) { for (const r of rows) for (const v of (r || [])) if (/^\d{7,8}$/.test(String(v || '').trim())) out.add(pad8(v)); return out; }
  const C = mapColumns(rows[h]);
  for (let r = h + 1; r < rows.length; r++) for (const i of [C.NCM, C.NCM_ORIG]) {
    const v = i != null && rows[r] ? rows[r][i] : null;
    if (v != null && String(v).replace(/\D/g, '')) out.add(pad8(v));
  }
  return out;
}

// Ordem de prioridade do NCM: revisão manual › GTIN › NCM informado
function prepareRows() {
  const { rows, gtinInfo } = lastInput;
  const g = gtinInfo ? GtinBase.apply(rows, gtinInfo) : { rows: rows.map(r => (r || []).slice()), shared: new Set() };
  const gtinNcm = (raw, desc) => {
    if (!gtinInfo) return null;
    const d = gtinDecision(raw, desc, gtinInfo, g.shared);
    return d.situacao === 'ok' ? { ncm: d.ncm, fonte: d.fonte } : null;
  };
  const review = NcmNormalizer.analyze(g.rows, { check: checkNcmCoherence, gtinNcm });
  return { gtinRows: g.rows, finalRows: NcmNormalizer.apply(g.rows), shared: g.shared, review };
}

function runClassification() {
  const { sheetName, fileName, ncmInfo, gtinInfo } = lastInput;
  const prep = prepareRows();
  const res = classifyRows(prep.finalRows, ncmInfo, NCM_DB, { isConfirmed: NcmNormalizer.isConfirmed, gtinInfo, gtinShared: prep.shared });
  const review = prep.review.map(p => Object.assign(p, { impacto: reviewImpact(p) }));
  setProgress(85, 'Gerando arquivo…');
  resultWorkbook = buildWorkbook(res, sheetName, review);
  resultFileName = fileName.replace(/\.xlsx?$/i, '') + ' - classificado.xlsx';
  renderResults(res, ncmInfo);
  renderNcmReview(review);
  setProgress(100, 'Concluído!');
  setTimeout(() => { $('progress-section').hidden = true; $('results-section').hidden = false; }, 300);
  return res;
}

// Tratamento hoje (NCMs informados) × tratamento com o NCM sugerido/escolhido
function reviewImpact(p) {
  const atuais = p.counts.map(([n]) => getRuleFor(n, p.description, NCM_DB));
  const atualTxt = [...new Set(atuais.map(descTrat))].join(' / ');
  let alvo = null, novoTxt = '';
  if (p.suggestion) { alvo = getRuleFor(p.suggestion, p.description, NCM_DB); novoTxt = alvo ? descTrat(alvo) : 'NCM sem regra no banco'; }
  else if (p.suspeitos.length && p.suspeitos[0].esperado.length) {
    alvo = ruleForPrefixes(p.suspeitos[0].esperado, NCM_DB);
    novoTxt = alvo ? descTrat(alvo) : 'depende do NCM exato';
  }
  const chaves = new Set(atuais.map(tratKey));
  const muda = alvo ? [...chaves].some(k => k !== tratKey(alvo)) : (chaves.size > 1 ? true : null);
  return { atual: atualTxt, novo: novoTxt, muda };
}

// Depois de salvar NCMs na revisão: reclassifica e busca a descrição oficial dos códigos novos
async function refreshAfterReview(codes, note) {
  runClassification();
  $('actions-note').textContent = note;
  if (!$('api-toggle').checked || !lastInput || !lastInput.ncmInfo) return;
  const missing = [...new Set(codes.map(pad8))].filter(c => !lastInput.ncmInfo.has(c));
  if (!missing.length) return;
  const info = await NcmAPI.lookupMany(missing);
  if (!lastInput || !lastInput.ncmInfo) return;
  for (const [c, i] of info) lastInput.ncmInfo.set(c, i);
  runClassification();
  $('actions-note').textContent = note;
}

function renderNcmReview(products) {
  const wrap = $('ncm-review-wrap');
  const tbody = $('ncm-review-body');
  tbody.innerHTML = '';
  if (!products.length) { wrap.hidden = true; return; }
  wrap.hidden = false;
  const pend = products.filter(p => !p.reviewed);
  const impacto = pend.filter(p => p.impacto.muda).length;
  $('ncm-review-badge').textContent = `${pend.length} pendente(s)` + (impacto ? ` · ${impacto} mudam o ICMS` : '') +
    (products.length > pend.length ? ` · ${products.length - pend.length} revisado(s)` : '');
  $('btn-review-all').hidden = !pend.length;

  const order = p => (p.reviewed ? 2 : 0) + (p.impacto.muda ? 0 : 1);
  const info = (lastInput && lastInput.ncmInfo) || new Map();
  const offDesc = n => { const i = info.get(n); return i && i.found ? i.leaf || i.desc : i && !i.error ? 'NCM inexistente na tabela oficial' : ''; };
  for (const p of [...products].sort((a, b) => order(a) - order(b))) {
    const tr = document.createElement('tr');
    if (p.reviewed) tr.className = 'rev-done';
    const ncms = p.counts.map(([code, count]) => {
      const sus = p.suspeitos.some(s => s.ncm === code);
      const od = offDesc(code);
      return `<div class="${sus ? 'ncm-sus' : ''}"><span class="ncm-cell">${fmtNcm(code)}</span> (${count}) · ${escHtml(descTrat(getRuleFor(code, p.description, NCM_DB)))}` +
             (od ? `<span class="off-desc">${escHtml(od.substring(0, 70))}</span>` : '') + '</div>';
    }).join('');
    const imp = p.impacto;
    const impHtml = imp.novo
      ? `${escHtml(imp.atual)} → <strong>${escHtml(imp.novo)}</strong>${imp.muda ? ' <span class="badge badge-red">muda ICMS</span>' : imp.muda === false ? ' <span class="badge badge-green">sem impacto</span>' : ''}`
      : escHtml(imp.atual) + (imp.muda ? ' <span class="badge badge-red">tratamentos diferentes</span>' : '');
    const sugDesc = p.suggestion ? offDesc(pad8(p.suggestion)) : '';
    tr.innerHTML = `
      <td class="ncm-cell">${escHtml(p.sku)}</td>
      <td>${escHtml(p.description)}<span class="motivo">${p.motivos.map(escHtml).join('<br>')}</span></td>
      <td>${ncms}</td>
      <td class="imp-cell">${impHtml}</td>
      <td><input class="ncm-input ncm-normalized-input" type="text" inputmode="numeric" maxlength="10" placeholder="8 dígitos"
             value="${escHtml(p.suggestion)}" data-key="${escHtml(p.key)}">
          <span class="sug">${p.reviewed ? '✓ revisado' : escHtml(p.fonte || 'informe o NCM correto')}</span>
          ${sugDesc ? `<span class="off-desc">${escHtml(sugDesc.substring(0, 70))}</span>` : ''}</td>
      <td class="rev-actions"><button class="btn-add" data-act="save">${p.reviewed ? 'Atualizar' : 'Salvar'}</button>
          ${p.reviewed ? '<button class="btn-link" data-act="undo">Desfazer</button>' : ''}</td>`;
    const input = tr.querySelector('.ncm-normalized-input');
    tr.querySelector('[data-act=save]').addEventListener('click', () => {
      try {
        const ncm = NcmNormalizer.save(p.key, input.value);
        refreshAfterReview([ncm], `NCM ${fmtNcm(ncm)} aplicado a "${p.description}" e planilha reclassificada.`);
      } catch (error) { input.focus(); alert(error.message); }
    });
    const undo = tr.querySelector('[data-act=undo]');
    if (undo) undo.addEventListener('click', () => {
      NcmNormalizer.remove(p.key);
      refreshAfterReview([], `Revisão desfeita para "${p.description}" — voltou o NCM informado.`);
    });
    tbody.appendChild(tr);
  }
}

// Salva de uma vez o NCM preenchido em todos os produtos pendentes
$('btn-review-all').addEventListener('click', () => {
  const inputs = [...document.querySelectorAll('#ncm-review-body tr:not(.rev-done) .ncm-normalized-input')];
  const entries = inputs.map(i => [i.dataset.key, i.value]).filter(([, v]) => String(v).replace(/\D/g, '').length >= 7);
  const vazios = inputs.length - entries.length;
  if (!entries.length) { alert('Nenhum produto pendente tem NCM preenchido.'); return; }
  if (!confirm(`Aplicar o NCM preenchido em ${entries.length} produto(s)?` + (vazios ? `\n${vazios} sem NCM preenchido continuarão pendentes.` : ''))) return;
  const n = NcmNormalizer.saveMany(entries);
  refreshAfterReview(entries.map(([, v]) => v), `${n} produto(s) com NCM revisado e planilha reclassificada.`);
});

function buildWorkbook(res, sheetName, review) {
  const wb = XLSX.utils.book_new();
  const C = res.cols;
  const widths = res.rows[0].map((h, i) => {
    if (i === C.NCM_DESC) return { wch: 60 };
    if (i === C.OBS) return { wch: 55 };
    if (i === C.STATUS) return { wch: 70 };
    if (i === C.DESC) return { wch: 40 };
    if (i === C.NCM_SUG || i === C.NCM_ORIG || i === C.NCM_GTIN || i === C.GTIN) return { wch: 15 };
    if (i === C.NCM_FONTE) return { wch: 30 };
    return { wch: Math.max(10, String(h || '').length + 2) };
  });
  const ws = XLSX.utils.aoa_to_sheet(res.rows);
  ws['!cols'] = widths;
  ws['!autofilter'] = { ref: XLSX.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: res.rows.length - 1, c: res.rows[0].length - 1 } }) };
  XLSX.utils.book_append_sheet(wb, ws, (sheetName || 'Planilha1').slice(0, 31));

  const probl = res.rows.filter((r, i) => i > 0 && !/^✅/.test(String(r[C.STATUS] || '')));
  probl.sort((a, b) => Math.abs(num(b[C.DIF])) - Math.abs(num(a[C.DIF])));
  const ws2 = XLSX.utils.aoa_to_sheet([res.rows[0], ...probl]);
  ws2['!cols'] = widths;
  if (probl.length) ws2['!autofilter'] = { ref: XLSX.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: probl.length, c: res.rows[0].length - 1 } }) };
  XLSX.utils.book_append_sheet(wb, ws2, 'Divergências');

  if (review && review.length) {
    const head = ['CÓDIGO', 'DESCRIÇÃO', 'NCMs INFORMADOS (OCORRÊNCIAS)', 'MOTIVO', 'TRATAMENTO ATUAL',
                  'NCM SUGERIDO / ESCOLHIDO', 'TRATAMENTO COM ESSE NCM', 'MUDA O ICMS?', 'SITUAÇÃO'];
    const lines = review.map(p => [
      p.sku, p.description, p.counts.map(([c, n]) => `${fmtNcm(c)} (${n})`).join(' · '), p.motivos.join(' | '),
      p.impacto.atual, p.suggestion ? fmtNcm(p.suggestion) : '', p.impacto.novo,
      p.impacto.muda ? 'SIM' : p.impacto.muda === false ? 'não' : '?', p.reviewed ? 'Revisado' : 'Pendente']);
    lines.sort((a, b) => (a[8] > b[8] ? 1 : a[8] < b[8] ? -1 : 0) || (a[7] === 'SIM' ? -1 : b[7] === 'SIM' ? 1 : 0));
    const ws3 = XLSX.utils.aoa_to_sheet([head, ...lines]);
    ws3['!cols'] = [{ wch: 10 }, { wch: 42 }, { wch: 34 }, { wch: 70 }, { wch: 22 }, { wch: 16 }, { wch: 26 }, { wch: 10 }, { wch: 11 }];
    ws3['!autofilter'] = { ref: XLSX.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: lines.length, c: head.length - 1 } }) };
    XLSX.utils.book_append_sheet(wb, ws3, 'Revisão NCM');
  }

  if (res.gtinReport && res.gtinReport.length) {
    const SIT = { ok: 'NCM do GTIN aplicado', 'sem-base': 'Sem cadastro — usado NCM informado', 'sem-ncm': 'GTIN sem NCM — usado NCM informado',
                  compartilhado: 'Não aplicado — GTIN usado p/ produtos diferentes', 'desc-diverge': 'Não aplicado — descrição não confere',
                  invalido: 'GTIN inválido', interno: 'GTIN interno (balança/loja)' };
    const head = ['GTIN', 'DESCRIÇÃO NA PLANILHA', 'NCM INFORMADO', 'NCM DO GTIN', 'CONFERE?', 'DESCRIÇÃO NA BASE GTIN', 'FONTE', 'SITUAÇÃO', 'LINHAS', 'OBSERVAÇÃO'];
    const lines = res.gtinReport.map(r => {
      const inf = [...r.ncmInf];
      const confere = !r.ncmGtin ? '' : inf.length === 1 && inf[0] === r.ncmGtin ? 'sim' : 'NÃO';
      return [fmtGtin(r.gtin), r.desc, inf.map(fmtNcm).join(' / '), r.ncmGtin ? fmtNcm(r.ncmGtin) : '', confere, r.descGtin, r.fonte,
              SIT[r.situacao] || r.situacao, r.linhas, [r.motivo, r.conflito ? 'base com outros NCMs: ' + r.conflito.map(fmtNcm).join(', ') : ''].filter(Boolean).join(' | ')];
    });
    lines.sort((a, b) => (a[4] === 'NÃO' ? 0 : 1) - (b[4] === 'NÃO' ? 0 : 1) || String(a[1]).localeCompare(String(b[1]), 'pt-BR'));
    const ws4 = XLSX.utils.aoa_to_sheet([head, ...lines]);
    ws4['!cols'] = [{ wch: 15 }, { wch: 40 }, { wch: 22 }, { wch: 12 }, { wch: 9 }, { wch: 40 }, { wch: 30 }, { wch: 34 }, { wch: 7 }, { wch: 60 }];
    ws4['!autofilter'] = { ref: XLSX.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: lines.length, c: head.length - 1 } }) };
    XLSX.utils.book_append_sheet(wb, ws4, 'Validação GTIN');
  }
  return wb;
}

function renderResults(res, ncmInfo) {
  const s = res.stats;
  const fmt = n => n.toLocaleString('pt-BR');
  $('t-total').textContent = fmt(s.total);
  $('t-classified').textContent = fmt(s.classified);
  $('t-st').textContent = fmt(s.stIsento);
  $('t-div').textContent = fmt(s.divergentes);
  const prodDiv = res.rows.filter((r, i) => i > 0 && /^⚠️/.test(String(r[res.cols.STATUS] || ''))).length;
  $('t-dif').textContent = `${fmt(prodDiv)} produto(s)` + (s.difTotal
    ? ' · dif. ' + s.difTotal.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' }) : '');
  $('t-dif').title = 'Diferença de ICMS = ICMS correto − ICMS declarado (negativo: recolhido a maior; positivo: a menor)';
  $('t-rev').textContent = fmt(s.revisar);
  $('t-inv').textContent = fmt(s.ncmInvalido + s.atencao);
  $('t-sus').textContent = fmt(s.ncmSuspeito);
  $('t-sus-sub').textContent = [s.ncmSuspeitoImpacto ? `${fmt(s.ncmSuspeitoImpacto)} mudam ICMS` : '', s.ncmCorrigido ? `${fmt(s.ncmCorrigido)} corrigidas` : ''].filter(Boolean).join(' · ');
  const avisos = [];
  if (s.isCsosn) avisos.push('Coluna CST lida como CSOSN (Simples Nacional): conferido o enquadramento ST/isento/tributado, sem alíquota.');
  if (s.aliqFator === 100) avisos.push('Alíquotas vieram como fração (ex.: 0,225) e foram lidas como percentual (22,5%).');
  $('parse-notes').textContent = avisos.join(' ');
  $('parse-notes').hidden = !avisos.length;
  const newCount = Object.keys(res.newNCMs).length;
  $('t-new').textContent = fmt(newCount);
  $('t-gtin').textContent = fmt(s.gtinConfirmado + s.gtinCorrigido);
  $('t-gtin-sub').textContent = s.temGtin
    ? [s.gtinCorrigido ? `${fmt(s.gtinCorrigido)} corrigidas` : '', s.gtinSemBase ? `${fmt(s.gtinSemBase)} sem cadastro` : '',
       s.gtinNaoAplicado ? `${fmt(s.gtinNaoAplicado)} não aplicadas` : '', s.gtinInvalido ? `${fmt(s.gtinInvalido)} GTIN inválido` : ''].filter(Boolean).join(' · ')
    : ($('gtin-toggle').checked ? 'planilha sem coluna GTIN' : 'consulta GTIN desligada');
  const gs = $('gtin-status');
  if (s.temGtin) {
    const cm = GtinBase.mode();
    gs.textContent = `GTIN (prioritário): ${fmt(s.gtinConfirmado)} linha(s) com NCM confirmado e ${fmt(s.gtinCorrigido)} corrigida(s) pelo GTIN; ` +
      `${fmt(s.gtinSemBase + s.semGtin)} seguiram com o NCM informado (sem GTIN ou sem cadastro).` + (cm.msg ? ' ' + cm.msg : '');
    gs.className = 'api-status ' + (cm.sefaz === 'erro' || cm.free === 'erro' ? 'off' : 'ok');
    gs.hidden = false;
  } else gs.hidden = true;

  const mode = $('api-toggle').checked ? NcmAPI.mode() : 'desligada';
  const st = $('api-status');
  const msgs = {
    local: `Tabela NCM oficial do Siscomex consultada localmente (${window.NCM_OFFICIAL_UPDATED_AT || 'data de atualização não informada'}).`,
    tabela: 'Tabela NCM oficial consultada — NCMs inexistentes ou extintos foram sinalizados.',
    cache: 'NCMs validados com a tabela oficial (cache local de até 30 dias).',
    individual: 'NCMs consultados um a um na BrasilAPI (descrição sem hierarquia).',
    parcial: 'Consulta NCM parcial — parte dos códigos não respondeu; esses não foram validados.',
    offline: 'Consulta NCM indisponível (sem internet ou API fora do ar) — classificação feita só com o banco local.',
    desligada: 'Validação na tabela oficial desligada.',
  };
  st.textContent = msgs[mode] || '';
  st.className = 'api-status ' + (['local', 'tabela', 'cache', 'individual'].includes(mode) ? 'ok' : 'off');

  $('actions-note').textContent = newCount > 0
    ? `⚠️ ${newCount} NCM(s) novo(s) — revise a tabela abaixo`
    : '✅ Todos os NCMs encontrados no banco';

  const tbody = $('new-ncms-body');
  tbody.innerHTML = '';
  $('custom-count').hidden = true;
  $('btn-reclassify').hidden = true;
  if (!newCount) { $('new-ncms-wrap').hidden = true; return; }
  $('new-ncms-wrap').hidden = false;
  $('new-badge').textContent = newCount + ' NCMs';
  const entries = Object.entries(res.newNCMs).sort((a, b) => b[1].count - a[1].count);
  for (const [ncm, info] of entries) {
    const sug = suggestRule(ncm, NCM_DB);
    const api = info.info;
    const tr = document.createElement('tr');
    const cstSel = sug && !sug.conflito ? cst2(sug.cst) : '00';
    tr.innerHTML = `
      <td class="ncm-cell">${fmtNcm(ncm)}</td>
      <td>${escHtml(info.desc.substring(0, 60))}
        ${api && api.found ? `<span class="off-desc">${escHtml(api.desc)}</span>` : ''}
        ${info.invalido ? `<span class="inv">NCM inexistente/extinto na tabela oficial — corrigir cadastro</span>` : ''}
        ${info.suspeito ? `<span class="inv">NCM suspeito: ${escHtml(info.suspeito.msg)} — corrija na revisão por produto antes de cadastrar</span>` : ''}
        ${sug ? `<span class="sug">${sug.conflito ? `Grupo ${sug.base}: regras diferentes no banco — classificar manualmente` : `Sugestão (grupo ${sug.base}): CST ${cst2(sug.cst)} · ${sug.aliq}%`}</span>` : ''}
      </td>
      <td style="font-family:var(--mono);text-align:right">${info.count}</td>
      <td><input class="ncm-input" type="number" data-f="aliq" placeholder="ex: 22.5" step="0.1" min="0" max="100" style="width:80px" value="${sug && !sug.conflito ? sug.aliq : ''}"></td>
      <td>
        <select class="ncm-input" data-f="cst" style="width:64px">
          ${['00', '20', '40', '41', '60'].map(c => `<option value="${c}"${c === cstSel ? ' selected' : ''}>${c}</option>`).join('')}
        </select>
      </td>
      <td><input class="ncm-input" type="text" data-f="obs" placeholder="Descrição/regra" style="min-width:140px" value="${sug && !sug.conflito ? escHtml(sug.obs) : ''}"></td>
      <td><button class="btn-add">＋ Salvar</button></td>`;
    tr.querySelector('.btn-add').addEventListener('click', ev => addToBank(ncm, tr, ev.currentTarget, sug));
    tbody.appendChild(tr);
  }
}

// ── Adicionar NCM ao banco ──────────────────────────────────────────
function addToBank(ncm, tr, btn, sug) {
  const aliqEl = tr.querySelector('[data-f=aliq]');
  const cstEl = tr.querySelector('[data-f=cst]');
  const obsEl = tr.querySelector('[data-f=obs]');
  const aliq = parseFloat(aliqEl.value);
  if (isNaN(aliq) || aliq < 0) { aliqEl.focus(); alert('Informe a alíquota.'); return; }
  const cst = cst2(cstEl.value);
  if ((cst === '40' || cst === '41' || cst === '60') && aliq !== 0) { aliqEl.focus(); alert('Para CST 40/41/60 a alíquota deve ser 0.'); return; }
  const rule = { cst, aliq, obs: obsEl.value.trim() || ('Adicionado manualmente – ' + aliq + '%') };
  if (cst === '20') {
    const nominal = sug && sug.aliq_nominal ? sug.aliq_nominal : parseFloat(prompt('CST 20: informe a alíquota NOMINAL (a alíquota digitada é a carga efetiva).', '12'));
    if (isNaN(nominal) || nominal <= 0) return;
    rule.aliq_nominal = nominal;
  }
  NCM_DB[ncm] = rule;
  try {
    const saved = JSON.parse(localStorage.getItem(CUSTOM_KEY) || '{}');
    saved[ncm] = rule;
    localStorage.setItem(CUSTOM_KEY, JSON.stringify(saved));
  } catch (e) { console.warn('localStorage indisponível:', e); }
  btn.textContent = '✓ Salvo'; btn.disabled = true; btn.style.background = 'var(--green)';
  [aliqEl, cstEl, obsEl].forEach(el => el.disabled = true);
  updateDbCount();
  $('custom-added').textContent = document.querySelectorAll('#new-ncms-body .btn-add[disabled]').length;
  $('custom-count').hidden = false;
  $('btn-reclassify').hidden = false;
}

// ── Reclassificar com o banco atualizado ────────────────────────────
// Refaz todo o processamento a partir das linhas originais (mesma lógica,
// mesma consolidação e mesmos status da primeira classificação).
function reclassifyWithCustom() {
  if (!lastInput) return;
  const saved = document.querySelectorAll('#new-ncms-body .btn-add[disabled]').length;
  runClassification();
  $('actions-note').textContent = `↻ Reclassificado com ${saved} NCM(s) novo(s) — ` + $('actions-note').textContent;
}

// ── Base GTIN (painel) ──────────────────────────────────────────────
function updateGtinCount() { $('gtin-count').textContent = GtinBase.count().toLocaleString('pt-BR'); }
function gtinMsg(html) { const b = $('gtin-msg'); b.hidden = !html; b.innerHTML = html || ''; }
updateGtinCount();
$('sefaz-connect').addEventListener('click', async () => {
  const status = $('sefaz-status');
  const button = $('sefaz-connect');
  const token = $('sefaz-token').value.trim();
  const file = $('sefaz-pfx').files[0];
  if (!token) { status.textContent = 'Cole o token que apareceu no terminal do conector.'; gtinMsg(status.textContent); $('sefaz-token').focus(); return; }
  if (!file && !$('sefaz-status').textContent.includes('certificado carregado')) {
    status.textContent = 'Selecione o arquivo .pfx/.p12 e informe a senha.'; gtinMsg(status.textContent); $('sefaz-pfx').focus(); return;
  }
  GtinBase.setBridgeToken(token);
  button.disabled = true;
  button.textContent = 'Conectando…';
  status.textContent = file ? 'Enviando o certificado ao conector local…' : 'Verificando o conector local…';
  gtinMsg(status.textContent);
  try {
    if (file) {
      const bytes = new Uint8Array(await file.arrayBuffer());
      let binary = '';
      for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
      const res = await fetch('http://127.0.0.1:8787/api/certificate', {
        method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ pfx: btoa(binary), passphrase: $('sefaz-password').value })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Falha ao carregar certificado');
      $('sefaz-pfx').value = ''; $('sefaz-password').value = '';
    }
    const res = await fetch('http://127.0.0.1:8787/api/status', { headers: { Authorization: `Bearer ${token}` } });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Conector não autorizado');
    status.textContent = data.certificate ? 'Conector conectado · certificado carregado' : 'Conector conectado · selecione o certificado';
    gtinMsg('Conector SEFAZ local conectado. A senha e o arquivo não são gravados pelo navegador.');
  } catch (e) {
    const detail = e.name === 'TypeError'
      ? 'Não foi possível acessar o conector local. Confirme que node sefaz-bridge/server.mjs está rodando e que SEFAZ_ALLOWED_ORIGINS corresponde exatamente à origem do site (somente https://domínio, sem caminho).'
      : e.message;
    status.textContent = detail;
    gtinMsg(`<strong style="color:var(--red)">${escHtml(detail)}</strong>`);
  } finally { button.disabled = false; button.textContent = 'Conectar'; }
});
$('gtin-import-btn').addEventListener('click', () => $('gtin-file').click());
$('gtin-file').addEventListener('change', async e => {
  const files = [...e.target.files];
  e.target.value = '';
  if (!files.length) return;
  gtinMsg('<span class="cr-muted">Importando…</span>');
  const r = await GtinBase.importFiles(files);
  updateGtinCount();
  gtinMsg(`${r.itens.toLocaleString('pt-BR')} item(ns) lidos de ${r.xmls} XML(s) e ${r.planilhas} planilha(s). Base com <strong>${r.total.toLocaleString('pt-BR')}</strong> GTINs.` +
    (r.salvo ? '' : ' <strong style="color:var(--red)">Não foi possível gravar no navegador — a base vale só nesta sessão.</strong>') +
    (r.erros.length ? `<br><span class="cr-muted">${r.erros.slice(0, 5).map(escHtml).join('<br>')}${r.erros.length > 5 ? `<br>… e mais ${r.erros.length - 5}` : ''}</span>` : ''));
  if (lastInput && r.itens) refreshGtin('Base GTIN atualizada e planilha reclassificada.');
});
$('gtin-export-btn').addEventListener('click', () => {
  if (!GtinBase.count()) { alert('A base GTIN está vazia.'); return; }
  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.aoa_to_sheet(GtinBase.exportRows());
  ws['!cols'] = [{ wch: 15 }, { wch: 12 }, { wch: 45 }, { wch: 9 }, { wch: 40 }, { wch: 40 }];
  XLSX.utils.book_append_sheet(wb, ws, 'Base GTIN');
  XLSX.writeFile(wb, 'base GTIN x NCM.xlsx');
});
$('gtin-clear-btn').addEventListener('click', () => {
  if (!confirm('Apagar a base GTIN importada neste navegador?')) return;
  GtinBase.clear(); updateGtinCount(); gtinMsg('Base GTIN apagada.');
  if (lastInput) refreshGtin('Base GTIN apagada e planilha reclassificada.');
});

// Refaz a consulta GTIN (e a dos NCMs novos) com a planilha já carregada
async function refreshGtin(note) {
  if (!lastInput || !$('gtin-toggle').checked) return;
  lastInput.gtinInfo = await GtinBase.lookupMany(GtinBase.collect(lastInput.rows), null, gtinLookupOptions());
  if ($('api-toggle').checked) {
    const prep = prepareRows();
    const missing = [...ncmCodesOf(prep.finalRows)].filter(c => !lastInput.ncmInfo.has(c));
    if (missing.length) for (const [c, i] of await NcmAPI.lookupMany(missing)) lastInput.ncmInfo.set(c, i);
  }
  runClassification();
  $('actions-note').textContent = note;
}

function gtinLookupOptions() {
  return { free: $('gtin-free-toggle').checked, sefaz: $('gtin-sefaz-toggle').checked };
}

// ── Consulta avulsa (NCM ou GTIN) ───────────────────────────────────
async function consultNcm() {
  const raw = $('consult-input').value;
  const box = $('consult-result');
  const d = raw.replace(/\D/g, '');
  box.hidden = false;
  if ([12, 13, 14].includes(d.length)) return consultGtin(d, box);
  if (d.length < 7 || d.length > 8) { box.innerHTML = '<span class="cr-muted">Digite um NCM (8 dígitos) ou um GTIN (12 a 14 dígitos).</span>'; return; }
  box.innerHTML = '<span class="cr-muted">Consultando…</span>';
  box.innerHTML = await ncmInfoHtml(pad8(d));
}

async function consultGtin(d, box) {
  const p = gtinParse(d);
  if (!p || !p.ok) { box.innerHTML = `<span class="inv" style="color:var(--red);font-weight:600">GTIN ${escHtml(d)}: ${escHtml(p ? p.motivo : 'inválido')}.</span>`; return; }
  box.innerHTML = '<span class="cr-muted">Consultando GTIN…</span>';
  const i = await GtinBase.lookup(p.gtin, Object.assign(gtinLookupOptions(), { input: d }));
  const cm = GtinBase.mode();
  let head = `<div><span class="cr-code">GTIN ${escHtml(fmtGtin(p.gtin))}</span> — `;
  if (!i || !i.found || !i.ncm) {
    head += i && i.found ? 'encontrado, mas sem NCM cadastrado.' : i && i.error ? 'consulta indisponível.' : 'não encontrado na base GTIN.';
    box.innerHTML = head + (cm.msg ? ` <span class="cr-muted">${escHtml(cm.msg)}</span>` : '') +
      '</div><div class="cr-muted">Na classificação, as linhas com este GTIN seguem com o NCM informado.</div>';
    return;
  }
  head += `<span class="cr-desc">${escHtml(i.desc || '(sem descrição)')}</span> · fonte: ${escHtml(i.fonte)}` +
          (i.cest ? ` · CEST ${escHtml(i.cest)}` : '') +
          (i.conflito ? ` <strong style="color:var(--red)">· a base tem também ${i.conflito.map(fmtNcm).join(', ')}</strong>` : '') + '</div>';
  box.innerHTML = head + await ncmInfoHtml(i.ncm);
}

async function ncmInfoHtml(ncm) {
  const rule = NCM_DB[ncm];
  const sug = rule ? null : suggestRule(ncm, NCM_DB);
  const api = await NcmAPI.lookup(ncm);
  let apiTxt;
  if (api.error) apiTxt = '<span class="cr-muted">Tabela oficial indisponível no momento (sem internet ou API fora do ar).</span>';
  else if (!api.found) apiTxt = '<span class="inv" style="color:var(--red);font-weight:600">NCM não existe na tabela NCM oficial.</span>';
  else apiTxt = `<span class="cr-desc">${escHtml(api.desc)}</span>${api.expired ? ` <strong style="color:var(--red)">· extinto em ${escHtml(api.fim)}</strong>` : ''}`;
  let ruleTxt;
  if (rule) {
    const nom = rule.aliq_nominal || (cst2(rule.cst) === '20' ? 12 : null);
    ruleTxt = `Banco: <strong>CST ${cst2(rule.cst)} · ${rule.aliq}%</strong>${nom ? ` (nominal ${nom}%)` : ''} — ${escHtml(rule.obs || '')}`;
  } else if (sug && !sug.conflito) {
    ruleTxt = `Não cadastrado. Sugestão pelo grupo ${sug.base}: <strong>CST ${cst2(sug.cst)} · ${sug.aliq}%</strong> (${sug.n} NCM(s) semelhantes)`;
  } else {
    ruleTxt = 'Não cadastrado no banco' + (sug && sug.conflito ? ` (grupo ${sug.base} tem regras diferentes)` : '') + '.';
  }
  const dr = DESC_RULES.filter(r => { try { return r.test(ncm, '', rule) || String(r.test).includes(`'${ncm}'`); } catch (e) { return false; } });
  return `<div><span class="cr-code">${fmtNcm(ncm)}</span> — ${apiTxt}</div>
    <div class="cr-rule">${ruleTxt}</div>
    ${dr.length ? `<div class="cr-muted">Este NCM tem regra por descrição do produto (${dr.map(r => r.id).join(', ')}).</div>` : ''}`;
}
$('consult-btn').addEventListener('click', consultNcm);
$('consult-input').addEventListener('keydown', e => { if (e.key === 'Enter') consultNcm(); });

// ── Utils ───────────────────────────────────────────────────────────
function escHtml(s) {
  return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
