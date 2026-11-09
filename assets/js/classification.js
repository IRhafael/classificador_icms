// ════════════════════════════════════════════════════════════════════
// NÚCLEO DE CLASSIFICAÇÃO (sem dependência de DOM — testável isoladamente)
// ════════════════════════════════════════════════════════════════════

// NCM sempre com 8 dígitos. Excel costuma perder o zero à esquerda (2071210 → 02071210);
// códigos com mais de 8 dígitos (NCM + EX, por exemplo) ficam com os 8 primeiros.
const pad8 = s => {
  const d = String(s == null ? '' : s).replace(/\D/g, '');
  return (d.length > 8 ? d.slice(0, 8) : d).padStart(8, '0');
};
const cst2 = c => {
  const s = String(c == null ? '' : c).replace(/\D/g, '');
  return s === '' ? '' : s.slice(-2).padStart(2, '0');
};
const normTxt = s => String(s == null ? '' : s).toUpperCase().trim()
  .normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/\s+/g, ' ');
// Aceita "1.234,56", "1234.56", "R$ 10,00", "22,5%". Vírgula depois do último ponto = decimal BR.
const num = v => {
  if (v == null || v === '') return 0;
  if (typeof v === 'number') return isFinite(v) ? v : 0;
  let s = String(v).trim().replace(/[^\d,.\-]/g, '');
  if (s.includes(',') && s.lastIndexOf(',') > s.lastIndexOf('.')) s = s.replace(/\./g, '').replace(',', '.');
  else s = s.replace(/,/g, '');
  const n = parseFloat(s);
  return isNaN(n) ? 0 : n;
};
const r2 = v => Math.round((v + Number.EPSILON) * 100) / 100;
const fmtNcm = c => { const s = pad8(c); return `${s.slice(0,4)}.${s.slice(4,6)}.${s.slice(6)}`; };

// ── GTIN (código de barras) ─────────────────────────────────────────
// Valida o GTIN-8/12/13/14 pelo dígito verificador e devolve a chave de 14
// dígitos. "SEM GTIN", vazio e zeros retornam null. Códigos de uso interno
// (prefixo 2 — balança/loja) não identificam o produto e não são consultados.
function gtinParse(v) {
  const raw = String(v == null ? '' : v).trim();
  if (!raw || /SEM\s*GTIN/i.test(raw)) return null;
  if (/E\+?\d+$/i.test(raw) && /[.,]/.test(raw)) return { gtin: raw, ok: false, motivo: 'GTIN em notação científica (Excel perdeu dígitos)' };
  const d = raw.replace(/\D/g, '');
  if (!d || /^0+$/.test(d)) return null;
  if (![8, 12, 13, 14].includes(d.length)) return { gtin: d, ok: false, motivo: `GTIN com ${d.length} dígitos` };
  const g14 = d.padStart(14, '0');
  let s = 0;
  for (let i = 0; i < 13; i++) s += Number(g14[i]) * (i % 2 === 0 ? 3 : 1);
  if ((10 - s % 10) % 10 !== Number(g14[13])) return { gtin: g14, ok: false, motivo: 'dígito verificador do GTIN inválido' };
  const core = g14.slice(1);
  if (/^2/.test(core) || /^0[24]/.test(core) || (d.length === 8 && /^[02]/.test(d)))
    return { gtin: g14, ok: false, interno: true, motivo: 'GTIN de uso interno (balança/loja) — não identifica o produto' };
  return { gtin: g14, ok: true, digits: d, inputLength: d.length };
}
const fmtGtin = g => String(g || '').replace(/^0+(?=\d{8})/, '');

// Duas descrições falam do mesmo produto? (pelo menos uma palavra em comum)
const DESC_STOP = new Set(['COM', 'SEM', 'PARA', 'TIPO', 'UND', 'UNID', 'PCT', 'PACOTE', 'CAIXA', 'LATA', 'GARRAFA', 'SACHE', 'REFIL', 'GRANEL']);
const descTokens = s => new Set(normTxt(s).replace(/[^A-Z0-9 ]/g, ' ').split(' ')
  .filter(w => w.length >= 3 && !/\d/.test(w) && !DESC_STOP.has(w)));
function descCompat(a, b) {
  const ta = descTokens(a), tb = descTokens(b);
  if (!ta.size || !tb.size) return true;            // sem palavras úteis: não dá para afirmar que divergem
  for (const w of ta) if (tb.has(w)) return true;
  for (const w of ta) for (const x of tb) if (w.length >= 4 && x.length >= 4 && (w.startsWith(x) || x.startsWith(w))) return true; // abreviações
  return false;
}

// Decide se o NCM do GTIN vale para a linha.
//   info: resultado da consulta (Map gtin14 → {found, ncm, desc, fonte})
//   shared: Set de GTINs usados na planilha para produtos diferentes
// situacao: sem-gtin | invalido | interno | sem-base | sem-ncm | referencia | compartilhado | desc-diverge | ok
function gtinDecision(rawGtin, desc, info, shared) {
  const p = gtinParse(rawGtin);
  if (!p) return { situacao: 'sem-gtin' };
  if (!p.ok) return { situacao: p.interno ? 'interno' : 'invalido', gtin: p.gtin, motivo: p.motivo };
  const i = info && info.get(p.gtin);
  if (!i || i.error) return { situacao: 'sem-base', gtin: p.gtin, motivo: i && i.error ? 'consulta do GTIN indisponível' : 'GTIN não consultado' };
  if (!i.found) return { situacao: 'sem-base', gtin: p.gtin, motivo: 'GTIN não encontrado na base' };
  if (!i.ncm) return { situacao: 'sem-ncm', gtin: p.gtin, fonte: i.fonte, motivo: 'GTIN encontrado sem NCM cadastrado' };
  const base = { gtin: p.gtin, ncm: pad8(i.ncm), fonte: i.fonte || 'base GTIN', descGtin: i.desc || '', conflito: i.conflito || null };
  // PreçoMelhor é cadastro colaborativo (erra com frequência): só referência, nunca troca o NCM
  if (i.viaFree) return Object.assign(base, { situacao: 'referencia', motivo: 'NCM do PreçoMelhor (cadastro não oficial) — só referência' });
  if (shared && shared.has(p.gtin)) return Object.assign(base, { situacao: 'compartilhado', motivo: 'mesmo GTIN usado para produtos diferentes na planilha' });
  if (i.desc && desc && !descCompat(desc, i.desc)) return Object.assign(base, { situacao: 'desc-diverge', motivo: `descrição do GTIN ("${String(i.desc).slice(0, 50)}") não confere com o produto` });
  return Object.assign(base, { situacao: 'ok' });
}

// Valor do item = (valor total, ou qtd × valor unitário) − desconto + frete + seguro + outras despesas
function valorDoItem(decl) {
  let bruto = decl.valor > 0 ? decl.valor : 0, fonte = 'valor do item';
  if (!(bruto > 0) && decl.qtd > 0 && decl.vunit > 0) { bruto = decl.qtd * decl.vunit; fonte = 'qtd × valor unitário'; }
  if (!(bruto > 0)) return { valor: 0, fonte: '' };
  const acess = (decl.frete || 0) + (decl.seguro || 0) + (decl.outras || 0);
  const extras = [decl.desconto > 0 ? 'desconto' : '', decl.frete > 0 ? 'frete' : '', decl.seguro > 0 ? 'seguro' : '', decl.outras > 0 ? 'outras despesas' : ''].filter(Boolean);
  return { valor: r2(Math.max(0, bruto - (decl.desconto || 0)) + acess), fonte: fonte + (extras.length ? ` (± ${extras.join(', ')})` : '') };
}

