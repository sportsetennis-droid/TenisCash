// Central publication gate for the Sports & Tennis Nuvemshop catalog.
// Keep this module pure so the cron, handlers and tests use the same rules.

const INVALID_LABELS = new Set([
  '',
  'A CLASSIFICAR',
  'A DEFINIR',
  'SEM MARCA',
  'NAO DEFINIDO',
  'NÃO DEFINIDO',
]);

function clean(value) {
  return value == null ? '' : String(value).trim();
}

function upper(value) {
  return clean(value).toLocaleUpperCase('pt-BR');
}

function contextOf(product) {
  try {
    return typeof product?.aiContext === 'string'
      ? JSON.parse(product.aiContext)
      : (product?.aiContext || {});
  } catch (_) {
    return {};
  }
}

function hasUsableImage(product) {
  const valid = (value) => {
    const s = clean(value);
    if (!s) return false;
    if (/lookaside\.instagram\.com|\/crawler\/|google_widget|\/seo\//i.test(s)) return false;
    return /^data:image\/[a-z0-9.+-]+;base64,/i.test(s)
      || /^https?:\/\//i.test(s);
  };

  if (valid(product?.imageUrl)) return true;
  try {
    const values = typeof product?.imageUrls === 'string'
      ? JSON.parse(product.imageUrls)
      : product?.imageUrls;
    return Array.isArray(values) && values.some(valid);
  } catch (_) {
    return false;
  }
}

function physicalStock(size) {
  return (size?.storeStocks || []).reduce((sum, row) => sum + Number(row?.stock || 0), 0);
}

function isPublicSizeLabel(value) {
  const label = upper(value).replace(/\s+/g, ' ');
  if (!label || /^T[-_]/.test(label)) return false;
  if (/^(SEM TAMANHO|DESCONHECIDO|N\/?A|NULL|UNDEFINED)$/.test(label)) return false;
  if (/^\d{8,14}$/.test(label)) return false; // EAN used as a fake size

  if (/^\d{1,2}(?:[.,]5)?(?:[-/]\d{1,2}(?:[.,]5)?)?$/.test(label)) return true;
  if (/^(?:UNICO|ÚNICO|UN|U|TU|PP|P|M|G|GG|XG|XGG|EG|EGG|XS|S|L|XL|XXL|XXXL|[1-4]XL)$/.test(label)) return true;
  return false;
}

function assessProductForNuvemshop(product, options = {}) {
  const requireConfirmation = options.requireConfirmation !== false;
  const reasons = [];
  const ctx = contextOf(product);
  const classification = ctx.classification || {};
  const invalid = (value) => INVALID_LABELS.has(upper(value));

  if (!product || product.active === false) reasons.push('produto inativo');
  if (invalid(product?.name)) reasons.push('nome ausente ou indefinido');
  if (invalid(product?.brand)) reasons.push('marca ausente ou indefinida');
  if (invalid(product?.category)) reasons.push('categoria ausente ou indefinida');
  if (invalid(product?.subcategory)) reasons.push('subcategoria ausente ou indefinida');
  if (invalid(classification.modality)) reasons.push('modalidade ausente ou indefinida');
  if (invalid(classification.tier)) reasons.push('especialidade ausente ou indefinida');

  if (!hasUsableImage(product)) reasons.push('sem foto valida');
  if (!clean(product?.longDescription || product?.shortDescription)) reasons.push('sem descricao');

  const price = Number(product?.price || 0);
  const cost = Number(product?.costPrice || 0);
  if (!(price > 0)) reasons.push('preco de venda zerado');
  if (cost > 0 && price <= cost) reasons.push('preco de venda nao supera o custo');

  if (requireConfirmation && ctx.confirmedForNuvemshop !== true) {
    reasons.push('sem confirmacao humana para Nuvemshop');
  }
  if (ctx.hideFromNuvemshop === true) reasons.push('oculto manualmente');

  const sizes = Array.isArray(product?.sizes) ? product.sizes : [];
  const locatedSizes = sizes.map((size) => ({ ...size, stock: physicalStock(size) }));
  const publicSizes = locatedSizes.filter((size) => size.stock > 0 && isPublicSizeLabel(size.size));
  const placeholderStock = locatedSizes.reduce(
    (sum, size) => sum + (size.stock > 0 && !isPublicSizeLabel(size.size) ? size.stock : 0),
    0,
  );

  if (publicSizes.length === 0) reasons.push('sem tamanho valido com estoque fisico');
  if (placeholderStock > 0) reasons.push('estoque em tamanho placeholder');

  return {
    eligible: reasons.length === 0,
    reasons,
    context: ctx,
    publicSizes,
    locatedSizes,
    placeholderStock,
  };
}

module.exports = {
  assessProductForNuvemshop,
  contextOf,
  hasUsableImage,
  isPublicSizeLabel,
  physicalStock,
};
