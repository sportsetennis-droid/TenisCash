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

const crypto = require('crypto');
const { prisma } = require('../middleware');
const ns = require('./nuvemshop');
const { assessProductForNuvemshop } = require('./nuvemshopEligibility');
const storeRadio = require('./storeRadio');

// Storefront currently bound to www.sportsetennis.com.br (LS.store.id).
// An env override keeps migrations possible without ever falling back to an
// arbitrary old active connection.
const DEFAULT_NUVEMSHOP_TARGET_USER_ID = '7890890';

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
  const targetId = String(
    process.env.NUVEMSHOP_TARGET_USER_ID || DEFAULT_NUVEMSHOP_TARGET_USER_ID,
  );
  const exact = await prisma.nuvemshopConnection.findFirst({
    where: { status: 'active', nuvemshopUserId: targetId },
  });
  if (exact) return exact;

  const active = await prisma.nuvemshopConnection.findMany({
    where: { status: 'active' },
    orderBy: { updatedAt: 'desc' },
    select: { nuvemshopUserId: true },
  });
  if (active.length === 0) return null;
  throw new Error(
    `Conexao Nuvemshop alvo ${targetId} nao encontrada; conexoes ativas: ${active.map((row) => row.nuvemshopUserId).join(',')}`,
  );
}

