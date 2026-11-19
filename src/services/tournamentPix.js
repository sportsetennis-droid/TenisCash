// =====================================================================
// CLUB F3 — PIX da inscrição de torneio, pelo PSP JÁ USADO NO VAREJO.
// ---------------------------------------------------------------------
// Reaproveita src/services/pagbank.js (o mesmo PIX-QR do PDV das lojas):
//   createPixOrder(store, ...)  → QR + copia-e-cola na conta PagBank da loja
//   getOrder + readPixPayment   → confirmação (SEMPRE re-consulta a API;
//                                 nunca confia no payload do webhook)
// Não cria conta nem credencial: usa o Store.pagbankToken da loja que o
// admin escolheu (TournamentRegistrationConfig.paymentStoreId), senão a
// loja-sede do torneio (Tournament.storeId), senão CLUB_PIX_STORE_ID.
//
// Para teste, setProvider() troca o PSP por um simulado (nada de rede).
// =====================================================================

const pagbank = require('./pagbank');
const { publicBaseUrl } = require('../config/publicUrl');

let override = null; // PSP simulado (testes)
function setProvider(p) { override = p || null; }

const REF_PREFIX = 'treg_';

// Loja (conta PagBank) que recebe o PIX deste torneio.
async function resolveStore(prisma, cfg, tournament) {
  const ids = [cfg && cfg.paymentStoreId, tournament && tournament.storeId, process.env.CLUB_PIX_STORE_ID].filter(Boolean);
  for (const id of ids) {
    const store = await prisma.store.findUnique({ where: { id: String(id) } }).catch(() => null);
    if (store && store.pagbankEnabled && pagbank.isConfigured(store)) return store;
  }
  return null;
}

// PIX disponível? { ok, provider, store, reason }
async function availability(prisma, cfg, tournament) {
  if (override) {
    const ok = override.available ? await override.available(cfg, tournament) : true;
    return { ok: !!ok, provider: 'simulated', store: null, reason: ok ? null : 'PSP simulado desligado' };
  }
  const store = await resolveStore(prisma, cfg, tournament);
  if (!store) return { ok: false, provider: 'pagbank', store: null, reason: 'nenhuma loja com PIX PagBank configurado para este torneio' };
  return { ok: true, provider: 'pagbank', store, reason: null };
}

/**
 * Cria a cobrança PIX. Retorna { providerOrderId, qrText, qrPngUrl, expiresAt }.
 * chargeId vira o reference_id ("treg_<id>") — é por ele que o webhook acha a cobrança.
 */
async function createCharge({ store, chargeId, amountCents, expiresAt, customerName, description }) {
  const cents = Math.round(Number(amountCents));
  if (!Number.isInteger(cents) || cents < 1) throw new Error('valor inválido para PIX');
  const expiresInSec = Math.max(300, Math.round((new Date(expiresAt).getTime() - Date.now()) / 1000));
  if (override) return override.createCharge({ chargeId, amountCents: cents, expiresAt, customerName, description });
  const r = await pagbank.createPixOrder(store, {
    amountCents: cents,
    saleId: REF_PREFIX + chargeId, // reference_id + chave de idempotência do PagBank
    customerName: customerName || null,
    notificationUrl: publicBaseUrl() + '/api/tournament-registration/pagbank/webhook',
    expiresInSec,
    itemName: String(description || 'Inscrição de torneio').slice(0, 60),
  });
  return { providerOrderId: r.orderId, qrText: r.qrText, qrPngUrl: r.qrPngUrl, expiresAt: r.expiration ? new Date(r.expiration) : new Date(expiresAt) };
}

// Consulta o PSP: { paid, paidCents, e2e, status }.
async function fetchStatus({ store, providerOrderId, chargeId }) {
  if (override) return override.fetchStatus({ providerOrderId, chargeId });
  const order = await pagbank.getOrder(store, providerOrderId);
  const pay = pagbank.readPixPayment(order);
  return { paid: !!pay.paid, paidCents: pay.paidCents, e2e: pay.e2e, status: pay.status };
}

function chargeIdFromReference(ref) {
  const s = String(ref || '');
  return s.startsWith(REF_PREFIX) ? s.slice(REF_PREFIX.length) : null;
}

module.exports = { setProvider, resolveStore, availability, createCharge, fetchStatus, chargeIdFromReference, REF_PREFIX };
