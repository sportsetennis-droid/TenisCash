// =====================================================================
// Fiscal API — cliente HTTP da Brasil NFe (NFe, NFCe, CTe, MDFe)
// =====================================================================
// Docs: https://www.brasilnfe.com.br/docs/
// Cada CNPJ tem seu próprio apiToken e environment (homologation|production)
// armazenados em FiscalIssuer. Esse client recebe o issuer e monta os calls.
// =====================================================================

// Brasil NFe usa URL única + flag TipoAmbiente no payload:
//   1 = produção, 2 = homologação
// Auth: header "Token: <token>"
const BASE_URL = 'https://api.brasilnfe.com.br';

function tipoAmbiente(env) {
  return env === 'production' ? 1 : 2;
}

async function callApi(issuer, method, path, body = null) {
  if (!issuer || !issuer.apiToken) {
    throw new Error('Issuer sem apiToken — configure o token Brasil NFe pra esse CNPJ');
  }
  const url = BASE_URL + path;
  const headers = {
    'Token': issuer.apiToken,
    'Accept': 'application/json',
  };
  if (body && method !== 'GET') headers['Content-Type'] = 'application/json';

  const opts = { method, headers };
  if (body && method !== 'GET') opts.body = JSON.stringify(body);

  const r = await fetch(url, opts);
  const ct = r.headers.get('content-type') || '';

  if (ct.includes('application/pdf')) {
    const buf = Buffer.from(await r.arrayBuffer());
    return { ok: r.ok, status: r.status, pdf: buf };
  }
  let data = null;
  try { data = await r.json(); } catch { /* sem corpo */ }
  return { ok: r.ok, status: r.status, data };
}

// Endpoints reais Brasil NFe (PascalCase, mesmo path pra NFe/NFCe — diferencia
// pelo campo ModeloDocumento: 55=NFe, 65=NFCe).
async function enviarNotaFiscal(issuer, payload) {
  return callApi(issuer, 'POST', '/services/Fiscal/EnviarNotaFiscal', payload);
}

async function consultarNotaFiscal(issuer, accessKey) {
  return callApi(issuer, 'GET', '/services/Fiscal/ConsultarNotaFiscal/' + accessKey);
}

async function cancelarNotaFiscal(issuer, accessKey, motivo) {
  return callApi(issuer, 'POST', '/services/Fiscal/CancelarNotaFiscal', {
    TipoAmbiente: tipoAmbiente(issuer.environment),
    CnpjEmitente: issuer.cnpj,
    ChaveAcesso: accessKey,
    Motivo: motivo,
  });
}

async function downloadDanfe(issuer, accessKey) {
  return callApi(issuer, 'GET', '/services/Fiscal/DownloadDanfe/' + accessKey);
}

async function cartaCorrecao(issuer, accessKey, sequencia, correcao) {
  return callApi(issuer, 'POST', '/services/Fiscal/CartaCorrecao', {
    TipoAmbiente: tipoAmbiente(issuer.environment),
    CnpjEmitente: issuer.cnpj,
    ChaveAcesso: accessKey,
    Sequencia: sequencia,
    Correcao: correcao,
  });
}

// Aliases retrocompatíveis com fiscal.js
const emitNFe = enviarNotaFiscal;
const emitNFCe = enviarNotaFiscal;
const emitCTe = enviarNotaFiscal; // CTe usa endpoint próprio (TODO ajustar)
const getNFe = (i, k) => consultarNotaFiscal(i, k);
const getNFCe = (i, k) => consultarNotaFiscal(i, k);
const getCTe = (i, k) => consultarNotaFiscal(i, k);
const cancelNFe = (i, k, m) => cancelarNotaFiscal(i, k, m);
const cancelNFCe = (i, k, m) => cancelarNotaFiscal(i, k, m);
const cancelCTe = (i, k, m) => cancelarNotaFiscal(i, k, m);
const getNFePdf = (i, k) => downloadDanfe(i, k);
const getNFCePdf = (i, k) => downloadDanfe(i, k);
const correctionLetter = cartaCorrecao;

