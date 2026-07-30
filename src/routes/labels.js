// =====================================================================
// Routes: /api/admin/labels — gestão de templates, lotes, geração de PDF
// =====================================================================

const express = require('express');
const { authMiddleware, adminMiddleware, prisma } = require('../middleware');
const {
  generateLabelsPDF,
  defaultTemplates,
  isSTHorizontalTemplate,
  isDuplexTemplate,
  isProductDuplexTemplate,
} = require('../services/labelGenerator');
const { resolveBrandLogoUrl, validateBrandLogoUrl } = require('../services/brandLogoResolver');
const { ensureProductInternalBarcode } = require('../services/internalBarcode');

const router = express.Router();
router.use(authMiddleware);
router.use(adminMiddleware);

const LABEL_PROMOTION_TEXT = 'Garanta 30% de Desconto levando três produtos da loja.';
const LABEL_PROMOTION_FACTOR = 0.70;
const LABEL_PAYMENT_TERMS = 'PIX, DINHEIRO OU CARTÃO';
const LABEL_GUARANTEE_TEXT = 'PRODUTO ORIGINAL E GARANTIA.';
const INVALID_LABEL_BRAND = 'A DEFINIR';
const UMBRO_MOTIVATION_PHRASES = {
  futsal: [
    'DOMINE A QUADRA. DECIDA O JOGO.',
    'SEU PRÓXIMO GOL COMEÇA AQUI.',
    'ENTRE EM QUADRA PARA VENCER.',
    'CONTROLE, VELOCIDADE E ATITUDE.',
    'JOGUE COM CONFIANÇA. VÁ PARA CIMA.',
  ],
  football: [
    'SEU PRÓXIMO GOL COMEÇA AQUI.',
    'CONTROLE, VELOCIDADE E ATITUDE.',
    'JOGUE COM CONFIANÇA. VÁ PARA CIMA.',
  ],
  footwear: [
    'CONFORTO PARA IR ALÉM.',
    'MOVA-SE COM CONFIANÇA E ATITUDE.',
    'ENCONTRE SEU RITMO. SUPERE LIMITES.',
  ],
  clothing: [
    'VISTA SUA ATITUDE. MOVA-SE COM CONFIANÇA.',
    'CONFORTO NO MOVIMENTO. ESTILO EM AÇÃO.',
    'FEITO PARA ACOMPANHAR SEU RITMO.',
  ],
  accessory: [
    'O DETALHE CERTO ELEVA SEU DESEMPENHO.',
    'PREPARE-SE MELHOR. SIGA COM CONFIANÇA.',
    'PRONTO PARA ACOMPANHAR CADA DESAFIO.',
  ],
  general: [
    'PERFORMANCE PARA SEU PRÓXIMO DESAFIO.',
    'MOVIMENTO, CONFIANÇA E ATITUDE.',
    'ESCOLHA SEU RITMO. VÁ ALÉM.',
  ],
};

function labelsPerProduct(template) {
  if (!isDuplexTemplate(template)) return 1;
  return Math.max(1, Number(template?.layoutConfig?.labelsPerProduct || 1));
}

function brandSlug(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/&/g, 'and')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function brandSlugCompact(value) {
  return brandSlug(value).replace(/-/g, '');
}

function isConverseBrand(value) {
  const slug = brandSlug(value);
  return slug === 'converse' || slug.includes('converse');
}

// A categoria do catÃ¡logo nem sempre Ã© confiÃ¡vel: alguns acessÃ³rios acabam
// classificados como "TÃªnis". O nome do item tem prioridade para impedir
// que a etiqueta chame uma joelheira, luva ou outro acessÃ³rio de tÃªnis.
const NON_FOOTWEAR_NAME_PATTERN = /\b(?:joelheira|cotoveleira|munhequeira|tornozeleira|caneleira|protetor(?:es)?|meia(?:s)?|luva(?:s)?|bola(?:s)?|mochila(?:s)?|bolsa(?:s)?|garrafa(?:s)?|squeeze|faixa(?:s)?|bandagem(?:s)?|chaveiro(?:s)?|bone|viseira(?:s)?|carteira(?:s)?|necessaire(?:s)?|sacola(?:s)?|acessorio(?:s)?)\b/;
const FOOTWEAR_NAME_PATTERN = /\b(?:tenis|sapat[eê]nis|chuteira(?:s)?|sapatilha(?:s)?|sandalia(?:s)?|bota(?:s)?|calcado(?:s)?)\b/;
const FOOTWEAR_CATEGORY_PATTERN = /\b(?:tenis|chuteiras?|calcados?|footwear|shoes?)\b/;

function isTennisProduct(product) {
  const name = normalizeLabelText(product?.name);
  const categoryFields = [product?.category, product?.subcategory, productClassification(product).type]
    .map(normalizeLabelText)
    .filter(Boolean);
  // O nome/tipo explícito tem prioridade sobre uma categoria antiga ou
  // incorreta (por exemplo, uma joelheira cadastrada como "Tênis").
  if (productType(product, product?.name)) return false;
  if (NON_FOOTWEAR_NAME_PATTERN.test(name)) return false;
  if (FOOTWEAR_NAME_PATTERN.test(name)) return true;
  return categoryFields.some((value) => FOOTWEAR_CATEGORY_PATTERN.test(value));
}

function productClassification(product) {
  try {
    const value = typeof product?.aiContext === 'string' ? JSON.parse(product.aiContext) : (product?.aiContext || {});
    return value.classification || value.classification2 || {};
  } catch {
    return {};
  }
}

function footwearType(product) {
  const fields = [product?.name, product?.category, product?.subcategory, productClassification(product).type, productClassification(product).modality]
    .map(normalizeLabelText)
    .filter(Boolean);
  if (fields.some((value) => /\bchuteira\b/.test(value))) return 'Chuteira';
  if (fields.some((value) => /\bsapatilha\b/.test(value))) return 'Sapatilha';
  if (fields.some((value) => /\bsandalia\b/.test(value))) return 'Sandália';
  if (fields.some((value) => /\bbota\b/.test(value))) return 'Bota';
  return 'Tênis';
}