// Grupo tributário do CST
const cstGroup = c => {
  const s = cst2(c);
  if (['00', '20'].includes(s)) return 'TRIB';
  if (['10', '30', '60', '70'].includes(s)) return 'ST';
  if (['40', '41', '50'].includes(s)) return 'ISENTO';
  if (s === '51') return 'DIFERIDO';
  return s ? 'OUTRO' : '';
};
const GROUP_LABEL = { TRIB: 'tributado', ST: 'ST', ISENTO: 'isento/não trib.', DIFERIDO: 'diferido', OUTRO: 'outro' };

// CSOSN (Simples Nacional): grupo equivalente para comparar com a regra do NCM
const CSOSN_SET = new Set(['101', '102', '103', '201', '202', '203', '300', '400', '500', '900']);
const csosnGroup = c => {
  const s = String(c == null ? '' : c).replace(/\D/g, '');
  if (['201', '202', '203', '500'].includes(s)) return 'ST';
  if (['300', '400'].includes(s)) return 'ISENTO';
  if (['101', '102', '103'].includes(s)) return 'SN';
  if (s === '900') return 'OUTRO';
  return '';
};

// Texto curto do tratamento de uma regra (para comparar NCM atual × sugerido)
function descTrat(rule) {
  if (!rule) return 'sem regra no banco';
  const g = cstGroup(rule.cst);
  if (g === 'ST') return 'ST';
  if (g === 'ISENTO') return 'isento';
  if (cst2(rule.cst) === '20') return `${String(rule.aliq_nominal || 12).replace('.', ',')}% c/ redução (carga ${String(rule.aliq).replace('.', ',')}%)`;
  return `${String(rule.aliq).replace('.', ',')}%`;
}
const tratKey = r => r ? cstGroup(r.cst) + '|' + r.aliq : '';
const fmtPrefixo = p => p.length === 8 ? fmtNcm(p) : p.length > 4 ? `${p.slice(0, 4)}.${p.slice(4)}` : p;

// ── Coerência NCM × descrição (regras em ncm-rules.js) ──────────────
// Retorna null quando o NCM é compatível (ou quando a descrição não é reconhecida).
function checkNcmCoherence(ncm, desc) {
  const n = pad8(ncm), d = normTxt(desc);
  if (!d || /^0+$/.test(n)) return null;
  const cats = typeof NCM_CATEGORIAS !== 'undefined' ? NCM_CATEGORIAS : [];
  for (const cat of cats) {
    if (!cat.re.test(d) || (cat.exceto && cat.exceto.test(d))) continue;
    if (cat.ncm.some(p => n.startsWith(p))) return null;
    return { id: cat.id, nome: cat.nome, esperado: cat.ncm.slice(), sugerido: cat.sugerido || '',
             msg: `descrição indica ${cat.nome.toLowerCase()} (NCM esperado: ${cat.ncm.map(fmtPrefixo).join(' / ')})` };
  }
  const rev = typeof NCM_EXIGE_DESCRICAO !== 'undefined' ? NCM_EXIGE_DESCRICAO : [];
  for (const r of rev) {
    if (r.prefixos.some(p => n.startsWith(p)) && !r.re.test(d)) {
      return { id: 'inverso-' + r.nome.toLowerCase(), nome: r.nome, esperado: [], sugerido: '',
               msg: `NCM de ${r.nome.toLowerCase()} (${fmtNcm(n)}) para produto que não parece ${r.nome.toLowerCase()}` };
    }
  }
  return null;
}

// Tratamento previsto para um conjunto de prefixos, se o banco for unânime
function ruleForPrefixes(prefixes, db) {
  db = db || NCM_DB;
  const rules = Object.entries(db).filter(([k]) => prefixes.some(p => k.startsWith(p))).map(([, v]) => v);
  if (!rules.length) return null;
  const keys = new Set(rules.map(tratKey));
  return keys.size === 1 ? rules[0] : null;
}

// Impacto de trocar o NCM: tratamento hoje × tratamento com o NCM sugerido
function impactoNcm(ncmAtual, ncmNovo, desc, coh, db) {
  db = db || NCM_DB;
  const atual = getRuleFor(ncmAtual, desc, db);
  let novo = null, alvo = '';
  if (ncmNovo && pad8(ncmNovo) !== pad8(ncmAtual)) { novo = getRuleFor(ncmNovo, desc, db); alvo = fmtNcm(ncmNovo); }
  else if (coh && coh.esperado.length) { novo = ruleForPrefixes(coh.esperado, db); alvo = coh.esperado.map(fmtPrefixo).join('/'); }
  if (!alvo) return { atual: descTrat(atual), novo: '', muda: null };
  if (!novo) return { atual: descTrat(atual), novo: ncmNovo ? 'NCM sem regra no banco (cadastrar)' : 'depende do NCM exato', muda: null, alvo };
  return { atual: descTrat(atual), novo: descTrat(novo), muda: tratKey(atual) !== tratKey(novo), alvo };
}

// ── Regras por descrição do produto ─────────────────────────────────
// Ajustam a regra do NCM quando o mesmo código abriga produtos com
// tratamentos diferentes. Executadas em ordem; a primeira que casar vence.
const RE_SUCO     = /SUCO|N[EÉ]CTAR|REFRESCO|KAPO|DEL\s*VAL|DV\s*FRUT|CAJU[IÍ]NA|MARACUJ|GOIABA|LARANJA\s*\d|UVA\s*\d|CAIXINHA|FRUT[^S]/;
const RE_NAO_SUCO = /REFRIG|SODA\b|GATORADE|POWERADE|ISOT[OÔ]N|ENERG|H2OH|\bCOLA\b|COCA|PEPSI|GUARAN|FANTA|SPRITE|SCHWEPPES/;
const RE_POLVILHO = /POL?VILHO|SEQUILHO|\bPETA\b/;
const RE_SNACK    = /DORITOS|TORCIDA|KIKOS|PRINGLES|SALSITO|DELICITO|CHIPS|SNACK|SALGADINHO|CHEETOS|FANDANGOS|RUFFLES|BATATA\s*PALHA/;

