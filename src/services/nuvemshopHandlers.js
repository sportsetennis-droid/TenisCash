// =====================================================================
// Nuvemshop Webhook Handlers — processa cada tipo de evento
// =====================================================================
// Eventos suportados:
//   order/created, order/paid, order/cancelled, order/updated, order/fulfilled
//   product/created, product/updated, product/deleted
//   customer/created, customer/updated, customer/deleted
//   app/uninstalled, app/suspended, app/resumed
//   store/redact, customers/redact, customers/data_request
// =====================================================================

const { prisma } = require('../middleware');
const ns = require('./nuvemshop');

function pickStr(v) {
  if (v == null) return null;
  if (typeof v === 'string') return v;
  if (typeof v === 'object' && v.pt) return v.pt; // Nuvemshop multi-língua
  if (typeof v === 'object') {
    const first = Object.values(v).find((x) => typeof x === 'string');
    return first || null;
  }
  return String(v);
}

async function logSync(entity, status, message, payload = null) {
  try {
    await prisma.nuvemshopSyncLog.create({
      data: { type: 'webhook', entity, status, message, payload },
    });
  } catch (_) { /* silencioso */ }
}

async function getConnection() {
  return prisma.nuvemshopConnection.findFirst({ where: { status: 'active' } });
}

// =====================================================================
// PRODUCT HANDLERS
// =====================================================================

async function upsertLocalProduct(nsProduct) {
  // Espelha um produto da Nuvemshop num Product local (TenisCash)
  const name = pickStr(nsProduct.name) || 'Produto sem nome';
  const brand = pickStr(nsProduct.brand) || pickStr(nsProduct.vendor) || 'A DEFINIR';
  const description = pickStr(nsProduct.description) || '';
  const categories = Array.isArray(nsProduct.categories) ? nsProduct.categories : [];
  const category = pickStr(categories[0]?.name) || 'geral';

  // Primeira variant define o preço base
  const variants = Array.isArray(nsProduct.variants) ? nsProduct.variants : [];
  const firstVariant = variants[0] || {};
  const price = parseFloat(firstVariant.price || 0) || 0;
  const promoPrice = firstVariant.promotional_price ? parseFloat(firstVariant.promotional_price) : null;
  const sku = firstVariant.sku || `NS-${nsProduct.id}`;
  const imageUrl = nsProduct.images?.[0]?.src || null;

  // Tenta achar por mapeamento existente
  const mapping = await prisma.nuvemshopProductMapping.findFirst({
    where: { nuvemshopProductId: String(nsProduct.id) },
  });

  let product;
  if (mapping) {
    // Atualiza produto existente
    product = await prisma.product.update({
      where: { id: mapping.localProductId },
      data: {
        name,
        brand,
        category,
        price,
        promoPrice,
        shortDescription: description.slice(0, 200) || null,
        longDescription: description || null,
        imageUrl,
        active: nsProduct.published !== false,
      },
    });
    await prisma.nuvemshopProductMapping.update({
      where: { id: mapping.id },
      data: { lastSyncedAt: new Date(), syncStatus: 'synced' },
    });
  } else {
    // Cria produto novo (verifica SKU duplicado)
    const existing = await prisma.product.findUnique({ where: { sku } });
    if (existing) {
      // Vincula ao existente
      product = existing;
      await prisma.product.update({
        where: { id: existing.id },
        data: { name, brand, category, price, promoPrice, imageUrl, active: nsProduct.published !== false },
      });
    } else {
      product = await prisma.product.create({
        data: {
          sku,
          name,
          brand,
          category,
          price,
          promoPrice,
          shortDescription: description.slice(0, 200) || null,
          longDescription: description || null,
          imageUrl,
          active: nsProduct.published !== false,
          source: 'nuvemshop',
        },
      });
    }
    await prisma.nuvemshopProductMapping.create({
      data: {
        localProductId: product.id,
        nuvemshopProductId: String(nsProduct.id),
        syncStatus: 'synced',
        lastSyncedAt: new Date(),
      },
    });
  }

  // Variants → ProductSize
  for (const v of variants) {
    const size = pickStr(v.values?.[0]?.name) || pickStr(v.option1) || 'único';
    const stock = parseInt(v.stock, 10) || 0;
    const barcode = v.barcode || null;

    const existingSize = await prisma.productSize.findFirst({
      where: { productId: product.id, size },
    });
    let psize;
    if (existingSize) {
      psize = await prisma.productSize.update({
        where: { id: existingSize.id },
        data: { stock, barcode },
      });
    } else {
      psize = await prisma.productSize.create({
        data: { productId: product.id, size, stock, barcode },
      });
    }

    // VariantMapping
    const vMapping = await prisma.nuvemshopVariantMapping.findFirst({
      where: { nuvemshopVariantId: String(v.id) },
    });
    if (vMapping) {
      await prisma.nuvemshopVariantMapping.update({
        where: { id: vMapping.id },
        data: { sku: v.sku, barcode, lastSyncedAt: new Date() },
      });
    } else {
      await prisma.nuvemshopVariantMapping.create({
        data: {
          localInventoryId: psize.id,
          localProductId: product.id,
          nuvemshopProductId: String(nsProduct.id),
          nuvemshopVariantId: String(v.id),
          sku: v.sku || null,
          barcode,
        },
      });
    }
  }

  return product;
}