async function unpublishMappedProduct(localProductId, connection, reason, mappingOverride = null) {
  const mapping = mappingOverride || await prisma.nuvemshopProductMapping.findUnique({
    where: { localProductId },
  });
  if (!mapping) return { unpublished: false, reason: 'produto sem mapping' };

  const conn = connection || await getConnection();
  if (!conn) throw new Error('Sem conexao Nuvemshop ativa');

  try {
    await ns.nuvemshopApi(conn, 'PUT', `/products/${mapping.nuvemshopProductId}`, {
      published: false,
    });
  } catch (error) {
    if (!/404|not found/i.test(String(error.message))) throw error;
  }

  await prisma.nuvemshopProductMapping.update({
    where: { id: mapping.id },
    data: { syncStatus: 'hidden-invalid', lastSyncedAt: new Date() },
  }).catch(() => {});
  await logSync(
    'product',
    'ok',
    `Despublicado por gate de qualidade: ${localProductId} (${reason || 'invalido'})`,
    { localProductId, nuvemshopProductId: mapping.nuvemshopProductId, reason },
  );
  return {
    unpublished: true,
    localProductId,
    nuvemshopProductId: String(mapping.nuvemshopProductId),
    reason,
  };
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

  // GUARDA ANTI-ECO (2026-06-08): se alguma variante casa com um ProductSize existente
  // (o sku/barcode da variante NO NS é o EAN = ProductSize.barcode), este produto NASCEU
  // no TenisCash e foi empurrado pro Nuvemshop — o webhook product/created é só o ECO do push.
  // NÃO espelhar (não criar card-fantasma nem sobrescrever o card curado): só GARANTIR o
  // mapping no card local existente (upsert, idempotente p/ corrida com o push) e sair.
  {
    const codes = variants
      .map((v) => v.barcode || v.sku)
      .filter((c) => c && /^[0-9]{6,}$/.test(String(c)));
    if (codes.length) {
      const ps = await prisma.productSize.findFirst({
        where: { barcode: { in: codes } },
        select: { productId: true },
      });
      if (ps) {
        await prisma.nuvemshopProductMapping.upsert({
          where: { localProductId: ps.productId },
          create: { localProductId: ps.productId, nuvemshopProductId: String(nsProduct.id), syncStatus: 'synced', lastSyncedAt: new Date() },
          update: { nuvemshopProductId: String(nsProduct.id), syncStatus: 'synced', lastSyncedAt: new Date() },
        });
        return prisma.product.findUnique({ where: { id: ps.productId } });
      }
    }
  }

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

// Baixa o estoque FÍSICO (StoreStock) dos itens de um pedido Nuvemshop.
// Regra do dono: baixa de onde o produto ESTÁ — prioridade LOJA04, senão qualquer outra loja.
// Mexe só no StoreStock (localizado); não toca no comprado. Nunca deixa negativo.
async function decrementPhysicalStockForOrder(nsOrder) {
  const items = Array.isArray(nsOrder.products) ? nsOrder.products : [];
  const loja04 = await prisma.store.findFirst({ where: { code: 'LOJA04' }, select: { id: true } });
  const loja04Id = loja04?.id || null;
  for (const it of items) {
    const code = String(it.sku || it.barcode || '').trim();
    const qty = Number(it.quantity) || 1;
    if (!code || qty <= 0) continue;
    const ps = await prisma.productSize.findFirst({ where: { barcode: code }, select: { id: true } });
    if (!ps) continue;
    const stocks = await prisma.storeStock.findMany({
      where: { productSizeId: ps.id, stock: { gt: 0 } },
      select: { id: true, storeId: true, stock: true },
    });
    // LOJA04 primeiro; depois loja com maior estoque
    stocks.sort((a, b) => {
      const a4 = loja04Id && a.storeId === loja04Id ? 0 : 1;
      const b4 = loja04Id && b.storeId === loja04Id ? 0 : 1;
      return a4 - b4 || b.stock - a.stock;
    });
    let remaining = qty;
    for (const s of stocks) {
      if (remaining <= 0) break;
      const dec = Math.min(remaining, s.stock);
      await prisma.storeStock.update({ where: { id: s.id }, data: { stock: { decrement: dec } } });
      remaining -= dec;
    }
  }
}

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

  // order/paid pode chegar depois de order/created: transforma a Sale local
  // em concluída antes de criar o anúncio (sem repetir em webhooks duplicados).
  if (sale && nsOrder.payment_status === 'paid' && sale.status !== 'completed') {
    sale = await prisma.sale.update({ where: { id: sale.id }, data: { status: 'completed' } });
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

  // 3a. Baixa estoque FÍSICO (StoreStock) na venda online — prioridade LOJA04, senão qualquer loja.
  // Idempotente por pedido (flag _stockDecremented no payload do mapping). O cron espelha o físico → Nuvemshop.
  if (nsOrder.payment_status === 'paid' && !(existing && existing.payload && existing.payload._stockDecremented)) {
    try {
      await decrementPhysicalStockForOrder(nsOrder);
      await prisma.nuvemshopOrderMapping.updateMany({
        where: { nuvemshopOrderId: String(nsOrder.id) },
        data: { payload: { ...nsOrder, _stockDecremented: true } },
      });
    } catch (e) { await logSync('order', 'error', `Baixa estoque pedido ${nsOrder.id}: ${e.message}`); }
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

  // 3b. Comissão do Creation (independe de o cliente ter conta). Idempotente por nsOrderId.
  if (nsOrder.payment_status === 'paid') {
    await creditPartnerFromOrder(nsOrder);
    // 3c. Resgate de TenisCash: se o cupom usado é de resgate, debita o saldo.
    await consumeCashbackRedemptionFromOrder(nsOrder);
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
        // cMun (código IBGE do município do destinatário): a Nuvemshop não envia, mas a SEFAZ exige
        // (senão rejeita comprador fora de João Pessoa). Resolve via ViaCEP (best-effort, não bloqueia).
        const zipDigits = (addr.zipcode || '').replace(/\D/g, '');
        let cityCode = null;
        if (zipDigits.length === 8) {
          try {
            const cepResp = await fetch('https://viacep.com.br/ws/' + zipDigits + '/json/', { signal: AbortSignal.timeout(8000) });
            const cepJson = await cepResp.json();
            if (cepJson && cepJson.ibge) cityCode = String(cepJson.ibge);
          } catch (e) { /* best-effort: emitNFe55 cai no default se faltar */ }
        }
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
                  zip: zipDigits,
                  cityCode,
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

  if (nsOrder.payment_status === 'paid' && sale) {
    await storeRadio.queueSaleAnnouncement(sale.id).catch((err) => {
      console.error('[store-radio] venda Nuvemshop:', err.message);
    });
  }

  return sale;
}

// ---------------------------------------------------------------------
// Interligação Creation ⇄ Nuvemshop (lado entrada): pedido pago com cupom
// de um Creation → cria PartnerSale + credita comissão (partnerBalance).
// Idempotente por nsOrderId. Não derruba o fluxo principal se falhar.
// ---------------------------------------------------------------------
function normalizeCouponCode(raw) {
  return String(raw || '').trim().toUpperCase().replace(/\s+/g, '').replace(/[^A-Z0-9_-]/g, '').slice(0, 32);
}

function tierFromPartnerSales(totalSales) {
  if (totalSales >= 100) return 'platina';
  if (totalSales >= 31) return 'ouro';
  if (totalSales >= 10) return 'prata';
  return 'bronze';
}

// Extrai o(s) código(s) de cupom do pedido NS (campo `coupon` costuma ser array).
function extractOrderCouponCodes(nsOrder) {
  const out = [];
  const c = nsOrder.coupon;
  if (Array.isArray(c)) { for (const x of c) { const code = normalizeCouponCode(x?.code || x); if (code) out.push(code); } }
  else if (c && typeof c === 'object') { const code = normalizeCouponCode(c.code); if (code) out.push(code); }
  else if (typeof c === 'string') { const code = normalizeCouponCode(c); if (code) out.push(code); }
  return out;
}

async function creditPartnerFromOrder(nsOrder) {
  try {
    const codes = extractOrderCouponCodes(nsOrder);
    if (!codes.length) return null;

    // Idempotência: já processamos esse pedido pro programa Creation?
    const dup = await prisma.partnerSale.findFirst({ where: { nsOrderId: String(nsOrder.id) } });
    if (dup) return dup;

    // Acha o Creation dono de algum dos cupons do pedido
    const partner = await prisma.partner.findFirst({
      where: { couponCode: { in: codes }, status: 'active' },
      include: { user: { select: { id: true, name: true } } },
    });
    if (!partner) return null;

    // Valores: saleAmountFull = produtos a preço cheio (subtotal);
    // discountValue = desconto do cupom (NS manda discount_coupon); fallback = % do Creation.
    // NOTA: semântica dos campos de cupom do pedido NS precisa ser confirmada com um pedido real.
    const subtotal = parseFloat(nsOrder.subtotal);
    const productTotal = parseFloat(nsOrder.total) || 0;
    const saleAmountFull = Number.isFinite(subtotal) && subtotal > 0 ? subtotal : productTotal;
    let discountValue = parseFloat(nsOrder.discount_coupon);
    if (!Number.isFinite(discountValue) || discountValue <= 0) {
      discountValue = Number((saleAmountFull * (partner.discountPct || 0) / 100).toFixed(2));
    }
    const saleAmount = Number(Math.max(0, saleAmountFull - discountValue).toFixed(2));
    const commissionT = Number((saleAmount * (partner.commissionPct || 0) / 100).toFixed(2));

    const c = nsOrder.customer || {};
    const customerName = (c.name || ((c.first_name || '') + ' ' + (c.last_name || ''))).trim() || null;
    const customerCpf = (c.identification || '').replace(/\D/g, '') || null;
    const products = Array.isArray(nsOrder.products)
      ? nsOrder.products.map((p) => ({ sku: String(p.sku || p.variant_id || ''), name: pickStr(p.name) || '', qty: Number(p.quantity) || 1, price: parseFloat(p.price) || 0 }))
      : [];

    const result = await prisma.$transaction(async (tx) => {
      const sale = await tx.partnerSale.create({
        data: {
          partnerId: partner.id,
          customerName,
          customerCpf,
          customerPhone: (c.phone || '').replace(/\D/g, '') || null,
          saleAmount,
          saleAmountFull,
          discountValue,
          commissionT,
          products: products.length ? JSON.stringify(products) : null,
          status: 'approved',
          channel: 'nuvemshop',
          nsOrderId: String(nsOrder.id),
        },
      });
      const updatedUser = await tx.user.update({
        where: { id: partner.userId },
        data: { partnerBalance: { increment: commissionT } },
      });
      await tx.transaction.create({
        data: {
          type: 'partner_commission',
          amount: commissionT,
          description: `Comissão cupom ${partner.couponCode} — pedido NS-${nsOrder.id}`,
          receiverId: partner.userId,
          balanceAfter: updatedUser.partnerBalance,
          metadata: JSON.stringify({ partnerSaleId: sale.id, couponCode: partner.couponCode, nsOrderId: String(nsOrder.id), wallet: 'partnerBalance', channel: 'nuvemshop' }),
        },
      });
      const newTotalSales = partner.totalSales + 1;
      await tx.partner.update({
        where: { id: partner.id },
        data: {
          totalSales: newTotalSales,
          totalRevenue: partner.totalRevenue + saleAmount,
          totalCommission: partner.totalCommission + commissionT,
          tier: tierFromPartnerSales(newTotalSales),
        },
      });
      return { sale, commissionT };
    });

    await logSync('order', 'ok', `order/paid ${nsOrder.id} → comissão Creation ${partner.couponCode}: T$ ${result.commissionT}`);
    return result.sale;
  } catch (err) {
    console.error('[creation commission NS]', err.message);
    await logSync('order', 'error', `order/paid ${nsOrder.id} comissão Creation falhou: ${err.message}`);
    return null;
  }
}

// Estorna a comissão do Creation quando o pedido NS é cancelado. Idempotente:
// só age se houver PartnerSale 'approved' por esse nsOrderId.
async function reversePartnerCommission(nsOrderId) {
  try {
    const ps = await prisma.partnerSale.findFirst({
      where: { nsOrderId: String(nsOrderId), channel: 'nuvemshop', status: { not: 'refunded' } },
      include: { partner: true },
    });
    if (!ps || !ps.partner) return;
    await prisma.$transaction(async (tx) => {
      await tx.partnerSale.update({ where: { id: ps.id }, data: { status: 'refunded' } });
      const updatedUser = await tx.user.update({
        where: { id: ps.partner.userId },
        data: { partnerBalance: { decrement: ps.commissionT } },
      });
      await tx.transaction.create({
        data: {
          type: 'partner_commission_reversal',
          amount: ps.commissionT,
          description: `Estorno comissão cupom ${ps.partner.couponCode} — pedido NS-${nsOrderId} cancelado`,
          senderId: ps.partner.userId,
          balanceAfter: updatedUser.partnerBalance,
          metadata: JSON.stringify({ partnerSaleId: ps.id, couponCode: ps.partner.couponCode, nsOrderId: String(nsOrderId), wallet: 'partnerBalance', channel: 'nuvemshop', reversal: true }),
        },
      });
      await tx.partner.update({
        where: { id: ps.partner.id },
        data: {
          totalSales: { decrement: 1 },
          totalRevenue: { decrement: ps.saleAmount },
          totalCommission: { decrement: ps.commissionT },
        },
      });
    });
    await logSync('order', 'ok', `order/cancelled ${nsOrderId} → comissão Creation ${ps.partner.couponCode} estornada (T$ ${ps.commissionT})`);
  } catch (err) {
    console.error('[creation reversal NS]', err.message);
    await logSync('order', 'error', `order/cancelled ${nsOrderId} estorno comissão Creation falhou: ${err.message}`);
  }
}

// ---------------------------------------------------------------------
// Resgate de TenisCash (lado entrada): pedido pago com cupom de resgate.
// O saldo JÁ foi RESERVADO (hold) quando o cupom foi gerado (balance -= maxAmount).
// Aqui só RECONCILIA: usedAmount = min(desconto real, maxAmount). Se o carrinho
// ficou abaixo do teto (10% do carrinho < maxAmount), devolve a diferença reservada.
// NÃO debita de novo. Idempotente por nsOrderId. NÃO derruba o fluxo principal.
// ---------------------------------------------------------------------
async function consumeCashbackRedemptionFromOrder(nsOrder) {
  try {
    const codes = extractOrderCouponCodes(nsOrder);
    if (!codes.length) return null;

    const redemption = await prisma.cashbackRedemption.findFirst({
      where: { couponCode: { in: codes }, status: 'pending' },
    });
    if (!redemption) return null;
    if (redemption.nsOrderId === String(nsOrder.id)) return redemption; // idempotência

    // Valor descontado pelo cupom (NS manda discount_coupon); fallback = pct do subtotal.
    let discount = parseFloat(nsOrder.discount_coupon);
    if (!Number.isFinite(discount) || discount <= 0) {
      const subtotal = parseFloat(nsOrder.subtotal) || parseFloat(nsOrder.total) || 0;
      discount = Number((subtotal * (redemption.pct || 0) / 100).toFixed(2));
    }

    const user = await prisma.user.findUnique({ where: { id: redemption.userId }, select: { id: true, balance: true } });
    if (!user) return null;

    const held = Number(redemption.maxAmount) || 0;            // valor que foi reservado
    const used = Number(Math.max(0, Math.min(discount, held)).toFixed(2)); // realmente consumido (<= reservado)
    const refund = Number(Math.max(0, held - used).toFixed(2)); // sobra do reservado -> volta pro cliente

    await prisma.$transaction(async (tx) => {
      let balanceAfter = user.balance;
      if (refund > 0) {
        const updatedUser = await tx.user.update({
          where: { id: user.id },
          data: { balance: { increment: refund } },
        });
        balanceAfter = updatedUser.balance;
        await tx.transaction.create({
          data: {
            type: 'cashback_redeem_hold_release',
            amount: refund,
            description: `Sobra do TenisCash reservado devolvida — pedido NS-${nsOrder.id} (cupom ${redemption.couponCode})`,
            receiverId: user.id,
            balanceAfter,
            metadata: JSON.stringify({ redemptionId: redemption.id, couponCode: redemption.couponCode, nsOrderId: String(nsOrder.id), wallet: 'balance', channel: 'nuvemshop', hold: 'partial_release' }),
          },
        });
      }
      await tx.cashbackRedemption.update({
        where: { id: redemption.id },
        data: { status: 'consumed', usedAmount: used, nsOrderId: String(nsOrder.id), consumedAt: new Date() },
      });
    });
    const debit = used;

    // Queima o cupom na NS (já é uso único, mas limpamos pra não poluir a loja).
    try {
      if (redemption.nsCouponId) {
        const conn = await getConnection();
        if (conn) await ns.deleteCoupon(conn, redemption.nsCouponId);
      }
    } catch (_) { /* uso único já protege contra reuso */ }

    await logSync('order', 'ok', `order/paid ${nsOrder.id} → resgate TenisCash debitado: R$ ${debit} de ${user.id}`);
    return redemption;
  } catch (err) {
    console.error('[redeem consume NS]', err.message);
    await logSync('order', 'error', `order/paid ${nsOrder.id} resgate TenisCash falhou: ${err.message}`);
    return null;
  }
}

// Estorna o resgate de TenisCash quando o pedido é cancelado (idempotente).
async function reverseCashbackRedemption(nsOrderId) {
  try {
    const r = await prisma.cashbackRedemption.findFirst({
      where: { nsOrderId: String(nsOrderId), status: 'consumed' },
    });
    if (!r || r.usedAmount <= 0) return;
    await prisma.$transaction(async (tx) => {
      const u = await tx.user.update({
        where: { id: r.userId },
        data: { balance: { increment: r.usedAmount } },
      });
      await tx.cashbackRedemption.update({ where: { id: r.id }, data: { status: 'cancelled' } });
      await tx.transaction.create({
        data: {
          type: 'cashback_redeem_reversal',
          amount: r.usedAmount,
          description: `Estorno resgate TenisCash — pedido NS-${nsOrderId} cancelado`,
          receiverId: r.userId,
          balanceAfter: u.balance,
          metadata: JSON.stringify({ redemptionId: r.id, couponCode: r.couponCode, nsOrderId: String(nsOrderId), wallet: 'balance', channel: 'nuvemshop', reversal: true }),
        },
      });
    });
    await logSync('order', 'ok', `order/cancelled ${nsOrderId} → resgate TenisCash estornado: R$ ${r.usedAmount}`);
  } catch (err) {
    console.error('[redeem reversal NS]', err.message);
    await logSync('order', 'error', `order/cancelled ${nsOrderId} estorno resgate TenisCash falhou: ${err.message}`);
  }
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
            },
          });
        });
      }
    }
    // Estorna comissão do Creation, se houve PartnerSale por esse pedido (idempotente: status refunded)
    await reversePartnerCommission(String(resourceId));
    // Devolve o TenisCash que foi descontado via cupom de resgate, se houve (idempotente: status cancelled)
    await reverseCashbackRedemption(String(resourceId));
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
  const cats = await ns.fetchAllPages(connection, '/categories', { perPage: 100, max: 3000 });
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