const DESC_RULES = [
  { id: 'suco-2202',
    test: (n, d, r) => r && r.cst === '60' && n.startsWith('2202') && RE_SUCO.test(d) && !RE_NAO_SUCO.test(d),
    rule: { cst: '00', aliq: 22.5, obs: '⚠️ Suco/néctar/cajuína - 22,5% (verificar se NCM está correto)' } },
  { id: 'achoc-22029900',
    test: (n, d) => n === '22029900' && /ACHOC|TODDYNHO|PIRAKIDS|NESCAU|CHOCOL[AÁ]T|CACAU|L[AÁ]CTEA|LACT|IOGUR|CAJU[IÍ]NA/.test(d) && !RE_NAO_SUCO.test(d),
    rule: { cst: '00', aliq: 22.5, obs: 'Achocolatado/bebida láctea/cajuína - 22,5%' } },
  { id: 'agua-mineral-2202',
    test: (n, d) => n.startsWith('2202') && /AGUA\s*MINERAL|AGUA\s*S\/?\s*GAS|AGUA\s*C\/?\s*GAS/.test(d),
    rule: { cst: '60', aliq: 0, obs: '⚠️ ST - Água mineral', atencao: 'NCM 2202 informado para água mineral — o correto é 2201.10.00. Pedir correção ao fornecedor.' } },
  { id: 'flocos-milho-11042900',
    test: (n, d) => n === '11042900' && /MILHO/.test(d),
    rule: { cst: '40', aliq: 0, obs: '✅ Isento - Cesta básica (flocos de milho)' } },
  { id: 'flocao-arroz-11041900',
    test: (n, d) => n === '11041900' && /ARROZ/.test(d) && !/MILHO|CUSCUZ/.test(d),
    rule: { cst: '00', aliq: 22.5, obs: '⚠️ Flocão de arroz - 22,5% (isenção da cesta básica alcança derivados de milho — confirmar)' } },
  { id: 'mamadeira-39249000',
    test: (n, d) => n === '39249000' && /MAMADEIRA|PUERICULTURA|BICO\s*(DE\s*)?MAMAD|CHUPETA/.test(d),
    rule: { cst: '60', aliq: 0, obs: '⚠️ ST - Mamadeira/bico (artigo de puericultura)' } },
  { id: 'torta-algodao-19059090',
    test: (n, d) => n === '19059090' && /CAROCO|ALGODAO|SOJA\s*(DESINT|TOST)|FARELO|EXPEL/.test(d),
    rule: { cst: '00', aliq: 22.5, obs: '⚠️ Subproduto agrícola (torta/farelo) - 22,5%',
            atencao: 'Torta de caroço de algodão não é produto de padaria — NCM correto provável 2306.10.00.' } },
  { id: 'polvilho-salgadinho',
    test: (n, d, r) => r && r.cst === '60' && /^(19|20)/.test(n) &&
      (RE_POLVILHO.test(d) || (RE_SNACK.test(d) && !/BISC|COOKIE|BOLACHA|WAFER/.test(d))),
    rule: { cst: '00', aliq: 22.5, obs: 'Salgadinho/polvilho/sequilho - 22,5%' } },
  { id: 'peta-35051000',
    test: (n, d) => n === '35051000' && (RE_POLVILHO.test(d) || /BISC|BOLINHA/.test(d)),
    rule: { cst: '00', aliq: 22.5, obs: 'Biscoito de polvilho - 22,5%',
            atencao: 'Produto é biscoito de polvilho (1905.90.90); NCM 3505.10.00 é amido/dextrina.' } },
  { id: 'massa-arroz-19021900',
    test: (n, d) => n === '19021900' && /\bARROZ\b|SEM\s*GLUT|S\/\s*GLUT/.test(d),
    rule: { cst: '00', aliq: 22.5, obs: 'Massa de arroz/sem glúten - 22,5%' } },
  { id: 'sal-25010020',
    test: (n, d) => n === '25010020' && !/GROSS|CHURRASC|PARRILHA|INDUSTRIAL|GADO|MINERAL/.test(d),
    rule: { cst: '40', aliq: 0, obs: '✅ Isento - Sal de cozinha (uso doméstico)' } },
  { id: 'preservativo-40141000',
    test: (n, d) => n === '40141000' && /PRESERV|CAMISINHA|CONDOM/.test(d),
    rule: { cst: '40', aliq: 0, obs: '✅ Isento - Preservativo' } },
  { id: 'peroba-2710',
    test: (n, d) => n.startsWith('2710') && /PEROBA|LUSTRA\s*MOV|LUSTRA-MOV/.test(d),
    rule: { cst: '00', aliq: 22.5, obs: 'Óleo de peroba (lustra-móveis) - 22,5%',
            atencao: 'Óleo de peroba é lustra-móveis (3405.20.00), não óleo lubrificante (2710) — não é ST.' } },
  { id: 'leite-po-19011010',
    test: (n, d) => n === '19011010' && /LEITE|NINHO/.test(d) && !/FORMULA|NESTOGENO|NAN\b|APTAMIL|INFANTIL|MILNUTRI/.test(d),
    rule: { cst: '00', aliq: 22.5, obs: 'Preparação infantil (1901.10.10) - 22,5% pelo NCM declarado',
            atencao: 'Leite em pó integral/desnatado costuma ser 0402.21.xx ou 0402.10.xx (12% c/ redução p/ 7%). Conferir NCM com o fornecedor.' } },
  { id: 'bacon-16024900',
    test: (n, d) => n === '16024900' && /BACON/.test(d),
    rule: { cst: '00', aliq: 22.5, obs: 'Bacon com NCM 1602.49.00 - 22,5% pelo NCM declarado',
            atencao: 'Bacon normalmente é 0210.12.00 (ST). Conferir NCM com o fornecedor.' } },
];

function getRuleFor(ncm, desc, db) {
  db = db || NCM_DB;
  const n = pad8(ncm);
  const d = normTxt(desc);
  const base = db[n] || null;
  for (const dr of DESC_RULES) {
    if (dr.test(n, d, base)) return Object.assign({ fonte: 'descricao:' + dr.id }, dr.rule);
  }
  if (base) {
    const r = Object.assign({ fonte: 'banco' }, base);
    if (/ATENÇÃO/.test(r.obs || '')) r.atencao = r.atencao || 'NCM informado diverge do produto — ver observação.';
    return r;
  }
  return null;
}

// Sugestão para NCM fora do banco: mesma subposição (6 díg.) ou posição (4 díg.)
// quando todos os NCMs do banco naquele grupo têm o mesmo tratamento.
function suggestRule(ncm, db) {
  db = db || NCM_DB;
  const n = pad8(ncm);
  for (const len of [7, 6, 4]) {
    const pre = n.slice(0, len);
    const same = Object.entries(db).filter(([k]) => k.startsWith(pre));
    if (!same.length) continue;
    const keys = new Set(same.map(([, v]) => cst2(v.cst) + '|' + v.aliq + '|' + (v.aliq_nominal || '')));
    if (keys.size === 1) {
      const v = same[0][1];
      return { cst: cst2(v.cst), aliq: v.aliq, aliq_nominal: v.aliq_nominal, base: pre, n: same.length,
               obs: `Sugestão: mesma regra de ${same.length} NCM(s) do grupo ${pre} no banco — conferir` };
    }
    return { conflito: true, base: pre, n: same.length };
  }
  return null;
}

