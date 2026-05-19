// =====================================================================
// Fiscal API — cliente HTTP da Brasil NFe (NFe, NFCe, CTe, MDFe)
// =====================================================================
// Docs: https://www.brasilnfe.com.br/docs/
// Cada CNPJ tem seu próprio apiToken e environment (homologation|production)
// armazenados em FiscalIssuer. Esse client recebe o issuer e monta os calls.
// =====================================================================

const BASE_URLS = {
  homologation: 'https://hom.brasilnfe.com.br/v2', // homologação SEFAZ
  production: 'https://api.brasilnfe.com.br/v2',   // produção
};

function getBaseUrl(env) {
  return BASE_URLS[env === 'production' ? 'production' : 'homologation'];
}

async function callApi(issuer, method, path, body = null) {
  if (!issuer || !issuer.apiToken) {
    throw new Error('Issuer sem apiToken — configure o token Brasil NFe pra esse CNPJ');
  }
  const url = getBaseUrl(issuer.environment) + path;
  const headers = {
    'Authorization': 'Bearer ' + issuer.apiToken,
    'Accept': 'application/json',
  };
  if (body && method !== 'GET') headers['Content-Type'] = 'application/json';

  const opts = { method, headers };
  if (body && method !== 'GET') opts.body = JSON.stringify(body);

  const r = await fetch(url, opts);
  const ct = r.headers.get('content-type') || '';

  // Resposta binária (PDF DANFE)
  if (ct.includes('application/pdf')) {
    const buf = Buffer.from(await r.arrayBuffer());
    return { ok: r.ok, status: r.status, pdf: buf };
  }
  // Resposta JSON
  let data = null;
  try { data = await r.json(); } catch { /* sem corpo */ }
  return { ok: r.ok, status: r.status, data };
}

// ============================================================
// NFCe — Nota Fiscal de Consumidor Eletrônica (venda presencial)
// ============================================================
// payload: { items, customer?, payment, total, ... }
async function emitNFCe(issuer, payload) {
  return callApi(issuer, 'POST', '/nfce', payload);
}

async function getNFCe(issuer, externalId) {
  return callApi(issuer, 'GET', '/nfce/' + externalId);
}

async function cancelNFCe(issuer, externalId, reason) {
  return callApi(issuer, 'POST', '/nfce/' + externalId + '/cancel', { motivo: reason });
}

async function getNFCePdf(issuer, externalId) {
  return callApi(issuer, 'GET', '/nfce/' + externalId + '/danfe');
}

// ============================================================
// NFe modelo 55 — venda online, B2B, transferência
// ============================================================
async function emitNFe(issuer, payload) {
  return callApi(issuer, 'POST', '/nfe', payload);
}

async function getNFe(issuer, externalId) {
  return callApi(issuer, 'GET', '/nfe/' + externalId);
}

async function cancelNFe(issuer, externalId, reason) {
  return callApi(issuer, 'POST', '/nfe/' + externalId + '/cancel', { motivo: reason });
}

async function getNFePdf(issuer, externalId) {
  return callApi(issuer, 'GET', '/nfe/' + externalId + '/danfe');
}

// Carta de correção (até 30 dias após autorização, máx 20 sequências)
async function correctionLetter(issuer, externalId, sequence, reason) {
  return callApi(issuer, 'POST', '/nfe/' + externalId + '/cce', { sequencia: sequence, correcao: reason });
}

// ============================================================
// CTe — Conhecimento de Transporte Eletrônico (transferência entre filiais)
// ============================================================
async function emitCTe(issuer, payload) {
  return callApi(issuer, 'POST', '/cte', payload);
}

async function getCTe(issuer, externalId) {
  return callApi(issuer, 'GET', '/cte/' + externalId);
}

async function cancelCTe(issuer, externalId, reason) {
  return callApi(issuer, 'POST', '/cte/' + externalId + '/cancel', { motivo: reason });
}

// ============================================================
// Builders — montam o payload no formato Brasil NFe
// ============================================================

// Helper: monta item da nota a partir de Sale.SaleItem + Product
function buildItemFromProduct(product, qty, unitPrice, opts = {}) {
  const totalValue = +(qty * unitPrice).toFixed(2);
  return {
    codigo: product.sku || product.id,
    descricao: product.name,
    ean: (product.sku && /^\d{12,14}$/.test(product.sku)) ? product.sku : 'SEM GTIN',
    ncm: product.ncm || '64041100', // calçados esportivos default — TODO mapear NCM real
    cfop: opts.cfop || '5102', // venda dentro do estado
    unidade: 'UN',
    quantidade: qty,
    valor_unitario: unitPrice,
    valor_total: totalValue,
    // Impostos (preencher por regime CRT do issuer):
    icms: opts.icms || { origem: 0, situacao_tributaria: '102' }, // SN sem permissão de crédito
    pis: opts.pis || { situacao_tributaria: '49' }, // SN
    cofins: opts.cofins || { situacao_tributaria: '49' },
  };
}

// Builder de payload NFCe (venda presencial → consumidor final)
function buildNFCePayload(issuer, sale, items, payment) {
  return {
    natureza_operacao: 'VENDA',
    serie: issuer.nfceSerie,
    numero: issuer.nfceNextNumber,
    data_emissao: new Date().toISOString(),
    presencial: 1, // 1=Operação presencial (NFCe)
    finalidade: 1, // 1=NFe normal
    consumidor_final: 1,
    // Emitente vem do token
    // Destinatário (opcional pra NFCe quando consumidor final sem CPF)
    destinatario: sale.customerCpf ? {
      cpf: sale.customerCpf,
      nome: sale.customerName || 'CONSUMIDOR FINAL',
    } : null,
    items,
    pagamento: [{
      forma: payment.method || '01', // 01=Dinheiro, 03=Cartão crédito, 04=Cartão débito, 17=PIX, 99=Outros
      valor: payment.amount,
    }],
  };
}

// Builder de payload NFe modelo 55 (venda online ou B2B)
function buildNFePayload(issuer, sale, items, recipient) {
  return {
    natureza_operacao: sale.natureza || 'VENDA',
    serie: issuer.nfeSerie,
    numero: issuer.nfeNextNumber,
    data_emissao: new Date().toISOString(),
    finalidade: 1,
    consumidor_final: recipient.cnpj ? 0 : 1,
    presencial: 0, // operação não presencial (online)
    destinatario: {
      ...(recipient.cnpj ? { cnpj: recipient.cnpj } : { cpf: recipient.cpf }),
      nome: recipient.name,
      email: recipient.email,
      endereco: recipient.address,
      ie: recipient.ie || null,
    },
    items,
    pagamento: sale.payments || [{ forma: '99', valor: sale.total }],
  };
}

module.exports = {
  // NFCe
  emitNFCe, getNFCe, cancelNFCe, getNFCePdf,
  // NFe
  emitNFe, getNFe, cancelNFe, getNFePdf, correctionLetter,
  // CTe
  emitCTe, getCTe, cancelCTe,
  // Builders
  buildItemFromProduct, buildNFCePayload, buildNFePayload,
  // Util
  getBaseUrl,
};
