const { prisma } = require('../middleware');

const DEFAULT_TEMPLATE = 'A Sports & Tennis agradece sua compra! Aproveite seu novo produto e volte sempre.';
const COMPLETED_STATUSES = new Set(['completed', 'paid', 'approved']);

function moneyBRL(value) {
  const amount = Number(value || 0);
  return new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(Number.isFinite(amount) ? amount : 0);
}

function cleanText(value, fallback = '') {
  return String(value == null ? fallback : value)
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 500);
}

function renderTemplate(template, sale, storeName) {
  const products = (sale?.items || [])
    .map((item) => `${Number(item.quantity || 1)} ${cleanText(item.productName || item.name || 'produto')}`)
    .join(', ');
  const values = {
    '{loja}': cleanText(storeName, 'Sports & Tennis'),
    '{valor}': moneyBRL(sale?.totalAmount),
    '{produtos}': products || 'seu produto',
  };
  let result = cleanText(template, DEFAULT_TEMPLATE);
  for (const [token, value] of Object.entries(values)) result = result.split(token).join(value);
  return result || DEFAULT_TEMPLATE;
}

async function defaultStore() {
  return prisma.store.findFirst({ where: { active: true }, orderBy: { code: 'asc' }, select: { id: true, name: true } });
}

async function getConfig(storeId) {
  if (!storeId) return null;
  return prisma.storeRadioConfig.findUnique({ where: { storeId } });
}

async function ensureConfig(storeId, patch = {}) {
  if (!storeId) throw new Error('Selecione uma loja para configurar a rádio.');
  return prisma.storeRadioConfig.upsert({
    where: { storeId },
    create: {
      storeId,
      enabled: Boolean(patch.enabled),
      volume: Number.isFinite(Number(patch.volume)) ? Math.max(0, Math.min(1, Number(patch.volume))) : 1,
      language: cleanText(patch.language, 'pt-BR').slice(0, 20),
      voiceName: cleanText(patch.voiceName, '') || null,
      announcementTemplate: cleanText(patch.announcementTemplate, DEFAULT_TEMPLATE) || DEFAULT_TEMPLATE,
    },
    update: {
      ...(patch.enabled !== undefined ? { enabled: Boolean(patch.enabled) } : {}),
      ...(patch.volume !== undefined ? { volume: Math.max(0, Math.min(1, Number(patch.volume) || 0)) } : {}),
      ...(patch.language !== undefined ? { language: cleanText(patch.language, 'pt-BR').slice(0, 20) } : {}),
      ...(patch.voiceName !== undefined ? { voiceName: cleanText(patch.voiceName, '') || null } : {}),
      ...(patch.announcementTemplate !== undefined ? { announcementTemplate: cleanText(patch.announcementTemplate, DEFAULT_TEMPLATE) || DEFAULT_TEMPLATE } : {}),
    },
  });
}

async function queueSaleAnnouncement(saleId) {
  const sale = await prisma.sale.findUnique({
    where: { id: String(saleId) },
    include: { items: true, seller: { select: { name: true } } },
  });
  if (!sale || !COMPLETED_STATUSES.has(String(sale.status || '').toLowerCase())) return { queued: false, reason: 'sale_not_completed' };

  let store = sale.storeId ? await prisma.store.findUnique({ where: { id: sale.storeId }, select: { id: true, name: true } }) : null;
  if (!store) store = await defaultStore();
  if (!store) return { queued: false, reason: 'no_store' };
  const config = await getConfig(store.id);
  if (!config?.enabled) return { queued: false, reason: 'radio_disabled', storeId: store.id };

  const eventKey = `sale:${sale.id}:completed`;
  const message = renderTemplate(config.announcementTemplate, sale, store.name);
  try {
    const announcement = await prisma.radioAnnouncement.create({
      data: { storeId: store.id, saleId: sale.id, eventKey, source: 'sale', message },
    });
    return { queued: true, id: announcement.id, storeId: store.id };
  } catch (error) {
    // A repeated webhook or retry must never make the customer hear the same sale twice.
    if (error?.code === 'P2002') {
      const existing = await prisma.radioAnnouncement.findUnique({ where: { eventKey } });
      return { queued: false, duplicate: true, id: existing?.id || null, storeId: store.id };
    }
    throw error;
  }
}

async function queueTestAnnouncement({ storeId, message }) {
  let store = storeId ? await prisma.store.findUnique({ where: { id: String(storeId) }, select: { id: true } }) : await defaultStore();
  if (!store) throw new Error('Nenhuma loja ativa encontrada.');
  const text = cleanText(message, 'Teste da rádio Sports & Tennis. A caixa de som está conectada e funcionando.') || DEFAULT_TEMPLATE;
  const announcement = await prisma.radioAnnouncement.create({
    data: {
      storeId: store.id,
      eventKey: `test:${Date.now()}:${Math.random().toString(36).slice(2, 10)}`,
      source: 'test',
      message: text,
    },
  });
  return announcement;
}

async function claimNext(storeId) {
  const now = new Date();
  const stale = new Date(now.getTime() - 5 * 60 * 1000);
  await prisma.radioAnnouncement.updateMany({
    where: { status: 'PLAYING', claimedAt: { lt: stale }, ...(storeId ? { storeId } : {}) },
    data: { status: 'QUEUED', claimedAt: null, error: 'Player não confirmou a reprodução; devolvido à fila.' },
  });
  const candidate = await prisma.radioAnnouncement.findFirst({
    where: { status: 'QUEUED', availableAt: { lte: now }, ...(storeId ? { storeId } : {}) },
    orderBy: [{ availableAt: 'asc' }, { createdAt: 'asc' }],
  });
  if (!candidate) return null;
  const claimed = await prisma.radioAnnouncement.updateMany({
    where: { id: candidate.id, status: 'QUEUED' },
    data: { status: 'PLAYING', claimedAt: now, attempts: { increment: 1 } },
  });
  if (!claimed.count) return null;
  return prisma.radioAnnouncement.findUnique({ where: { id: candidate.id } });
}

async function complete(id) {
  return prisma.radioAnnouncement.updateMany({
    where: { id: String(id), status: 'PLAYING' },
    data: { status: 'PLAYED', playedAt: new Date(), claimedAt: null },
  });
}

async function fail(id, error) {
  return prisma.radioAnnouncement.updateMany({
    where: { id: String(id), status: 'PLAYING' },
    data: { status: 'FAILED', error: cleanText(error, 'Falha ao reproduzir anúncio.') || 'Falha ao reproduzir anúncio.', claimedAt: null },
  });
}

module.exports = {
  DEFAULT_TEMPLATE,
  COMPLETED_STATUSES,
  ensureConfig,
  getConfig,
  queueSaleAnnouncement,
  queueTestAnnouncement,
  claimNext,
  complete,
  fail,
  cleanText,
};