// ── Detecção de colunas pelo cabeçalho ──────────────────────────────
// Cada coluna recebe no máximo um papel (o primeiro da lista que casar).
// Quando várias colunas servem ao mesmo papel, vence a de maior pontuação
// (COL_PREF + conteúdo); no empate, a primeira da planilha.
// Termos que indicam outro tributo ou outro campo do ICMS:
const NAO_ICMS_PROPRIO = /\bST\b|RET|FCP|DESON|DIFAL|DIFER|\bIBS\b|\bCBS\b|\bPIS\b|COFINS|\bIPI\b|\bISS\b|\bII\b|SIMPLES|CREDITO|MODALIDADE|MOTIVO|REDUC|SUBSTITUTO|PROPRIO DO|\bUF\b|DESTINO|INTER|MVA|APROX/;
const COL_RULES = [
  ['BASE_C',   h => /BASE.*CORRET/.test(h)],
  ['ALIQ_C',   h => /AL[I]Q.*CORRET/.test(h)],
  ['ICMS_C',   h => /ICMS.*CORRET/.test(h)],
  ['DIF',      h => /^DIFEREN/.test(h)],
  ['NCM_DESC', h => /DESCRI.*NCM|NCM.*(OFICIAL|TIPI)/.test(h)],
  ['OBS',      h => /^OBS|OBSERV/.test(h)],
  ['STATUS',   h => /^STATUS$/.test(h)],
  ['NITENS',   h => /^N.? ?(DE )?(ITENS|LINHAS)$|^QTD\.? LINHAS/.test(h)],
  ['NCM_ORIG', h => /^NCM\s+(INFORMADO|ORIGINAL)$/.test(h)],
  ['NCM_SUG',  h => /^NCM\s+SUGERIDO/.test(h)],
  ['NCM_GTIN', h => /^NCM\s+(DO\s+|PELO\s+)?GTIN/.test(h)],
  ['NCM_FONTE',h => /^FONTE\s+(DO\s+)?NCM/.test(h)],
  ['VITEM_C',  h => /VALOR.*ITEM.*CALC/.test(h)],
  ['GTIN',     h => /GTIN|\bEAN\b|\bCEAN\b|COD(IGO)?\.?\s*(DE\s+)?BARRAS?\b|^BARRAS$/.test(h) && !/TRIB/.test(h)],
  ['NCM',      h => /\bNCM\b/.test(h)],
  ['CFOP',     h => /\bCFOP\b/.test(h)],
  ['CST',      h => /\bCST\b|\bCSOSN\b|SIT.*TRIB/.test(h) && !/PIS|COFINS|IPI|\bIBS\b|\bCBS\b/.test(h)],
  ['ALIQ',     h => /AL[I]Q/.test(h) && !NAO_ICMS_PROPRIO.test(h)],
  ['BASE',     h => (/BASE.*(CAL|ICMS|TRIB)|^BASE$|^BC\b|VALOR.?BASE|VL.?BC/.test(h)) && !NAO_ICMS_PROPRIO.test(h)],
  ['ICMS',     h => /\bICMS\b/.test(h) && !NAO_ICMS_PROPRIO.test(h) && !/AL[I]Q|BASE|%/.test(h)],
  ['DESC_V',   h => /DESCONTO|^VL?\.? ?DESC\.?$|^DESC\.?$/.test(h)],
  ['FRETE',    h => /FRETE/.test(h) && !/MOD|TIPO|TRANSP/.test(h)],
  ['SEGURO',   h => /SEGURO/.test(h)],
  ['OUTRAS',   h => /OUTRAS?\s*(DESP|ACESS)|DESP.*ACESS|^VL?\.?\s*OUTR/.test(h)],
  ['VUNIT',    h => /UNIT/.test(h) && /VAL|VL|PRECO|PRC/.test(h) && !/TRIB/.test(h)],
  ['QTD',      h => /^QTD|^QTDE|^QUANT|^QTE\b/.test(h) && !/LINHA|TRIB/.test(h)],
  ['VALOR',    h => /^(VALOR|VL\.?|VLR\.?)\s*(TOTAL|DO PRODUTO|PRODUTO|DO ITEM|ITEM|MERC|CONTABIL|DA OPERACAO|OPERACAO|LIQ)|^TOTAL$|^VALOR$|^VPROD$/.test(h) && !/APROX|TRIB/.test(h)],
  ['COD',      h => /^COD|^CODIGO|^CPROD$|^REF\b|^REFERENCIA|^SKU|^ID\b/.test(h) && !/BENEF|CLIENTE|PARTIC|FORNEC|EMIT|DEST|ENQUADR|MUNIC|IBGE|VEND|CFOP|NCM|CEST|CCLASS/.test(h)],
  ['DESC',     h => /DESCRI|PRODUTO|MERCADORIA|^NOME|^ITEM$|^XPROD$/.test(h) && !/CFOP|OPERACAO|NATUREZA|UNIDADE|CLIENTE|EMIT|DEST/.test(h)],
];
const COL_PREF = {
  DESC: h => /^(DESCRICAO|DESCR\.?|DESCRICAO DO (PRODUTO|ITEM)|DESCRICAO DA MERCADORIA|DESC\.? PRODUTO|XPROD|NOME DO PRODUTO)$/.test(h) ? 3 : /DESCRI/.test(h) ? 2 : /^ITEM$/.test(h) ? -2 : 0,
  COD:  h => /PROD|ITEM|MERC|SKU|^COD(IGO)?\.?$/.test(h) ? 2 : 0,
  ICMS: h => /^(ICMS|VALOR (DO )?ICMS|VL\.? ?(DO )?ICMS|VLR\.? ?ICMS)$/.test(h) ? 3 : 0,
  ALIQ: h => /ICMS/.test(h) ? 2 : 0,
  BASE: h => /ICMS/.test(h) ? 2 : 0,
  CST:  h => /ICMS|^CST$|^CSOSN$/.test(h) ? 2 : 0,
};
const temLetras = v => /[A-Za-zÀ-ú]{3}/.test(String(v == null ? '' : v));
function textoRatio(sample, ci) {
  const vals = sample.map(r => (r || [])[ci]).filter(v => v != null && String(v).trim() !== '');
  return vals.length ? vals.filter(temLetras).length / vals.length : 0;
}

// header: linha de cabeçalho. sample (opcional): linhas de dados, usadas para
// conferir pelo conteúdo (ex.: "Item" com 1, 2, 3 não é descrição).
function mapColumns(header, sample) {
  sample = sample || [];
  const cand = {};
  header.forEach((cell, ci) => {
    const h = normTxt(cell);
    if (!h) return;
    for (const [role, test] of COL_RULES) if (test(h)) { (cand[role] = cand[role] || []).push({ ci, h }); return; }
  });
  const idx = {}, descNumerica = [];
  for (const [role, list] of Object.entries(cand)) {
    let best = null, bestScore = -Infinity;
    for (const c of list) {
      let score = COL_PREF[role] ? COL_PREF[role](c.h) : 0;
      if (role === 'DESC' && sample.length) {
        const t = textoRatio(sample, c.ci);
        if (t < 0.5) { score = -100; if (/PROD|MERC/.test(c.h)) descNumerica.push(c.ci); } else score += t * 2;
      }
      if (score > bestScore) { best = c; bestScore = score; }
    }
    if (best && bestScore > -100) idx[role] = best.ci;
  }
  // "PRODUTO" com números é o código do produto
  if (idx.COD == null && descNumerica.length) idx.COD = descNumerica[0];
  // Sem coluna de descrição pelo título: usa a coluna de texto mais variada que não seja de outro tipo
  if (idx.DESC == null && sample.length) {
    const usadas = new Set(Object.values(idx));
    let best = -1, bestN = 4;
    header.forEach((cell, ci) => {
      const h = normTxt(cell);
      if (usadas.has(ci) || /EMIT|DEST|CLIENTE|FORNEC|RAZAO|FANTASIA|MUNIC|CIDADE|\bUF\b|NATUREZA|UNID|TIPO|OBS|CHAVE|SERIE|DATA|STATUS|SITUAC|INF|MOTIVO|CONTRIB|VENDEDOR|OPERADOR/.test(h)) return;
      if (textoRatio(sample, ci) < 0.8) return;
      const n = new Set(sample.map(r => normTxt((r || [])[ci])).filter(Boolean)).size;
      if (n > bestN) { bestN = n; best = ci; }
    });
    if (best >= 0) idx.DESC = best;
  }
  return idx;
}
// Atalho: colunas a partir da linha de cabeçalho h, conferindo até 300 linhas de dados
const columnsOf = (rows, h) => mapColumns(rows[h] || [], rows.slice(h + 1, h + 301));

