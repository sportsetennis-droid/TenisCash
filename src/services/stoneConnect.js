'use strict';

// =====================================================================
// Stone Connect 2.0 — maquininha integrada (API Pagar.me, pedido direto)
// =====================================================================
// Docs: connect-stone.stone.com.br (Criar pedido para maquininha, Recebendo um
// Pagamento, Fechamento de um pedido, Webhook).
//   POST  https://api.pagar.me/core/v5/orders              → cria pedido aberto pra POS
//   GET   https://api.pagar.me/core/v5/orders/{id}         → consulta (charges pagas)
//   PATCH https://api.pagar.me/core/v5/orders/{id}/closed  → fecha (paid|canceled|failed)
// Autenticação: Basic Auth com a Secret Key (usuário = SK, senha vazia) + header
// ServiceRefererName (ID do parceiro). Não existe sandbox: teste é em produção.
// Estorno de pagamento aprovado NÃO tem API — é feito na maquininha ou no portal Stone.
// =====================================================================

const crypto = require('node:crypto');

const BASE_URL = 'https://api.pagar.me';
const PAYMENT_TYPES = ['credit', 'debit', 'pix'];

// Bandeira (metadata.scheme_name da Stone) → tBand da NFC-e (fiscalAcquirers.BRANDS).
const SCHEME_TO_TBAND = {
  visa: '01', mastercard: '02', americanexpress: '03', sorocred: '04', dinersclub: '05',
  elo: '06', hipercard: '07', cabal: '09', alelo: '10', banescard: '11', discover: '14',
  greencard: '16', jcb: '18', sodexo: '23', valecard: '24', vr: '26', ticket: '27',
};

function newWebhookToken() { return crypto.randomBytes(24).toString('hex'); }

function parseSerials(text) {
  return String(text || '').split(/[,;\s]+/).map((s) => s.trim()).filter(Boolean);
}

function isConfigured(cfg) {
  return !!(cfg && cfg.enabled && cfg.secretKey && parseSerials(cfg.deviceSerials).length);
}

function serviceRefererName(cfg) {
  return (cfg && cfg.serviceRefererName) || process.env.STONE_SERVICE_REFERER_NAME || '';
}

// Forma de pagamento da venda (seller.js) → tipo do pedido direto.
function paymentTypeFor(paymentMethod) {
  return { credit_card: 'credit', debit_card: 'debit', pix: 'pix' }[paymentMethod] || null;
}

function cleanText(s, max) {
  return String(s == null ? '' : s).replace(/\s+/g, ' ').trim().slice(0, max);
}

// Corpo do pedido direto. O valor cobrado na maquininha é SEMPRE o total do pedido,
// então os itens precisam somar exatamente amountCents (total − TenisCash).
function buildOrderBody({ amountCents, saleId, type, installments, deviceSerial, customerName, customerEmail }) {
  const cents = Number(amountCents);
  if (!Number.isInteger(cents) || cents < 1) throw new Error('Valor inválido pra maquininha: ' + amountCents);
  if (!PAYMENT_TYPES.includes(type)) throw new Error('Tipo de pagamento inválido pra maquininha: ' + type);
  if (!deviceSerial) throw new Error('Loja sem número de série da maquininha');
  const parcelas = type === 'credit' ? Math.max(1, Math.min(18, Number.parseInt(installments, 10) || 1)) : 1;
  const ref = String(saleId).slice(-6).toUpperCase();
  const paymentSetup = { type };
  if (type === 'credit') { paymentSetup.installments = parcelas; paymentSetup.installment_type = 'merchant'; }
  return {
    customer: {
      name: cleanText(customerName, 64) || 'Consumidor',
      email: cleanText(customerEmail, 64) || 'consumidor@sportsetennis.com.br',
    },
    items: [{ amount: cents, description: 'Venda Sports & Tennis ' + ref, quantity: 1, code: String(saleId).slice(0, 52) }],
    closed: false,
    poi_payment_settings: {
      visible: true,
      print_order_receipt: false,
      devices_serial_number: [String(deviceSerial)],
      payment_setup: paymentSetup,
      display_name: 'Venda ' + ref,
    },
  };
}

function pick(obj, ...keys) {
  for (const k of keys) if (obj && obj[k] != null && obj[k] !== '') return obj[k];
  return null;
}

