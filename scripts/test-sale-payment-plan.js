'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const plan = require('../src/services/salePaymentPlan');
const pagbank = require('../src/services/pagbank');

// toCents: arredonda certo valores que o Float erra
assert.strictEqual(plan.toCents(1.005), 101);
assert.strictEqual(plan.toCents(0.1 + 0.2), 30);
assert.strictEqual(plan.toCents(299.99), 29999);
assert.strictEqual(plan.toCents(-12.345), -1235);
assert.strictEqual(plan.toCents('abc'), 0);

// Valor devido = total − TenisCash (o QR do PIX cobra isso)
assert.strictEqual(plan.amountDueCents({ totalAmount: 300, tcUsed: 30 }), 27000);
assert.strictEqual(plan.amountDueCents({ totalAmount: 300, tcUsed: 0 }), 30000);
assert.strictEqual(plan.amountDueCents({ totalAmount: 300, tcUsed: null }), 30000);
assert.strictEqual(plan.amountDueCents({ totalAmount: 199.9, tcUsed: 19.99 }), 17991);
// TenisCash nunca passa do total nem fica negativo
assert.strictEqual(plan.amountDueCents({ totalAmount: 50, tcUsed: 80 }), 0);
assert.strictEqual(plan.amountDueCents({ totalAmount: 50, tcUsed: -10 }), 5000);

const primary = { tPag: '17', acquirerKey: 'PAGSEGURO', tpIntegra: 2 };

// Modo padrão ('single'): nota igual à de antes (1 pagamento pelo total)
let r = plan.buildNfcePayments({ totalAmount: 300, tcUsed: 30, primary, mode: 'single' });
assert.strictEqual(r.payments, null);
assert.deepStrictEqual(r.payment, { tPag: '17', acquirerKey: 'PAGSEGURO', tpIntegra: 2, valor: 300 });

// Modo desconhecido cai no padrão
r = plan.buildNfcePayments({ totalAmount: 300, tcUsed: 30, primary, mode: 'xpto' });
assert.strictEqual(r.payments, null);

// Modo 'tpag19': linha 19 do TenisCash + forma principal pela diferença; soma = total
r = plan.buildNfcePayments({ totalAmount: 300, tcUsed: 30, primary, mode: 'tpag19' });
assert.strictEqual(r.payment, null);
assert.deepStrictEqual(r.payments, [
  { tPag: '19', valor: 30 },
  { tPag: '17', acquirerKey: 'PAGSEGURO', tpIntegra: 2, valor: 270 },
]);
const sum = r.payments.reduce((s, p) => s + plan.toCents(p.valor), 0);
assert.strictEqual(sum, 30000);

// Centavos quebrados somam exato
r = plan.buildNfcePayments({ totalAmount: 199.9, tcUsed: 19.99, primary: { tPag: '03' }, mode: 'tpag19' });
assert.deepStrictEqual(r.payments.map((p) => p.valor), [19.99, 179.91]);

// Sem TenisCash: mesmo no modo tpag19, 1 pagamento só (não exige agente 2.1)
r = plan.buildNfcePayments({ totalAmount: 120, tcUsed: 0, primary, mode: 'tpag19' });
assert.strictEqual(r.payments, null);
assert.strictEqual(r.payment.valor, 120);

// `valor` vindo no primary é ignorado (o valor sai do cálculo)
r = plan.buildNfcePayments({ totalAmount: 100, tcUsed: 0, primary: { tPag: '01', valor: 999 }, mode: 'single' });
assert.strictEqual(r.payment.valor, 100);

// Config: lê string crua, JSON string e objeto { mode }; erro/ausente = 'single'
(async () => {
  const fake = (value) => ({ config: { findUnique: async () => (value === undefined ? null : { value }) } });
  assert.strictEqual(await plan.loadCashbackNfceMode(fake(undefined)), 'single');
  assert.strictEqual(await plan.loadCashbackNfceMode(fake('tpag19')), 'tpag19');
  assert.strictEqual(await plan.loadCashbackNfceMode(fake('"tpag19"')), 'tpag19');
  assert.strictEqual(await plan.loadCashbackNfceMode(fake('{"mode":"tpag19"}')), 'tpag19');
  assert.strictEqual(await plan.loadCashbackNfceMode(fake('qualquer')), 'single');
  assert.strictEqual(await plan.loadCashbackNfceMode({ config: { findUnique: async () => { throw new Error('db'); } } }), 'single');

  // PagBank: valor pago lido da cobrança paga
  const order = { charges: [{ id: 'CHAR_1', status: 'PAID', amount: { value: 27000, summary: { total: 27000, paid: 27000, refunded: 0 } }, payment_method: { pix: { end_to_end_id: 'E123' } } }] };
  const pay = pagbank.readPixPayment(order);
  assert.strictEqual(pay.paid, true);
  assert.strictEqual(pay.paidCents, 27000);
  assert.strictEqual(pay.e2e, 'E123');
  const waiting = pagbank.readPixPayment({ charges: [] });
  assert.strictEqual(waiting.paid, false);
  assert.strictEqual(waiting.paidCents, null);

  // Guarda de regressão: o QR não pode voltar a ser gerado pelo total cheio
  const seller = fs.readFileSync(path.join(__dirname, '..', 'src', 'routes', 'seller.js'), 'utf8');
  assert.ok(!/amountCents:\s*Math\.round\(totalAmount\s*\*\s*100\)/.test(seller), 'QR PIX voltou a usar o total cheio');
  assert.ok(seller.includes('salePaymentPlan.amountDueCents({ totalAmount, tcUsed: tcConsumed })'), 'QR PIX sem abater o TenisCash');
  const fiscal = fs.readFileSync(path.join(__dirname, '..', 'src', 'routes', 'fiscal.js'), 'utf8');
  assert.ok(!/valor:\s*sale\.totalAmount,/.test(fiscal), 'NFC-e da venda voltou a ignorar o TenisCash');

  console.log('test-sale-payment-plan: ok');
})().catch((e) => { console.error(e); process.exit(1); });
