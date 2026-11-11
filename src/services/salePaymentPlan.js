'use strict';

// Valor efetivamente cobrado do cliente e pagamentos da NFC-e quando parte da
// compra é paga com TenisCash.
//
// Sale.totalAmount = subtotal − desconto (NÃO abate o TenisCash usado). O cliente
// paga em dinheiro/PIX/cartão só a diferença: totalAmount − tcUsed. O QR do PIX
// precisa ser gerado por essa diferença (bug 2026-11: QR saía pelo valor cheio).
//
// Na NFC-e, a SEFAZ exige Σ vPag == vNF (= totalAmount). Duas formas de declarar
// a parte paga com TenisCash, escolhidas pela Config 'fin_cashback_nfce_mode':
//   'single' (padrão, comportamento antigo): 1 pagamento da forma principal pelo total.
//   'tpag19': tPag 19 (programa de fidelidade/cashback) pelo TenisCash + forma
//             principal pela diferença. Exige agente fiscal >= 2.1 (payments[]).
// A escolha é do contador; o padrão não muda a nota até ele validar.

const CASHBACK_NFCE_MODE_KEY = 'fin_cashback_nfce_mode';
const MODES = new Set(['single', 'tpag19']);

function toCents(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  const abs = Math.round(Number((Math.abs(n) * 100).toPrecision(15)));
  return n < 0 ? -abs : abs;
}

// Parte do TenisCash em centavos, limitada a [0, total].
function cashbackCents({ totalAmount, tcUsed }) {
  const total = Math.max(0, toCents(totalAmount));
  return Math.min(Math.max(0, toCents(tcUsed)), total);
}

// Valor que o cliente paga fora do TenisCash, em centavos.
function amountDueCents({ totalAmount, tcUsed }) {
  return Math.max(0, toCents(totalAmount)) - cashbackCents({ totalAmount, tcUsed });
}

function normalizeMode(mode) {
  return MODES.has(mode) ? mode : 'single';
}

// Devolve { payment } (1 forma, formato antigo) ou { payments } (N formas).
// `primary` = forma principal sem valor ({ tPag, acquirerKey, tBand, cAut, tpIntegra }).
function buildNfcePayments({ totalAmount, tcUsed, primary, mode }) {
  const totalC = Math.max(0, toCents(totalAmount));
  const tcC = cashbackCents({ totalAmount, tcUsed });
  const base = { ...(primary || {}) };
  delete base.valor;

  if (normalizeMode(mode) !== 'tpag19' || tcC <= 0) {
    return { payment: { ...base, valor: totalC / 100 }, payments: null, usesCashbackLine: false };
  }

  const restC = totalC - tcC;
  const payments = [{ tPag: '19', valor: tcC / 100 }];
  if (restC > 0) payments.push({ ...base, valor: restC / 100 });

  const sumC = payments.reduce((s, p) => s + toCents(p.valor), 0);
  if (sumC !== totalC) {
    throw new Error('Soma dos pagamentos (' + (sumC / 100).toFixed(2) + ') difere do total (' + (totalC / 100).toFixed(2) + ')');
  }
  return { payment: null, payments, usesCashbackLine: true };
}

async function loadCashbackNfceMode(prisma) {
  try {
    const row = await prisma.config.findUnique({ where: { key: CASHBACK_NFCE_MODE_KEY } });
    if (!row || row.value == null) return 'single';
    let v = String(row.value).trim();
    try { const parsed = JSON.parse(v); if (typeof parsed === 'string') v = parsed; else if (parsed && parsed.mode) v = parsed.mode; } catch (_) { /* valor cru */ }
    return normalizeMode(v);
  } catch (_) {
    return 'single';
  }
}

module.exports = {
  CASHBACK_NFCE_MODE_KEY,
  toCents,
  cashbackCents,
  amountDueCents,
  normalizeMode,
  buildNfcePayments,
  loadCashbackNfceMode,
};