function footwearModality(product, source) {
  const classification = productClassification(product);
  const fields = [
    classification.modality,
    product?.subcategory,
    product?.category,
    source,
  ].map(normalizeLabelText).filter(Boolean);
  const known = fields.find((value) => /\b(?:futsal|society|campo|indoor|futebol|beach)\b/.test(value));
  if (!known) return '';
  const match = known.match(/\b(futsal|society|campo|indoor|futebol|beach)\b/);
  if (!match) return '';
  const labels = { futsal: 'Futsal', society: 'Society', campo: 'Campo', indoor: 'Indoor', futebol: 'Futebol', beach: 'Beach' };
  return labels[match[1]] || match[1];
}

function normalizeLabelText(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

const CLOTHING_TYPES = [
  ['short saia', 'Short Saia'],
  ['calca legging', 'Calça Legging'],
  ['calca', 'Calça'],
  ['bermuda', 'Bermuda'],
  ['camiseta', 'Camiseta'],
  ['camisa', 'Camisa'],
  ['regata', 'Regata'],
  ['legging', 'Legging'],
  ['macaquinho', 'Macaquinho'],
  ['macacao', 'Macacão'],
  ['conjunto', 'Conjunto'],
  ['cropped', 'Cropped'],
  ['vestido', 'Vestido'],
  ['short', 'Short'],
  ['saia', 'Saia'],
  ['top', 'Top'],
  ['blusa', 'Blusa'],
  ['jaqueta', 'Jaqueta'],
  ['casaco', 'Casaco'],
  ['moletom', 'Moletom'],
  ['body', 'Body'],
  ['biquini', 'Biquíni'],
  ['maio', 'Maiô'],
];

// Tipos de produtos que não são calçados. O rótulo deve repetir o tipo
// comercial real do item, mesmo quando a categoria antiga do cadastro estiver
// incorreta ou genérica (por exemplo: "Joelheira" nunca vira "Tênis").
const NON_FOOTWEAR_TYPE_RULES = [
  ['joelheira', 'Joelheira'],
  ['cotoveleira', 'Cotoveleira'],
  ['munhequeira', 'Munhequeira'],
  ['tornozeleira', 'Tornozeleira'],
  ['caneleira', 'Caneleira'],
  ['perneira', 'Perneira'],
  ['protetor', 'Protetor'],
  ['meia', 'Meia'],
  ['luva', 'Luva'],
  ['bola', 'Bola'],
  ['raquete', 'Raquete'],
  ['mochila', 'Mochila'],
  ['bolsa', 'Bolsa'],
  ['garrafa', 'Garrafa'],
  ['squeeze', 'Squeeze'],
  ['faixa', 'Faixa'],
  ['bandagem', 'Bandagem'],
  ['chaveiro', 'Chaveiro'],
  ['bone', 'Boné'],
  ['viseira', 'Viseira'],
  ['touca', 'Touca'],
  ['oculos', 'Óculos'],
  ['carteira', 'Carteira'],
  ['necessaire', 'Nécessaire'],
  ['sacola', 'Sacola'],
  ['pochete', 'Pochete'],
  ['corda', 'Corda'],
  ['halter', 'Halter'],
  ['kettlebell', 'Kettlebell'],
  ['colchonete', 'Colchonete'],
  ['rede', 'Rede'],
  ['apito', 'Apito'],
  ['cone', 'Cone'],
  ['bomba', 'Bomba'],
  ['capacete', 'Capacete'],
  ['toalha', 'Toalha'],
];

function typeFieldMatches(field, needle) {
  const escaped = String(needle || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const plural = String(needle || '').includes(' ') ? '' : 's?';
  return new RegExp(`\\b${escaped}${plural}\\b`).test(field);
}

function clothingType(product, source) {
  const fields = [source, product?.category, product?.subcategory].map(normalizeLabelText).filter(Boolean);
  for (const [needle, label] of CLOTHING_TYPES) {
    if (fields.some((field) => typeFieldMatches(field, needle))) return { needle, label };
  }
  return null;
}

function productType(product, source = '') {
  const fields = [
    source,
    product?.name,
    product?.subcategory,
    product?.category,
    productClassification(product).modality,
  ].map(normalizeLabelText).filter(Boolean);
  const clothing = clothingType(product, source || product?.name || '');
  if (clothing) return clothing;
  for (const [needle, label] of NON_FOOTWEAR_TYPE_RULES) {
    if (fields.some((field) => typeFieldMatches(field, needle))) return { needle, label };
  }
  return null;
}

function stripLeadingCatalogGender(value) {
  return String(value || '')
    .trim()
    .replace(/^(?:unissex|unisex|feminino|feminina|masculino|masculina|homem|mulher|men|women)\s+/i, '')
    .trim();
}

function labelTypedNonFootwearName(product, source, type) {
  const brand = String(product?.brand || '').trim();
  let description = String(source || '').trim();
  description = removeBrandPrefix(description, brand);
  // Retira o tipo em qualquer posição usual: "Umbro Joelheira",
  // "Joelheira Umbro" ou "Joelheira Unissex Umbro".
  description = description.replace(new RegExp(`\\b${type.needle}s?\\b`, 'i'), ' ');
  description = stripLeadingCatalogGender(description).replace(/\s+/g, ' ').trim();
  description = removeBrandPrefix(description, brand);
  description = stripLeadingCatalogGender(description);
  return [type.label, brand, description].filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();
}

function removeBrandPrefix(value, brand) {
  const text = String(value || '').trim();
  if (!brand) return text;
  const escaped = String(brand).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return text.replace(new RegExp(`^${escaped}[\\s-]*`, 'i'), '').trim();
}

function removeTypePrefix(value, needle) {
  const words = String(value || '').trim().split(/\s+/).filter(Boolean);
  const typeWords = String(needle || '').split(/\s+/).filter(Boolean);
  const normalizedWords = words.map(normalizeLabelText);
  const normalizedTypeWords = typeWords.map(normalizeLabelText);
  const first = normalizedWords.slice(0, normalizedTypeWords.length).join(' ');
  const expected = normalizedTypeWords.join(' ');
  const pluralExpected = normalizedTypeWords.length === 1 ? `${expected}s` : expected;
  if (!normalizedTypeWords.length || (first !== expected && first !== pluralExpected)) return String(value || '').trim();
  return words.slice(normalizedTypeWords.length).join(' ').trim();
}

function labelClothingName(product, source) {
  const brand = String(product?.brand || '').trim();
  const type = clothingType(product, source);
  if (!type) return '';
  let description = String(source || '').trim();
  // Aceita cadastro com a marca antes do tipo: "Caju Brasil Bermuda ...".
  description = removeBrandPrefix(description, brand);
  description = removeTypePrefix(description, type.needle);
  // E também o formato já parcialmente montado: "Bermuda Caju Brasil ...".
  description = removeBrandPrefix(description, brand);
  return [type.label, brand, description].filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();
}

function labelProductName(product, fallback = '') {
  const source = String(product?.name || fallback || '').trim();
  const brand = String(product?.brand || '').trim();
  const clothingName = labelClothingName(product, source);
  const typedName = productType(product, source);
  const converseTennis = isConverseBrand(product?.brand)
    && (isTennisProduct(product) || /all[\s-]*star|chuck[\s-]*taylor|star[\s-]*player/i.test(source));
  if (clothingName && !converseTennis) return clothingName;
  if (typedName && !converseTennis) return labelTypedNonFootwearName(product, source, typedName);
  if (!isConverseBrand(product?.brand) && !isTennisProduct(product)) {
    return typedName ? labelTypedNonFootwearName(product, source, typedName) : source;
  }
  if (!isConverseBrand(product?.brand)) {
    const typeLabel = footwearType(product);
    const modality = typeLabel === 'Chuteira' ? footwearModality(product, source) : '';
    // A etiqueta começa com o tipo correto e a marca. Removemos
    // prefixos que já possam existir no cadastro para não duplicá-los.
    let description = source
      .replace(/^(?:t[eê]nis|chuteira|sapatilha|sand[aá]lia|bota)\s+/i, '')
      .trim();
    if (brand) {
      const brandPattern = new RegExp(`^${brand.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[\\s-]*`, 'i');
      description = description.replace(brandPattern, '').trim();
    }
    if (modality) {
      const modalityPattern = new RegExp(`\\b${modality}\\b`, 'i');
      description = description.replace(modalityPattern, '').replace(/\s+/g, ' ').trim();
    }
    return [typeLabel, brand, modality, description].filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();
  }
  const normalized = source
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
  if (/all[\s-]*star|chuck[\s-]*taylor/.test(normalized)) {
    return 'TÊNIS ALL STAR CHUCK TAYLOR CONVERSE';
  }
  return 'TÊNIS CONVERSE STAR PLAYER';
}

function labelDescriptionWords(value) {
  return String(value || '')
    .replace(/[-/|:]+/g, ' ')
    .match(/[\p{L}\p{N}]+/gu) || [];
}

function dedupeLabelWords(words) {
  const seen = new Set();
  return words.filter((word) => {
    const normalized = normalizeLabelText(word);
    if (!normalized || seen.has(normalized)) return false;
    seen.add(normalized);
    return true;
  });
}

function stripLabelSizeSuffix(value) {
  const sizeToken = '(?:PP|P|M|G|GG|XG|XGG|EG|EGG|U|ÚNICO|ÚNICA|\\d{2,3}(?:[/-]\\d{2,3})?)';
  return String(value || '')
    .replace(new RegExp(`(?:^|[\\s|;,-])tam(?:anho)?\\.?\\s*[:=-]?\\s*${sizeToken}\\s*$`, 'iu'), ' ')
    .replace(new RegExp(`(?:\\s+-\\s*|\\s+)${sizeToken}\\s*$`, 'iu'), ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function stableLabelPhraseIndex(value, length) {
  let hash = 2166136261;
  for (const char of String(value || '')) {
    hash ^= char.codePointAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return length > 0 ? (hash >>> 0) % length : 0;
}

function labelMotivationText(product, classification = {}, seed = '') {
  if (brandSlug(product?.brand) !== 'umbro') return '';
  const source = String(product?.name || '');
  const clothing = clothingType(product, source);
  const typed = productType(product, source);
  let group = 'general';

  if (isTennisProduct(product)) {
    if (normalizeLabelText(footwearType(product)) === 'chuteira') {
      const modality = normalizeLabelText(
        footwearModality(product, source)
        || classification.modality
        || product?.subcategory
        || product?.category,
      );
      group = /\b(?:futsal|indoor)\b/.test(modality) ? 'futsal' : 'football';
    } else {
      group = 'footwear';
    }
  } else if (clothing) {
    group = 'clothing';
  } else if (typed) {
    group = 'accessory';
  }

  const phrases = UMBRO_MOTIVATION_PHRASES[group] || UMBRO_MOTIVATION_PHRASES.general;
  const identity = seed || [product?.id, product?.name, product?.sku, group].filter(Boolean).join('|');
  return phrases[stableLabelPhraseIndex(identity, phrases.length)];
}

// A descrição reúne o que identifica o produto para o cliente: tipo, marca e
// modelo/material. Tamanho, cor, modalidade e códigos ficam em campos próprios.
const LABEL_COLOR_WORDS = new Set([
  'azl', 'azul', 'bco', 'branco', 'bege', 'cinza', 'cnz', 'coral', 'dourado',
  'cor', 'cores',
  'frtc', 'grafite', 'grf', 'laranja', 'lima', 'lrj', 'lrjf', 'mar', 'marinho',
  'mcmt', 'multicolor', 'preto', 'pta', 'pto', 'purp', 'roxo', 'royal', 'verde',
  'vermelho', 'vrdl', 'vrm', 'sortida', 'sortidas', 'sortido', 'sortidos',
]);

function labelProductDescription(product, fallback = '', reference = '', categoryLabel = '', context = {}) {
  const source = stripLabelSizeSuffix(product?.name || fallback);
  const classification = context.classification || productClassification(product);
  const modality = isTennisProduct(product)
    ? footwearModality(product, source)
    : classification.modality;
  const reserved = [
    reference,
    context.supplierRef,
    context.color,
    modality,
  ]
    .flatMap(labelDescriptionWords)
    .map(normalizeLabelText)
    .filter((word) => word && word !== 'de' && word !== 'da' && word !== 'do');
  const reservedWords = new Set(reserved);
  // Alguns cadastros antigos gravaram o tipo do produto no campo de cor.
  // "BERMUDA", "MEIA" ou "BOLA" continuam sendo parte obrigatória da
  // descrição, mesmo quando esse dado ruim aparece entre as palavras reservadas.
  const detectedType = isTennisProduct(product)
    ? footwearType(product)
    : productType(product, source)?.label;
  const protectedTypeWords = new Set(
    labelDescriptionWords(detectedType).map(normalizeLabelText).filter(Boolean),
  );

  const cleanedWords = dedupeLabelWords(labelDescriptionWords(source).filter((word) => {
    const normalized = normalizeLabelText(word);
    if (!normalized || (reservedWords.has(normalized) && !protectedTypeWords.has(normalized))) return false;
    // Remove referências/SKUs mistos e códigos numéricos longos, preservando
    // números curtos que façam parte do modelo comercial (por exemplo, "Pro 5").
    if (/^(?=.*[a-z])(?=.*\d)[a-z0-9/-]{4,}$/i.test(normalized)) return false;
    if (/^\d{3,}$/.test(normalized)) return false;
    if (/^(?:ref|referencia|sku|codigo|cod|tam|tamanho)$/i.test(normalized)) return false;
    if (/^(?:pp|p|m|g|gg|xg|xgg|eg|egg|u|tu|unico|unica)$/i.test(normalized)) return false;
    if (LABEL_COLOR_WORDS.has(normalized)) return false;
    return !/^(?:unissex|unisex|feminino|feminina|fem|masculino|masculina|masc|homem|mulher|men|women|infantil|inf)$/i.test(normalized);
  }));

  return cleanedWords.join(' ').trim() || 'MODELO ESPORTIVO';
}

function cleanLabelCategory(value) {
  const text = String(value || '').trim();
  if (!text) return '';
  const normalized = text
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
  // Categoria, subcategoria e gênero servem para filtro do catálogo, não
  // para a etiqueta física. A regra é geral: nunca deixar "tênis",
  // "homem", "mulher" ou equivalentes escaparem para nenhuma etiqueta.
  const withoutCatalogTerms = normalized
    .replace(/\b(?:tenis|calcados?|shoes|footwear)\b/g, ' ')
    .replace(/\b(?:homem|masculino|mulher|feminino|men|women|unissex|unisex)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!withoutCatalogTerms) return '';
  if (withoutCatalogTerms === normalized) return text;
  // Rótulos como "Tênis de corrida" não devem virar "de corrida".
  const cleaned = text
    .replace(/\b(?:tênis|tenis|calçados?|shoes|footwear)\b/gi, ' ')
    .replace(/\b(?:homem|masculino|mulher|feminino|men|women|unissex|unisex)\b/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^de\s+/i, '')
    .trim();
  return cleaned;
}

function labelStyle(product, classification = {}) {
  if (isConverseBrand(product?.brand)) return 'ESTILO DE VIDA CLÁSSICO';
  const type = productType(product, product?.name || '');
  const clothing = clothingType(product, product?.name || '');
  if (isTennisProduct(product)) {
    const footwear = normalizeLabelText(footwearType(product));
    const modality = footwearModality(product, product?.name || '');
    if (footwear === 'chuteira' && modality) return modality.toUpperCase();
    return 'CALÇADO ESPORTIVO';
  }
  if (clothing) return 'ROUPA ESPORTIVA';
  if (type) {
    if (/^(?:joelheira|cotoveleira|munhequeira|tornozeleira|caneleira|protetor)$/i.test(type.needle)) {
      return 'PROTEÇÃO ESPORTIVA';
    }
    if (/^(?:bola|raquete|rede|cone|halter|kettlebell|colchonete)$/i.test(type.needle)) {
      return 'EQUIPAMENTO ESPORTIVO';
    }
    return 'ACESSÓRIO ESPORTIVO';
  }
  const modality = cleanLabelCategory(classification.modality);
  return /^(?:outro|outros|geral|não informado|nao informado)$/i.test(modality)
    ? 'PRODUTO ESPORTIVO'
    : (modality || 'PRODUTO ESPORTIVO').toUpperCase();
}

function roundLabelPrice(value) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.round(number * 100) / 100 : null;
}

function extractLabelReference(product, context, item) {
  const candidates = [context?.supplierRef, item?.supplierRef, item?.customText, product?.name]
    .map((value) => String(value || '').trim())
    .filter(Boolean);
  // A referência comercial é o código CK do modelo; o SKU interno do card
  // nunca deve ocupar esse campo. Para Converse, o código-base tem CK + oito
  // dígitos; se o fornecedor anexar tamanho ao final, preservamos só o CK.
  for (const candidate of candidates) {
    const match = candidate.match(/\b(CK\d{8})/i);
    if (match) return match[0].toUpperCase();
  }
  // Para outras marcas, aceita somente uma referência alfanumérica de
  // fornecedor; valores de SKU interno, EAN e descrições não entram na etiqueta.
  return candidates.find((candidate) => /^[A-Z]{2,4}[A-Z0-9]{4,12}$/i.test(candidate)) || '';
}

// Garante que os templates default existem (idempotente)
async function ensureDefaultTemplates() {
  const defaults = defaultTemplates();
  for (const key of Object.keys(defaults)) {
    const def = defaults[key];
    let existing = await prisma.labelTemplate.findFirst({ where: { name: def.name } });
    if (!existing) {
      for (const legacyName of def.legacyNames || []) {
        existing = await prisma.labelTemplate.findFirst({ where: { name: legacyName } });
        if (existing) break;
      }
    }
    // O template S&T horizontal usa QR e não usa código de barras.
    const isST = isSTHorizontalTemplate(def);
    const isDuplex = isDuplexTemplate(def);
    const isProductDuplex = isProductDuplexTemplate(def);
    const wantedData = {
      name: def.name,
      type: def.type,
      paperSize: def.paperSize,
      widthMm: def.widthMm,
      heightMm: def.heightMm,
      columns: def.columns || 1,
      rows: def.rows || 1,
      marginTopMm: def.marginTopMm || 0,
      marginLeftMm: def.marginLeftMm || 0,
      gapHorizontalMm: def.gapHorizontalMm || 0,
      gapVerticalMm: def.gapVerticalMm || 0,
      showLogo: true,
      showPrice: true,
      showPromotionalPrice: isST || def.type === 'PROMOTIONAL' || def.type === 'PRICE',
      showBarcode: isST ? false : def.type !== 'PROMOTIONAL',
      showQRCode: isST || isProductDuplex,
      showSku: true,
      showProductName: true,
      showBrand: true,
      showSize: def.type === 'PRODUCT',
      showColor: def.type === 'PRODUCT',
      showStore: false,
      layoutConfig: def.layoutConfig || null,
      isDefault: key === 'a4_16_5x7_duplex',
    };
    let templateRecord = existing;
    if (!existing) {
      templateRecord = await prisma.labelTemplate.create({ data: wantedData });
    } else if (isST || isDuplex) {
      const needsSync = Object.entries(wantedData).some(([field, value]) => {
        if (field === 'layoutConfig') {
          return JSON.stringify(existing[field] || null) !== JSON.stringify(value || null);
        }
        return existing[field] !== value;
      });
      if (needsSync) {
        // Migra o modelo S&T legado sem sobrescrever ajustes dos outros templates.
        templateRecord = await prisma.labelTemplate.update({ where: { id: existing.id }, data: wantedData });
      }
    }
    if (key === 'a4_16_5x7_duplex' && templateRecord) {
      await prisma.labelTemplate.updateMany({
        where: { id: { not: templateRecord.id } },
        data: { isDefault: false },
      });
    }
  }
}

router.get('/templates', async (_req, res) => {
  try {
    await ensureDefaultTemplates();
    const deprecatedNames = Object.values(defaultTemplates())
      .flatMap((template) => template.legacyNames || []);
    const templates = await prisma.labelTemplate.findMany({
      where: deprecatedNames.length ? { name: { notIn: deprecatedNames } } : undefined,
      orderBy: [{ isDefault: 'desc' }, { name: 'asc' }],
    });
    res.json({ templates });
  } catch (err) {
    console.error('[labels/templates] erro:', err);
    res.status(500).json({ error: 'Erro ao listar templates' });
  }
});

// Opções da geração automática: lojas, marcas e categorias presentes no
// catálogo ativo. O estoque por loja é aplicado somente no momento da geração.
router.get('/options', async (_req, res) => {
  try {
    const [stores, products] = await Promise.all([
      prisma.store.findMany({
        where: { active: true },
        select: { id: true, code: true, name: true },
        orderBy: { code: 'asc' },
      }),
      prisma.product.findMany({
        where: {
          active: true,
          price: { gt: 0 },
          NOT: { brand: { equals: INVALID_LABEL_BRAND, mode: 'insensitive' } },
          sizes: { some: { storeStocks: { some: { stock: { gt: 0 } } } } },
        },
        select: { brand: true, category: true },
      }),
    ]);
    const brands = [...new Set(products.map((p) => String(p.brand || '').trim()).filter(Boolean))]
      .sort((a, b) => a.localeCompare(b, 'pt-BR', { sensitivity: 'base' }));
    const categories = [...new Set(products.map((p) => String(p.category || '').trim()).filter(Boolean))]
      .sort((a, b) => a.localeCompare(b, 'pt-BR', { sensitivity: 'base' }));
    res.json({ stores, brands, categories });
  } catch (err) {
    console.error('[labels/options] erro:', err);
    res.status(500).json({ error: 'Erro ao carregar opções de etiquetas' });
  }
});

router.post('/batches', async (req, res) => {
  try {
    const { name, templateId, storeId, items } = req.body || {};
    if (!templateId) return res.status(400).json({ error: 'templateId é obrigatório' });
    if (!Array.isArray(items) || !items.length) return res.status(400).json({ error: 'items é obrigatório' });

    const templateMeta = await prisma.labelTemplate.findUnique({ where: { id: templateId } });
    const physicalPerProduct = labelsPerProduct(templateMeta);
    const batch = await prisma.labelBatch.create({
      data: {
        name: name || 'Lote ' + new Date().toLocaleString('pt-BR'),
        templateId,
        storeId: storeId || null,
        createdById: req.userId,
        status: 'DRAFT',
        totalLabels: items.reduce((s, x) => s + (parseInt(x.quantity, 10) || 1), 0) * physicalPerProduct,
        items: {
          create: items.map((it) => ({
            productId: it.productId || null,
            inventoryId: it.inventoryId || null,
            quantity: parseInt(it.quantity, 10) || 1,
            price: it.price != null ? Number(it.price) : null,
            promotionalPrice: it.promotionalPrice != null ? Number(it.promotionalPrice) : null,
            barcode: it.barcode || null,
            qrCodeValue: it.qrCodeValue || null,
            customText: it.customText || null,
          })),
        },
      },
      include: { items: true, template: true },
    });
    res.json({ batch });
  } catch (err) {
    console.error('[labels/batches POST] erro:', err);
    res.status(500).json({ error: 'Erro ao criar lote', detail: err.message });
  }
});

router.get('/batches', async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit || '30', 10), 100);
    const batches = await prisma.labelBatch.findMany({
      orderBy: { createdAt: 'desc' },
      take: limit,
      include: { template: true },
    });
    res.json({ batches });
  } catch (err) {
    console.error('[labels/batches GET] erro:', err);
    res.status(500).json({ error: 'Erro ao listar lotes' });
  }
});