async function handleProductEvent(eventType, resourceId, connection) {
  if (eventType === 'product/deleted') {
    const mapping = await prisma.nuvemshopProductMapping.findFirst({
      where: { nuvemshopProductId: String(resourceId) },
    });
    if (mapping) {
      await prisma.product.update({
        where: { id: mapping.localProductId },
        data: { active: false },
      });
    }
    await logSync('product', 'ok', `product/deleted ${resourceId} → desativado`);
    return;
  }
  // created OU updated: busca produto completo e upserta
  const data = await ns.getProduct(connection, resourceId);
  await upsertLocalProduct(data);
  await logSync('product', 'ok', `${eventType} ${resourceId} → sincronizado`);
}

// =====================================================================
// CUSTOMER HANDLERS
// =====================================================================

async function upsertLocalCustomer(nsCustomer) {
  const name = nsCustomer.name || nsCustomer.email || 'Cliente Nuvemshop';
  const email = nsCustomer.email || null;
  const phone = nsCustomer.phone ? String(nsCustomer.phone).replace(/\D/g, '') : null;
  const cpf = nsCustomer.identification ? String(nsCustomer.identification).replace(/\D/g, '') : null;

  // Tenta achar por mapeamento existente
  const mapping = await prisma.nuvemshopCustomerMapping.findFirst({
    where: { nuvemshopCustomerId: String(nsCustomer.id) },
  });

  let user;
  if (mapping) {
    user = await prisma.user.findUnique({ where: { id: mapping.customerId } });
    if (user) {
      user = await prisma.user.update({
        where: { id: user.id },
        data: {
          name,
          email: email || user.email,
          // Não atualiza phone/cpf se já existem (são identificadores únicos)
        },
      });
    }
  }
  if (!user) {
    // Tenta achar por phone, cpf ou email
    const byPhone = phone ? await prisma.user.findFirst({ where: { phone } }) : null;
    const byCpf = cpf && !byPhone ? await prisma.user.findFirst({ where: { cpf } }) : null;
    const byEmail = email && !byPhone && !byCpf ? await prisma.user.findFirst({ where: { email } }) : null;
    user = byPhone || byCpf || byEmail;

    if (!user) {
      // Cria User novo. Phone é unique e obrigatório no schema; usa placeholder se faltar.
      const pinHash = '$2a$10$placeholder.placeholder.placeholder.placeholder.placeho';
      try {
        user = await prisma.user.create({
          data: {
            name,
            phone: phone || `ns_${nsCustomer.id}`,
            email,
            cpf: cpf || null,
            role: 'user',
            pin: pinHash,
            active: true,
          },
        });
      } catch (err) {
        await logSync('customer', 'error', `Falha ao criar usuário ${nsCustomer.id}: ${err.message}`);
        return null;
      }
    }
    await prisma.nuvemshopCustomerMapping.create({
      data: { customerId: user.id, nuvemshopCustomerId: String(nsCustomer.id) },
    });
  }

  return user;
}

async function handleCustomerEvent(eventType, resourceId, connection) {
  if (eventType === 'customer/deleted') {
    const mapping = await prisma.nuvemshopCustomerMapping.findFirst({
      where: { nuvemshopCustomerId: String(resourceId) },
    });
    if (mapping) {
      // Não apaga User (pode ter histórico); só desativa
      await prisma.user.update({ where: { id: mapping.customerId }, data: { active: false } });
    }
    await logSync('customer', 'ok', `customer/deleted ${resourceId} → desativado`);
    return;
  }
  const data = await ns.getCustomer(connection, resourceId);
  await upsertLocalCustomer(data);
  await logSync('customer', 'ok', `${eventType} ${resourceId} → sincronizado`);
}

// =====================================================================
// ORDER HANDLERS
// =====================================================================