// Inferência pelo conteúdo quando não há cabeçalho reconhecível
function inferHeader(rows) {
  const sample = rows.slice(0, Math.min(30, rows.length));
  const nCols = Math.max(0, ...sample.map(r => r.length));
  const scores = [];
  for (let ci = 0; ci < nCols; ci++) {
    const vals = sample.map(r => r[ci]).filter(v => v != null && v !== '');
    const s = { NCM: 0, BASE: 0, CST: 0, ALIQ: 0, CFOP: 0, DESC: 0 };
    for (const v of vals) {
      const t = String(v).trim(); const n = parseFloat(t);
      if (/^\d{7,8}$/.test(t)) s.NCM++;
      if (!isNaN(n) && n > 1 && n < 9999999 && /[.,]/.test(t)) s.BASE++;
      if (/^(0|00|20|40|41|60|10|30|70|90)$/.test(t)) s.CST++;
      if (/^(0|4|7|12|17|18|19|20|21|22[.,]5|27|5[.,]6)$/.test(t)) s.ALIQ++;
      if (/^[1-7]\d{3}$/.test(t)) s.CFOP++;
      if (isNaN(n) && t.length > 5) s.DESC++;
    }
    scores.push(s);
  }
  const used = new Set(); const synth = new Array(nCols).fill('');
  const names = { NCM: 'NCM', CFOP: 'CFOP', CST: 'CST', DESC: 'DESCRIÇÃO', BASE: 'BASE DE CÁLCULO', ALIQ: 'ALIQ' };
  for (const role of ['NCM', 'CFOP', 'CST', 'DESC', 'BASE', 'ALIQ']) {
    let best = -1, bs = 2;
    scores.forEach((s, ci) => { if (!used.has(ci) && s[role] > bs) { bs = s[role]; best = ci; } });
    if (best >= 0) { used.add(best); synth[best] = names[role]; }
  }
  if (synth[0] === '') synth[0] = 'CÓDIGO DO ITEM';
  return synth;
}

function findHeader(rows) {
  for (let ri = 0; ri < Math.min(15, rows.length); ri++) {
    const r = rows[ri] || [];
    if (r.some(c => /\bNCM\b/.test(normTxt(c)) && !/DESCRI/.test(normTxt(c)))) return ri;
  }
  return -1;
}

// ── Avaliação de uma linha (Simples Nacional / CSOSN) ───────────────
// No Simples o ICMS próprio vai no DAS: não há alíquota a conferir, só o
// enquadramento (ST, isento, tributado) que define a segregação de receitas.
function avaliarSimples(rule, decl) {
  const gR = cstGroup(rule.cst);
  const cs = String(decl.cst == null ? '' : decl.cst).replace(/\D/g, '');
  const gD = csosnGroup(cs);
  const erros = [], revisar = [];
  if (!gD) revisar.push(`CSOSN ${cs || '(vazio)'} não reconhecido`);
  else if (gR === 'ST' && gD !== 'ST') erros.push(`CSOSN ${cs} informado; produto ST — esperado CSOSN 500 (receita de ST não entra no ICMS do DAS)`);
  else if (gR !== 'ST' && gD === 'ST') erros.push(`CSOSN ${cs} (ST) informado; produto não é ST — esperado CSOSN 102/103 (${descTrat(rule)})`);
  else if (gR === 'ISENTO' && gD === 'SN') revisar.push(`CSOSN ${cs} tributado; produto isento — conferir CSOSN 300/400 e segregação no DAS`);
  const cfop = String(decl.cfop || '').replace(/\D/g, '');
  if (cfop === '5405' && gR !== 'ST') revisar.push('CFOP 5405 (ST) — sugerido 5102');
  if (cfop === '5102' && gR === 'ST') revisar.push('CFOP 5102 — produto ST, sugerido 5405');
  const vi = decl.valorItem != null ? decl.valorItem : valorDoItem(decl);
  return { base: 0, aliq: '', icms: 0, dif: null, baseFaltando: true, simples: true, baseFonte: '', erros, revisar, icmsDecl: 0, valorItem: vi.valor };
}

// ── Avaliação de uma linha ──────────────────────────────────────────
// Saída interestadual do PI: 12% (4% para importados — Res. SF 13/2012).
// A regra do banco é interna; aqui só a alíquota interestadual é conferida.
function avaliarForaDoEstado(rule, decl, cfop, vi) {
  const ruleCst = cst2(rule.cst), declCst = cst2(decl.cst);
  const gR = cstGroup(ruleCst), gD = cstGroup(declCst);
  const icmsDecl = decl.icms != null ? decl.icms : r2(decl.base * decl.aliq / 100);
  const out = { base: 0, aliq: '', icms: 0, dif: null, baseFaltando: true, baseFonte: '', erros: [], revisar: [], icmsDecl, valorItem: vi.valor };
  if (/^6/.test(cfop)) {
    if (gR === 'TRIB' && gD === 'TRIB' && ruleCst !== '20') {
      const aliqInter = Math.abs(decl.aliq - 4) < 0.01 ? 4 : 12;
      out.base = r2(vi.valor > 0 ? vi.valor : decl.base);
      out.baseFaltando = !(out.base > 0);
      out.aliq = aliqInter;
      out.icms = r2(out.base * aliqInter / 100);
      if (!out.baseFaltando) out.dif = r2(out.icms - icmsDecl);
      if (vi.valor > 0 && Math.abs(vi.valor - decl.base) > 0.01) out.baseFonte = vi.fonte;
      if (Math.abs(decl.aliq - aliqInter) > 0.01) out.erros.push(`alíquota ${decl.aliq}% informada; saída interestadual do PI: 12% (4% p/ importados)`);
    }
    out.revisar.push(`CFOP ${cfop} interestadual — regra interna não aplicada` +
      (gR && gD && gR !== gD ? `; CST ${declCst} informado, regra interna prevê CST ${ruleCst} (${GROUP_LABEL[gR]})` : '') +
      `; conferir CST, benefício${gR === 'ST' ? ', ST por convênio/protocolo' : ''} e DIFAL`);
  } else if (/^7/.test(cfop)) out.revisar.push(`CFOP ${cfop} exportação — não incidência (CST 41); regra interna não aplicada`);
  else out.revisar.push(`CFOP ${cfop} é de entrada — o classificador confere saídas`);
  return out;
}