router.get('/batches/:id', async (req, res) => {
  try {
    const batch = await prisma.labelBatch.findUnique({
      where: { id: req.params.id },
      include: { items: true, template: true, prints: { orderBy: { printedAt: 'desc' } } },
    });
    if (!batch) return res.status(404).json({ error: 'Lote não encontrado' });
    res.json({ batch });
  } catch (err) {
    console.error('[labels/batches/:id] erro:', err);
    res.status(500).json({ error: 'Erro ao carregar lote' });
  }
});

// Gera PDF do lote
router.get('/batches/:id/pdf', async (req, res) => {
  try {
    const batch = await prisma.labelBatch.findUnique({
      where: { id: req.params.id },
      include: { items: true, template: true },
    });
    if (!batch) return res.status(404).json({ error: 'Lote não encontrado' });

    // Enriquece com dados de produto
    const productIds = batch.items.map((i) => i.productId).filter(Boolean);
    const products = productIds.length
      ? await prisma.product.findMany({
        where: { id: { in: productIds } },
        include: {
          sizes: {
            select: {
              size: true,
              stock: true,
              storeStocks: batch.storeId
                ? { where: { storeId: batch.storeId }, select: { stock: true } }
                : true,
            },
            orderBy: { size: 'asc' },
          },
        },
      })
      : [];
    for (const product of products) {
      if (!product.internalBarcode) {
        product.internalBarcode = await ensureProductInternalBarcode(prisma, product);
      }
    }
    const byId = Object.fromEntries(products.map((p) => [p.id, p]));
    const brandNames = [...new Set(products.map((p) => String(p.brand || '').trim()).filter(Boolean))];
    const brandSlugs = [...new Set(brandNames.flatMap((name) => [brandSlug(name), brandSlugCompact(name)]).filter(Boolean))];
    const brandProfileRows = brandNames.length
      ? await prisma.brandProfile.findMany({
        where: {
          OR: [
            { slug: { in: brandSlugs } },
            ...brandNames.map((name) => ({ displayName: { equals: name, mode: 'insensitive' } })),
          ],
        },
        select: { slug: true, displayName: true, logoUrl: true },
      })
      : [];
    const brandLogos = new Map();
    await Promise.all(brandProfileRows.map(async (row) => {
      if (!row.logoUrl || !await validateBrandLogoUrl(row.logoUrl)) return;
      brandLogos.set(brandSlug(row.slug), row.logoUrl);
      brandLogos.set(brandSlugCompact(row.slug), row.logoUrl);
      brandLogos.set(brandSlug(row.displayName), row.logoUrl);
      brandLogos.set(brandSlugCompact(row.displayName), row.logoUrl);
    }));

    // Quando a logo ainda não foi cadastrada no painel, tenta obter uma
    // correspondência exata em fontes públicas de logos SVG/PNG transparentes.
    // A resolução é cacheada no processo e nunca substitui uma logo já
    // cadastrada manualmente.
    if (isProductDuplexTemplate(batch.template)) {
      const brandsWithoutProfileLogo = brandNames.filter((name) => {
        const key = brandSlug(name);
        const compactKey = brandSlugCompact(name);
        return !brandLogos.get(key) && !brandLogos.get(compactKey);
      });
      const resolvedBrands = await Promise.all(brandsWithoutProfileLogo.map(async (name) => ({
        name,
        url: await resolveBrandLogoUrl(name),
      })));
      resolvedBrands.forEach(({ name, url }) => {
        if (!url) return;
        brandLogos.set(brandSlug(name), url);
        brandLogos.set(brandSlugCompact(name), url);
      });
    }
    const store = batch.storeId
      ? await prisma.store.findUnique({ where: { id: batch.storeId }, select: { name: true } })
      : null;
    const storeName = store?.name || 'Sports & Tennis';
    const storeKeys = [...new Set([brandSlug(storeName), brandSlugCompact(storeName)].filter(Boolean))];
    const storeProfiles = await prisma.brandProfile.findMany({
      where: {
        OR: [
          { slug: { in: storeKeys } },
          { displayName: { equals: storeName, mode: 'insensitive' } },
        ],
      },
      select: { id: true, logoUrl: true },
      take: 1,
    });
    let storeLogoUrl = storeProfiles[0]?.logoUrl
      && await validateBrandLogoUrl(storeProfiles[0].logoUrl)
      ? storeProfiles[0].logoUrl
      : null;
    if (!storeLogoUrl && isProductDuplexTemplate(batch.template)) {
      storeLogoUrl = await resolveBrandLogoUrl(storeName);
      if (storeLogoUrl && storeProfiles[0]?.id) {
        // Deixa a logo oficial disponível no painel para as próximas
        // etiquetas e para os demais materiais da marca.
        await prisma.brandProfile.update({
          where: { id: storeProfiles[0].id },
          data: { logoUrl: storeLogoUrl },
        }).catch((err) => {
          console.warn('[labels] não foi possível persistir a logo oficial da loja:', err.message);
        });
      }
    }

    // Base URL pra QRs apontarem pra página pública do produto
    const baseUrl = (req.headers.origin || `${req.protocol}://${req.get('host')}`).replace(/\/$/, '');

    const items = batch.items.map((it) => {
      const p = it.productId ? byId[it.productId] : null;
      const ctx = (() => {
        if (!p) return {};
        try { return typeof p.aiContext === 'string' ? JSON.parse(p.aiContext) : (p.aiContext || {}); }
        catch { return {}; }
      })();
      const cls = ctx.classification || {};
      // Tamanho: extrai do customText ("Tam: 38") ou it.size se houver
      let sizeStr = it.size || null;
      if (!sizeStr && it.customText) {
        const m = String(it.customText).match(/Tam[:\s]+([\w\d\/\-]+)/i);
        if (m) sizeStr = m[1];
      }
      // Nome com tamanho embutido (etiqueta mostra "TENIS X - TAM 38")
      const baseName = p ? p.name : (it.customText || '');
      const availableSizes = p?.sizes
        ?.filter((s) => batch.storeId
          ? (s.storeStocks || []).some((ss) => Number(ss.stock || 0) > 0)
          : Number(s.stock || 0) > 0)
        .map((s) => s.size)
        .filter(Boolean)
        .join(' | ') || '';
      const categoryLabel = labelStyle(p, cls);
      const reference = extractLabelReference(p, ctx, it);
      const productName = labelProductDescription(
        p,
        baseName,
        reference,
        categoryLabel,
        ctx,
      );
      const motivationText = labelMotivationText(
        p,
        cls,
        [p?.id, baseName, reference, categoryLabel].filter(Boolean).join('|'),
      );
      const price = it.price != null ? Number(it.price) : (p ? Number(p.price) : null);
      const configuredPromo = it.promotionalPrice != null
        ? Number(it.promotionalPrice)
        : (p?.promoPrice != null ? Number(p.promoPrice) : null);
      // A etiqueta 5x7 anuncia exatamente 30% OFF levando três produtos.
      // O valor grande precisa, portanto, ser sempre 70% do preço normal.
      const promotionalPrice = isProductDuplexTemplate(batch.template)
        && Number.isFinite(price) && price > 0
        ? roundLabelPrice(price * LABEL_PROMOTION_FACTOR)
        : configuredPromo;
      return {
        name: productName,
        productName,
        description: productName,
        categoryLabel,
        reference,
        availableSizes,
        storeName,
        storeLogoUrl,
        brand: p ? p.brand : '',
        brandLogoUrl: p ? (brandLogos.get(brandSlug(p.brand)) || brandLogos.get(brandSlugCompact(p.brand)) || null) : null,
        sku: reference,
        supplierRef: reference || null,
        gender: '',
        category: p ? p.category : '',
        modality: cls.modality || '',
        tier: cls.tier || '',
        size: sizeStr,
        price,
        promotionalPrice,
        promotionText: LABEL_PROMOTION_TEXT,
        paymentTerms: LABEL_PAYMENT_TERMS,
        guaranteeText: LABEL_GUARANTEE_TEXT,
        motivationText,
        // Mantém o código original (EAN/SKU) e acrescenta o interno do card.
        barcode: it.barcode || (p ? p.sku : null),
        internalBarcode: p?.internalBarcode || null,
        qrCodeValue: it.qrCodeValue || (p ? `${baseUrl}/p/${p.id}` : null),
        quantity: it.quantity || 1,
      };
    });

    if (isProductDuplexTemplate(batch.template)) {
      const missingLogos = [];
      if (!storeLogoUrl) missingLogos.push(`loja: ${storeName}`);
      [...new Set(items.map((item) => item.brand).filter(Boolean))].forEach((brand) => {
        if (!items.some((item) => item.brand === brand && item.brandLogoUrl)) missingLogos.push(`marca: ${brand}`);
      });
      if (missingLogos.length) {
        return res.status(409).json({
          error: 'Não foi encontrada uma logo confiável para todos os lados da etiqueta. Cadastre a logo faltante no painel de Marcas.',
          missingLogos,
        });
      }
    }

    const pdfBuffer = await generateLabelsPDF({
      template: batch.template,
      items,
      storeName,
      storeLogoUrl,
    });

    await prisma.labelBatch.update({
      where: { id: batch.id },
      data: { status: 'GENERATED' },
    });

    res.set({
      'Content-Type': 'application/pdf',
      'Content-Disposition': `inline; filename="etiquetas-${batch.id}.pdf"`,
    });
    res.send(pdfBuffer);
  } catch (err) {
    console.error('[labels/batches/:id/pdf] erro:', err);
    res.status(500).json({ error: 'Erro ao gerar PDF', detail: err.message });
  }
});

