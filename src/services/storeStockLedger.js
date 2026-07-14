class SaleStockError extends Error {
  constructor(message, statusCode = 400) {
    super(message);
    this.name = 'SaleStockError';
    this.statusCode = statusCode;
  }
}

function clean(value) {
  return value == null ? '' : String(value).trim();
}

function requiresPhysicalSizeConfirmation(product) {
  const brand = clean(product?.brand).toUpperCase();
  return brand.includes('NIKE');
}

function assertSellableSize(product, size) {
  // Decisão do dono (2026-07-14): Adidas não pode ficar indisponível por
  // tamanho técnico/não confirmado. A venda segue e o rótulo pendente fica
  // registrado no SaleItem para conferência posterior.
  if (clean(product?.brand).toUpperCase().includes('ADIDAS')) return size;
  const label = clean(size?.size);
  if (!label || label === '?' || /^T-/i.test(label)) {
    throw new SaleStockError(`${product?.name || 'Produto'} está com tamanho não confirmado. Confira a caixa antes de vender.`);
  }
  if (requiresPhysicalSizeConfirmation(product) && !size?.sizeConfirmedAt) {
    throw new SaleStockError(`${product?.name || 'Produto'} está com tamanho Nike não confirmado pela caixa.`);
  }
  return size;
}

function resolveProductSize(product, item = {}) {
  const sizes = Array.isArray(product?.sizes) ? product.sizes : [];
  const requestedId = clean(item.productSizeId);
  const requestedSize = clean(item.size);
  const barcode = clean(item.barcode);

  if (requestedId) {
    const byId = sizes.find((size) => size.id === requestedId);
    if (!byId) throw new SaleStockError(`Tamanho invalido para ${product?.name || 'o produto'}. Selecione novamente.`);
    return assertSellableSize(product, byId);
  }

  if (barcode) {
    const byBarcode = sizes.find((size) => clean(size.barcode) === barcode);
    if (byBarcode) return assertSellableSize(product, byBarcode);
  }

  if (requestedSize) {
    const bySize = sizes.find((size) => clean(size.size) === requestedSize);
    if (!bySize) throw new SaleStockError(`Tamanho ${requestedSize} nao cadastrado para ${product?.name || 'o produto'}.`);
    return assertSellableSize(product, bySize);
  }

  if (sizes.length === 1) return assertSellableSize(product, sizes[0]);
  if (!sizes.length) throw new SaleStockError(`${product?.name || 'Produto'} esta sem tamanho cadastrado. Corrija o cadastro antes de vender.`);
  throw new SaleStockError(`Escolha o tamanho de ${product?.name || 'cada produto'} antes de finalizar a venda.`);
}

function planSaleProductSize(product, item = {}) {
  try {
    return {
      productSize: resolveProductSize(product, item),
      needsNewProductSize: false,
    };
  } catch (err) {
    const sizes = Array.isArray(product?.sizes) ? product.sizes : [];
    const requestedId = clean(item.productSizeId);
    const requestedSize = clean(item.size);
    const barcode = clean(item.barcode);
    const sizeAlreadyExists = requestedSize
      ? sizes.some((size) => clean(size.size).toLowerCase() === requestedSize.toLowerCase())
      : false;

    // Cadastro legado sem nenhuma variante: o PDV exige que o operador digite
    // o tamanho real e cria a variante atomicamente junto com a venda.
    const canCreateLegacySize = Boolean(
      item.isNewSize && requestedSize && !requestedId && sizes.length === 0,
    );

    // Código ainda desconhecido pode ensinar uma numeração nova ao produto.
    // Mantém o fluxo de bipe existente, mas nunca duplica um tamanho cadastrado.
    const canCreateBarcodeSize = Boolean(
      item.isNewBarcode && barcode && requestedSize && !requestedId && !sizeAlreadyExists,
    );

    if (canCreateLegacySize || canCreateBarcodeSize) {
      return {
        productSize: null,
        needsNewProductSize: true,
        requestedSize,
      };
    }

    throw err;
  }
}

async function applyStoreStockDelta(tx, {
  storeId,
  productSizeId,
  saleId = null,
  saleItemId = null,
  quantity,
  type,
  source = 'system',
  reason = null,
  metadata = null,
}) {
  const delta = Number(quantity);
  if (!storeId) throw new SaleStockError('Venda sem loja: nao e possivel contabilizar o estoque.');
  if (!productSizeId) throw new SaleStockError('Item sem tamanho vinculado: nao e possivel contabilizar o estoque.');
  if (!Number.isInteger(delta) || delta === 0) throw new SaleStockError('Quantidade de estoque invalida.');
  if (!type) throw new SaleStockError('Tipo do movimento de estoque nao informado.');

  // Incremento atomico evita perda de baixa quando duas vendas do mesmo tamanho acontecem juntas.
  // Se o item ainda nao foi bipado nessa loja, cria a localizacao e deixa saldo negativo: o deficit
  // fica visivel e conciliavel, em vez de a venda desaparecer do estoque.
  const row = await tx.storeStock.upsert({
    where: { storeId_productSizeId: { storeId, productSizeId } },
    update: { stock: { increment: delta } },
    create: { storeId, productSizeId, stock: delta },
  });
  const stockAfter = row.stock;
  const stockBefore = stockAfter - delta;

  const movement = await tx.storeStockMovement.create({
    data: {
      storeId,
      productSizeId,
      saleId,
      saleItemId,
      type,
      quantity: delta,
      stockBefore,
      stockAfter,
      source,
      reason,
      metadata,
    },
  });

  return { row, movement, stockBefore, stockAfter };
}

module.exports = {
  SaleStockError,
  resolveProductSize,
  planSaleProductSize,
  applyStoreStockDelta,
  requiresPhysicalSizeConfirmation,
};
