// Ratificado pelo titular em 13/09/2026: sem descontos ou promoções nas
// novas vendas. Preços e documentos de vendas existentes não são recalculados.
const DISCOUNTS_ENABLED = false;

function policyError(message) {
  const error = new Error(message);
  error.statusCode = 409;
  error.code = 'DISCOUNTS_DISABLED';
  return error;
}

function assertDiscountsEnabled() {
  if (!DISCOUNTS_ENABLED) throw policyError('Descontos e promoções estão desativados para novas vendas.');
}

function numericValue(value) {
  if (!['number', 'string'].includes(typeof value) || (typeof value === 'string' && !value.trim())) return NaN;
  return Number(value);
}

function assertNoSaleDiscount(discount) {
  if (DISCOUNTS_ENABLED || discount == null || discount === '') return;
  if (!Number.isFinite(numericValue(discount)) || numericValue(discount) !== 0) {
    throw policyError('Descontos estão desativados. Atualize o carrinho e finalize a venda pelo preço normal.');
  }
}

function normalSalePrice(product, requestedUnitPrice) {
  const normal = numericValue(product?.price);
  const normalCents = Math.round(normal * 100);
  if (!Number.isFinite(normal) || normal <= 0 || !Number.isSafeInteger(normalCents) || normalCents <= 0) {
    throw policyError(`Preço normal inválido para ${product?.name || 'o produto'}. Corrija o cadastro antes de vender.`);
  }
  if (!DISCOUNTS_ENABLED && requestedUnitPrice != null) {
    const requested = numericValue(requestedUnitPrice);
    if (!Number.isFinite(requested) || requested < normalCents / 100) {
      throw policyError(`O preço de ${product?.name || 'o produto'} está desatualizado ou contém desconto. Atualize o carrinho para usar o preço normal.`);
    }
  }
  // O preço do catálogo é a fonte canônica; nunca aceitar promoPrice ou preço
  // arbitrário do cliente como substituto de um preço normal ausente.
  return normalCents / 100;
}

function assertNoPromotionalProduct(input = {}) {
  if (DISCOUNTS_ENABLED) return;
  assertNoSaleDiscount(input.promoPrice);
  let context = input.aiContext;
  if (typeof context === 'string') {
    try { context = JSON.parse(context); } catch { context = null; }
  }
  if (context?.paymentOffer?.active === true || input.paymentOffer?.active === true) {
    throw policyError('Promoções estão desativadas. Remova a oferta ativa antes de salvar o produto.');
  }
}

module.exports = { DISCOUNTS_ENABLED, assertDiscountsEnabled, assertNoSaleDiscount, normalSalePrice, assertNoPromotionalProduct };