// Marca lote como impresso
router.post('/batches/:id/print', async (req, res) => {
  try {
    const { copies, printerName, notes } = req.body || {};
    const log = await prisma.labelPrintLog.create({
      data: {
        labelBatchId: req.params.id,
        printedById: req.userId,
        copies: parseInt(copies, 10) || 1,
        printerName: printerName || null,
        notes: notes || null,
      },
    });
    await prisma.labelBatch.update({
      where: { id: req.params.id },
      data: { status: 'PRINTED' },
    });
    res.json({ log });
  } catch (err) {
    console.error('[labels/batches/:id/print] erro:', err);
    res.status(500).json({ error: 'Erro ao registrar impressão' });
  }
});

router.delete('/batches/:id', async (req, res) => {
  try {
    await prisma.labelBatch.delete({ where: { id: req.params.id } });
    res.json({ success: true });
  } catch (err) {
    console.error('[labels/batches/:id DELETE] erro:', err);
    res.status(500).json({ error: 'Erro ao remover lote' });
  }
});

// Cria lote rápido a partir de filtros de produto.
// Aceita 2 formatos:
//   1) { productIds: [...], quantityPerProduct: N }  (legado)
//   2) { selections: [{ productId, quantity }] } (novo — por produto/modelo)
router.post('/batches/quick', async (req, res) => {
  try {
    const { templateId, name, storeId, productIds, quantityPerProduct, usePromo, selections } = req.body || {};
    if (!templateId) return res.status(400).json({ error: 'templateId é obrigatório' });

    let items = [];
    if (Array.isArray(selections) && selections.length) {
      // Formato novo: lista de seleções por produto/modelo; tamanho é opcional
      const uniqueIds = [...new Set(selections.map(s => s.productId).filter(Boolean))];
      const products = await prisma.product.findMany({ where: { id: { in: uniqueIds } } });
      const byId = Object.fromEntries(products.map(p => [p.id, p]));
      items = selections.filter(s => s.productId && byId[s.productId]).map(s => {
        const p = byId[s.productId];
        // OBS: LabelItem (Prisma) não tem campo "size" — guardamos no customText
        return {
          productId: p.id,
          quantity: Math.max(1, parseInt(s.quantity, 10) || 1),
          price: p.price,
          promotionalPrice: usePromo ? p.promoPrice : null,
          barcode: p.sku,
          customText: s.size ? ('Tam: ' + s.size) : null,
        };
      });
    } else if (Array.isArray(productIds) && productIds.length) {
      const products = await prisma.product.findMany({ where: { id: { in: productIds } } });
      items = products.map((p) => ({
        productId: p.id,
        quantity: parseInt(quantityPerProduct, 10) || 1,
        price: p.price,
        promotionalPrice: usePromo ? p.promoPrice : null,
        barcode: p.sku,
      }));
    } else {
      return res.status(400).json({ error: 'Envie productIds ou selections' });
    }
    if (!items.length) return res.status(400).json({ error: 'Nenhum item gerado' });
    const templateMeta = await prisma.labelTemplate.findUnique({ where: { id: templateId } });
    const totalLabels = items.reduce((s, x) => s + (x.quantity || 1), 0) * labelsPerProduct(templateMeta);
    const batch = await prisma.labelBatch.create({
      data: {
        name: name || ('Lote rápido ' + new Date().toLocaleString('pt-BR')),
        templateId,
        storeId: storeId || null,
        createdById: req.userId,
        status: 'DRAFT',
        totalLabels,
        items: { create: items },
      },
      include: { items: true, template: true },
    });
    res.json({ batch });
  } catch (err) {
    console.error('[labels/batches/quick] erro:', err);
    res.status(500).json({ error: 'Erro ao criar lote rápido', detail: err.message });
  }
});