async function upsertSaleFromOrder(nsOrder) {
  // 1. Resolve cliente (cria se necessário)
  let user = null;
  if (nsOrder.customer) {
    user = await upsertLocalCustomer(nsOrder.customer);
  }

  // 2. Cria/atualiza Sale local
  // Schema Sale exige sellerId (não opcional). Usa primeiro admin/seller disponível como "operador" da venda online.
  const operator = await prisma.user.findFirst({
    where: { role: { in: ['admin', 'superadmin', 'seller'] }, active: true },
  });
  if (!operator) {
    await logSync('order', 'error', `Sem operador disponível para venda Nuvemshop ${nsOrder.id}`);
    return null;
  }

  const totalAmount = parseFloat(nsOrder.total || 0) || 0;
  // Cashback: 1 BRL = 1 T$ (regra do projeto)
  const tcEarned = totalAmount;

  // Checa se já existe
  const existing = await prisma.nuvemshopOrderMapping.findUnique({
    where: { nuvemshopOrderId: String(nsOrder.id) },
  });

  let sale;
  if (existing && existing.saleId) {
    sale = await prisma.sale.findUnique({ where: { id: existing.saleId } });
  }
  if (!sale) {
    try {
      sale = await prisma.sale.create({
        data: {
          sellerId: operator.id,
          totalAmount,
          tcUsed: 0,
          tcEarned,
          paymentMethod: nsOrder.payment_status || 'nuvemshop',
          status: nsOrder.payment_status === 'paid' ? 'completed' : 'pending',
          erpReference: `NS-${nsOrder.id}`,
          note: `Pedido Nuvemshop #${nsOrder.number || nsOrder.id}`,
        },
      });
    } catch (err) {
      await logSync('order', 'error', `Falha criar Sale: ${err.message}`);
      return null;
    }
  }

  // Mapping
  if (existing) {
    await prisma.nuvemshopOrderMapping.update({
      where: { id: existing.id },
      data: { saleId: sale.id, payload: nsOrder },
    });
  } else {
    await prisma.nuvemshopOrderMapping.create({
      data: {
        saleId: sale.id,
        nuvemshopOrderId: String(nsOrder.id),
        payload: nsOrder,
      },
    });
  }

  // 3. Se pago → credita TenisCash pro cliente (idempotente)
  if (nsOrder.payment_status === 'paid' && user) {
    const alreadyCredited = await prisma.transaction.findFirst({
      where: { description: `Cashback pedido NS-${nsOrder.id}` },
    });
    if (!alreadyCredited) {
      await prisma.$transaction(async (tx) => {
        await tx.user.update({
          where: { id: user.id },
          data: { balance: { increment: tcEarned } },
        });
        await tx.transaction.create({
          data: {
            type: 'credit',
            amount: tcEarned,
            receiverId: user.id,
            description: `Cashback pedido NS-${nsOrder.id}`,
            status: 'completed',
          },
        });
      });
      await logSync('order', 'ok', `order/paid ${nsOrder.id} → T$ ${tcEarned} creditado pra ${user.id}`);
    }
  }

  return sale;
}

async function handleOrderEvent(eventType, resourceId, connection) {
  const order = await ns.getOrder(connection, resourceId);
  if (eventType === 'order/cancelled') {
    // Cancela Sale + estorna TenisCash se já tinha sido creditado
    const mapping = await prisma.nuvemshopOrderMapping.findUnique({
      where: { nuvemshopOrderId: String(resourceId) },
    });
    if (mapping && mapping.saleId) {
      await prisma.sale.update({ where: { id: mapping.saleId }, data: { status: 'cancelled' } });
      // Estorna cashback se houve
      const cashback = await prisma.transaction.findFirst({
        where: { description: `Cashback pedido NS-${resourceId}` },
      });
      if (cashback && cashback.receiverId) {
        await prisma.$transaction(async (tx) => {
          await tx.user.update({
            where: { id: cashback.receiverId },
            data: { balance: { decrement: cashback.amount } },
          });
          await tx.transaction.create({
            data: {
              type: 'admin_debit',
              amount: cashback.amount,
              senderId: cashback.receiverId,
              description: `Estorno: pedido NS-${resourceId} cancelado`,
              status: 'completed',
            },
          });
        });
      }
    }
    await logSync('order', 'ok', `order/cancelled ${resourceId} → Sale cancelada + estorno se aplicável`);
    return;
  }
  await upsertSaleFromOrder(order);
  await logSync('order', 'ok', `${eventType} ${resourceId} → processado`);
}