function avaliarLinha(rule, decl) {
  const ruleCst = cst2(rule.cst);
  const declCst = cst2(decl.cst);
  const gR = cstGroup(ruleCst), gD = cstGroup(declCst);
  const isRed = ruleCst === '20';
  const aliqEf = rule.aliq;
  const aliqNom = rule.aliq_nominal || (isRed ? 12 : aliqEf);
  const cfop = String(decl.cfop || '').replace(/\D/g, '');
  // Valor do item (líquido de desconto + despesas acessórias) é a base de partida;
  // a base declarada só é usada quando a planilha não traz valor.
  const vi = decl.valorItem != null ? decl.valorItem : valorDoItem(decl);
  if (/^[12367]/.test(cfop)) return avaliarForaDoEstado(rule, decl, cfop, vi);
  const valorLiq = vi.valor;

  // Base e ICMS corretos
  let base = 0, baseFonte = '', baseFaltando = false;
  if (aliqEf > 0) {
    if (isRed) {
      if (valorLiq > 0) { base = valorLiq * aliqEf / aliqNom; baseFonte = vi.fonte + ' × redução'; }
      else if (declCst === '20') { base = decl.base; baseFonte = 'base declarada (já reduzida)'; }
      else { base = decl.base * aliqEf / aliqNom; baseFonte = 'base declarada × redução'; }
    } else {
      if (valorLiq > 0) { base = valorLiq; if (Math.abs(valorLiq - decl.base) > 0.01) baseFonte = vi.fonte; }
      else if (decl.base > 0) { base = decl.base; baseFonte = 'base declarada (planilha sem valor do item)'; }
    }
    if (!(base > 0)) baseFaltando = true;
  }
  base = r2(base);
  const aliqOut = isRed ? aliqNom : aliqEf;
  const icms = r2(base * aliqOut / 100);
  const icmsDecl = decl.icms != null ? decl.icms : r2(decl.base * decl.aliq / 100);
  const dif = baseFaltando ? null : r2(icms - icmsDecl);

  // Divergências
  const erros = [], revisar = [];
  if (gR && gD && gR !== gD) {
    if (gR === 'TRIB' || gD === 'TRIB') erros.push(`CST ${declCst} (${GROUP_LABEL[gD]}) informado; esperado CST ${ruleCst} (${GROUP_LABEL[gR]})`);
    else revisar.push(`CST ${declCst} informado; esperado CST ${ruleCst} (${GROUP_LABEL[gR]}) — sem diferença de ICMS próprio`);
  } else if (!gD) {
    revisar.push('CST não informado');
  }
  if (gR === 'TRIB' && gD === 'TRIB') {
    if (isRed) {
      if (Math.abs(decl.aliq - aliqNom) > 0.01) erros.push(`alíquota ${decl.aliq}% informada; esperado ${aliqNom}% com base reduzida (carga ${aliqEf}%)`);
      if (declCst !== '20') erros.push(`CST ${declCst} sem redução; regra prevê CST 20 (carga efetiva ${aliqEf}%)`);
      else if (valorLiq > 0 && Math.abs(decl.base - base) > 0.10) erros.push(`base ${decl.base.toFixed(2)} informada; base reduzida esperada ${base.toFixed(2)}`);
    } else {
      if (Math.abs(decl.aliq - aliqEf) > 0.01) erros.push(`alíquota ${decl.aliq}% informada; esperado ${aliqEf}%`);
      if (declCst === '20') erros.push('CST 20 (redução de base) sem previsão no banco — conferir benefício');
      else if (valorLiq > 0 && Math.abs(decl.base - base) > 0.10) erros.push(`base ${decl.base.toFixed(2)} informada; esperada ${base.toFixed(2)} (${vi.fonte})`);
    }
  }
  // CFOP x tratamento (operações internas de venda)
  if (cfop === '5405' && gR !== 'ST') revisar.push('CFOP 5405 (ST) — sugerido 5102');
  if (cfop === '5102' && gR === 'ST') revisar.push('CFOP 5102 — produto ST, sugerido 5405');

  return { base, aliq: aliqOut, icms, dif, baseFaltando, baseFonte, erros, revisar, icmsDecl, valorItem: valorLiq };
}

