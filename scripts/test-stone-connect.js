'use strict';

// Stone Connect 2.0 — funções puras + chamadas HTTP com fetch simulado (sem banco, sem rede).
const assert = require('assert');
const stone = require('../src/services/stoneConnect');

(async () => {
  // ---------- configuração ----------
  assert.deepStrictEqual(stone.parseSerials(' 6C582505, 6N021234 ;X1 '), ['6C582505', '6N021234', 'X1']);
  assert.strictEqual(stone.isConfigured({ enabled: true, secretKey: 'sk_x', deviceSerials: '6C58' }), true);
  assert.strictEqual(stone.isConfigured({ enabled: false, secretKey: 'sk_x', deviceSerials: '6C58' }), false);
  assert.strictEqual(stone.isConfigured({ enabled: true, secretKey: 'sk_x', deviceSerials: '' }), false);
  assert.strictEqual(stone.isConfigured({ enabled: true, deviceSerials: '6C58' }), false);
  assert.strictEqual(stone.paymentTypeFor('credit_card'), 'credit');
  assert.strictEqual(stone.paymentTypeFor('debit_card'), 'debit');
  assert.strictEqual(stone.paymentTypeFor('pix'), 'pix');
  assert.strictEqual(stone.paymentTypeFor('cash'), null);
  assert.strictEqual(stone.newWebhookToken().length, 48);

  // ---------- corpo do pedido direto ----------
  const body = stone.buildOrderBody({ amountCents: 15990, saleId: 'cmsale12345abc', type: 'credit', installments: 3, deviceSerial: '6C582505', customerName: 'Maria' });
  assert.strictEqual(body.closed, false);
  assert.strictEqual(body.items.reduce((s, i) => s + i.amount * i.quantity, 0), 15990, 'itens somam o valor cobrado');
  assert.deepStrictEqual(body.poi_payment_settings.devices_serial_number, ['6C582505']);
  assert.deepStrictEqual(body.poi_payment_settings.payment_setup, { type: 'credit', installments: 3, installment_type: 'merchant' });
  assert.strictEqual(body.poi_payment_settings.print_order_receipt, false);
  assert.strictEqual(body.customer.name, 'Maria');
  const debit = stone.buildOrderBody({ amountCents: 100, saleId: 's', type: 'debit', installments: 5, deviceSerial: 'A' });
  assert.deepStrictEqual(debit.poi_payment_settings.payment_setup, { type: 'debit' }, 'débito não leva parcelas');
  assert.strictEqual(debit.customer.name, 'Consumidor');
  assert.throws(() => stone.buildOrderBody({ amountCents: 0, saleId: 's', type: 'debit', deviceSerial: 'A' }), /Valor inválido/);
  assert.throws(() => stone.buildOrderBody({ amountCents: 10.5, saleId: 's', type: 'debit', deviceSerial: 'A' }), /Valor inválido/);
  assert.throws(() => stone.buildOrderBody({ amountCents: 100, saleId: 's', type: 'boleto', deviceSerial: 'A' }), /Tipo/);
  assert.throws(() => stone.buildOrderBody({ amountCents: 100, saleId: 's', type: 'debit' }), /série/);

  // ---------- leitura do pagamento (formato da documentação Stone) ----------
  const paidOrder = {
    id: 'or_1', status: 'paid', closed: false,
    charges: [{
      id: 'ch_1', code: '11831338033297', amount: 2538, paid_amount: 2538, status: 'paid', payment_method: 'cash', paid_at: '2023-01-18T21:22:21Z',
      last_transaction: { transaction_type: 'cash', status: 'paid' },
      metadata: { scheme_name: 'MasterCard', account_funding_source: 'Credit', authorization_code: '051659', installment_quantity: '3', terminal_serial_number: '6C568971' },
    }],
  };
  let pay = stone.readPayment(paidOrder);
  assert.strictEqual(pay.paid, true);
  assert.strictEqual(pay.paidCents, 2538);
  assert.strictEqual(pay.nsu, '11831338033297');
  assert.strictEqual(pay.authCode, '051659');
  assert.strictEqual(pay.brand, 'MasterCard');
  assert.strictEqual(pay.installments, 3);
  assert.strictEqual(pay.terminalSerial, '6C568971');
  assert.deepStrictEqual(stone.nfcePaymentFor(pay, 'credit'), { paymentMethod: '03', acquirerKey: 'STONE', cardBrand: '02', cardAuthCode: '051659', tpIntegra: 1 });

  pay = stone.readPayment({ charges: [{ id: 'ch', status: 'paid', amount: 100, metadata: { schemeName: 'Elo', accountFundingSource: 'Debit', authorizationCode: 'A1' } }] });
  assert.deepStrictEqual(stone.nfcePaymentFor(pay, 'debit'), { paymentMethod: '04', acquirerKey: 'STONE', cardBrand: '06', cardAuthCode: 'A1', tpIntegra: 1 }, 'aceita camelCase');
  pay = stone.readPayment({ charges: [{ id: 'ch', status: 'paid', amount: 100, metadata: { scheme_name: 'Visa', account_funding_source: 'Prepaid' } }] });
  assert.strictEqual(stone.nfcePaymentFor(pay, 'debit').paymentMethod, '04', 'pré-pago segue o tipo enviado');
  assert.strictEqual(stone.nfcePaymentFor(pay, 'credit').paymentMethod, '03');
  pay = stone.readPayment({ charges: [{ id: 'ch', code: 'E2E1', status: 'paid', amount: 100, last_transaction: { transaction_type: 'pix' }, metadata: {} }] });
  assert.deepStrictEqual(stone.nfcePaymentFor(pay, 'pix'), { paymentMethod: '17', acquirerKey: 'STONE', cardAuthCode: 'E2E1', tpIntegra: 1 });
  assert.strictEqual(stone.tBandFor('AmericanExpress'), '03');
  assert.strictEqual(stone.tBandFor('VerdeCard'), '99', 'bandeira sem código NFC-e vira Outros');

  assert.strictEqual(stone.readPayment({ id: 'or_2', status: 'pending', charges: [] }).paid, false);
  const refunded = stone.readPayment({ charges: [{ id: 'ch', status: 'canceled', amount: 100, metadata: {} }] });
  assert.strictEqual(refunded.paid, false);
  assert.strictEqual(refunded.refunded, true);
  // duas cobranças pagas somam
  assert.strictEqual(stone.readPayment({ charges: [{ status: 'paid', amount: 100 }, { status: 'paid', amount: 50 }, { status: 'failed', amount: 999 }] }).paidCents, 150);

  // ---------- HTTP: Basic Auth (SK + ':'), ServiceRefererName, endpoints ----------
  const calls = [];
  const fakeFetch = async (url, init) => {
    calls.push({ url, init });
    if (init.method === 'POST') return { ok: true, status: 200, text: async () => JSON.stringify({ id: 'or_abc', status: 'pending' }) };
    if (init.method === 'PATCH') return { ok: true, status: 200, text: async () => JSON.stringify({ id: 'or_abc', closed: true }) };
    return { ok: false, status: 401, text: async () => JSON.stringify({ message: 'Authorization has been denied' }) };
  };
  const cfg = { secretKey: 'sk_test123', serviceRefererName: 'partner-1', deviceSerials: '6C58', enabled: true };
  const created = await stone.createPosOrder(cfg, { amountCents: 500, saleId: 's1', type: 'pix', deviceSerial: '6C58' }, fakeFetch);
  assert.strictEqual(created.orderId, 'or_abc');
  assert.strictEqual(calls[0].url, 'https://api.pagar.me/core/v5/orders');
  assert.strictEqual(calls[0].init.headers.Authorization, 'Basic ' + Buffer.from('sk_test123:').toString('base64'));
  assert.strictEqual(calls[0].init.headers.ServiceRefererName, 'partner-1');
  assert.strictEqual(JSON.parse(calls[0].init.body).poi_payment_settings.payment_setup.type, 'pix');
  await stone.closeOrder(cfg, 'or_abc', 'canceled', fakeFetch);
  assert.strictEqual(calls[1].url, 'https://api.pagar.me/core/v5/orders/or_abc/closed');
  assert.strictEqual(calls[1].init.method, 'PATCH');
  assert.deepStrictEqual(JSON.parse(calls[1].init.body), { status: 'canceled' });
  await assert.rejects(stone.getOrder(cfg, 'or_abc', fakeFetch), (e) => e.status === 401 && /Stone 401/.test(e.message));
  await assert.rejects(stone.getOrder({}, 'or_abc', fakeFetch), /Secret Key/);

  console.log('test-stone-connect: ok');
})().catch((e) => { console.error(e); process.exit(1); });