// Lê o pagamento de um pedido consultado (GET /orders/{id}) ou de uma charge de webhook.
function readPayment(orderOrCharge) {
  const src = orderOrCharge || {};
  const charges = Array.isArray(src.charges) ? src.charges : (src.status && src.amount != null && !src.items ? [src] : []);
  const paid = charges.filter((c) => String(c.status).toLowerCase() === 'paid');
  const refunded = charges.some((c) => ['canceled', 'refunded'].includes(String(c.status).toLowerCase()));
  const main = paid[paid.length - 1] || null;
  const meta = (main && (main.metadata || {})) || {};
  const tx = (main && main.last_transaction) || {};
  const paidCents = paid.length
    ? paid.reduce((s, c) => s + Math.round(Number(pick(c, 'paid_amount', 'amount')) || 0), 0)
    : null;
  const brand = pick(meta, 'scheme_name', 'schemeName');
  const funding = pick(meta, 'account_funding_source', 'accountFundingSource');
  const inst = pick(meta, 'installment_quantity', 'installmentQuantity');
  return {
    paid: paid.length > 0,
    refunded: !paid.length && refunded,
    paidCents,
    chargeId: main ? main.id : null,
    nsu: main ? (main.code || null) : null,
    authCode: pick(meta, 'authorization_code', 'authorizationCode'),
    brand,
    fundingSource: funding,
    installments: inst != null && Number.isFinite(Number(inst)) ? Number(inst) : null,
    terminalSerial: pick(meta, 'terminal_serial_number', 'terminalSerialNumber'),
    transactionType: tx.transaction_type || (main ? main.payment_method : null) || null,
    paidAt: main ? (main.paid_at || null) : null,
  };
}

function tBandFor(brand) {
  const key = String(brand || '').toLowerCase().replace(/[^a-z]/g, '');
  return SCHEME_TO_TBAND[key] || '99';
}

// Dados de pagamento da NFC-e a partir do que a maquininha devolveu.
// Maquininha integrada ao sistema = tpIntegra 1 (pagamento integrado).
function nfcePaymentFor(pay, requestedType) {
  const tx = String(pay.transactionType || '').toLowerCase();
  const funding = String(pay.fundingSource || '').toLowerCase();
  if (requestedType === 'pix' || tx === 'pix') {
    return { paymentMethod: '17', acquirerKey: 'STONE', cardAuthCode: pay.authCode || pay.nsu || undefined, tpIntegra: 1 };
  }
  let tPag;
  if (funding === 'credit') tPag = '03';
  else if (funding === 'debit') tPag = '04';
  else tPag = requestedType === 'credit' ? '03' : '04'; // pré-pago/sem informação: segue o tipo enviado
  return { paymentMethod: tPag, acquirerKey: 'STONE', cardBrand: tBandFor(pay.brand), cardAuthCode: pay.authCode || undefined, tpIntegra: 1 };
}

async function stoneFetch(cfg, pathname, { method = 'GET', body, fetchImpl = globalThis.fetch } = {}) {
  if (!cfg || !cfg.secretKey) throw new Error('Loja sem Secret Key da Stone');
  const headers = {
    Authorization: 'Basic ' + Buffer.from(cfg.secretKey + ':').toString('base64'),
    Accept: 'application/json',
  };
  const ref = serviceRefererName(cfg);
  if (ref) headers.ServiceRefererName = ref;
  if (body) headers['Content-Type'] = 'application/json';
  const res = await fetchImpl(BASE_URL + pathname, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  let json = null; try { json = text ? JSON.parse(text) : null; } catch (_) { /* resposta não-JSON */ }
  if (!res.ok) {
    const msg = json ? JSON.stringify(json).slice(0, 400) : String(text).slice(0, 400);
    const err = new Error('Stone ' + res.status + ': ' + msg);
    err.status = res.status; err.body = json;
    throw err;
  }
  return json;
}

async function createPosOrder(cfg, opts, fetchImpl) {
  const body = buildOrderBody(opts);
  const order = await stoneFetch(cfg, '/core/v5/orders', { method: 'POST', body, fetchImpl });
  if (!order || !order.id) throw new Error('Stone não devolveu o id do pedido');
  return { orderId: order.id, body, raw: order };
}

function getOrder(cfg, orderId, fetchImpl) {
  return stoneFetch(cfg, '/core/v5/orders/' + encodeURIComponent(orderId), { fetchImpl });
}

function closeOrder(cfg, orderId, status = 'paid', fetchImpl) {
  return stoneFetch(cfg, '/core/v5/orders/' + encodeURIComponent(orderId) + '/closed', { method: 'PATCH', body: { status }, fetchImpl });
}

module.exports = {
  BASE_URL, PAYMENT_TYPES, SCHEME_TO_TBAND,
  newWebhookToken, parseSerials, isConfigured, serviceRefererName, paymentTypeFor,
  buildOrderBody, readPayment, tBandFor, nfcePaymentFor,
  stoneFetch, createPosOrder, getOrder, closeOrder,
};