// ── Classificação completa ──────────────────────────────────────────
// rowsIn: matriz (sheet_to_json header:1). ncmInfo: Map ncm -> {found, expired, desc}
// opts.isConfirmed(cod, desc, ncm, gtin): true quando o usuário já confirmou o NCM
// daquele produto na revisão (suprime o aviso de NCM suspeito).
function classifyRows(rowsIn, ncmInfo, db, opts) {
  db = db || NCM_DB;
  ncmInfo = ncmInfo || new Map();
  opts = opts || {};
  let rows = rowsIn.map(r => (r || []).slice());

  const hIdx = findHeader(rows);
  if (hIdx < 0) rows.unshift(inferHeader(rows));
  else if (hIdx > 0) rows = rows.slice(hIdx);
  const header = rows[0].map(h => h == null ? '' : h);
  const C = mapColumns(header, rows.slice(1, 301));
  if (C.NCM == null) throw new Error('Coluna NCM não encontrada. Verifique se a planilha contém NCMs de 7-8 dígitos.');

  const temGtin = C.GTIN != null && !!opts.gtinInfo;   // opts.gtinInfo = null → consulta GTIN desligada
  const outCols = [
    ['NCM_DESC', 'DESCRIÇÃO NCM (TABELA OFICIAL)'],
    ...(temGtin ? [['NCM_GTIN', 'NCM DO GTIN'], ['NCM_FONTE', 'FONTE DO NCM']] : []),
    ['NCM_SUG', 'NCM SUGERIDO'],
    ['VITEM_C', 'VALOR DO ITEM (CALC.)'], ['BASE_C', 'BASE CORRETA'], ['ALIQ_C', 'ALIQ CORRETA'], ['ICMS_C', 'ICMS CORRETO'],
    ['DIF', 'DIFERENÇA ICMS'], ['OBS', 'OBSERVAÇÃO'], ['STATUS', 'STATUS'], ['NITENS', 'Nº LINHAS'],
  ];
  for (const [role, name] of outCols) if (C[role] == null) { C[role] = header.length; header.push(name); }
  rows[0] = header;

  const g = (row, role) => C[role] == null ? undefined : row[C[role]];
  const dataRows = rows.slice(1).filter(row => { const v = g(row, 'NCM'); return v != null && String(v).replace(/\D/g, '') !== ''; });

  // Alíquota exportada como fração (0,225 em vez de 22,5)
  const aliqVals = C.ALIQ == null ? [] : dataRows.map(row => num(g(row, 'ALIQ'))).filter(v => v > 0);
  const aliqFator = aliqVals.length && aliqVals.every(v => v <= 1) ? 100 : 1;
  // CSOSN (Simples Nacional): pelo cabeçalho ou pelos valores da coluna
  // Cabeçalho só "CSOSN" decide; "CST/CSOSN" (comum em exportações) decide pelos valores.
  let isCsosn = false;
  if (C.CST != null) {
    const hc = normTxt(header[C.CST]);
    if (/CSOSN/.test(hc) && !/\bCST\b/.test(hc)) isCsosn = true;
    else {
      const vals = dataRows.map(row => String(g(row, 'CST') == null ? '' : g(row, 'CST')).replace(/\D/g, '')).filter(Boolean);
      isCsosn = vals.length > 0 && vals.filter(v => CSOSN_SET.has(v)).length / vals.length >= 0.8;
    }
  }

  const stats = { total: 0, classified: 0, stIsento: 0, divergentes: 0, revisar: 0, ncmInvalido: 0, atencao: 0,
                  ncmSuspeito: 0, ncmSuspeitoImpacto: 0, ncmCorrigido: 0, difTotal: 0, aliqFator, isCsosn,
                  temGtin, gtinConfirmado: 0, gtinCorrigido: 0, gtinSemBase: 0, gtinInvalido: 0, gtinNaoAplicado: 0, gtinReferencia: 0, semGtin: 0 };
  const newNCMs = {};
  const gtinReport = new Map();   // gtin → resumo para a aba "Validação GTIN"

  for (const row of dataRows) {
    stats.total++;
    const ncm = pad8(g(row, 'NCM'));
    const desc = C.DESC != null ? String(g(row, 'DESC') || '') : '';
    const cod = C.COD != null ? g(row, 'COD') : '';
    const info = ncmInfo.get(ncm);
    row[C.NCM_DESC] = info ? (info.found ? info.desc : (info.error ? '' : 'NCM NÃO EXISTE NA TABELA OFICIAL')) : '';
    row[C.NCM_SUG] = '';
    row[C.NITENS] = 1;

    const ncmProblema = info && !info.error && (!info.found || info.expired)
      ? (!info.found ? 'NCM inexistente na tabela NCM oficial' : `NCM extinto em ${info.fim}`) : '';

    // NCM corrigido antes da classificação (coluna NCM INFORMADO): pelo GTIN ou na revisão por produto
    const orig = C.NCM_ORIG != null ? g(row, 'NCM_ORIG') : null;
    const corrigido = orig != null && String(orig).replace(/\D/g, '') !== '' && pad8(orig) !== ncm;
    const ncmInformado = corrigido ? pad8(orig) : ncm;

    // ── GTIN: fonte prioritária do NCM ──
    let gtinTxt = '', gtinStatus = '', gtinOk = false, descGtin = '';
    if (temGtin) {
      const gd = gtinDecision(g(row, 'GTIN'), desc, opts.gtinInfo, opts.gtinShared);
      descGtin = gd.descGtin || '';
      if (typeof row[C.GTIN] === 'number') row[C.GTIN] = String(row[C.GTIN]);   // evita 7,89E+12 no Excel
      row[C.NCM_GTIN] = gd.ncm ? fmtNcm(gd.ncm) : '';
      const confl = gd.conflito ? ` (base tem também ${gd.conflito.map(fmtNcm).join(', ')})` : '';
      if (gd.situacao === 'ok' && gd.ncm === ncm) {
        gtinOk = true;
        if (ncmInformado === ncm) {
          stats.gtinConfirmado++;
          row[C.NCM_FONTE] = `GTIN — confirma o informado (${gd.fonte})`;
          gtinTxt = `NCM confirmado pelo GTIN ${fmtGtin(gd.gtin)} (${gd.fonte})${confl}`;
        } else {
          stats.gtinCorrigido++;
          row[C.NCM_FONTE] = `GTIN — corrigido (${gd.fonte})`;
          gtinTxt = `NCM corrigido pelo GTIN ${fmtGtin(gd.gtin)} (${gd.fonte}): informado ${fmtNcm(ncmInformado)} → usado ${fmtNcm(ncm)}${confl}`;
          gtinStatus = `🔵 NCM CORRIGIDO PELO GTIN — informado ${fmtNcm(ncmInformado)}, GTIN indica ${fmtNcm(ncm)}`;
        }
      } else if (gd.situacao === 'ok') {
        // GTIN indica outro NCM, mas o usuário fixou um NCM na revisão por produto
        row[C.NCM_FONTE] = 'Revisão manual (prevalece sobre o GTIN)';
        gtinTxt = `GTIN ${fmtGtin(gd.gtin)} indica ${fmtNcm(gd.ncm)} (${gd.fonte}); mantido ${fmtNcm(ncm)} pela revisão manual`;
      } else {
        const sit = gd.situacao;
        if (sit === 'sem-gtin') stats.semGtin++;
        else if (sit === 'invalido') stats.gtinInvalido++;
        else if (sit === 'referencia') stats.gtinReferencia++;
        else if (sit === 'compartilhado' || sit === 'desc-diverge') stats.gtinNaoAplicado++;
        else if (sit !== 'interno') stats.gtinSemBase++;
        const FONTE_SIT = { 'sem-gtin': ' (sem GTIN)', interno: ' (GTIN interno)', invalido: ' (GTIN inválido)',
                            compartilhado: ' (GTIN não aplicado)', 'desc-diverge': ' (GTIN não aplicado)', referencia: ' (PreçoMelhor só como referência)' };
        row[C.NCM_FONTE] = corrigido ? 'Revisão manual' : 'NCM informado' + (FONTE_SIT[sit] || ' (GTIN sem cadastro na base)');
        if (sit === 'referencia') { if (gd.ncm !== ncmInformado) gtinTxt = `PreçoMelhor indica ${fmtNcm(gd.ncm)} para o GTIN ${fmtGtin(gd.gtin)} (cadastro não oficial — não aplicado; confira)`; }
        else if (sit === 'compartilhado' || sit === 'desc-diverge')
          gtinTxt = `GTIN ${fmtGtin(gd.gtin)} indica ${fmtNcm(gd.ncm)}, não aplicado: ${gd.motivo}`;
        else if (sit !== 'sem-gtin' && sit !== 'interno') gtinTxt = `GTIN ${fmtGtin(gd.gtin)}: ${gd.motivo} — usado o NCM informado`;
      }
      if (gd.gtin) {
        if (!gtinReport.has(gd.gtin)) gtinReport.set(gd.gtin, { gtin: gd.gtin, desc, ncmInf: new Set(), ncmGtin: gd.ncm || '', descGtin: gd.descGtin || '',
                                                                fonte: gd.fonte || '', situacao: gd.situacao, motivo: gd.motivo || '', linhas: 0, conflito: gd.conflito });
        const rep = gtinReport.get(gd.gtin);
        rep.ncmInf.add(ncmInformado); rep.linhas++;
      }
    }
    if (corrigido && !gtinOk) stats.ncmCorrigido++;

    // Planilha sem descrição: as regras por descrição usam a descrição do GTIN
    const descRegra = desc || descGtin;
    const rule = getRuleFor(ncm, descRegra, db);

    // NCM suspeito pela descrição (a regra por descrição com "atenção" já avisa;
    // NCM validado pelo GTIN não é tratado como suspeito)
    const confirmado = gtinOk || (opts.isConfirmed ? opts.isConfirmed(cod, desc, ncm, C.GTIN != null ? g(row, 'GTIN') : '') : false);
    const jaAvisado = rule && rule.atencao && /^descricao:/.test(rule.fonte || '');
    const coh = confirmado || jaAvisado ? null : checkNcmCoherence(ncm, descRegra);
    let cohTxt = '', imp = null;
    if (coh) {
      imp = impactoNcm(ncm, coh.sugerido, descRegra, coh, db);
      row[C.NCM_SUG] = coh.sugerido ? fmtNcm(coh.sugerido) : coh.esperado.map(fmtPrefixo).join(' / ');
      cohTxt = 'NCM SUSPEITO: ' + coh.msg + (coh.sugerido ? ` — sugerido ${fmtNcm(coh.sugerido)}` : '');
      if (imp.novo) cohTxt += imp.muda ? ` — tratamento MUDA: hoje ${imp.atual}, com ${imp.alvo} seria ${imp.novo}`
                                       : imp.muda === false ? ` — sem impacto no ICMS (${imp.atual})` : ` — com ${imp.alvo}: ${imp.novo}`;
      stats.ncmSuspeito++;
      if (imp.muda) stats.ncmSuspeitoImpacto++;
    }
    const corrTxt = corrigido && !gtinOk ? `NCM corrigido na revisão: informado ${fmtNcm(orig)} → usado ${fmtNcm(ncm)}` : '';

    const decl = {
      cst: g(row, 'CST'), cfop: g(row, 'CFOP'),
      base: num(g(row, 'BASE')), aliq: num(g(row, 'ALIQ')) * aliqFator,
      icms: C.ICMS != null && g(row, 'ICMS') !== '' && g(row, 'ICMS') != null ? num(g(row, 'ICMS')) : null,
      valor: num(g(row, 'VALOR')), desconto: num(g(row, 'DESC_V')),
      qtd: num(g(row, 'QTD')), vunit: num(g(row, 'VUNIT')),
      frete: num(g(row, 'FRETE')), seguro: num(g(row, 'SEGURO')), outras: num(g(row, 'OUTRAS')),
    };
    decl.valorItem = valorDoItem(decl);
    row[C.VITEM_C] = decl.valorItem.valor > 0 ? decl.valorItem.valor : '';

    if (!rule) {
      row[C.BASE_C] = ''; row[C.ALIQ_C] = ''; row[C.ICMS_C] = ''; row[C.DIF] = '';
      row[C.OBS] = ['⚠️ NCM não encontrado no banco', ncmProblema, gtinTxt, corrTxt, cohTxt].filter(Boolean).join(' | ');
      row[C.STATUS] = (ncmProblema ? '❌ NCM INVÁLIDO — ' + ncmProblema : '❓ NCM não encontrado' + (coh ? ' | 🟡 NCM suspeito' : '')) +
                      (gtinStatus ? ' | ' + gtinStatus : '');
      if (ncmProblema) stats.ncmInvalido++;
      if (!newNCMs[ncm]) newNCMs[ncm] = { desc, count: 0, info, invalido: !!ncmProblema, suspeito: coh };
      newNCMs[ncm].count++;
      continue;
    }
    stats.classified++;
    const a = isCsosn ? avaliarSimples(rule, decl) : avaliarLinha(rule, decl);
    if (rule.aliq === 0) stats.stIsento++;

    row[C.BASE_C] = a.baseFaltando ? '' : a.base;
    row[C.ALIQ_C] = a.aliq;
    row[C.ICMS_C] = a.baseFaltando ? '' : a.icms;
    // Diferença negativa indica ICMS recolhido a maior; não informar esse valor
    // na planilha de diferenças (o campo destaca apenas recolhimento a menor).
    row[C.DIF] = a.dif == null || a.dif <= 0 ? '' : a.dif;
    const obs = [rule.obs || ''];
    if (rule.atencao && !/ATENÇÃO/.test(rule.obs || '')) obs.push('ATENÇÃO: ' + rule.atencao);
    if (a.simples) obs.push('Simples Nacional (CSOSN) — ICMS no DAS; conferido só o enquadramento ST/isento/tributado');
    else if (a.baseFaltando && a.aliq !== '') obs.push('Base não informada (saída sem tributação) — ICMS correto depende do valor do item');
    if (a.baseFonte) obs.push('Base correta calculada sobre ' + a.baseFonte);
    if (ncmProblema) obs.push(ncmProblema);
    if (gtinTxt) obs.push(gtinTxt);
    if (corrTxt) obs.push(corrTxt);
    if (cohTxt) obs.push(cohTxt);
    row[C.OBS] = obs.filter(Boolean).join(' | ');

    let status;
    if (a.erros.length) {
      stats.divergentes++;
      status = '⚠️ DIVERGENTE — ' + a.erros.join('; ');
      if (a.revisar.length) status += ' | ' + a.revisar.join('; ');
    } else if (a.revisar.length) {
      stats.revisar++;
      status = '🟠 REVISAR — ' + a.revisar.join('; ');
    } else if (ncmProblema) {
      status = '❌ NCM INVÁLIDO — ' + ncmProblema;
    } else if (rule.atencao) {
      stats.atencao++;
      status = '🟡 ATENÇÃO — NCM informado diverge do produto';
    } else if (coh) {
      status = '🟡 NCM SUSPEITO — ' + coh.msg + (imp && imp.muda ? ` (tratamento muda: ${imp.atual} → ${imp.novo})` : '');
    } else {
      status = gtinStatus || '✅ Correto';
    }
    if (gtinStatus && status !== gtinStatus) status += ' | ' + gtinStatus;
    if (coh && !/^🟡 NCM SUSPEITO/.test(status)) status += ' | 🟡 NCM suspeito';
    if (ncmProblema) { stats.ncmInvalido++; if (!/^❌/.test(status)) status += ' | ❌ ' + ncmProblema; }
    row[C.STATUS] = status;
    if (a.dif > 0 && a.erros.length) stats.difTotal = r2(stats.difTotal + a.dif);
  }

  // ── Consolidação ─────────────────────────────────────────────────
  // Agrupa por produto + NCM + CST + alíquota + CFOP + situação, para que linhas
  // com tratamento ou resultado diferente do mesmo produto não se escondam umas nas outras.
  const keyCols = ['COD', 'NCM', 'CST', 'ALIQ', 'CFOP'].filter(k => C[k] != null);
  if (C.COD == null && C.DESC != null) keyCols.unshift('DESC');
  const sumCols = ['BASE', 'ICMS', 'VALOR', 'DESC_V', 'QTD', 'FRETE', 'SEGURO', 'OUTRAS', 'VITEM_C', 'BASE_C', 'ICMS_C', 'DIF', 'NITENS'].filter(k => C[k] != null);
  const cstKey = v => isCsosn ? String(v == null ? '' : v).replace(/\D/g, '') : cst2(v);
  const situacao = row => String(row[C.STATUS] || '').split(/ — | \| /)[0];
  const AGRUPADO = ' | (linhas agrupadas com valores diferentes — ver Nº LINHAS)';
  const map = new Map();
  for (const row of dataRows) {
    const key = keyCols.map(k => k === 'NCM' ? pad8(row[C[k]]) : k === 'CST' ? cstKey(row[C[k]]) : String(row[C[k]] == null ? '' : row[C[k]]).trim())
      .concat(situacao(row)).join('|');
    if (!map.has(key)) { map.set(key, row.slice()); continue; }
    const ex = map.get(key);
    if (ex[C.STATUS] !== row[C.STATUS] && !String(ex[C.STATUS]).endsWith(AGRUPADO)) ex[C.STATUS] += AGRUPADO;
    for (const k of sumCols) {
      const i = C[k];
      if ((ex[i] === '' || ex[i] == null) && (row[i] === '' || row[i] == null)) continue;
      ex[i] = r2(num(ex[i]) + num(row[i]));
    }
  }
  const consolidated = [header, ...map.values()];
  return { rows: consolidated, cols: C, stats, newNCMs, gtinReport: [...gtinReport.values()] };
}

if (typeof module !== 'undefined') module.exports = { classifyRows, columnsOf, gtinParse, gtinDecision, descCompat, valorDoItem, getRuleFor, suggestRule, mapColumns, avaliarLinha, avaliarSimples, checkNcmCoherence, impactoNcm, descTrat, pad8, cst2, fmtNcm, DESC_RULES };