// ============================================================
// Builders — montam o payload no formato Brasil NFe
// ============================================================

// Builder: item da nota fiscal no formato Brasil NFe (PascalCase)
function buildItemFromProduct(product, qty, unitPrice, opts = {}) {
  const totalValue = +(qty * unitPrice).toFixed(2);
  return {
    NmProduto: (product.name || '').slice(0, 120),
    CodigoProduto: product.sku || product.id,
    Ean: (product.sku && /^\d{12,14}$/.test(product.sku)) ? product.sku : 'SEM GTIN',
    NCM: product.ncm || '64041100',  // calçados esportivos default
    CFOP: opts.cfop || '5102',       // venda dentro do estado
    Unidade: 'UN',
    Quantidade: qty,
    ValorUnitario: unitPrice,
    ValorTotal: totalValue,
    OrigemMercadoria: 0,             // 0=Nacional
    SituacaoTributariaIcms: opts.cstIcms || '102', // 102=SN sem crédito
    SituacaoTributariaPis: opts.cstPis || '49',
    SituacaoTributariaCofins: opts.cstCofins || '49',
  };
}

// Builder NFCe (modelo 65) - venda presencial consumidor final
function buildNFCePayload(issuer, sale, items, payment) {
  return {
    TipoAmbiente: tipoAmbiente(issuer.environment),
    CnpjEmitente: issuer.cnpj,
    ModeloDocumento: 65,
    Serie: issuer.nfceSerie,
    NumeroNotaFiscal: issuer.nfceNextNumber,
    NaturezaOperacao: 'VENDA AO CONSUMIDOR',
    TipoOperacao: 1,         // 1=Saída
    FinalidadeNotaFiscal: 1, // 1=Normal
    Presencial: 1,
    ConsumidorFinal: 1,
    DataEmissao: new Date().toISOString(),
    Cliente: sale.customerCpf ? {
      CpfCnpj: sale.customerCpf,
      NmCliente: sale.customerName || 'CONSUMIDOR FINAL',
    } : null,
    Produtos: items,
    Pagamentos: [{
      FormaPagamento: payment.method || '01',
      ValorPagamento: payment.amount,
    }],
  };
}

// Builder NFe modelo 55 (online, B2B, transferência)
function buildNFePayload(issuer, sale, items, recipient) {
  return {
    TipoAmbiente: tipoAmbiente(issuer.environment),
    CnpjEmitente: issuer.cnpj,
    ModeloDocumento: 55,
    Serie: issuer.nfeSerie,
    NumeroNotaFiscal: issuer.nfeNextNumber,
    NaturezaOperacao: sale.natureza || 'VENDA',
    TipoOperacao: 1,
    FinalidadeNotaFiscal: 1,
    Presencial: 0,
    ConsumidorFinal: recipient.cnpj ? 0 : 1,
    DataEmissao: new Date().toISOString(),
    Cliente: {
      CpfCnpj: recipient.cnpj || recipient.cpf,
      NmCliente: recipient.name,
      Email: recipient.email,
      InscricaoEstadual: recipient.ie || null,
      Endereco: recipient.address || null,
    },
    Produtos: items,
    Pagamentos: sale.payments || [{ FormaPagamento: '99', ValorPagamento: sale.total }],
  };
}

module.exports = {
  // Endpoints reais Brasil NFe
  enviarNotaFiscal, consultarNotaFiscal, cancelarNotaFiscal, downloadDanfe, cartaCorrecao,
  // Aliases
  emitNFCe, getNFCe, cancelNFCe, getNFCePdf,
  emitNFe, getNFe, cancelNFe, getNFePdf, correctionLetter,
  emitCTe, getCTe, cancelCTe,
  // Builders
  buildItemFromProduct, buildNFCePayload, buildNFePayload,
  // Util
  tipoAmbiente, BASE_URL,
};
