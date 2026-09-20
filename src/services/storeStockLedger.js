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

function usableBarcode(value) {
  const barcode = clean(value);
  return barcode && !/^SEM[\s_-]*GTIN$/i.test(barcode) ? barcode : '';
}

function saleSizeKey(value) {
  const label = clean(value).toUpperCase();
  // Mesma equivalência usada na bipagem. Não renomeia nem reúne variantes.
  return /^(U|UNICO|ÚNICO)$/.test(label) ? 'ÚNICO' : label;
}

function uniqueVariant(matches, product) {
  if (matches.length > 1) {
    const err = new SaleStockError(`Mais de uma variante corresponde ao tamanho de ${product?.name || 'o produto'}. Selecione a variante antes de finalizar.`);
    err.ambiguousVariant = true;
    throw err;
  }
  return matches[0] || null;
}

function requiresPhysicalSizeConfirmation() {
  // Decisão do dono (2026-07-15): nenhuma marca pode bloquear a venda
  // por falta de confirmação prévia do tamanho da caixa.
  return false;
}

function assertSellableSize(_product, size) {
  // Tamanho técnico, placeholder ou ainda não confirmado nunca trava a venda.
  // A variante continua obrigatória para a baixa atingir o estoque correto;
  // o tamanho real informado pelo vendedor fica registrado no SaleItem.
  return size;
}

function resolveProductSize(product, item = {}) {
  const sizes = Array.isArray(product?.sizes) ? product.sizes : [];
  const requestedId = clean(item.productSizeId);
  // Bipe por código interno reconhece o produto, mas não uma variante quando
  // há mais de uma. Nesse caso, o tamanho manual também precisa resolvê-la.
  const requestedSize = clean(item.size) || clean(item.sellerSize);
  const barcode = usableBarcode(item.barcode);

  if (item.isNewBarcode && clean(item.barcode) && !barcode) {
    throw new SaleStockError('SEM GTIN não é um código de barras. Informe o código efetivamente lido.');
  }

  if (requestedId) {
    const byId = sizes.find((size) => size.id === requestedId);
    if (!byId) throw new SaleStockError(`Tamanho invalido para ${product?.name || 'o produto'}. Selecione novamente.`);
    return assertSellableSize(product, byId);
  }

  if (barcode) {
    const byBarcode = uniqueVariant(sizes.filter((size) => usableBarcode(size.barcode) === barcode), product);
    if (byBarcode) return assertSellableSize(product, byBarcode);
  }

  if (requestedSize) {
    // Primeiro a grafia literal, depois caixa e por fim equivalência de Único.
    // Uma correspondência ambígua nunca cria uma terceira variante ou escolhe
    // por saldo de outra loja; o vendedor precisa selecionar um id explícito.
    const bySize = uniqueVariant(sizes.filter((size) => clean(size.size) === requestedSize), product)
      || uniqueVariant(sizes.filter((size) => clean(size.size).toUpperCase() === requestedSize.toUpperCase()), product)
      || uniqueVariant(sizes.filter((size) => saleSizeKey(size.size) === saleSizeKey(requestedSize)), product);
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
    if (err.ambiguousVariant || (item.isNewBarcode && clean(item.barcode) && !usableBarcode(item.barcode))) throw err;
    const sizes = Array.isArray(product?.sizes) ? product.sizes : [];
    const requestedId = clean(item.productSizeId);
    const requestedSize = clean(item.size);
    const barcode = usableBarcode(item.barcode);
    const sizeAlreadyExists = requestedSize
      ? sizes.some((size) => saleSizeKey(size.size) === saleSizeKey(requestedSize))
      : false;

    // Fluxo manual do PDV: se o vendedor informou um tamanho ainda inexistente,
    // cria a variante atomicamente junto com a venda. A baixa negativa fica
    // auditável até a conciliação do estoque físico.
    const canCreateManualSize = Boolean(
      item.isNewSize && requestedSize && !requestedId && !sizeAlreadyExists,
    );

    // Código ainda desconhecido pode ensinar uma numeração nova ao produto.
    // Mantém o fluxo de bipe existente, mas nunca duplica um tamanho cadastrado.
    const canCreateBarcodeSize = Boolean(
      item.isNewBarcode && barcode && requestedSize && !requestedId && !sizeAlreadyExists,
    );

    if (canCreateManualSize || canCreateBarcodeSize) {
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
