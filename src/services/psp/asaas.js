// =====================================================================
// PSP ADAPTER — Asaas (split, Pix/cartão/boleto, webhook, reembolso)
// ---------------------------------------------------------------------
// Liga o recebimento ON-PLATFORM: a S&T recebe na conta Asaas e faz
// split automático pro produtor (walletId) e afiliado (walletId),
// retendo o take rate. Enquanto ASAAS_API_KEY não estiver setada,
// isEnabled() => false e o checkout cai no Pix off-platform.
//
// Onboarding de recebedor (sub-conta/walletId por profissional) é KYC
// e roda à parte — aqui só consumimos o walletId já existente.
// Docs: https://docs.asaas.com  (v3)
// =====================================================================

const crypto = require('crypto');

const API_KEY = process.env.ASAAS_API_KEY || '';
// sandbox por padrão; produção exige ASAAS_ENV=production
const BASE =
  process.env.ASAAS_BASE_URL ||
  (process.env.ASAAS_ENV === 'production'
    ? 'https://api.asaas.com/v3'
    : 'https://sandbox.asaas.com/api/v3');
const WEBHOOK_TOKEN = process.env.ASAAS_WEBHOOK_TOKEN || '';

function isEnabled() {
  return !!API_KEY;
}

async function request(method, path, body) {
  if (!isEnabled()) throw new Error('asaas_disabled'); // sem API key
  if (typeof fetch !== 'function') throw new Error('fetch_unavailable'); // Node <18
  const res = await fetch(BASE + path, {
    method,
    headers: {
      'Content-Type': 'application/json',
      access_token: API_KEY,
      'User-Agent': 'TenisCash',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data = {};
  try { data = text ? JSON.parse(text) : {}; } catch (_) { data = { raw: text }; }
  if (!res.ok) {
    const msg = (data.errors && data.errors[0] && data.errors[0].description) || res.statusText;
    const err = new Error('asaas_error: ' + msg);
    err.status = res.status;
    err.body = data;
    throw err;
  }
  return data;
}

// Cliente (comprador) — idempotente por externalReference (email/phone).
async function ensureCustomer({ name, email, phone, cpfCnpj, externalReference }) {
  // tenta achar por externalReference
  if (externalReference) {
    const found = await request('GET', '/customers?externalReference=' + encodeURIComponent(externalReference));
    if (found && found.data && found.data.length) return found.data[0];
  }
  return request('POST', '/customers', {
    name: name || 'Cliente',
    email: email || undefined,
    mobilePhone: phone ? String(phone).replace(/\D/g, '') : undefined,
    cpfCnpj: cpfCnpj ? String(cpfCnpj).replace(/\D/g, '') : undefined,
    externalReference: externalReference || undefined,
  });
}

/**
 * Cria a cobrança com split.
 * @param {object} o
 * @param {string} o.customerId        id do cliente Asaas
 * @param {('PIX'|'CREDIT_CARD'|'BOLETO'|'UNDEFINED')} o.billingType
 * @param {number} o.value             valor total
 * @param {string} o.dueDate           YYYY-MM-DD
 * @param {string} o.description
 * @param {string} o.externalReference id da DigitalSale
 * @param {number} [o.installmentCount]
 * @param {Array<{walletId:string,fixedValue?:number,percentualValue?:number}>} [o.split]
 */
async function createPayment(o) {
  const body = {
    customer: o.customerId,
    billingType: o.billingType || 'PIX',
    value: Number(o.value),
    dueDate: o.dueDate,
    description: o.description || undefined,
    externalReference: o.externalReference || undefined,
  };
  if (o.installmentCount && o.installmentCount > 1) {
    body.installmentCount = o.installmentCount;
    body.totalValue = Number(o.value);
    delete body.value;
  }
  if (Array.isArray(o.split) && o.split.length) {
    body.split = o.split
      .filter((s) => s.walletId && (s.fixedValue > 0 || s.percentualValue > 0))
      .map((s) => ({
        walletId: s.walletId,
        fixedValue: s.fixedValue != null ? Number(s.fixedValue) : undefined,
        percentualValue: s.percentualValue != null ? Number(s.percentualValue) : undefined,
      }));
  }
  return request('POST', '/payments', body);
}

// QR Pix dinâmico de uma cobrança (encodedImage base64 + payload copia-e-cola).
async function getPixQr(paymentId) {
  return request('GET', `/payments/${encodeURIComponent(paymentId)}/pixQrCode`);
}

async function getPayment(paymentId) {
  return request('GET', '/payments/' + encodeURIComponent(paymentId));
}

async function refund(paymentId, value) {
  return request('POST', `/payments/${encodeURIComponent(paymentId)}/refund`, value ? { value: Number(value) } : undefined);
}

// Transferência (payout) pra chave Pix de afiliado/produtor sem walletId.
async function transferToPix({ value, pixKey, description }) {
  return request('POST', '/transfers', {
    value: Number(value),
    pixAddressKey: pixKey,
    operationType: 'PIX',
    description: description || undefined,
  });
}

// Valida o webhook pelo header asaas-access-token (configurado no painel Asaas).
function verifyWebhook(req) {
  if (!WEBHOOK_TOKEN) return true; // sem token configurado: não bloqueia (DEV)
  const got = req.headers['asaas-access-token'] || req.headers['Asaas-Access-Token'];
  if (!got) return false;
  try {
    const a = Buffer.from(String(got));
    const b = Buffer.from(WEBHOOK_TOKEN);
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  } catch (_) {
    return false;
  }
}

module.exports = {
  isEnabled,
  ensureCustomer,
  createPayment,
  getPixQr,
  getPayment,
  refund,
  transferToPix,
  verifyWebhook,
  _config: { BASE, hasKey: !!API_KEY, hasWebhookToken: !!WEBHOOK_TOKEN },
};
