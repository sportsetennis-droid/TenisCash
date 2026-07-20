const DEFAULT_CONTENT_SLOTS = Object.freeze([
  ...Array.from({ length: 4 }, (_, reelIndex) => (
    Array.from({ length: 3 }, (_, productIndex) => ({
      contentType: 'REEL',
      slotKey: `REEL_${reelIndex + 1}`,
      position: productIndex + 1,
      label: `Reels ${reelIndex + 1} - produto ${productIndex + 1}`,
    }))
  )).flat(),
  ...Array.from({ length: 10 }, (_, photoIndex) => ({
    contentType: 'PHOTO',
    slotKey: `PHOTO_${photoIndex + 1}`,
    position: 1,
    label: `Foto ${photoIndex + 1}`,
  })),
]);

function startOfLocalDay(value = new Date()) {
  const date = value instanceof Date ? new Date(value) : new Date(`${value}T12:00:00`);
  if (Number.isNaN(date.getTime())) throw new Error('Data invalida');
  date.setHours(0, 0, 0, 0);
  return date;
}

function endOfLocalDay(value = new Date()) {
  const start = startOfLocalDay(value);
  return new Date(start.getTime() + 24 * 60 * 60 * 1000);
}

function parseJson(value, fallback) {
  if (value == null) return fallback;
  if (typeof value === 'object') return value;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function textList(value) {
  const parsed = parseJson(value, []);
  if (Array.isArray(parsed)) return parsed.map((item) => String(item || '').trim()).filter(Boolean);
  if (parsed && typeof parsed === 'object') {
    return Object.entries(parsed)
      .map(([key, item]) => {
        if (item == null || item === false || item === '') return '';
        if (item === true) return key;
        if (typeof item === 'object') return `${key}: ${JSON.stringify(item)}`;
        return `${key}: ${item}`;
      })
      .filter(Boolean);
  }
  return [];
}

function productHasCharacteristics(product) {
  return Boolean(
    String(product.shortDescription || '').trim()
    || String(product.longDescription || '').trim()
    || textList(product.features).length
    || textList(product.recommendedFor).length
  );
}

function availableSizesAtStore(product, storeId) {
  const rows = [];
  for (const size of product.sizes || []) {
    const quantity = (size.storeStocks || [])
      .filter((stock) => !storeId || stock.storeId === storeId)
      .reduce((sum, stock) => sum + Math.max(0, Number(stock.stock) || 0), 0);
    if (quantity > 0) rows.push({ size: size.size, quantity });
  }
  return rows;
}

function makeProductSnapshot(product, storeId, maxDiscountByBrand = new Map()) {
  const sizes = availableSizesAtStore(product, storeId);
  const features = textList(product.features);
  const recommendedFor = textList(product.recommendedFor);
  const notRecommendedFor = textList(product.notRecommendedFor);
  const currentPrice = Number(product.promoPrice) > 0 ? Number(product.promoPrice) : Number(product.price);
  const maxDiscount = maxDiscountByBrand.has(product.brand)
    ? Number(maxDiscountByBrand.get(product.brand))
    : null;
  const hasCharacteristics = productHasCharacteristics(product);

  return {
    productId: product.id,
    sku: product.sku,
    name: product.name,
    brand: product.brand,
    category: product.category,
    subcategory: product.subcategory || null,
    imageUrl: product.imageUrl || null,
    price: Number(product.price),
    promoPrice: Number(product.promoPrice) > 0 ? Number(product.promoPrice) : null,
    currentPrice,
    maxDiscount,
    shortDescription: product.shortDescription || null,
    longDescription: product.longDescription || null,
    features,
    recommendedFor,
    notRecommendedFor,
    sizes,
    totalStock: sizes.reduce((sum, size) => sum + size.quantity, 0),
    characteristicsSource: 'CATALOG',
    characteristicsComplete: hasCharacteristics,
    warning: hasCharacteristics ? null : 'Caracteristicas nao cadastradas. Nao inventar informacoes.',
  };
}

function sortProductsForContent(products) {
  return [...products].sort((a, b) => {
    const completeDiff = Number(productHasCharacteristics(b)) - Number(productHasCharacteristics(a));
    if (completeDiff) return completeDiff;
    const featuredDiff = Number(Boolean(b.featured)) - Number(Boolean(a.featured));
    if (featuredDiff) return featuredDiff;
    const brandDiff = String(a.brand || '').localeCompare(String(b.brand || ''), 'pt-BR');
    if (brandDiff) return brandDiff;
    return String(a.name || '').localeCompare(String(b.name || ''), 'pt-BR');
  });
}

function selectProductsWithoutRepeating(products, count) {
  const sorted = sortProductsForContent(products);
  const byBrand = new Map();
  for (const product of sorted) {
    const brand = String(product.brand || 'SEM_MARCA').toUpperCase();
    if (!byBrand.has(brand)) byBrand.set(brand, []);
    byBrand.get(brand).push(product);
  }

  const selected = [];
  const used = new Set();
  const brands = [...byBrand.keys()].sort((a, b) => a.localeCompare(b, 'pt-BR'));
  while (selected.length < count) {
    let added = false;
    for (const brand of brands) {
      const bucket = byBrand.get(brand);
      const product = bucket && bucket.shift();
      if (!product || used.has(product.id)) continue;
      used.add(product.id);
      selected.push(product);
      added = true;
      if (selected.length >= count) break;
    }
    if (!added) break;
  }
  return selected;
}

function normalizePhoneBR(raw) {
  let phone = String(raw || '').replace(/\D/g, '');
  if (!phone) return null;
  if (phone.length === 10 || phone.length === 11) phone = `55${phone}`;
  else if (!(phone.startsWith('55') && (phone.length === 12 || phone.length === 13))) return null;
  return phone;
}

function buildWhatsAppUrl(phone, message) {
  const normalized = normalizePhoneBR(phone);
  const cleanMessage = String(message || '').trim();
  if (!normalized || !cleanMessage) return null;
  return `https://wa.me/${normalized}?text=${encodeURIComponent(cleanMessage)}`;
}

function parseWhatsappDraft(text) {
  const raw = String(text || '').trim();
  const match = raw.match(/(?:mande|envie|abrir|prepare)(?:\s+uma)?\s+(?:mensagem\s+no\s+)?whatsapp\s+(?:para|pra|pro)\s+([+()\d\s-]{10,})(?:\s*(?:dizendo|com\s+a\s+mensagem|:))\s*(.+)$/i);
  if (!match) return null;
  const phone = normalizePhoneBR(match[1]);
  const message = String(match[2] || '').trim();
  if (!phone || !message) return null;
  return { phone, message };
}

async function getOrCreateAssistantProfile(prisma, seller) {
  const displayName = `Assistente de ${String(seller.name || 'Vendedor').trim()}`;
  return prisma.sellerAssistantProfile.upsert({
    where: { sellerId: seller.id },
    create: {
      sellerId: seller.id,
      displayName,
      memory: {
        sellerName: seller.name,
        employeeCode: seller.employeeCode || null,
        primaryStoreId: seller.storeId || null,
      },
      lastOpenedAt: new Date(),
    },
    update: {
      displayName,
      lastOpenedAt: new Date(),
    },
  });
}

async function getOrCreateMainConversation(prisma, profile, seller) {
  let conversation = null;
  if (profile.mainConversationId) {
    conversation = await prisma.aIConversation.findFirst({
      where: { id: profile.mainConversationId, userId: seller.id, active: true },
    });
  }
  if (!conversation) {
    conversation = await prisma.aIConversation.findFirst({
      where: { userId: seller.id, userType: 'seller-agent', active: true },
      orderBy: { updatedAt: 'desc' },
    });
  }
  if (!conversation) {
    conversation = await prisma.aIConversation.create({
      data: {
        userId: seller.id,
        userType: 'seller-agent',
        title: profile.displayName,
      },
    });
  }
  if (profile.mainConversationId !== conversation.id) {
    await prisma.sellerAssistantProfile.update({
      where: { id: profile.id },
      data: { mainConversationId: conversation.id },
    });
  }
  return conversation;
}

async function resolveStoreForDate(prisma, seller, workDate) {
  const start = startOfLocalDay(workDate);
  const end = endOfLocalDay(workDate);
  const shift = await prisma.sellerMonthlyShift.findFirst({
    where: {
      sellerId: seller.id,
      workDate: { gte: start, lt: end },
      schedule: { status: 'PUBLISHED' },
    },
    orderBy: { schedule: { publishedAt: 'desc' } },
    include: { store: { select: { id: true, code: true, name: true } } },
  });
  if (shift?.store) return shift.store;
  if (seller.store) return seller.store;
  if (!seller.storeId) return null;
  return prisma.store.findUnique({
    where: { id: seller.storeId },
    select: { id: true, code: true, name: true },
  });
}

function assignmentToOutput(row) {
  return {
    id: row.id,
    contentType: row.contentType,
    slotKey: row.slotKey,
    position: row.position,
    status: row.status,
    note: row.note || null,
    completedAt: row.completedAt || null,
    product: parseJson(row.productSnapshot, {}),
  };
}

function groupAssignments(rows) {
  const reels = [];
  const photos = [];
  const byReel = new Map();
  for (const row of rows || []) {
    const output = assignmentToOutput(row);
    if (row.contentType === 'REEL') {
      if (!byReel.has(row.slotKey)) byReel.set(row.slotKey, []);
      byReel.get(row.slotKey).push(output);
    } else {
      photos.push(output);
    }
  }
  for (const [slotKey, products] of byReel.entries()) {
    products.sort((a, b) => a.position - b.position);
    reels.push({ slotKey, products });
  }
  reels.sort((a, b) => a.slotKey.localeCompare(b.slotKey, 'pt-BR', { numeric: true }));
  photos.sort((a, b) => a.slotKey.localeCompare(b.slotKey, 'pt-BR', { numeric: true }));
  return { reels, photos };
}

async function ensureDailyContentPlan(prisma, profile, seller, workDateInput = new Date()) {
  const workDate = startOfLocalDay(workDateInput);
  const nextDay = endOfLocalDay(workDateInput);
  const store = await resolveStoreForDate(prisma, seller, workDate);
  if (!store) {
    return {
      workDate,
      store: null,
      reels: [],
      photos: [],
      assignedCount: 0,
      requiredCount: DEFAULT_CONTENT_SLOTS.length,
      complete: false,
      warning: 'Vendedor sem loja definida para a data.',
    };
  }

  const existing = await prisma.sellerAssistantProductAssignment.findMany({
    where: { sellerId: seller.id, workDate: { gte: workDate, lt: nextDay } },
    orderBy: [{ contentType: 'desc' }, { slotKey: 'asc' }, { position: 'asc' }],
  });
  const occupiedSlots = new Set(existing.map((row) => `${row.slotKey}:${row.position}`));
  const remainingSlots = DEFAULT_CONTENT_SLOTS.filter((slot) => !occupiedSlots.has(`${slot.slotKey}:${slot.position}`));

  if (remainingSlots.length) {
    const sellerHistory = await prisma.sellerAssistantProductAssignment.findMany({
      where: { sellerId: seller.id, cycle: profile.contentCycle },
      select: { productId: true },
    });
    const excludedIds = [...new Set(sellerHistory.map((row) => row.productId).filter(Boolean))];

    const products = await prisma.product.findMany({
      where: {
        active: true,
        ...(excludedIds.length ? { id: { notIn: excludedIds } } : {}),
        sizes: {
          some: {
            storeStocks: { some: { storeId: store.id, stock: { gt: 0 } } },
          },
        },
      },
      take: 500,
      orderBy: [{ featured: 'desc' }, { updatedAt: 'desc' }],
      select: {
        id: true,
        sku: true,
        name: true,
        brand: true,
        category: true,
        subcategory: true,
        shortDescription: true,
        longDescription: true,
        features: true,
        recommendedFor: true,
        notRecommendedFor: true,
        imageUrl: true,
        price: true,
        promoPrice: true,
        featured: true,
        sizes: {
          where: { storeStocks: { some: { storeId: store.id, stock: { gt: 0 } } } },
          select: {
            size: true,
            storeStocks: {
              where: { storeId: store.id, stock: { gt: 0 } },
              select: { storeId: true, stock: true },
            },
          },
        },
      },
    });

    const selected = selectProductsWithoutRepeating(products, remainingSlots.length);
    const brands = [...new Set(selected.map((product) => product.brand).filter(Boolean))];
    const rules = brands.length
      ? await prisma.brandRule.findMany({ where: { active: true, brand: { in: brands } }, select: { brand: true, maxDiscount: true } })
      : [];
    const maxDiscountByBrand = new Map(rules.map((rule) => [rule.brand, rule.maxDiscount]));

    if (selected.length) {
      await prisma.sellerAssistantProductAssignment.createMany({
        data: selected.map((product, index) => {
          const slot = remainingSlots[index];
          return {
            assistantId: profile.id,
            sellerId: seller.id,
            storeId: store.id,
            productId: product.id,
            workDate,
            cycle: profile.contentCycle,
            contentType: slot.contentType,
            slotKey: slot.slotKey,
            position: slot.position,
            productSnapshot: makeProductSnapshot(product, store.id, maxDiscountByBrand),
          };
        }),
        skipDuplicates: true,
      });
    }
  }

  const assignments = await prisma.sellerAssistantProductAssignment.findMany({
    where: { sellerId: seller.id, workDate: { gte: workDate, lt: nextDay } },
    orderBy: [{ contentType: 'desc' }, { slotKey: 'asc' }, { position: 'asc' }],
  });
  const grouped = groupAssignments(assignments);
  const assignedCount = assignments.length;
  return {
    workDate,
    store,
    cycle: profile.contentCycle,
    ...grouped,
    assignedCount,
    requiredCount: DEFAULT_CONTENT_SLOTS.length,
    complete: assignedCount === DEFAULT_CONTENT_SLOTS.length,
    warning: assignedCount < DEFAULT_CONTENT_SLOTS.length
      ? `Foram encontrados ${assignedCount} produtos sem repeticao. O sistema nao repetiu produto para completar o plano.`
      : null,
  };
}

async function prepareWhatsappMessage(prisma, sellerId, payload) {
  const recipientName = String(payload.recipientName || '').trim().slice(0, 120) || null;
  const phone = normalizePhoneBR(payload.phone);
  const message = String(payload.message || '').trim().slice(0, 2000);
  const consentConfirmed = payload.consentConfirmed === true;
  if (!phone) throw new Error('Telefone invalido');
  if (!message) throw new Error('Mensagem obrigatoria');
  if (!consentConfirmed) throw new Error('Confirme que a pessoa autorizou o contato ou ja esta em atendimento.');
  const waUrl = buildWhatsAppUrl(phone, message);
  return prisma.sellerAssistantWhatsappMessage.create({
    data: {
      sellerId,
      recipientName,
      phone,
      message,
      consentConfirmed,
      waUrl,
      status: 'PREPARED',
    },
  });
}

module.exports = {
  DEFAULT_CONTENT_SLOTS,
  startOfLocalDay,
  textList,
  productHasCharacteristics,
  makeProductSnapshot,
  selectProductsWithoutRepeating,
  normalizePhoneBR,
  buildWhatsAppUrl,
  parseWhatsappDraft,
  getOrCreateAssistantProfile,
  getOrCreateMainConversation,
  ensureDailyContentPlan,
  prepareWhatsappMessage,
};
