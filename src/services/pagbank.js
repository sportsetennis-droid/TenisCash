// =====================================================================
// PagBank (PagSeguro) — PIX via QR Code, POR LOJA
// =====================================================================
// Cada loja = 1 conta PagBank (token no Store.pagbankToken — segredo).
// Cria pedido com QR Code PIX, consulta status e lê o pagamento.
// Docs: developer.pagbank.com.br (Criar pedido com QR Code / Objeto Order).
//   POST  {base}/orders            -> cria pedido (qr_codes[].amount.value em centavos)
//   GET   {base}/orders/{id}       -> consulta (charges[].status = PAID, payment_method.pix.end_to_end_id)
// =====================================================================

const SANDBOX_BASE = 'https://sandbox.api.pagseguro.com';
const PROD_BASE = 'https://api.pagseguro.com';

function baseUrl(store) { return store && store.pagbankSandbox ? SANDBOX_BASE : PROD_BASE; }
function isConfigured(store) { return !!(store && store.pagbankToken); }

// ISO 8601 com offset -03:00 (Fortaleza/PB) a partir de um instante em ms.
function isoMinus3(ms) {
  return new Date(ms - 3 * 3600 * 1000).toISOString().replace(/\.\d{3}Z$/, '-03:00');
}

async function pbFetch(store, pathname, { method = 'GET', body, idemKey } = {}) {
  const headers = { Authorization: 'Bearer ' + store.pagbankToken, Accept: 'application/json' };
  if (body) headers['Content-Type'] = 'application/json';
  if (idemKey) headers['x-idempotency-key'] = String(idemKey);
  const res = await fetch(baseUrl(store) + pathname, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  let json = null; try { json = text ? JSON.parse(text) : null; } catch (_) {}
  if (!res.ok) {
    const msg = json ? JSON.stringify(json).slice(0, 400) : String(text).slice(0, 400);
    const err = new Error('PagBank ' + res.status + ': ' + msg);
    err.status = res.status; err.body = json;
    throw err;
  }
  return json;
}

// Cria pedido PIX com QR Code. amountCents = inteiro em centavos.
// Retorna { orderId, qrId, qrText (copia-e-cola), qrPngUrl, expiration, raw }.
async function createPixOrder(store, opts) {
  if (!isConfigured(store)) throw new Error('Loja sem pagbankToken configurado');
  const { amountCents, saleId, customerName, customerTaxId, notificationUrl, expiresInSec = 1800, itemName = 'Venda Sports & Tennis' } = opts || {};
  const cents = Math.round(Number(amountCents));
  if (!cents || cents < 1) throw new Error('valor inválido pro PIX: ' + amountCents);
  const body = {
    reference_id: String(saleId),
    qr_codes: [{ amount: { value: cents }, expiration_date: isoMinus3(Date.now() + expiresInSec * 1000) }],
  };
  const taxId = (customerTaxId || '').replace(/\D/g, '');
  if (customerName || taxId) body.customer = { name: customerName || 'Consumidor', ...(taxId ? { tax_id: taxId } : {}) };
  if (itemName) body.items = [{ name: itemName, quantity: 1, unit_amount: cents }];
  if (notificationUrl) body.notification_urls = [notificationUrl];
  const order = await pbFetch(store, '/orders', { method: 'POST', body, idemKey: 'sale-' + saleId });
  const qr = (order.qr_codes && order.qr_codes[0]) || {};
  const png = (qr.links || []).find((l) => /QRCODE\.PNG/i.test(l.rel || ''));
  return {
    orderId: order.id,
    qrId: qr.id || null,
    qrText: qr.text || null,
    qrPngUrl: png ? png.href : null,
    expiration: qr.expiration_date || null,
    raw: order,
  };
}

async function getOrder(store, orderId) {
  if (!isConfigured(store)) throw new Error('Loja sem pagbankToken configurado');
  return pbFetch(store, '/orders/' + encodeURIComponent(orderId), { method: 'GET' });
}

// Lê o pagamento PIX de um Order consultado. Retorna { paid, status, e2e, chargeId }.
function readPixPayment(order) {
  const charges = (order && order.charges) || [];
  const paid = charges.find((c) => c.status === 'PAID') || null;
  const ref = paid || charges[0] || null;
  const pix = ref && ref.payment_method ? ref.payment_method.pix : null;
  return {
    paid: !!paid,
    status: ref ? ref.status : 'WAITING',
    e2e: pix && pix.end_to_end_id ? pix.end_to_end_id : null,
    chargeId: ref ? ref.id : null,
  };
}

module.exports = { isConfigured, baseUrl, createPixOrder, getOrder, readPixPayment };
