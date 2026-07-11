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

function localized(value) {
  if (value == null) return '';
  if (typeof value === 'string' || typeof value === 'number') return clean(value);
  if (typeof value === 'object') {
    return clean(value.pt || value['pt-BR'] || value.es || value.en || Object.values(value)[0]);
  }
  return '';
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

function assessRemoteProductForNuvemshop(product) {
  const reasons = [];
  const invalid = (value) => INVALID_LABELS.has(upper(localized(value)));

  if (!product) return { eligible: false, reasons: ['produto remoto inexistente'] };
  if (invalid(product.name)) reasons.push('nome remoto ausente ou indefinido');
  if (invalid(product.brand)) reasons.push('marca remota ausente ou indefinida');
  if (!localized(product.description)) reasons.push('descricao remota ausente');

  if (!hasRemoteUsableImage(product)) {
    reasons.push('foto remota ausente');
  }

  const variants = Array.isArray(product.variants) ? product.variants : [];
  const priced = variants.filter((variant) => Number(variant?.price || 0) > 0);
  if (priced.length === 0) reasons.push('preco remoto zerado');

  const sizeLabels = variants.flatMap((variant) => {
    const values = Array.isArray(variant?.values) ? variant.values : [];
    return values.map(localized).filter(Boolean);
  });
  if (sizeLabels.length === 0 || !sizeLabels.some(isPublicSizeLabel)) {
    reasons.push('tamanho remoto ausente ou invalido');
  }
  if (sizeLabels.some((label) => !isPublicSizeLabel(label))) {
    reasons.push('tamanho remoto placeholder');
  }

  return { eligible: reasons.length === 0, reasons };
}

function hasRemoteUsableImage(product) {
  const images = Array.isArray(product?.images) ? product.images : [];
  return images.some((image) => /^https?:\/\//i.test(clean(image?.src)));
}

module.exports = {
  assessProductForNuvemshop,
  assessRemoteProductForNuvemshop,
  contextOf,
  hasUsableImage,
  hasRemoteUsableImage,
  isPublicSizeLabel,
  physicalStock,
};