// Aliases de nome na resolução de categoria — a árvore do menu usa "Treinamento"
// onde a classificação interna diz "Treino", e existe o typo histórico "Profissinal"
// numa categoria do admin. Match nos DOIS sentidos.
const CATEGORY_NAME_ALIASES = { treino: 'treinamento', profissinal: 'profissional', lifestyle: 'estilo de vida' };

function categoryNameMatches(catName, wantedName) {
  const a = normalize(catName);
  const b = normalize(wantedName);
  return a === b || CATEGORY_NAME_ALIASES[a] === b || CATEGORY_NAME_ALIASES[b] === a;
}

function findCategoryInLevel(cats, name, parentId) {
  const cands = cats.filter((c) => categoryNameMatches(c.name, name) && (c.parentId || null) === (parentId || null));
  if (!cands.length) return null;
  // Entre nomes duplicados no mesmo nível, o MENOR id é o nó original do menu
  // (duplicatas de id maior foram criadas por pushes antigos que não achavam o nome).
  return cands.reduce((a, b) => (Number(a.id) <= Number(b.id) ? a : b));
}

// Resolve a cadeia Categoria > Sub > Modalidade > Especialidade contra a árvore REAL
// da loja, pra o produto cair nas categorias que o menu do site aponta:
// - match por nome normalizado sob o pai atual; duplicata → menor id (nó do menu)
// - nível que NÃO existe sob o pai é PULADO se o nível seguinte casar — ex. classificação
//   "Chuteiras > Homem > Futsal" numa árvore "Chuteiras > Futsal" (sem nível de gênero)
// - só cria categoria quando o nome não existe nem com skip (árvore genuinamente nova)
async function resolveChainAgainstTree(connection, names) {
  const wanted = (names || []).map((n) => String(n || '').trim()).filter(Boolean);
  if (!wanted.length) return [];
  const cats = await loadNsCategories(connection);
  const ids = [];
  let parentId = null;
  for (let i = 0; i < wanted.length; i++) {
    const found = findCategoryInLevel(cats, wanted[i], parentId);
    if (found) { ids.push(found.id); parentId = found.id; continue; }
    const next = wanted[i + 1];
    if (next && findCategoryInLevel(cats, next, parentId)) continue; // pula nível ausente (gênero)
    const createdId = await findOrCreateCategoryWithParent(connection, wanted[i], parentId);
    if (!createdId) return []; // falha de API — retorna vazio em vez de IDs parciais que NS rejeita com 422
    ids.push(createdId); parentId = createdId;
  }
  return ids;
}

