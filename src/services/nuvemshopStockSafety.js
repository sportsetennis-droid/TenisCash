// The local signature cannot detect a missed remote update or a manual edit.
function remoteStockDiffers(product, remote) {
  const sizes = product.sizes || [];
  return (remote.variants || []).some(variant => {
    const label = variant.values?.[0]?.pt || variant.values?.[0]?.name || '';
    const candidates = sizes.filter(size =>
      (size.barcode && [variant.sku, variant.barcode].includes(size.barcode)) ||
      variant.sku === `${product.sku}-${size.size}` || String(size.size).trim() === String(label).trim());
    if (candidates.length !== 1) return true;
    const quantity = (candidates[0].storeStocks || []).reduce((sum, row) => sum + Number(row.stock || 0), 0);
    return variant.stock_management !== true || Number(variant.stock || 0) !== quantity;
  }) || sizes.some(size => (size.storeStocks || []).some(row => Number(row.stock) > 0)
    && !(remote.variants || []).some(v => (size.barcode && (v.sku === size.barcode || v.barcode === size.barcode))
      || String(v.values?.[0]?.pt || '').trim() === String(size.size).trim()));
}

// Inventory bookkeeping is independent from cashback, invoicing and announcements.
function preservedPayload(order, previous = {}) {
  const internal = Object.fromEntries(Object.entries(previous || {}).filter(([key]) => key.startsWith('_')));
  const external = Object.fromEntries(Object.entries(order || {}).filter(([key]) => !key.startsWith('_')));
  return { ...external, ...internal };
}

async function applyOrderStock(prisma, order, { saleId, allowLegacy = false } = {}) {
  return prisma.$transaction(async (tx) => {
    const id = String(order.id);
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`nuvemshop-stock:${id}`}))`;
    const existing = await tx.nuvemshopOrderMapping.findUnique({ where: { nuvemshopOrderId: id } });
    const payload = preservedPayload(order, existing?.payload);
    const cancelled = order.status === 'cancelled';
    let allocations = payload._stockAllocations || [];
    if (cancelled && payload._stockDecremented && allocations.length && !payload._stockRestored) {
      for (const allocation of allocations) {
        await tx.storeStock.update({ where: { id: allocation.id }, data: { stock: { increment: allocation.quantity } } });
      }
      payload._stockRestored = true;
    }
    if (!cancelled && order.payment_status === 'paid' && !payload._stockDecremented) {
      // Old mappings may have lost their flag in the former handler. Never guess
      // whether their stock was already deducted; surface them for reconciliation.
      if (existing && !allowLegacy && !payload._stockPending) {
        throw new Error(`Pedido ${order.number || id}: baixa antiga sem comprovante; conferir antes de repetir`);
      }
      const items = Array.isArray(order.products) ? order.products : [];
      if (!items.length) throw new Error(`Pedido ${id} sem itens`);
      const preferred = await tx.store.findFirst({ where: { code: 'LOJA04' }, select: { id: true } });
      allocations = [];
      for (const item of items) {
        const code = String(item.sku || item.barcode || '').trim();
        const quantity = Number(item.quantity);
        if (!Number.isInteger(quantity) || quantity <= 0) throw new Error(`Quantidade inválida no pedido ${id}`);
        const variantMappings = item.variant_id ? await tx.nuvemshopVariantMapping.findMany({
          where: { nuvemshopVariantId: String(item.variant_id) },
        }) : [];
        let matches = variantMappings.length ? await tx.productSize.findMany({
          where: { id: { in: [...new Set(variantMappings.map(mapping => mapping.localInventoryId))] } },
        }) : code ? await tx.productSize.findMany({ where: { barcode: code } }) : [];
        // Older storefront variants use reference-size instead of an EAN.
        // Resolve only inside the exact mapped product; never infer a size by
        // splitting arbitrary codes or by matching a similar product name.
        if (!matches.length && item.product_id) {
          const mappings = await tx.nuvemshopProductMapping.findMany({
            where: { nuvemshopProductId: String(item.product_id) },
          });
          const products = await tx.product.findMany({
            where: { id: { in: mappings.map(mapping => mapping.localProductId) } }, include: { sizes: true },
          });
          matches = products.flatMap(product => (product.sizes || []).filter(size =>
            code && (code === `${product.sku}-${size.size}` || code === size.barcode)));
        }
        if (matches.length !== 1) throw new Error(`Pedido ${order.number || id}: SKU ${code || item.variant_id} sem tamanho único confirmado`);
        const rows = await tx.storeStock.findMany({ where: { productSizeId: matches[0].id, stock: { gt: 0 } } });
        rows.sort((a, b) => Number(b.storeId === preferred?.id) - Number(a.storeId === preferred?.id) || b.stock - a.stock);
        let remaining = quantity;
        for (const row of rows) {
          const decrement = Math.min(remaining, row.stock);
          if (!decrement) break;
          const updated = await tx.storeStock.updateMany({
            where: { id: row.id, stock: { gte: decrement } }, data: { stock: { decrement } },
          });
          if (updated.count !== 1) throw new Error(`Estoque alterado durante baixa do pedido ${id}; tentar novamente`);
          allocations.push({ id: row.id, quantity: decrement, productSizeId: matches[0].id });
          remaining -= decrement;
        }
        if (remaining) throw new Error(`Pedido ${order.number || id}: estoque físico insuficiente para ${code}`);
      }
      payload._stockAllocations = allocations;
      payload._stockDecremented = true;
      payload._stockDecrementedAt = new Date().toISOString();
    }
    if (order.payment_status !== 'paid' && !existing) payload._stockPending = true;
    const data = { payload, ...(saleId ? { saleId } : {}) };
    await tx.nuvemshopOrderMapping.upsert({
      where: { nuvemshopOrderId: id }, update: data, create: { nuvemshopOrderId: id, ...data },
    });
    return { orderId: id, deducted: payload._stockDecremented === true, restored: payload._stockRestored === true };
  }, { timeout: 30000 });
}

module.exports = { preservedPayload, applyOrderStock, remoteStockDiffers };
