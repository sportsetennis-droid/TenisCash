const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'loja.html'), 'utf8');
function extract(signature) {
  const start = html.indexOf(signature);
  const end = html.indexOf('\n}', start);
  assert.ok(start >= 0 && end > start, 'Frontend function must exist: ' + signature);
  return html.slice(start, end + 2);
}
const source = [
  extract('function updateSummary()'), extract('async function finalizeSale()'),
  extract('function addToCartById(productId)'), extract('function addToCart(productId, name, brand, price, imageUrl, opts)'),
].join('\n');
const removedIds = ['sellDiscount', 'discModeRs', 'discModePct', 'discHelper'];
for (const id of removedIds) assert.doesNotMatch(html, new RegExp('id=["\']' + id + '["\']'));
assert.doesNotMatch(source, /getDiscountRS|sellDiscount|discHelper/);
assert.doesNotMatch(html, /function (?:setDiscMode|limparDesc|getDiscountRS)\s*\(|let _discMode\b/);
assert.equal(/\.promoPrice\b/.test(html), false, 'Storefront must display and sell products using the normal price');

function fixture({ balance = 100, hasCustomer = true, payment = 'cash', response } = {}) {
  const elements = {};
  for (const id of [
    'sellTcUsed', 'sellTcMax', 'sellCpfReq', 'sellCustomerCpf', 'cartCount', 'sellSummary',
    'sellVendor', 'sellPayment', 'sellCardAcquirer', 'sellCardAuthCode', 'sellCardBrand',
    'sellFinalize', 'sellCustomerNome', 'sellReferralCode', 'sellNfceResult', 'sellNfceStatus',
    'sellCustomerPhone', 'sellCustomerInfo', 'sellCustomerResults', 'sellSearchInput', 'sellSearchResults', 'sellBipeMsg',
  ]) {
    elements[id] = {
      value: '', innerHTML: '', textContent: '', disabled: false, style: {}, focused: false,
      focus() { this.focused = true; },
      insertAdjacentHTML(position, markup) {
        assert.equal(position, 'afterbegin');
        this.innerHTML = markup + this.innerHTML;
      },
    };
  }
  elements.sellTcUsed.value = '0';
  elements.sellVendor.value = 'seller-test';
  elements.sellPayment.value = payment;
  elements.sellCustomerNome.value = 'Cliente teste';
  elements.sellCustomerPhone.value = '83900000000';
  const requests = [];
  const alerts = [];
  const confirmations = [];
  const calls = { cart: 0, dashboard: 0, qr: [] };
  const crypto = { randomUUID: () => 'test-idempotency-key' };
  const context = vm.createContext({
    cart: [
      { productId: 'promo', productSizeId: 'size-m', unitPrice: 79.90, originalPrice: 149.90, quantity: 2, size: 'M', sellerSize: 'M', barcode: '123' },
      { productId: 'regular', unitPrice: 20.10, quantity: 2, size: 'P', sellerSize: 'P' },
    ],
    customer: hasCustomer ? { name: 'Cliente teste', phone: '83900000000', balance } : null,
    activeStore: { id: 'store-test' }, _saleIdemKey: null,
    _sellSearchAll: [], _pendingBarcode: null,
    _isSizePending: () => false,
    _chooseSaleSize: () => ({ id: 'size-m', size: 'M', sellerSize: 'M' }),
    _askSizeForBipe: () => ({ id: 'size-m', size: 'M', sellerSize: 'M' }),
    crypto, window: { crypto },
    document: {
      getElementById(id) {
        assert.ok(!removedIds.includes(id), 'Removed discount control must never be accessed: ' + id);
        assert.ok(elements[id], 'Unexpected element: ' + id);
        return elements[id];
      },
    },
    fmt: value => 'R$ ' + Number(value).toFixed(2),
    alert: message => alerts.push(message),
    confirm(message) { confirmations.push(message); return true; },
    async api(url, options) {
      assert.equal(url, '/api/seller/sale');
      assert.equal(options.method, 'POST');
      requests.push(JSON.parse(options.body));
      return response || { totalAmount: 180, tcEarned: 180, fiscal: { skipped: true, reason: 'Teste' }, relationshipCommissionCreated: true };
    },
    showNfceBlock() {},
    showPixQr(saleId, fiscal) { calls.qr.push({ saleId, fiscal }); },
    renderCart() { calls.cart++; },
    loadDashboard() { calls.dashboard++; },
  });
  vm.runInContext(source, context, { filename: 'loja-sale-no-discount.js' });
  return { context, elements, requests, alerts, confirmations, calls };
}

function assertSummaryValue(f, label, value) {
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const expression = new RegExp('<span class="label">' + escaped + '</span><span class="value"[^>]*>[^<]*R\\$ ' + value.replace('.', '\\.'));
  assert.match(f.elements.sellSummary.innerHTML, expression);
}

(async () => {
  const standard = fixture();
  standard.context.updateSummary();
  assert.equal(standard.elements.cartCount.textContent, '(4 itens)');
  assertSummaryValue(standard, 'Subtotal', '200.00');
  assertSummaryValue(standard, 'Total a pagar', '200.00');
  assertSummaryValue(standard, '🎁 Cashback que cliente ganha', '200.00');
  assert.doesNotMatch(standard.elements.sellSummary.innerHTML, /Desconto/);

  const capped = fixture();
  capped.elements.sellTcUsed.value = '50';
  capped.context.updateSummary();
  assert.equal(capped.elements.sellTcUsed.value, '20.00');
  assert.match(capped.elements.sellTcMax.textContent, /Máx R\$ 20.00/);
  assertSummaryValue(capped, 'TenisCash usado', '20.00');
  assertSummaryValue(capped, 'Total a pagar', '180.00');
  assertSummaryValue(capped, '🎁 Cashback que cliente ganha', '180.00');

  const lowBalance = fixture({ balance: 7.5 });
  lowBalance.elements.sellTcUsed.value = '50';
  lowBalance.context.updateSummary();
  assert.equal(lowBalance.elements.sellTcUsed.value, '7.50');
  assertSummaryValue(lowBalance, 'Total a pagar', '192.50');
  assertSummaryValue(lowBalance, '🎁 Cashback que cliente ganha', '192.50');

  const anonymous = fixture({ hasCustomer: false });
  anonymous.context.updateSummary();
  assertSummaryValue(anonymous, 'Total a pagar', '200.00');
  assert.match(anonymous.elements.sellSummary.innerHTML, /Sem cliente — venda não gera cashback/);
  assert.doesNotMatch(anonymous.elements.sellSummary.innerHTML, /Cashback que cliente ganha/);

  for (const pixPending of [false, true]) {
    const f = fixture({
      payment: pixPending ? 'pix' : 'cash',
      response: pixPending ? { saleId: 'sale-test', fiscal: { pixPending: true, qrCode: 'test' } } : undefined,
    });
    f.elements.sellTcUsed.value = '20';
    f.context.updateSummary();
    await f.context.finalizeSale();
    assert.deepEqual(f.alerts, [], 'Finalization must not fail while accessing removed controls');
    assert.equal(f.requests.length, 1);
    const payload = f.requests[0];
    assert.equal(Object.hasOwn(payload, 'discount'), false, 'New sales must not submit a manual discount');
    assert.equal(payload.tcUsed, 20);
    assert.equal(payload.storeId, 'store-test');
    assert.equal(payload.vendorId, 'seller-test');
    assert.equal(payload.customerPhone, '83900000000');
    assert.equal(payload.idemKey, 'test-idempotency-key');
    assert.deepEqual(payload.items.map(item => [item.productId, item.quantity, item.unitPrice]), [
      ['promo', 2, 79.90], ['regular', 2, 20.10],
    ]);
    assert.equal(payload.items[0].sellerSize, 'M');
    assert.equal(payload.items[0].productSizeId, 'size-m');
    assert.equal(f.context.cart.length, 0);
    assert.equal(f.context.customer, null);
    assert.equal(f.context._saleIdemKey, null);
    assert.equal(f.elements.sellTcUsed.value, 0);
    assert.equal(f.elements.sellCustomerPhone.value, '');
    assert.equal(f.elements.sellFinalize.disabled, false);
    assert.equal(f.elements.sellFinalize.textContent, 'Finalizar venda');
    assert.equal(f.calls.cart, 1);
    assert.equal(f.calls.dashboard, 1);
    assert.equal(f.calls.qr.length, pixPending ? 1 : 0);
    if (pixPending) {
      assert.equal(f.calls.qr[0].saleId, 'sale-test');
      assert.equal(payload.acquirerKey, 'PAGSEGURO');
    } else {
      assert.match(f.elements.sellSummary.innerHTML, /Total: R\$ 180.00 \| Cashback: R\$ 180.00/);
    }
  }

  const cpf = fixture();
  cpf.context.cart = [{ productId: 'threshold', unitPrice: 250, quantity: 2 }];
  cpf.elements.sellTcUsed.value = '50';
  await cpf.context.finalizeSale();
  assert.equal(cpf.requests.length, 0, 'The full R$ 500 subtotal requires CPF even when TC is used');
  assert.equal(cpf.confirmations.length, 0);
  assert.match(cpf.alerts[0], /Venda de R\$ 500.00/);
  assert.equal(cpf.elements.sellCustomerCpf.focused, true);
  assert.equal(cpf.context.cart.length, 1, 'A blocked sale must keep the cart');
  cpf.elements.sellCustomerCpf.value = '123.456.789-01';
  await cpf.context.finalizeSale();
  assert.equal(cpf.requests.length, 1, 'Providing CPF allows the same sale to proceed');
  assert.equal(cpf.requests[0].customerCpf, '12345678901');
  assert.equal(Object.hasOwn(cpf.requests[0], 'discount'), false);

  for (const pendingBarcode of [null, '7890000000000']) {
    const f = fixture();
    f.context.cart = [];
    f.context._sellSearchAll = [{ id: 'priced-product', name: 'Produto teste', price: 100, promoPrice: 60 }];
    f.context._pendingBarcode = pendingBarcode;
    f.context.addToCartById('priced-product');
    assert.equal(f.context.cart.length, 1);
    assert.equal(f.context.cart[0].unitPrice, 100, 'Selecting a product must ignore an old promotional price');
    assert.equal(f.context.cart[0].quantity, 1);
    if (pendingBarcode) {
      assert.equal(f.context.cart[0].barcode, pendingBarcode);
      assert.equal(f.context.cart[0].isNewBarcode, true);
      assert.equal(f.context._pendingBarcode, null);
    }
    f.context.updateSummary();
    assertSummaryValue(f, 'Total a pagar', '100.00');
    await f.context.finalizeSale();
    assert.deepEqual(f.alerts, []);
    assert.equal(f.requests.length, 1);
    assert.equal(f.requests[0].items[0].unitPrice, 100, 'Finalization must keep the normal price selected by the cart');
    assert.equal(Object.hasOwn(f.requests[0], 'discount'), false);
  }

  console.log('PASS: normal prices without promotions/manual discounts, TC limits, cashback, normal/PIX cleanup and CPF threshold');
})().catch(error => { console.error(error); process.exitCode = 1; });