// Categoria de MARCA: filha da raiz "Marcas" do menu (handle histórico "roupas").
// O produto SEMPRE entra na página da sua marca — sem isso as 24 páginas de marca
// do menu ficam vazias pra sempre (o push antigo nunca atribuía marca).
async function findOrCreateBrandCategory(connection, brandName) {
  const brand = String(brandName || '').trim();
  if (!brand) return null;
  const cats = await loadNsCategories(connection);
  const roots = cats.filter((c) => !c.parentId && normalize(c.name) === 'marcas');
  if (!roots.length) return null;
  const root = roots.reduce((a, b) => (Number(a.id) <= Number(b.id) ? a : b));
  const existing = cats.filter((c) => (c.parentId || null) === root.id && normalize(c.name) === normalize(brand));
  if (existing.length) return existing.reduce((a, b) => (Number(a.id) <= Number(b.id) ? a : b)).id;
  // marca local costuma vir TODA-CAPS ("NEW BALANCE") — cria com capitalização de título
  const pretty = brand.replace(/\S+/g, (w) => (w === w.toUpperCase() && w.length > 2 ? w[0] + w.slice(1).toLowerCase() : w));
  return findOrCreateCategoryWithParent(connection, pretty, root.id);
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

  // Coleta TODAS as imagens disponíveis. data:URL (base64) → { attachment } (Nuvemshop
  // rejeita base64 no campo src com 422); URL http(s) → { src }.
  const allImages = [];
  const seenImg = new Set();
  const toImgBody = (u) => {
    const m = /^data:([^;]+);base64,(.*)$/s.exec(u);
    if (m) {
      const ext = (m[1].split('/')[1] || 'jpg').replace('jpeg', 'jpg').replace('svg+xml', 'svg');
      return { attachment: m[2], filename: `img-${seenImg.size}.${ext}` };
    }
    return { src: u };
  };
  // Nuvemshop rejeita ("src not a valid url") URLs de crawler/placeholder (ex:
  // lookaside.instagram.com/...crawler/?media_id=). Só aceita data:URI (→attachment)
  // ou URL http(s) limpa de imagem. URL-lixo é PULADA (produto sobe com as válidas).
  const isHttpImg = (u) => /^https?:\/\//i.test(u) && !/lookaside\.instagram\.com|\/crawler\/|google_widget|\/seo\//i.test(u);
  // Espaços não-codificados causam "not a valid url" no NS — % encode antes de enviar.
  const sanitizeUrl = (u) => (u.includes(' ') ? u.replace(/ /g, '%20') : u);
  const addImg = (u) => {
    if (!u || typeof u !== 'string') return;
    const norm = sanitizeUrl(u);
    if (seenImg.has(norm)) return;
    const isData = /^data:[^;]+;base64,/.test(norm);
    if (!isData && !isHttpImg(norm)) return;
    seenImg.add(norm); allImages.push(toImgBody(norm));
  };
  if (localProduct.imageUrl) addImg(localProduct.imageUrl);
  if (localProduct.imageUrls) {
    try {
      const arr = typeof localProduct.imageUrls === 'string'
        ? JSON.parse(localProduct.imageUrls)
        : localProduct.imageUrls;
      if (Array.isArray(arr)) arr.forEach(addImg);
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
    // Regra do dono 2026-06-08: só publica se houver estoque físico (sized → ≥1 tamanho com stock>0).
    && (!Array.isArray(sizes) || sizes.length === 0 || sizes.some((s) => Number(s.stock || 0) > 0))
  );

  // Marcação manual do dono: aiContext.hideFromNuvemshop força published=false (tira da VITRINE
  // sem APAGAR o produto — link/dados/avaliações ficam). Vale no create E no update, então
  // qualquer sync (clique ou cron de 5 min) mantém oculto enquanto a marca estiver ligada.
  const _hideCtx = (() => { try { return typeof localProduct.aiContext === 'string' ? JSON.parse(localProduct.aiContext) : (localProduct.aiContext || {}); } catch { return {}; } })();
  const hiddenManually = _hideCtx.hideFromNuvemshop === true;

  const payload = {
    name: ptObj(localProduct.name),
    description: ptObj(description),
    brand: localProduct.brand || null,
    published: !!isFullyClassified && !hiddenManually,
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

// Reconcilia variants de um produto na Nuvemshop com os tamanhos DISPONÍVEIS (estoque físico > 0).
// A loja deve ter EXATAMENTE os tamanhos disponíveis: atualiza os que existem, CRIA os que passaram
// a ter estoque, e DELETA os que zeraram (pra o tamanho sumir da loja — não basta esgotar, o tema
// continua exibindo). Regra do dono 2026-06-08: "sincronizar apenas com os tamanhos disponíveis".
async function updateNuvemshopVariants(connection, nsProductId, localProduct, sizes, options = {}) {
  const stockOnly = options.stockOnly === true;
  const desired = Array.isArray(sizes) ? sizes.filter((s) => Number(s.stock || 0) > 0) : [];

  let nsVariants;
  try {
    nsVariants = await ns.nuvemshopApi(connection, 'GET', `/products/${nsProductId}/variants`);
  } catch (e) {
    return { updated: 0, created: 0, deleted: 0, errors: [{ reason: 'failed to fetch variants: ' + e.message }] };
  }
  if (!Array.isArray(nsVariants)) return { updated: 0, created: 0, deleted: 0, errors: [{ reason: 'unexpected response' }] };

  const result = { updated: 0, created: 0, deleted: 0, unchanged: 0, errors: [] };
  const price = String(Number(localProduct.price || 0).toFixed(2));
  const promo = localProduct.promoPrice != null ? String(Number(localProduct.promoPrice).toFixed(2)) : null;
  const sizeOf = (v) => (Array.isArray(v.values) && v.values[0]) ? String(v.values[0].pt || v.values[0].name || '').trim() : '';
  const matchVar = (sz) => nsVariants.find((v) =>
    v.sku === `${localProduct.sku}-${sz.size}` ||
    (sz.barcode && (v.sku === sz.barcode || v.barcode === sz.barcode)) ||
    sizeOf(v) === String(sz.size).trim()
  );

  // Sem nenhum tamanho disponível: zera tudo (esgotado) e NÃO deleta (NS exige >=1 variante);
  // o produto é despublicado no PUT do produto (isFullyClassified exige estoque).
  if (!desired.length) {
    for (const v of nsVariants) {
      if (v.stock_management === true && Number(v.stock || 0) === 0) {
        result.unchanged++;
        continue;
      }
      try { await ns.nuvemshopApi(connection, 'PUT', `/products/${nsProductId}/variants/${v.id}`, { stock_management: true, stock: 0 }); result.updated++; }
      catch (e) { result.errors.push({ variantId: v.id, error: e.message }); }
    }
    return result;
  }

  // 1) UPSERT dos disponíveis: PUT se a variante existe, POST se o tamanho passou a ter estoque.
  const keepIds = new Set();
  for (const sz of desired) {
    const nsVar = matchVar(sz);
    const desiredStock = parseInt(sz.stock || 0, 10);
    const payload = { stock_management: true, stock: desiredStock };
    if (!stockOnly || !nsVar) {
      payload.price = price;
      if (promo != null) payload.promotional_price = promo;
    }
    try {
      if (nsVar) {
        keepIds.add(String(nsVar.id));
        if (nsVar.stock_management === true && Number(nsVar.stock || 0) === desiredStock) {
          result.unchanged++;
        } else {
          await ns.nuvemshopApi(connection, 'PUT', `/products/${nsProductId}/variants/${nsVar.id}`, payload);
          result.updated++;
        }
      } else {
        payload.values = [{ pt: String(sz.size) }];
        payload.sku = sz.barcode || `${localProduct.sku}-${sz.size}`;
        if (sz.barcode) payload.barcode = sz.barcode;
        const created = await ns.nuvemshopApi(connection, 'POST', `/products/${nsProductId}/variants`, payload);
        if (created && created.id) keepIds.add(String(created.id));
        result.created++;
      }
    } catch (e) {
      result.errors.push({ size: sz.size, error: e.message });
    }
  }

  // 2) DELETE das variantes de tamanho SEM estoque (somem da loja). Guarda: keepIds tem >=1.
  for (const v of nsVariants) {
    if (keepIds.has(String(v.id))) continue;
    try {
      await ns.nuvemshopApi(connection, 'DELETE', `/products/${nsProductId}/variants/${v.id}`);
      result.deleted++;
    } catch (e) {
      result.errors.push({ variantId: v.id, del: true, error: e.message });
    }
  }
  return result;
}

// =====================================================================
// SYNC DE IMAGENS — Nuvemshop só aceita "images" no POST /products (create).
// No PUT /products/:id ele IGNORA images. Resultado: trocar/adicionar foto
// num produto já listado NUNCA aparecia na loja ("não aparece todas as fotos").
// Aqui reconciliamos via os endpoints dedicados de imagem, e só quando o
// conjunto local muda de fato (assinatura em aiContext.nsImagesSig evita
// re-upload a cada sync de estoque/preço).
// =====================================================================

// Junta imageUrl (capa) + imageUrls[] numa lista ordenada e deduplicada.
function collectLocalImages(localProduct) {
  const out = [];
  const push = (u) => { if (u && typeof u === 'string' && !out.includes(u)) out.push(u); };
  push(localProduct.imageUrl);
  if (localProduct.imageUrls) {
    try {
      const arr = typeof localProduct.imageUrls === 'string'
        ? JSON.parse(localProduct.imageUrls)
        : localProduct.imageUrls;
      if (Array.isArray(arr)) arr.forEach(push);
    } catch (_) {}
  }
  return out;
}

// Assinatura estável do conjunto (ordem importa — 1ª = capa).
function imageSignature(imgs) {
  return crypto.createHash('sha1').update(imgs.join('|')).digest('hex');
}

function ctxOf(localProduct) {
  try { return typeof localProduct.aiContext === 'string' ? JSON.parse(localProduct.aiContext) : (localProduct.aiContext || {}); }
  catch { return {}; }
}

// Converte uma src local no corpo aceito pelo POST /products/:id/images.
// URL http(s) → { src } (Nuvemshop baixa). data:URL → { attachment, filename }.
function imageBodyFromSrc(src, position) {
  const body = { position };
  const m = /^data:([^;]+);base64,(.*)$/s.exec(src);
  if (m) {
    const ext = (m[1].split('/')[1] || 'jpg').replace('jpeg', 'jpg').replace('svg+xml', 'svg');
    body.attachment = m[2];
    body.filename = `img-${position}.${ext}`;
  } else {
    body.src = src;
  }
  return body;
}

// Reconcilia as imagens do produto na Nuvemshop (replace-all, só quando muda).
async function syncNuvemshopImages(connection, nsProductId, localProduct) {
  const desired = collectLocalImages(localProduct);
  const sig = desired.length ? imageSignature(desired) : 'empty';
  const ctx = ctxOf(localProduct);
  if (ctx.nsImagesSig === sig) return { changed: false, added: 0, removed: 0, sig };

  // Apaga as atuais
  let removed = 0;
  try {
    const current = await ns.nuvemshopApi(connection, 'GET', `/products/${nsProductId}/images`);
    if (Array.isArray(current)) {
      for (const img of current) {
        try { await ns.nuvemshopApi(connection, 'DELETE', `/products/${nsProductId}/images/${img.id}`); removed++; }
        catch (e) { console.warn('[ns img] delete falhou', img.id, e.message); }
      }
    }
  } catch (e) { console.warn('[ns img] GET atual falhou:', e.message); }

  // Sobe as locais na ordem (1ª = capa)
  let added = 0;
  const errors = [];
  for (let i = 0; i < desired.length; i++) {
    try {
      await ns.nuvemshopApi(connection, 'POST', `/products/${nsProductId}/images`, imageBodyFromSrc(desired[i], i + 1));
      added++;
    } catch (e) { errors.push({ position: i + 1, error: e.message }); console.warn('[ns img] POST falhou pos', i + 1, e.message); }
  }

  // Persiste assinatura (só se algo subiu, ou se zeramos de propósito)
  if (added > 0 || desired.length === 0) {
    ctx.nsImagesSig = sig;
    try { await prisma.product.update({ where: { id: localProduct.id }, data: { aiContext: ctx } }); }
    catch (e) { console.warn('[ns img] salvar sig falhou:', e.message); }
  }
  return { changed: true, added, removed, sig, errors };
}

// Trava anti-corrida POR PRODUTO (mesmo processo): cron + clique do admin no mesmo
// instante reaproveitam a MESMA execução em vez de fazer 2 CREATEs (origem da
// duplicata Caju TOP MX 2026-06-12: dois pushes no mesmo segundo → 2 produtos na loja).
const _pushInFlight = new Map();
function pushProductToNuvemshop(localProductId, connection) {
  const inflight = _pushInFlight.get(localProductId);
  if (inflight) return inflight;
  const p = _pushProductToNuvemshopInner(localProductId, connection)
    .finally(() => _pushInFlight.delete(localProductId));
  _pushInFlight.set(localProductId, p);
  return p;
}

async function _pushProductToNuvemshopInner(localProductId, connection) {
  const product = await prisma.product.findUnique({
    where: { id: localProductId },
    include: { sizes: { include: { storeStocks: { select: { stock: true } } } } },
  });
  if (!product) throw new Error(`Produto ${localProductId} não encontrado`);

  const existingMapping = await prisma.nuvemshopProductMapping.findUnique({
    where: { localProductId: product.id },
  });

  // A single gate controls CREATE and UPDATE. If a previously mapped card
  // becomes invalid, it is actively unpublished instead of remaining frozen
  // and visible in the storefront.
  const eligibility = assessProductForNuvemshop(product);
  if (!eligibility.eligible) {
    const reason = eligibility.reasons.join('; ');
    console.log('[ns push] DESPUBLICADO/PULADO - gate de qualidade:', localProductId, reason);
    if (existingMapping) {
      const hidden = await unpublishMappedProduct(
        localProductId,
        connection,
        reason,
        existingMapping,
      );
      return { skipped: true, action: 'unpublished-invalid', reason, ...hidden };
    }
    return { skipped: true, action: 'skipped', reason };
  }

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
  // Só usa nuvemshopMapping se o produto JÁ tem mapping nesta loja.
  // IDs de loja anterior (ex: 6578901) não existem na nova loja e causam 422.
  const aiMapping = existingMapping ? aiCtx?.nuvemshopMapping : null;
  if (aiMapping && Array.isArray(aiMapping.categoryIds) && aiMapping.categoryIds.length) {
    categoryIds.push(...aiMapping.categoryIds);
    if (Array.isArray(aiMapping.tags)) aiTags = aiMapping.tags;
    if (aiMapping.gender) aiGender = aiMapping.gender;
  } else {
    // Cadeia Categoria > Subcategoria > Modalidade > Especialidade resolvida contra a
    // árvore REAL do menu da loja (resolveChainAgainstTree): duplicata → nó original
    // (menor id), nível de gênero ausente é pulado, e NÃO recria ramo paralelo.
    const modality = aiCtx?.classification?.modality || null;
    const tier = aiCtx?.classification?.tier || null;
    const chain = await resolveChainAgainstTree(connection, [product.category, product.subcategory, modality, tier]);
    categoryIds.push(...chain);
  }

  // 2ª classificação (opcional) — produto pode estar em DUAS cadeias de categoria
  // no Nuvemshop. Monta a 2ª cadeia a partir de aiContext.classification2 e ANEXA.
  const c2 = aiCtx?.classification2;
  if (c2 && c2.category) {
    const chain2 = await resolveChainAgainstTree(connection, [c2.category, c2.subcategory, c2.modality, c2.tier]);
    categoryIds.push(...chain2);
  }

  // Categoria de MARCA — todo produto entra na página da sua marca no menu Marcas.
  const brandCatId = await findOrCreateBrandCategory(connection, product.brand);
  if (brandCatId) categoryIds.push(brandCatId);
  // Dedupe IDs (caso as duas cadeias compartilhem nós)
  const dedupCategoryIds = [...new Set(categoryIds.map(String))];
  categoryIds.length = 0;
  categoryIds.push(...dedupCategoryIds);

  // ===== ESTOQUE REAL + SÓ TAMANHOS DISPONÍVEIS (regra do dono 2026-06-08) =====
  // A loja respeita o ESTOQUE FÍSICO real = Σ StoreStock de TODAS as lojas (o LOCALIZADO/bipado),
  // NÃO o comprado e NÃO vinculado a nenhuma loja específica (produto no site não "vai pro
  // estoque da LOJA04"). E só sincroniza tamanho com estoque > 0 — pra NUNCA vender um número
  // que não tem. Tamanho que zerou vira esgotado (stock 0) na loja; produto sem nenhum tamanho
  // disponível não é publicado.
  const hasSizes = (product.sizes || []).length > 0;
  const sizesLocated = eligibility.locatedSizes;
  // Internal placeholders such as T-6100 never become storefront variants.
  const saleableSizes = eligibility.publicSizes;
  // CREATE só com tamanhos disponíveis; UPDATE manda todos (os zerados viram esgotado).
  // Acessório (sem tamanhos) mantém o comportamento antigo.
  const createSizes = hasSizes ? saleableSizes : (product.sizes || []);
  const updateSizes = hasSizes ? sizesLocated : (product.sizes || []);

  // Produto COM tamanhos mas SEM estoque físico em nenhum: não cria na loja (não há o que vender).
  if (!existingMapping && hasSizes && saleableSizes.length === 0) {
    console.log('[ns push] PULADO — sem estoque físico em nenhum tamanho:', localProductId);
    return { skipped: true, action: 'skipped', reason: 'sem estoque fisico (nenhum tamanho disponivel)' };
  }

  let nsProduct;
  let action;
  let variantSync = null;
  let imageSync = null;
  if (existingMapping) {
    // UPDATE — payload SEM variants (NS rejeita variants em PUT)
    const payload = buildNuvemshopProductPayload(product, updateSizes, {
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
    variantSync = await updateNuvemshopVariants(connection, existingMapping.nuvemshopProductId, product, updateSizes);
    // Sincroniza imagens (PUT não aceita images — usa endpoints dedicados).
    // Só age quando o conjunto local mudou de fato (assinatura).
    try {
      imageSync = await syncNuvemshopImages(connection, existingMapping.nuvemshopProductId, product);
    } catch (e) { imageSync = { changed: false, error: e.message }; console.warn('[ns push] image sync falhou:', e.message); }
    await prisma.nuvemshopProductMapping.update({
      where: { id: existingMapping.id },
      data: { lastSyncedAt: new Date(), syncStatus: 'synced' },
    });
    action = 'updated';
  } else {
    // Re-check anti-corrida ENTRE PROCESSOS (overlap de deploy = 2 instâncias com o
    // mesmo cron): se outro processo criou o produto e gravou o mapping depois que
    // este push começou, NÃO cria de novo — o próximo tick (cardSig) sincroniza.
    const lateMapping = await prisma.nuvemshopProductMapping.findUnique({ where: { localProductId: product.id } });
    if (lateMapping) {
      console.log('[ns push] corrida detectada (mapping apareceu durante o push) — create abortado:', localProductId);
      return { skipped: true, action: 'raced', reason: 'mapping criado por execução concorrente', nuvemshopProductId: String(lateMapping.nuvemshopProductId) };
    }
    const payload = buildNuvemshopProductPayload(product, createSizes, {
      categoryIds, extraTags: aiTags, gender: aiGender,
      modality: aiCtx?.classification?.modality, tier: aiCtx?.classification?.tier,
      mode: 'create',
    });
    try {
      nsProduct = await ns.nuvemshopApi(connection, 'POST', '/products', payload);
    } catch (e) {
      // Se o 422 é exclusivamente sobre imagens (URL inválida / CDN inacessível do NS),
      // OU se o NS retornou 500 com imagens no payload (URL truncada/inacessível causa 500),
      // retentar SEM imagens — o produto entra na loja e recebe foto depois.
      const isImageErr = /images\[\d+\]|Remote image not found|Remote image exceeds max/i.test(e.message);
      const is500WithImages = /Nuvemshop 500/i.test(e.message) && payload.images && payload.images.length > 0;
      if (isImageErr || is500WithImages) {
        console.log('[ns push] retry sem imagens (erro de imagem):', localProductId, e.message.slice(0, 80));
        const payloadNoImg = { ...payload, images: [] };
        nsProduct = await ns.nuvemshopApi(connection, 'POST', '/products', payloadNoImg);
      } else {
        throw e;
      }
    }
    // Grava o mapping com COMPENSAÇÃO: se outro processo ganhou a corrida entre o
    // re-check e o POST (gravou mapping com OUTRO NS#), o produto que ESTE push criou
    // é duplicata → deleta na loja e usa o do vencedor. (O upsert era idempotente pro
    // eco do webhook do PRÓPRIO create, que grava o MESMO NS# — esse segue ok.)
    const winner = await prisma.$transaction(async (tx) => {
      const cur = await tx.nuvemshopProductMapping.findUnique({ where: { localProductId: product.id } });
      if (cur && String(cur.nuvemshopProductId) !== String(nsProduct.id)) return cur;
      await tx.nuvemshopProductMapping.upsert({
        where: { localProductId: product.id },
        create: {
          localProductId: product.id,
          nuvemshopProductId: String(nsProduct.id),
          syncStatus: 'synced',
          lastSyncedAt: new Date(),
        },
        update: {
          nuvemshopProductId: String(nsProduct.id),
          syncStatus: 'synced',
          lastSyncedAt: new Date(),
        },
      });
      return null;
    });
    if (winner) {
      console.log(`[ns push] corrida perdida — deletando duplicata NS#${nsProduct.id}, mantendo NS#${winner.nuvemshopProductId}:`, localProductId);
      try { await ns.nuvemshopApi(connection, 'DELETE', `/products/${nsProduct.id}`); }
      catch (e) { console.warn('[ns push] compensação: falha ao deletar duplicata NS#' + nsProduct.id + ':', e.message); }
      return { skipped: true, action: 'raced-deduped', reason: 'execução concorrente criou primeiro — duplicata removida', nuvemshopProductId: String(winner.nuvemshopProductId) };
    }
    // Imagens já subiram no payload do create — grava a assinatura como baseline
    // pra que o próximo update não as re-suba sem necessidade.
    try {
      const desired0 = collectLocalImages(product);
      const ctx0 = ctxOf(product);
      ctx0.nsImagesSig = desired0.length ? imageSignature(desired0) : 'empty';
      await prisma.product.update({ where: { id: product.id }, data: { aiContext: ctx0 } });
      imageSync = { fromCreate: true, count: desired0.length };
    } catch (e) { console.warn('[ns push] baseline sig (create) falhou:', e.message); }
    action = 'created';
  }

  // Cria mapeamento de variants (precisa buscar o produto criado pra pegar IDs)
  if (action === 'created' && Array.isArray(nsProduct.variants)) {
    for (let i = 0; i < nsProduct.variants.length; i++) {
      const nsVar = nsProduct.variants[i];
      const localSize = createSizes[i];
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

  return { action, nuvemshopProductId: String(nsProduct.id), localProductId: product.id, variantSync, imageSync };
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
  // Regra do dono 2026-07-04: a loja SÓ recebe produto com FOTO e DESCRIÇÃO.
  // (a trava real por produto — que ainda pega imageUrl vazio e imageUrls[] — está
  // em _pushProductToNuvemshopInner; aqui é só filtro de volume da query. withImageOnly
  // fica redundante: foto agora é sempre obrigatória.)
  where.imageUrl = { not: null };
  where.OR = [
    { longDescription: { not: null } },
    { shortDescription: { not: null } },
  ];
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
    include: { sizes: { include: { storeStocks: { select: { stock: true } } } } },
  });
  if (!product) throw new Error('Produto não encontrado');
  const mapping = await prisma.nuvemshopProductMapping.findUnique({ where: { localProductId } });
  if (!mapping) throw new Error('Produto sem mapping com Nuvemshop');
  const connection = await getConnection();
  if (!connection) throw new Error('Sem conexão Nuvemshop ativa');

  const locatedSizes = (product.sizes || []).map((size) => ({
    ...size,
    stock: (size.storeStocks || []).reduce((sum, row) => sum + Number(row.stock || 0), 0),
  }));
  const result = await updateNuvemshopVariants(
    connection,
    mapping.nuvemshopProductId,
    product,
    locatedSizes,
    { stockOnly: true },
  );
  await logSync(
    'product',
    result.errors.length ? 'warning' : 'ok',
    `Stock fisico push ${product.sku}: ${result.updated} atualizadas, ${result.created} criadas, ${result.deleted} removidas`,
  );
  return result;
}

// Remove o produto da loja Nuvemshop: deleta na NS, apaga os mappings locais (produto + variants)
// e limpa a marca de liberação (pra não re-subir no cron). NÃO apaga o Product local — só tira da loja.
async function removeProductFromNuvemshop(localProductId, connection) {
  const mapping = await prisma.nuvemshopProductMapping.findUnique({ where: { localProductId } });
  if (!mapping) return { removed: false, reason: 'não está na Nuvemshop' };

  let nsDeleted = false;
  try {
    await ns.deleteProduct(connection, mapping.nuvemshopProductId);
    nsDeleted = true;
  } catch (e) {
    // 404 = já não existe na loja → segue limpando o local. Outro erro → loga mas segue.
    if (/404|not found/i.test(String(e.message))) nsDeleted = true;
    else console.warn('[ns remove] delete na loja falhou:', e.message);
  }

  await prisma.nuvemshopVariantMapping.deleteMany({ where: { localProductId } });
  await prisma.nuvemshopProductMapping.deleteMany({ where: { localProductId } });

  // limpa marca de liberação + assinatura de estoque pra não re-subir
  try {
    const p = await prisma.product.findUnique({ where: { id: localProductId }, select: { aiContext: true } });
    const ctx = (() => { try { return typeof p?.aiContext === 'string' ? JSON.parse(p.aiContext) : (p?.aiContext || {}); } catch { return {}; } })();
    if (ctx.releaseToNuvemshop != null || ctx.nsStockSig != null) {
      delete ctx.releaseToNuvemshop; delete ctx.nsStockSig;
      await prisma.product.update({ where: { id: localProductId }, data: { aiContext: ctx } });
    }
  } catch (_) {}

  await logSync('product', 'ok', `Removido da Nuvemshop: ${localProductId} (NS#${mapping.nuvemshopProductId})`);
  return { removed: true, nsDeleted, nuvemshopProductId: mapping.nuvemshopProductId };
}

module.exports = {
  getConnection,
  unpublishMappedProduct,
  assessProductForNuvemshop,
  removeProductFromNuvemshop,
  processWebhookEvent,
  importAllProducts,
  importAllCustomers,
  importRecentOrders,
  upsertLocalProduct,
  upsertLocalCustomer,
  upsertSaleFromOrder,
  pushProductToNuvemshop,
  pushAllProducts,
  resolveChainAgainstTree,
  findOrCreateBrandCategory,
  loadNsCategories,
  findCategoryInLevel,
  clearNsCache,
  pushStockUpdate,
  syncNuvemshopImages,
  collectLocalImages,
  imageSignature,
  updateNuvemshopVariants,
};
