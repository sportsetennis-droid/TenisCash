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

async function pushProductToNuvemshop(localProductId, connection) {
  const product = await prisma.product.findUnique({
    where: { id: localProductId },
    include: { sizes: true },
  });
  if (!product) throw new Error(`Produto ${localProductId} não encontrado`);

  // ===== REGRA INQUEBRÁVEL =====
  // Só sobe pro Nuvemshop produto classificado nas 4: Categoria + Sub +
  // Modalidade + Especialidade. Sem as 4, NÃO sincroniza (nem cria, nem atualiza).
  {
    const _ctx = (() => { try { return typeof product.aiContext === 'string' ? JSON.parse(product.aiContext) : (product.aiContext || {}); } catch { return {}; } })();
    const _cls = _ctx.classification || {};
    const _badCat = ['', 'A CLASSIFICAR', 'A DEFINIR'];
    const _has = (v) => v != null && String(v).trim() !== '';
    const full = _has(product.category) && !_badCat.includes(String(product.category).trim())
      && _has(product.subcategory)
      && _has(_cls.modality)
      && _has(_cls.tier);
    if (!full) {
      console.log('[ns push] PULADO — regra das 4 classificações nao atendida:', localProductId);
      return { skipped: true, action: 'skipped', reason: 'classificacao incompleta (precisa Categoria + Sub + Modalidade + Especialidade)' };
    }
  }

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

  // 2ª classificação (opcional) — produto pode estar em DUAS cadeias de categoria
  // no Nuvemshop. Monta a 2ª cadeia a partir de aiContext.classification2 e ANEXA.
  const c2 = aiCtx?.classification2;
  if (c2 && c2.category) {
    let p2 = null;
    const cat2 = await findOrCreateCategoryWithParent(connection, c2.category, null);
    if (cat2) { categoryIds.push(cat2); p2 = cat2; }
    if (c2.subcategory && p2) {
      const sub2 = await findOrCreateCategoryWithParent(connection, c2.subcategory, p2);
      if (sub2) { categoryIds.push(sub2); p2 = sub2; }
    }
    if (c2.modality && p2) {
      const mod2 = await findOrCreateCategoryWithParent(connection, c2.modality, p2);
      if (mod2) { categoryIds.push(mod2); p2 = mod2; }
    }
    if (c2.tier && p2) {
      const tier2 = await findOrCreateCategoryWithParent(connection, c2.tier, p2);
      if (tier2) { categoryIds.push(tier2); }
    }
  }
  // Dedupe IDs (caso as duas cadeias compartilhem nós)
  const dedupCategoryIds = [...new Set(categoryIds.map(String))];
  categoryIds.length = 0;
  categoryIds.push(...dedupCategoryIds);

  let nsProduct;
  let action;
  let variantSync = null;
  let imageSync = null;
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
  syncNuvemshopImages,
  collectLocalImages,
  imageSignature,
};
