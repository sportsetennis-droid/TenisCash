const { prisma } = require('../middleware');
const ns = require('./nuvemshop');
const { applyOrderStock } = require('./nuvemshopStockSafety');
const state = { version: 2, lastCheckedAt: null, webhooks: null, orders: [], errors: [] };
let lastWebhookCheck = 0;

async function reconcileOrders(connection) {
  state.errors = [];
  state.orders = [];
  const blockedProducts = new Set();
  // Failure to read orders must stop stock increases, rather than replenish
  // quantities already reserved by a checkout whose notification was missed.
  const orders = await ns.fetchAllPages(connection, '/orders?status=any', { perPage: 100, max: 10000 });
  if (orders.length >= 10000) throw new Error('Limite da leitura de pedidos atingido; estoque não reconciliado');
  for (const order of orders) {
    const receipt = await prisma.nuvemshopOrderMapping.findUnique({ where: { nuvemshopOrderId: String(order.id) } });
    const row = { id: String(order.id), number: order.number, payment: order.payment_status,
      status: order.status, mapped: !!receipt, deducted: receipt?.payload?._stockDecremented === true };
    try {
      if (order.payment_status === 'paid' || order.status === 'cancelled') {
        Object.assign(row, await applyOrderStock(prisma, order));
      }
    } catch (error) {
      row.error = error.message;
      state.errors.push(error.message);
    }
    const pending = order.status !== 'cancelled' && ['pending', 'authorized'].includes(order.payment_status);
    if (row.error || pending) {
      for (const item of order.products || []) {
        if (!item.product_id) throw new Error(`Pedido ${order.id} sem product_id para proteger reserva`);
        blockedProducts.add(String(item.product_id));
      }
      row.stockProtected = true;
    }
    state.orders.push(row);
  }
  state.lastCheckedAt = new Date().toISOString();
  if (Date.now() - lastWebhookCheck > 3600000) {
    try {
      const url = 'https://teniscash.com.br/api/webhooks/nuvemshop';
      const hooks = await ns.fetchAllPages(connection, '/webhooks', { perPage: 100, max: 1000 });
      const required = ['order/created', 'order/paid', 'order/cancelled'];
      for (const event of required) {
        if (!hooks.some(h => h.event === event && h.url === url)) {
          await ns.nuvemshopApi(connection, 'POST', '/webhooks', { event, url });
        }
      }
      state.webhooks = { checkedAt: new Date().toISOString(), events: required, url };
      lastWebhookCheck = Date.now();
    } catch (error) { state.errors.push(`Webhooks: ${error.message}`); }
  }
  return blockedProducts;
}

function getStockAutomationState() { return JSON.parse(JSON.stringify(state)); }
module.exports = { reconcileOrders, getStockAutomationState };
