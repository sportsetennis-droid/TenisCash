'use strict';

// NF-e 4.00: xProd é TString (Latin-1, sem espaços nas extremidades), 1–120.
// Normaliza somente a descrição enviada ao fiscal; não altera o catálogo.
function normalizeFiscalProductName(value) {
  const text = (typeof value === 'string' ? value : '')
    .normalize('NFC')
    .replace(/[\u2010-\u2015\u2212]/g, '-')
    .replace(/[\u2018\u2019\u201A\u201B]/g, "'")
    .replace(/[\u201C\u201D\u201E\u201F]/g, '"')
    .replace(/\u2026/g, '...')
    .replace(/[\u200B-\u200D\uFEFF]/g, '')
    .replace(/\s+/g, ' ')
    .replace(/[^\x20-\x7E\xA0-\xFF]/gu, ' ')
    .replace(/ +/g, ' ')
    .trim()
    .slice(0, 120)
    .trim();
  if (!text) {
    const error = new Error('Descrição do produto vazia ou inválida para a nota fiscal (xProd). Corrija a descrição antes de emitir.');
    error.code = 'FISCAL_PRODUCT_DESCRIPTION_INVALID';
    throw error;
  }
  return text;
}

module.exports = { normalizeFiscalProductName };
