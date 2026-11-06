// ════════════════════════════════════════════════════════════════════
// TABELA GTIN → NCM FIXA (opcional)
// Use para distribuir uma base pronta junto com o classificador (todos os
// computadores passam a ter a mesma base, sem importar nada no navegador).
// Formatos aceitos:
//   window.GTIN_TABLE = { '7891910000197': { ncm: '17019900', desc: 'AÇÚCAR REFINADO UNIÃO 1KG', fonte: 'CCG' } };
//   window.GTIN_TABLE = { '7891910000197': '17019900' };
//   window.GTIN_TABLE = [ { gtin: '7891910000197', ncm: '17019900', desc: '...' } ];
// A base importada no navegador (XML/planilha) tem prioridade sobre esta tabela.
// ════════════════════════════════════════════════════════════════════
window.GTIN_TABLE = window.GTIN_TABLE || {};
