// Narrow, audited shutdown: never change orders, regular prices or stock.
const { DISCOUNTS_ENABLED } = require('./discountPolicy');
const ns = require('./nuvemshop');
const handlers = require('./nuvemshopHandlers');
let state = { running: false, phase: 'idle' };

function rows(payload) {
  if (Array.isArray(payload)) return payload;
  for (const key of ['data', 'result', 'results']) if (Array.isArray(payload?.[key])) return payload[key];
  throw new Error('Resposta de promoções da Nuvemshop não reconhecida');
}

async function strictList(connection, resource) {
  const result = [];
  for (let page = 1; page <= 100; page++) {
    let payload;
    try { payload = await ns.nuvemshopApi(connection, 'GET', `${resource}?per_page=100&page=${page}`); }
    catch (err) { if (page > 1 && /\[Nuvemshop 404\]/.test(err.message)) break; throw err; }
    const batch = rows(payload);
    result.push(...batch);
    if (batch.length < 100) return result;
  }
  if (result.length >= 10000) throw new Error('Listagem de promoções incompleta');
  return result;
}

async function scan(prisma) {
  const connection = await handlers.getConnection();
  if (!connection) return { connection: null, variants: [], promotions: [], coupons: [] };
  const products = await strictList(connection, '/products');
  if (products.length >= 10000) throw new Error('Listagem de produtos incompleta');
  const variants = products.flatMap(product => (product.variants || [])
    .filter(variant => variant.promotional_price != null && variant.promotional_price !== '')
    .map(variant => ({ productId: String(product.id), variantId: String(variant.id), promotionalPrice: variant.promotional_price })));
  const promotions = (await strictList(connection, '/promotions')).filter(p => p.active !== false && p.id != null)
    .map(p => ({ id: String(p.id), name: p.name, active: p.active }));
  const allCoupons = await strictList(connection, '/coupons');
  if (allCoupons.length >= 10000) throw new Error('Listagem de cupons incompleta');
  // Credit redemption is separate from a promotional coupon. Keep balances and
  // already reserved cashback intact; the owner has not requested their removal.
  const redemptions = await prisma.cashbackRedemption.findMany({ select: { nsCouponId: true, couponCode: true } });
  const creditIds = new Set(redemptions.map(r => String(r.nsCouponId || '')));
  const creditCodes = new Set(redemptions.map(r => r.couponCode));
  const coupons = allCoupons.filter(c => c.valid !== false && c.id != null
    && !creditIds.has(String(c.id)) && !creditCodes.has(c.code)
    // A redemption coupon can exist remotely just before its local transaction
    // commits. Preserve its reserved code/shape during that small interval too.
    && !(/^TC[0-9A-F]{7}$/.test(String(c.code)) && Number(c.max_uses) === 1 && c.max_discount_amount != null))
    .map(c => ({ id: String(c.id), code: c.code, valid: c.valid }));
  return { connection, variants, promotions, coupons };
}

function counts(snapshot) {
  return { connected: !!snapshot.connection, promotionalVariants: snapshot.variants.length,
    activePromotions: snapshot.promotions.length, activeDiscountCoupons: snapshot.coupons.length };
}

async function inspectRemoteDiscounts(prisma) { return counts(await scan(prisma)); }
function getRemoteDiscountShutdownState() { return JSON.parse(JSON.stringify(state)); }

async function runShutdown(prisma, actorId) {
  if (DISCOUNTS_ENABLED) throw new Error('A política de descontos ainda está ativa');
  const snapshot = await scan(prisma);
  state.before = counts(snapshot);
  if (!snapshot.connection) { state.phase = 'not_connected'; return; }
  state.phase = 'disabling';
  state.processed = 0;
  const key = `discount-shutdown-remote-${new Date().toISOString()}-${Math.random().toString(36).slice(2, 8)}`;
  const audit = { actorId, createdAt: new Date().toISOString(), storeId: snapshot.connection?.nuvemshopUserId,
    variants: snapshot.variants, promotions: snapshot.promotions, coupons: snapshot.coupons };
  // Persist a reversible snapshot BEFORE the first external mutation.
  await prisma.config.create({ data: { id: key, key, value: JSON.stringify(audit) } });
  state.auditKey = key;
  const operations = [
    ...snapshot.promotions.map(p => () => ns.nuvemshopApi(snapshot.connection, 'PATCH', `/promotions/${encodeURIComponent(p.id)}`, { active: false })),
    ...snapshot.coupons.map(c => () => ns.setCouponValid(snapshot.connection, c.id, false)),
    ...snapshot.variants.map(v => () => ns.nuvemshopApi(snapshot.connection, 'PUT', `/products/${encodeURIComponent(v.productId)}/variants/${encodeURIComponent(v.variantId)}`, { promotional_price: null })),
  ];
  state.total = operations.length;
  for (const operation of operations) {
    await operation();
    state.processed++;
  }
  state.phase = 'verifying';
  state.after = await inspectRemoteDiscounts(prisma);
  if (!state.after.connected || state.after.promotionalVariants || state.after.activePromotions || state.after.activeDiscountCoupons) {
    throw new Error('Ainda existem descontos ativos na Nuvemshop; repetir a conferência antes de concluir');
  }
  state.phase = 'complete';
  audit.completedAt = new Date().toISOString();
  audit.after = state.after;
  await prisma.config.update({ where: { key }, data: { value: JSON.stringify(audit) } });
}

function startRemoteDiscountShutdown(prisma, actorId) {
  if (state.running) return getRemoteDiscountShutdownState();
  state = { running: true, phase: 'scanning', startedAt: new Date().toISOString(), processed: 0 };
  runShutdown(prisma, actorId).catch(error => {
    state.phase = 'failed';
    state.error = error.message;
  }).finally(() => { state.running = false; state.finishedAt = new Date().toISOString(); });
  return getRemoteDiscountShutdownState();
}

module.exports = { inspectRemoteDiscounts, startRemoteDiscountShutdown, getRemoteDiscountShutdownState };
