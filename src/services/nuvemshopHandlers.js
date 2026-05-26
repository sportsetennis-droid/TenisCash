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
    where: { role: { in: ['admin', 'superadmin', 'manager', 'seller'] }, active: true },
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
      // Bot "TenisCash" avisa cliente
      try {
        const sysMsg = require('./systemMessenger');
        sysMsg.notifyCashbackEarned(user.id, tcEarned, nsOrder.id).catch(() => {});
      } catch (e) { /* ignora */ }
    }
  }

  // ===== PRÉ-EMISSÃO NFe MODELO 55 (Nuvemshop usa LOJA04 /0004-79) =====
  // Cria FiscalDocument em status 'draft' linkado à Sale + dados completos
  // do destinatário. Operador finaliza emissão pela aba Fiscal do admin
  // (ou em job batch). Mantém venda livre de bloqueio se faltar dado fiscal.
  try {
    if (nsOrder.payment_status === 'paid' && sale) {
      const issuer = await prisma.fiscalIssuer.findUnique({
        where: { cnpj: '44052617000479' }, // LOJA04 Ecommerce
      });
      if (issuer && issuer.active) {
        // Recipient = cliente do pedido Nuvemshop
        const c = nsOrder.customer || {};
        const addr = (nsOrder.shipping_address || {});
        const recipientName = c.name || (c.first_name || '') + ' ' + (c.last_name || '');
        const recipientDoc = (c.identification || '').replace(/\D/g, '');
        const fiscalDoc = await prisma.fiscalDocument.create({
          data: {
            issuerId: issuer.id,
            docType: 'NFE',
            serie: issuer.nfeSerie || 1,
            number: issuer.nfeNextNumber,
            status: 'draft', // aguardando emissão manual ou job
            recipientName: recipientName.trim() || 'CONSUMIDOR',
            recipientCnpjCpf: recipientDoc || null,
            recipientEmail: c.email || null,
            totalValue: parseFloat(nsOrder.total) || 0,
            productsValue: parseFloat(nsOrder.subtotal) || 0,
            freightValue: parseFloat(nsOrder.shipping_cost_customer) || 0,
            saleId: sale.id,
            productIds: (nsOrder.products || []).map(p => String(p.product_id)),
            payload: {
              source: 'nuvemshop-webhook',
              orderId: nsOrder.id,
              orderNumber: nsOrder.number,
              recipient: {
                name: recipientName.trim(),
                cpfCnpj: recipientDoc,
                email: c.email,
                phone: c.phone,
                address: {
                  street: addr.address,
                  number: addr.number,
                  complement: addr.floor || null,
                  neighborhood: addr.locality,
                  city: addr.city,
                  state: addr.province,
                  zip: (addr.zipcode || '').replace(/\D/g, ''),
                },
              },
            },
          },
        });
        await logSync('fiscal', 'ok', `order/paid ${nsOrder.id} → FiscalDocument NFe draft criada (id=${fiscalDoc.id})`);
      }
    }
  } catch (err) {
    console.error('[fiscal pre-emission NS]', err.message);
    await logSync('fiscal', 'error', `order/paid ${nsOrder.id} pré-emissão NFe falhou: ${err.message}`);
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

// =====================================================================
// PUSH: TenisCash → Nuvemshop (cria/atualiza produtos no e-commerce)
// =====================================================================

function ptObj(v) {
  // Nuvemshop usa multi-idioma: {pt: "..."}
  if (v == null) return null;
  return { pt: String(v) };
}

// =====================================================================
// Cache de categorias e marcas da Nuvemshop (evita N+1 lookups)
// =====================================================================

let _nsCategoryCache = null;
let _nsBrandCache = null;

async function loadNsCategories(connection) {
  if (_nsCategoryCache) return _nsCategoryCache;
  const cats = await ns.fetchAllPages(connection, '/categories', { perPage: 100, max: 500 });
  _nsCategoryCache = cats.map((c) => ({
    id: c.id,
    name: (typeof c.name === 'object' ? c.name.pt : c.name) || '',
    parentId: c.parent || null,
    handle: c.handle || null,
  }));
  return _nsCategoryCache;
}

async function loadNsBrands(connection) {
  // Nuvemshop não tem endpoint público de brands separado em todas as versões da API.
  // Brands são strings no produto. Mantemos só "produto.brand" como string mesmo.
  if (_nsBrandCache) return _nsBrandCache;
  _nsBrandCache = [];
  return _nsBrandCache;
}

function clearNsCache() {
  _nsCategoryCache = null;
  _nsBrandCache = null;
}

function normalize(s) {
  return String(s || '').trim().toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
}

async function findOrCreateCategory(connection, name) {
  if (!name) return null;
  const cats = await loadNsCategories(connection);
  const target = normalize(name);
  // Match por nome completo OU por último segmento (Tênis/Corrida → Corrida)
  let match = cats.find((c) => normalize(c.name) === target);
  if (!match) {
    const lastSeg = name.split('/').pop();
    match = cats.find((c) => normalize(c.name) === normalize(lastSeg));
  }
  if (match) return match.id;
  // Cria nova categoria raiz
  try {
    const created = await ns.nuvemshopApi(connection, 'POST', '/categories', {
      name: ptObj(name),
    });
    _nsCategoryCache.push({ id: created.id, name, parentId: null, handle: created.handle });
    return created.id;
  } catch (err) {
    await logSync('category', 'error', `Falha criar categoria "${name}": ${err.message}`);
    return null;
  }
}

// Versão hierárquica — match exige nome E parentId iguais.
// Cria com parent se não existir. Permite que 'LifeStyle' apareça sob
// Feminino/Homem/Menina/Menino sem colidir.
async function findOrCreateCategoryWithParent(connection, name, parentId) {
  if (!name) return null;
  const cats = await loadNsCategories(connection);
  const target = normalize(name);
  // Match por nome E mesmo parent (parentId null se for raiz)
  let match = cats.find((c) => normalize(c.name) === target && (c.parentId || null) === (parentId || null));
  if (match) return match.id;
  // Se não tem parent e existe categoria com mesmo nome em qualquer nível → reusa raiz se possível
  if (!parentId) {
    match = cats.find((c) => normalize(c.name) === target && !c.parentId);
    if (match) return match.id;
  }
  try {
    const body = { name: ptObj(name) };
    if (parentId) body.parent = parentId;
    const created = await ns.nuvemshopApi(connection, 'POST', '/categories', body);
    _nsCategoryCache.push({ id: created.id, name, parentId: parentId || null, handle: created.handle });
    return created.id;
  } catch (err) {
    await logSync('category', 'error', `Falha criar categoria "${name}" (parent=${parentId}): ${err.message}`);
    return null;
  }
}

function buildNuvemshopProductPayload(localProduct, sizes, opts = {}) {
  // opts.mode: 'create' (default) inclui variants; 'update' omite (NS rejeita variants em PUT)
  const mode = opts.mode || 'create';
  const hasSizes = sizes && sizes.length > 0;
  // Variants — uma por tamanho. Se produto não tem variação (acessório, bola, etc.),
  // cria 1 variant ÚNICA sem `values` (Nuvemshop exige variants.values.length === attributes.length).
  const variants = (hasSizes ? sizes : [{ size: null, stock: 0, barcode: null }]).map((s) => {
    const v = {
      price: String(Number(localProduct.price || 0).toFixed(2)),
      promotional_price: localProduct.promoPrice != null ? String(Number(localProduct.promoPrice).toFixed(2)) : null,
      stock_management: true,
      stock: parseInt(s.stock || 0, 10),
      sku: s.barcode || (hasSizes ? `${localProduct.sku}-${s.size}` : localProduct.sku),
      barcode: s.barcode || null,
    };
    // Só inclui values se tiver attributes (i.e., tiver tamanhos)
    if (hasSizes) v.values = [{ pt: String(s.size) }];
    return v;
  });

  // Coleta TODAS as imagens disponíveis
  const allImages = [];
  if (localProduct.imageUrl) allImages.push({ src: localProduct.imageUrl });
  if (localProduct.imageUrls) {
    try {
      const arr = typeof localProduct.imageUrls === 'string'
        ? JSON.parse(localProduct.imageUrls)
        : localProduct.imageUrls;
      if (Array.isArray(arr)) {
        arr.forEach((u) => { if (u && !allImages.find((i) => i.src === u)) allImages.push({ src: u }); });
      }
    } catch (_) {}
  }

  // Descrição: prioriza longa, depois curta. NÃO cai pro nome (causa duplicação no Nuvemshop).
  // Se nenhuma das duas existe, manda string vazia (Nuvemshop aceita).
  const description = localProduct.longDescription || localProduct.shortDescription || '';

  // SEO baseado em marca + nome
  const seoTitle = `${localProduct.brand || ''} ${localProduct.name}`.trim().slice(0, 70);
  const seoDescription = (description || '').slice(0, 160);

  // Published = produto ativo E classificação completa (category válida + subcategory + modality + tier)
  // Produtos sem classificação completa ficam ocultos pro cliente na loja online
  const isFullyClassified = (
    localProduct.active !== false
    && localProduct.category
    && localProduct.category !== 'A CLASSIFICAR'
    && localProduct.subcategory
    && opts.modality
    && opts.tier
  );

  const payload = {
    name: ptObj(localProduct.name),
    description: ptObj(description),
    brand: localProduct.brand || null,
    published: !!isFullyClassified,
    free_shipping: false,
    attributes: sizes && sizes.length ? [{ pt: 'Tamanho' }] : [],
    seo_title: ptObj(seoTitle),
    seo_description: ptObj(seoDescription),
    tags: [
      localProduct.brand,
      localProduct.category,
      localProduct.subcategory,
      opts.gender,
      opts.modality,
      opts.tier,
      ...(Array.isArray(opts.extraTags) ? opts.extraTags : []),
    ]
      .filter(Boolean)
      .map((s) => String(s).toLowerCase())
      .filter((v, i, a) => a.indexOf(v) === i)
      .join(','),
  };

  // Variants e Images só no CREATE — Nuvemshop rejeita ambos em PUT /products/:id
  // (422 "must not be present"). Pra UPDATE, usar endpoints separados:
  // - variants: PUT /products/:id/variants/:vid
  // - images: POST /products/:id/images (sem update direto — recria)
  if (mode === 'create') {
    payload.variants = variants;
    if (allImages.length) payload.images = allImages;
  }
  if (Array.isArray(opts.categoryIds) && opts.categoryIds.length) payload.categories = opts.categoryIds;

  return payload;
}

// Atualiza variants de um produto na Nuvemshop (chamado depois de PUT no produto)
async function updateNuvemshopVariants(connection, nsProductId, localProduct, sizes) {
  if (!sizes || !sizes.length) return { updated: 0, skipped: 0, errors: [] };

  // Pega variants atuais da NS
  let nsVariants;
  try {
    nsVariants = await ns.nuvemshopApi(connection, 'GET', `/products/${nsProductId}/variants`);
  } catch (e) {
    return { updated: 0, skipped: 0, errors: [{ reason: 'failed to fetch variants: ' + e.message }] };
  }
  if (!Array.isArray(nsVariants)) return { updated: 0, skipped: 0, errors: [{ reason: 'unexpected response' }] };

  const result = { updated: 0, skipped: 0, errors: [] };
  for (const sz of sizes) {
    // Match por SKU ou por valor de tamanho
    const expectedSku = `${localProduct.sku}-${sz.size}`;
    const nsVar = nsVariants.find(v =>
      v.sku === expectedSku ||
      v.sku === sz.barcode ||
      (Array.isArray(v.values) && v.values.some(val => String(val?.pt || val).trim() === String(sz.size).trim()))
    );
    if (!nsVar) { result.skipped++; continue; }
    const variantPayload = {
      price: String(Number(localProduct.price || 0).toFixed(2)),
      stock_management: true,
      stock: parseInt(sz.stock || 0, 10),
    };
    if (localProduct.promoPrice != null) variantPayload.promotional_price = String(Number(localProduct.promoPrice).toFixed(2));
    try {
      await ns.nuvemshopApi(connection, 'PUT', `/products/${nsProductId}/variants/${nsVar.id}`, variantPayload);
      result.updated++;
    } catch (e) {
      result.errors.push({ variantId: nsVar.id, size: sz.size, error: e.message });
    }
  }
  return result;
}

async function pushProductToNuvemshop(localProductId, connection) {
  const product = await prisma.product.findUnique({
    where: { id: localProductId },
    include: { sizes: true },
  });
  if (!product) throw new Error(`Produto ${localProductId} não encontrado`);

  const existingMapping = await prisma.nuvemshopProductMapping.findUnique({
    where: { localProductId: product.id },
  });

  // 1ª opção: aiContext.nuvemshopMapping (preenchido por IA via enrich-mappings)
  // 2ª opção: fallback por nome (cria categoria se não existir)
  const categoryIds = [];
  let aiTags = [];
  let aiGender = null;

  const aiCtx = (() => {
    try {
      if (!product.aiContext) return null;
      return typeof product.aiContext === 'string' ? JSON.parse(product.aiContext) : product.aiContext;
    } catch (_) { return null; }
  })();
  const aiMapping = aiCtx?.nuvemshopMapping;
  if (aiMapping && Array.isArray(aiMapping.categoryIds) && aiMapping.categoryIds.length) {
    categoryIds.push(...aiMapping.categoryIds);
    if (Array.isArray(aiMapping.tags)) aiTags = aiMapping.tags;
    if (aiMapping.gender) aiGender = aiMapping.gender;
  } else {
    // Constrói cadeia HIERÁRQUICA: Categoria > Subcategoria > Modalidade > Especialidade
    // Cada nível tem como pai o nó anterior, evitando colisão de nomes
    // (ex: 'LifeStyle' sob Feminino vs Homem vs Menina vs Menino).
    const modality = aiCtx?.classification?.modality || null;
    const tier = aiCtx?.classification?.tier || null;
    let parentId = null;
    if (product.category) {
      const catId = await findOrCreateCategoryWithParent(connection, product.category, null);
      if (catId) { categoryIds.push(catId); parentId = catId; }
    }
    if (product.subcategory && parentId) {
      const subId = await findOrCreateCategoryWithParent(connection, product.subcategory, parentId);
      if (subId) { categoryIds.push(subId); parentId = subId; }
    }
    if (modality && parentId) {
      const modId = await findOrCreateCategoryWithParent(connection, modality, parentId);
      if (modId) { categoryIds.push(modId); parentId = modId; }
    }
    if (tier && parentId) {
      const tierId = await findOrCreateCategoryWithParent(connection, tier, parentId);
      if (tierId) { categoryIds.push(tierId); }
    }
  }

  let nsProduct;
  let action;
  let variantSync = null;
  if (existingMapping) {
    // UPDATE — payload SEM variants (NS rejeita variants em PUT)
    const payload = buildNuvemshopProductPayload(product, product.sizes || [], {
      categoryIds, extraTags: aiTags, gender: aiGender,
      modality: aiCtx?.classification?.modality, tier: aiCtx?.classification?.tier,
      mode: 'update',
    });
    nsProduct = await ns.nuvemshopApi(
      connection,
      'PUT',
      `/products/${existingMapping.nuvemshopProductId}`,
      payload,
    );
    // Atualiza variants separadamente via /products/:id/variants/:vid
    variantSync = await updateNuvemshopVariants(connection, existingMapping.nuvemshopProductId, product, product.sizes || []);
    await prisma.nuvemshopProductMapping.update({
      where: { id: existingMapping.id },
      data: { lastSyncedAt: new Date(), syncStatus: 'synced' },
    });
    action = 'updated';
  } else {
    const payload = buildNuvemshopProductPayload(product, product.sizes || [], {
      categoryIds, extraTags: aiTags, gender: aiGender,
      modality: aiCtx?.classification?.modality, tier: aiCtx?.classification?.tier,
      mode: 'create',
    });
    nsProduct = await ns.nuvemshopApi(connection, 'POST', '/products', payload);
    await prisma.nuvemshopProductMapping.create({
      data: {
        localProductId: product.id,
        nuvemshopProductId: String(nsProduct.id),
        syncStatus: 'synced',
        lastSyncedAt: new Date(),
      },
    });
    action = 'created';
  }

  // Cria mapeamento de variants (precisa buscar o produto criado pra pegar IDs)
  if (action === 'created' && Array.isArray(nsProduct.variants)) {
    for (let i = 0; i < nsProduct.variants.length; i++) {
      const nsVar = nsProduct.variants[i];
      const localSize = (product.sizes || [])[i];
      if (localSize) {
        try {
          await prisma.nuvemshopVariantMapping.create({
            data: {
              localInventoryId: localSize.id,
              localProductId: product.id,
              nuvemshopProductId: String(nsProduct.id),
              nuvemshopVariantId: String(nsVar.id),
              sku: nsVar.sku || null,
              barcode: nsVar.barcode || null,
            },
          });
        } catch (_) { /* mapping pode já existir */ }
      }
    }
  }

  return { action, nuvemshopProductId: String(nsProduct.id), localProductId: product.id, variantSync };
}

async function pushAllProducts({ onlyMissing = true, limit = 1000, withImageOnly = false, supplierCnpj = null } = {}) {
  const connection = await getConnection();
  if (!connection) throw new Error('Sem conexão Nuvemshop ativa');

  // Quais produtos pushar?
  let where = { active: true };
  if (onlyMissing) {
    // Pega só os que NÃO têm mapping ainda
    const mapped = await prisma.nuvemshopProductMapping.findMany({ select: { localProductId: true } });
    const mappedIds = mapped.map((m) => m.localProductId);
    if (mappedIds.length) where.id = { notIn: mappedIds };
  }
  if (withImageOnly) {
    where.imageUrl = { not: null };
  }
  if (supplierCnpj) {
    where.aiContext = { path: ['supplierCnpj'], equals: String(supplierCnpj) };
  }

  const products = await prisma.product.findMany({ where, take: limit, orderBy: { createdAt: 'asc' } });
  let created = 0;
  let updated = 0;
  let failed = 0;
  const errors = [];

  for (const p of products) {
    try {
      const r = await pushProductToNuvemshop(p.id, connection);
      if (r.action === 'created') created++;
      else updated++;
      // Delay pequeno pra não estourar rate limit
      await new Promise((res) => setTimeout(res, 200));
    } catch (err) {
      failed++;
      errors.push({ sku: p.sku, error: err.message });
      await logSync('product', 'error', `Push ${p.sku}: ${err.message}`);
    }
  }

  await logSync('product', 'ok', `Push catálogo TenisCash → Nuvemshop: ${products.length} total, ${created} novos, ${updated} atualizados, ${failed} falhas`);
  return { total: products.length, created, updated, failed, errors: errors.slice(0, 20) };
}

async function pushStockUpdate(localProductId) {
  const product = await prisma.product.findUnique({
    where: { id: localProductId },
    include: { sizes: true },
  });
  if (!product) throw new Error('Produto não encontrado');
  const mapping = await prisma.nuvemshopProductMapping.findUnique({ where: { localProductId } });
  if (!mapping) throw new Error('Produto sem mapping com Nuvemshop');
  const connection = await getConnection();
  if (!connection) throw new Error('Sem conexão Nuvemshop ativa');

  let updates = 0;
  for (const s of product.sizes || []) {
    const vMapping = await prisma.nuvemshopVariantMapping.findFirst({
      where: { localInventoryId: s.id },
    });
    if (!vMapping) continue;
    await ns.updateVariantStock(connection, vMapping.nuvemshopProductId, vMapping.nuvemshopVariantId, s.stock || 0);
    updates++;
  }
  await logSync('product', 'ok', `Stock push ${product.sku}: ${updates} variants atualizados`);
  return { updates };
}

module.exports = {
  processWebhookEvent,
  importAllProducts,
  importAllCustomers,
  importRecentOrders,
  upsertLocalProduct,
  upsertLocalCustomer,
  upsertSaleFromOrder,
  pushProductToNuvemshop,
  pushAllProducts,
  pushStockUpdate,
};
