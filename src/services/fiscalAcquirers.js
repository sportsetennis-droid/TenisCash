// =====================================================================
// Adquirentes (operadoras de cartão) — usado em NFCe modelo 65
// =====================================================================
// Decreto SEFAZ-PB 43.077/2022 + Convênio ICMS 166/2022 exigem que
// pagamentos eletrônicos preencham:
//   tpIntegra (1=integrado / 2=não integrado)
//   CNPJ (da adquirente)
//   tBand (bandeira)
//   cAut (código autorização vindo do recibo da maquininha)
// =====================================================================

// Mapa: nome curto → { cnpj, label }
// CNPJs raízes oficiais publicados pelo SEFAZ (cBand do XSD)
const ACQUIRERS = {
  STONE:     { cnpj: '16501555000157', label: 'Stone Pagamentos S.A.' },
  CIELO:     { cnpj: '01027058000191', label: 'Cielo S.A.' },
  REDE:      { cnpj: '01425787000104', label: 'Rede (Banco Itaú)' },
  GETNET:    { cnpj: '10440482000154', label: 'GetNet Adquirência (Santander)' },
  PAGSEGURO: { cnpj: '08561701000101', label: 'PagBank / PagSeguro' },
  MERCADO_PAGO: { cnpj: '10573521000191', label: 'Mercado Pago' },
  SAFRAPAY:  { cnpj: '60814191000139', label: 'Safrapay' },
  BIN:       { cnpj: '15581725000130', label: 'BIN / Banco Inter' },
  SIPAG:     { cnpj: '11769082000186', label: 'Sipag (Banese)' },
  TICKET:    { cnpj: '47866934000174', label: 'Ticket Soluções' },
  VR:        { cnpj: '02753718000186', label: 'VR Benefícios' },
  ALELO:     { cnpj: '04740876000125', label: 'Alelo' },
};

// Mapa de bandeiras (cBand do XSD NFCe)
const BRANDS = {
  '01': 'Visa',
  '02': 'Mastercard',
  '03': 'American Express',
  '04': 'Sorocred',
  '05': 'Diners Club',
  '06': 'Elo',
  '07': 'Hipercard',
  '08': 'Aura',
  '09': 'Cabal',
  '10': 'Alelo',
  '11': 'Banes Card',
  '12': 'CalCard',
  '13': 'Credz',
  '14': 'Discover',
  '15': 'GoodCard',
  '16': 'GreenCard',
  '17': 'Hiper',
  '18': 'JCB',
  '19': 'Mais',
  '20': 'MaxVan',
  '21': 'Policard',
  '22': 'RedeCompras',
  '23': 'Sodexo',
  '24': 'ValeCard',
  '25': 'Verocheque',
  '26': 'VR',
  '27': 'Ticket',
  '99': 'Outros',
};

// Mapa de formas de pagamento (cPag/tPag do XSD)
const PAY_METHODS = {
  '01': 'Dinheiro',
  '02': 'Cheque',
  '03': 'Cartão de Crédito',
  '04': 'Cartão de Débito',
  '05': 'Crédito Loja',
  '10': 'Vale Alimentação',
  '11': 'Vale Refeição',
  '12': 'Vale Presente',
  '13': 'Vale Combustível',
  '14': 'Duplicata Mercantil',
  '15': 'Boleto Bancário',
  '16': 'Depósito Bancário',
  '17': 'PIX',
  '18': 'Transferência bancária, Carteira Digital',
  '19': 'Programa de fidelidade, Cashback, Crédito Virtual',
  '90': 'Sem pagamento',
  '99': 'Outros',
};

/**
 * Monta o objeto detPag completo pra NFCe com pagamento em cartão.
 * @param {Object} opts
 * @param {number} opts.valor — valor pago
 * @param {string} opts.tPag — '03'=Crédito, '04'=Débito, '17'=PIX, etc
 * @param {string} [opts.acquirerKey] — chave do ACQUIRERS (STONE, CIELO, ...)
 * @param {string} [opts.tBand] — código da bandeira ('01'=Visa, etc)
 * @param {string} [opts.cAut] — código autorização do recibo
 * @param {number} [opts.tpIntegra] — 1=integrado / 2=não integrado (default 2)
 */
function buildDetPag({ valor, tPag, acquirerKey, tBand, cAut, tpIntegra = 2, xPag }) {
  const _tPag = String(tPag).padStart(2, '0');
  const det = {
    tPag: _tPag,
    // tPag 90 = SEM PAGAMENTO (ex.: transferência entre estabelecimentos do mesmo
    // titular). A SEFAZ rejeita (904 "Informado indevidamente campo valor de
    // pagamento") se vier valor — tem que ir 0.00.
    vPag: _tPag === '90' ? '0.00' : Number(valor).toFixed(2),
  };
  // Cartão (crédito/débito) → adiciona dados do cartão
  if (['03', '04'].includes(det.tPag)) {
    const acq = ACQUIRERS[acquirerKey];
    det.card = {
      tpIntegra: tpIntegra,
      CNPJ: acq?.cnpj || '00000000000000',
      tBand: tBand || '99',
      cAut: cAut || '000000',
    };
  }
  // NT 2020.006: tPag=99 exige xPag. Sem ele a SEFAZ rejeita com cStat 441.
  if (det.tPag === '99') det.xPag = String(xPag || 'Outros').trim().slice(0, 60) || 'Outros';
  // PIX (tPag=17) — opcionalmente pode incluir CNPJ da credenciadora
  return det;
}

module.exports = { ACQUIRERS, BRANDS, PAY_METHODS, buildDetPag };