// Gera lotes automaticamente usando o estoque físico por loja.
// A unidade da etiqueta e o modelo/produto: uma selecao cria uma unica peca
// 5x7 com frente e verso, independentemente da quantidade de tamanhos.
router.post('/batches/auto', async (req, res) => {
  try {
    const {
      name,
      storeId,
      allStores,
      brand,
      category,
      usePromo,
    } = req.body || {};
    // A geração automática por loja/marca sempre usa a etiqueta 5x7 aprovada.
    // Antes, o front enviava o primeiro template em ordem alfabética e criava
    // lotes de preço antigos mesmo quando a loja e a marca estavam corretas.
    await ensureDefaultTemplates();
    const templateMeta = await prisma.labelTemplate.findFirst({
      where: { isDefault: true },
    });
    if (!templateMeta || !isProductDuplexTemplate(templateMeta)) {
      return res.status(500).json({ error: 'Template padrão 5x7 frente e verso não encontrado' });
    }
    if (brand && String(brand).trim().localeCompare(INVALID_LABEL_BRAND, 'pt-BR', { sensitivity: 'base' }) === 0) {
      return res.status(400).json({
        error: 'A marca “A DEFINIR” não pode gerar etiqueta. Corrija a marca e o preço do produto primeiro.',
      });
    }

    const generateForStore = allStores === true || storeId === 'all';
    if (!generateForStore && !storeId) {
      return res.status(400).json({ error: 'Escolha uma loja ou selecione todas as lojas' });
    }

    const stores = generateForStore
      ? await prisma.store.findMany({
        where: { active: true },
        select: { id: true, code: true, name: true },
        orderBy: { code: 'asc' },
      })
      : await prisma.store.findMany({
        where: { id: storeId, active: true },
        select: { id: true, code: true, name: true },
        take: 1,
      });
    if (!stores.length) return res.status(404).json({ error: 'Loja não encontrada ou inativa' });

    const batches = [];
    const emptyStores = [];
    for (const store of stores) {
      const productFilter = {
        active: true,
        price: { gt: 0 },
        NOT: { brand: { equals: INVALID_LABEL_BRAND, mode: 'insensitive' } },
        ...(brand ? { brand: { equals: String(brand).trim(), mode: 'insensitive' } } : {}),
        ...(category ? { category: { equals: String(category).trim(), mode: 'insensitive' } } : {}),
      };
      const productSelection = { id: true, sku: true, price: true, promoPrice: true };
      const productOrder = [{ brand: 'asc' }, { name: 'asc' }];
      const products = await prisma.product.findMany({
        where: {
          ...productFilter,
          // Fonte da verdade: basta um tamanho com saldo físico positivo na loja.
          sizes: { some: { storeStocks: { some: { storeId: store.id, stock: { gt: 0 } } } } },
        },
        select: productSelection,
        orderBy: productOrder,
      });

      if (!products.length) {
        emptyStores.push({ storeId: store.id, code: store.code, name: store.name });
        continue;
      }

      const items = products.map((p) => ({
        productId: p.id,
        // Uma etiqueta por modelo, nunca uma etiqueta por tamanho/quantidade em estoque.
        quantity: 1,
        price: p.price,
        promotionalPrice: usePromo ? p.promoPrice : null,
        barcode: p.sku,
      }));
      const totalLabels = items.length * labelsPerProduct(templateMeta);
      const filterName = [brand && `marca ${brand}`, category && `categoria ${category}`]
        .filter(Boolean)
        .join(' · ');
      const batch = await prisma.labelBatch.create({
        data: {
          name: name || `Etiquetas ${store.code}${filterName ? ` — ${filterName}` : ''}`,
          templateId: templateMeta.id,
          storeId: store.id,
          createdById: req.userId,
          status: 'DRAFT',
          totalLabels,
          items: { create: items },
        },
        include: { items: true, template: true },
      });
      batches.push({
        id: batch.id,
        name: batch.name,
        storeId: store.id,
        storeCode: store.code,
        storeName: store.name,
        models: products.length,
        physicalLabels: totalLabels,
      });
    }

    res.json({
      batches,
      templateId: templateMeta.id,
      templateName: templateMeta.name,
      totalBatches: batches.length,
      totalModels: batches.reduce((sum, b) => sum + b.models, 0),
      emptyStores,
    });
  } catch (err) {
    console.error('[labels/batches/auto] erro:', err);
    res.status(500).json({ error: 'Erro ao gerar etiquetas automaticamente', detail: err.message });
  }
});

// Exposto apenas para os testes determinísticos de composição das etiquetas;
// o objeto continua sendo um Router Express normalmente.
router.labelProductName = labelProductName;
router.labelProductDescription = labelProductDescription;
router.labelMotivationText = labelMotivationText;
router.labelStyle = labelStyle;
router.productType = productType;
module.exports = router;
