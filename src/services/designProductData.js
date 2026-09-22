// The Design workspace shares the catalog, but never returns staff, sale or
// invoice metadata embedded in legacy Product.aiContext JSON.
const { isDesignRole } = require('./designAccess');

const CONTEXT_FIELDS = ['classification', 'gender', 'ageGroup', 'sport', 'color', 'model', 'modelGroup', 'cleanName', 'supplierRef', 'supplierCnpj', 'supplierId', 'location', 'material', 'technology', 'technologies', 'benefits', 'fit', 'careInstructions'];
const CLASSIFICATION_FIELDS = ['category', 'subcategory', 'type', 'gender', 'ageGroup', 'modality', 'specialty', 'tier', 'sport', 'color'];
const PRODUCT_FIELDS = ['id', 'sku', 'internalBarcode', 'name', 'brand', 'category', 'subcategory', 'shortDescription', 'longDescription', 'features', 'recommendedFor', 'notRecommendedFor', 'imageUrl', 'imageUrls', 'videoUrl', 'price', 'promoPrice', 'costPrice', 'active', 'featured', 'createdAt', 'updatedAt', 'sizes', 'totalStock', 'supplierRef', 'gender', 'ageGroup', 'sport', 'color', 'location', 'type', 'modality', 'tier', 'classification'];
const WRITE_FIELDS = ['sku', 'name', 'brand', 'category', 'subcategory', 'shortDescription', 'longDescription', 'features', 'recommendedFor', 'notRecommendedFor', 'imageUrl', 'imageUrls', 'price', 'featured', 'aiContext'];

function objectValue(raw) {
  if (typeof raw === 'string') { try { raw = JSON.parse(raw); } catch { return {}; } }
  return raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
}
function pick(object, fields) {
  return Object.fromEntries(fields.filter(key => Object.hasOwn(object, key)).map(key => [key, object[key]]));
}
function designContext(raw) {
  const result = pick(objectValue(raw), CONTEXT_FIELDS);
  if (result.classification) result.classification = pick(objectValue(result.classification), CLASSIFICATION_FIELDS);
  return result;
}
function designProduct(product) {
  if (!product || typeof product !== 'object') return product;
  const result = pick(product, PRODUCT_FIELDS);
  if (result.classification) result.classification = pick(objectValue(result.classification), CLASSIFICATION_FIELDS);
  if (Object.hasOwn(product, 'aiContext')) result.aiContext = designContext(product.aiContext);
  if (Array.isArray(result.sizes)) result.sizes = result.sizes.map(size => ({
    ...pick(size, ['id', 'productId', 'size', 'barcode', 'stock', 'sizeConfirmedAt']),
    ...(Array.isArray(size.storeStocks) ? { storeStocks: size.storeStocks.map(stock => ({
      ...pick(stock, ['id', 'storeId', 'productSizeId', 'stock', 'updatedAt']),
      ...(stock.store ? { store: pick(stock.store, ['id', 'code', 'name']) } : {}),
    })) } : {}),
  }));
  return result;
}
function catalogWriteError(body, { creating = false } = {}) {
  const raw = objectValue(body);
  const fields = creating ? [...WRITE_FIELDS, 'sizes'] : WRITE_FIELDS;
  if (Object.keys(raw).some(key => !fields.includes(key))) return 'Design pode alterar somente os dados de apresentação do produto. Estoque e dados fiscais são restritos.';
  if (Object.hasOwn(raw, 'aiContext')) {
    if (!raw.aiContext || typeof raw.aiContext !== 'object' || Array.isArray(raw.aiContext)) return 'Informe os metadados como objeto; o contexto interno não pode ser apagado.';
    const ctx = raw.aiContext;
    if (Object.keys(ctx).some(key => !CONTEXT_FIELDS.includes(key) || ['supplierId', 'supplierCnpj'].includes(key))) return 'Metadado de produto não permitido para Design.';
    if (Object.hasOwn(ctx, 'classification') && (!ctx.classification || typeof ctx.classification !== 'object' || Array.isArray(ctx.classification))) return 'Informe os campos de classificação como objeto.';
    if (ctx.classification && Object.keys(ctx.classification).some(key => !CLASSIFICATION_FIELDS.includes(key))) return 'Campo de classificação não permitido para Design.';
  }
  if (raw.sizes != null && (!Array.isArray(raw.sizes) || raw.sizes.some(size => !size || Object.keys(size).some(key => !['size', 'barcode', 'stock'].includes(key)) || (size.stock != null && Number(size.stock) !== 0)))) return 'Novos tamanhos devem começar sem estoque. Design não altera quantidades.';
  if (raw.price != null && (!Number.isFinite(Number(raw.price)) || Number(raw.price) < 0)) return 'Preço inválido.';
  return null;
}

// Apply only to the product routers selected by the route policy. Do not
// change responses for the proprietor, managers, sellers or public catalog.
function designProductResponses(req, res, next) {
  if (!isDesignRole(req.userRole)) return next();
  const json = res.json.bind(res);
  res.json = data => {
    if (!data || typeof data !== 'object') return json(data);
    const result = { ...data };
    if (result.product) result.product = designProduct(result.product);
    if (result.aiContext) result.aiContext = designContext(result.aiContext);
    if (result.classification) result.classification = pick(objectValue(result.classification), CLASSIFICATION_FIELDS);
    if (Array.isArray(result.products)) result.products = result.products.map(designProduct);
    // Inventory uses `items` instead of `products`.
    if (Array.isArray(result.items) && result.items.some(item => item && Object.hasOwn(item, 'sku'))) result.items = result.items.map(designProduct);
    return json(result);
  };
  next();
}

module.exports = { designContext, designProduct, catalogWriteError, designProductResponses };