// =====================================================================
// APP / LGPD HANDLERS
// =====================================================================

async function handleAppEvent(eventType, payload) {
  if (eventType === 'app/uninstalled') {
    await prisma.nuvemshopConnection.updateMany({
      where: { status: 'active' },
      data: { status: 'revoked' },
    });
    await logSync('connection', 'ok', 'app/uninstalled → conexão revogada');
    return;
  }
  if (eventType === 'app/suspended') {
    await prisma.nuvemshopConnection.updateMany({
      where: { status: 'active' },
      data: { status: 'suspended' },
    });
    return;
  }
  if (eventType === 'app/resumed') {
    await prisma.nuvemshopConnection.updateMany({
      where: { status: 'suspended' },
      data: { status: 'active' },
    });
    return;
  }
}

// =====================================================================
// DISPATCHER
// =====================================================================

async function processWebhookEvent(eventRow) {
  const event = String(eventRow.event || '');
  const resourceId = eventRow.nuvemshopResourceId;
  const payload = eventRow.payload || {};
  const connection = await getConnection();

  // App events não precisam de conexão ativa
  if (event.startsWith('app/')) {
    await handleAppEvent(event, payload);
    return { ok: true };
  }

  if (!connection) {
    return { ok: false, reason: 'Sem conexão Nuvemshop ativa' };
  }

  try {
    if (event.startsWith('product/')) {
      await handleProductEvent(event, resourceId, connection);
    } else if (event.startsWith('customer/')) {
      await handleCustomerEvent(event, resourceId, connection);
    } else if (event.startsWith('order/')) {
      await handleOrderEvent(event, resourceId, connection);
    } else if (event === 'store/redact' || event === 'customers/redact' || event === 'customers/data_request') {
      await logSync('lgpd', 'ok', `Evento LGPD recebido: ${event} (apenas registrado)`, payload);
    } else {
      await logSync('unknown', 'warning', `Evento desconhecido: ${event}`, payload);
    }
    return { ok: true };
  } catch (err) {
    await logSync(event.split('/')[0] || 'webhook', 'error', err.message, { event, resourceId });
    throw err;
  }
}

// =====================================================================
// IMPORTAÇÃO INICIAL
// =====================================================================

async function importAllProducts({ max = 1000 } = {}) {
  const connection = await getConnection();
  if (!connection) throw new Error('Sem conexão Nuvemshop ativa');
  const products = await ns.listProducts(connection, { max });
  let created = 0;
  let updated = 0;
  for (const p of products) {
    try {
      const existing = await prisma.nuvemshopProductMapping.findFirst({
        where: { nuvemshopProductId: String(p.id) },
      });
      await upsertLocalProduct(p);
      if (existing) updated++;
      else created++;
    } catch (err) {
      await logSync('product', 'error', `Import produto ${p.id}: ${err.message}`);
    }
  }
  await logSync('product', 'ok', `Import inicial concluído: ${products.length} total, ${created} novos, ${updated} atualizados`);
  return { total: products.length, created, updated };
}

async function importAllCustomers({ max = 1000 } = {}) {
  const connection = await getConnection();
  if (!connection) throw new Error('Sem conexão Nuvemshop ativa');
  const customers = await ns.listCustomers(connection, { max });
  let synced = 0;
  let skipped = 0;
  for (const c of customers) {
    try {
      const user = await upsertLocalCustomer(c);
      if (user) synced++;
      else skipped++;
    } catch (err) {
      await logSync('customer', 'error', `Import cliente ${c.id}: ${err.message}`);
      skipped++;
    }
  }
  await logSync('customer', 'ok', `Import clientes: ${customers.length} total, ${synced} sincronizados, ${skipped} pulados`);
  return { total: customers.length, synced, skipped };
}

async function importRecentOrders({ max = 200 } = {}) {
  const connection = await getConnection();
  if (!connection) throw new Error('Sem conexão Nuvemshop ativa');
  const orders = await ns.listOrders(connection, { max });
  let synced = 0;
  for (const o of orders) {
    try {
      await upsertSaleFromOrder(o);
      synced++;
    } catch (err) {
      await logSync('order', 'error', `Import pedido ${o.id}: ${err.message}`);
    }
  }
  await logSync('order', 'ok', `Import pedidos: ${orders.length} total, ${synced} sincronizados`);
  return { total: orders.length, synced };
}

module.exports = {
  processWebhookEvent,
  importAllProducts,
  importAllCustomers,
  importRecentOrders,
  upsertLocalProduct,
  upsertLocalCustomer,
  upsertSaleFromOrder,
};
