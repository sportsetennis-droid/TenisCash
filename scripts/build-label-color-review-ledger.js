const fs = require('node:fs');
const path = require('node:path');
const { PrismaClient } = require('@prisma/client');
const labels = require('../src/routes/labels');

const OUTPUT_DIR = process.env.LABEL_COLOR_AUDIT_OUTPUT_DIR
  || path.resolve(process.cwd(), 'work/color-audit');
const LEDGER_PATH = path.resolve(__dirname, '../src/data/label-color-review-ledger.json');
const REVIEW_VERSION = 1;
const REVIEW_METHOD = 'strict-evidence-product-by-product-v1';

function contextOf(value) {
  if (!value) return {};
  if (typeof value === 'object') return value;
  try { return JSON.parse(value); } catch { return {}; }
}

function normalizeValue(value) {
  if (value == null || (typeof value === 'object' && !Array.isArray(value))) return '';
  return (Array.isArray(value) ? value.filter(Boolean).join('/') : String(value)).trim();
}

function normalizeText(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function canonicalColorText(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9/]+/g, ' ')
    .replace(/\s*\/\s*/g, '/')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizedColorKey(value) {
  const translated = labels.inferLabelProductColor(
    { id: null, name: '', brand: 'DIADORA' },
    { color: value },
  );
  return normalizeText(translated || value);
}

function reviewedColorOutput(value) {
  return labels.inferLabelProductColor(
    { id: null, name: '', brand: 'DIADORA' },
    { color: value },
  ) || String(value || '').trim();
}

function colorParts(value) {
  return canonicalColorText(value).split('/').map((part) => part.trim()).filter(Boolean);
}

function isOrderedSubset(shortValue, fullValue) {
  const shortParts = colorParts(shortValue);
  const fullParts = colorParts(fullValue);
  if (!shortParts.length || fullParts.length <= shortParts.length) return false;
  let cursor = 0;
  for (const part of fullParts) {
    if (part === shortParts[cursor]) cursor += 1;
    if (cursor === shortParts.length) return true;
  }
  return false;
}

function sourceEntries(product, context) {
  const classification = context?.classification || {};
  const classification2 = context?.classification2 || {};
  return [
    ['aiContext.color', context?.color],
    ['aiContext.cor', context?.cor],
    ['aiContext.productColor', context?.productColor],
    ['aiContext.attributes.color', context?.attributes?.color],
    ['aiContext.attributes.cor', context?.attributes?.cor],
    ['aiContext.specifications.color', context?.specifications?.color],
    ['aiContext.specifications.cor', context?.specifications?.cor],
    ['aiContext.classification.color', classification?.color],
    ['aiContext.classification.cor', classification?.cor],
    ['aiContext.classification2.color', classification2?.color],
    ['aiContext.classification2.cor', classification2?.cor],
    ['Product.color', product?.color],
  ].map(([source, value]) => ({ source, value: normalizeValue(value) }))
    .filter((entry) => entry.value);
}

function rawOccurrenceEvidence(product, rawValues) {
  const brand = normalizeText(product.brand);
  const name = canonicalColorText(product.name);
  let sawExact = false;
  let sawPartial = false;
  for (const rawValue of rawValues) {
    const raw = canonicalColorText(rawValue);
    if (!raw) continue;
    let start = name.indexOf(raw);
    while (start >= 0) {
      const before = name.slice(0, start).trimEnd().slice(-1);
      const after = name.slice(start + raw.length).trimStart().slice(0, 1);
      const boundaryBefore = !before || before === '/' || /\s/.test(name[start - 1] || '');
      const boundaryAfter = !after || after === '/' || /\s/.test(name[start + raw.length] || '');
      if (boundaryBefore && boundaryAfter) {
        const slashDelimitedField = ['caju brasil', 'let s gym'].includes(brand)
          && before === '/' && after === '/';
        if (!slashDelimitedField && (before === '/' || after === '/')) sawPartial = true;
        else sawExact = true;
      }
      start = name.indexOf(raw, start + 1);
    }
  }
  if (sawExact) return 'exact';
  if (sawPartial) return 'partial';
  return 'absent';
}

function exactBrooksNameColor(product) {
  if (normalizeText(product.brand) !== 'brooks') return '';
  const match = String(product.name || '').match(/\b(?:FEMININO|MASCULINO|UNISSEX)\s+(.+?)\s*$/i);
  if (!match || !match[1].includes('/')) return '';
  const parts = match[1].split('/').map((part) => part.trim()).filter(Boolean);
  if (parts.length < 2 || parts.some((part) => /\b(?:tam|ref|sku)\b|\d{4,}/i.test(part))) return '';
  return parts.join('/').toUpperCase();
}

function compact(value, limit = 54) {
  const text = String(value || '').replace(/\s+/g, ' ').trim().toUpperCase();
  return text.length <= limit ? text : `${text.slice(0, limit - 3).trim()}...`;
}

function doubt(type, short, detail, reason, evidence = {}) {
  return {
    status: 'doubt',
    color: '',
    issue: { type, short, detail },
    reason,
    evidence,
  };
}

function confirmed(color, reason, evidence = {}) {
  return {
    status: 'confirmed',
    color,
    issue: null,
    reason,
    evidence,
  };
}

function reviewProduct(product, context) {
  const entries = sourceEntries(product, context);
  const rawValues = [...new Set(entries.map((entry) => entry.value))];
  const structuredColors = [...new Map(rawValues.map((raw) => {
    const color = labels.inferLabelProductColor({ ...product, id: null, name: '' }, { color: raw });
    return [normalizedColorKey(color), color];
  }).filter(([key]) => key)).values()];
  const nameColor = labels.inferLabelProductColor({ ...product, id: null }, {});
  const brooksNameColor = exactBrooksNameColor(product);
  const exactNameColor = brooksNameColor || nameColor;
  const baseEvidence = {
    structuredValues: entries,
    structuredColors,
    nameColor: exactNameColor || '',
  };

  if (structuredColors.length > 1) {
    const values = structuredColors.map((value) => compact(value, 20)).join(' / ');
    return doubt(
      'conflict',
      'DÚVIDA: CORES DIVERGEM',
      `DÚVIDA: CAMPOS DE COR DIVERGENTES: ${values}`,
      'Campos estruturados do mesmo produto contêm cores divergentes.',
      baseEvidence,
    );
  }

  if (structuredColors.length === 1) {
    const structuredColor = structuredColors[0];
    const occurrence = rawOccurrenceEvidence(product, rawValues);

    if (brooksNameColor) {
      return confirmed(
        brooksNameColor,
        'O padrão Brooks identifica integralmente a combinação depois do gênero; o campo estruturado continha apenas parte dela.',
        { ...baseEvidence, partialStructuredColor: structuredColor, nameOccurrence: occurrence },
      );
    }

    if (occurrence === 'exact') {
      return confirmed(
        reviewedColorOutput(structuredColor),
        'A cor estruturada aparece integralmente no nome do mesmo produto.',
        { ...baseEvidence, nameOccurrence: occurrence },
      );
    }

    if (occurrence === 'partial') {
      const brand = normalizeText(product.brand);
      if (['fila', 'umbro'].includes(brand)
        && exactNameColor
        && isOrderedSubset(structuredColor, exactNameColor)) {
        return confirmed(
          exactNameColor,
          'O padrão codificado da marca contém a combinação completa; o campo estruturado continha apenas parte dela.',
          { ...baseEvidence, partialStructuredColor: structuredColor, nameOccurrence: occurrence },
        );
      }
      return doubt(
        'partial-color',
        'DÚVIDA: COR PARCIAL',
        `DÚVIDA: O CAMPO ${compact(structuredColor, 24)} É PARTE DE UMA COMBINAÇÃO MAIOR NO NOME`,
        'A cor estruturada está inserida em uma combinação maior e não pode ser impressa isoladamente.',
        { ...baseEvidence, nameOccurrence: occurrence },
      );
    }

    if (exactNameColor) {
      if (normalizedColorKey(exactNameColor) === normalizedColorKey(structuredColor)) {
        return confirmed(
          reviewedColorOutput(structuredColor),
          'Campo estruturado e nome do produto confirmam exatamente a mesma cor.',
          baseEvidence,
        );
      }
      if (isOrderedSubset(structuredColor, exactNameColor)) {
        return confirmed(
          exactNameColor,
          'O nome contém a combinação completa; o campo estruturado continha apenas parte dela.',
          { ...baseEvidence, partialStructuredColor: structuredColor },
        );
      }
      return doubt(
        'sources-diverge',
        'DÚVIDA: FONTES DIVERGEM',
        `DÚVIDA: CAMPO ${compact(structuredColor, 18)} / NOME ${compact(exactNameColor, 18)}`,
        'O campo estruturado e a cor identificada no nome não concordam.',
        baseEvidence,
      );
    }

    return doubt(
      'unverified-source',
      'DÚVIDA: SEM CONFIRMAÇÃO',
      `DÚVIDA: COR ${compact(structuredColor, 28)} SEM SEGUNDA EVIDÊNCIA NO PRODUTO`,
      'Existe uma cor estruturada, mas ela não é confirmada pelo nome nem por outra fonte do cadastro.',
      { ...baseEvidence, nameOccurrence: occurrence },
    );
  }

  if (exactNameColor) {
    return confirmed(
      exactNameColor,
      'O nome segue um padrão de cor integral e foi aceito sem ignorar palavras desconhecidas.',
      baseEvidence,
    );
  }

  const inferredIssue = labels.inferLabelProductColorIssue({ ...product, id: null }, context);
  if (rawValues.length) {
    return doubt(
      inferredIssue?.type || 'unmapped',
      inferredIssue?.short || 'DÚVIDA: COR NÃO VALIDADA',
      inferredIssue?.detail || `DÚVIDA: VALOR ${compact(rawValues[0], 28)} NÃO VALIDADO COMO COR`,
      'O valor cadastrado não passou nas regras estritas de identificação de cor.',
      baseEvidence,
    );
  }
  return doubt(
    'missing',
    'DÚVIDA: SEM CADASTRO',
    'DÚVIDA: SEM COR NO CADASTRO OU NO NOME DO PRODUTO',
    'Nenhuma fonte de cor foi encontrada para este produto.',
    baseEvidence,
  );
}

function csvValue(value) {
  const text = value == null ? '' : typeof value === 'string' ? value : JSON.stringify(value);
  return `"${text.replace(/"/g, '""')}"`;
}

async function main() {
  if (!process.env.TENISCASH_COLOR_AUDIT_DB) {
    throw new Error('TENISCASH_COLOR_AUDIT_DB é obrigatória para a auditoria de cores.');
  }
  const prisma = new PrismaClient({
    datasources: { db: { url: process.env.TENISCASH_COLOR_AUDIT_DB } },
  });
  try {
    const query = `
      SELECT
        p.id,
        p.sku,
        p."internalBarcode",
        p.brand,
        p.name,
        p.category,
        p.subcategory,
        p."shortDescription",
        p."longDescription",
        p.features,
        p."aiContext",
        p."imageUrl",
        p."updatedAt"
      FROM "Product" p
      WHERE p.active = true
        AND p.price > 0
        AND EXISTS (
          SELECT 1
          FROM "ProductSize" ps
          JOIN "StoreStock" ss ON ss."productSizeId" = ps.id
          WHERE ps."productId" = p.id AND ss.stock > 0
        )
      ORDER BY p.brand, p.name, p.id
    `;
    const products = await prisma.$queryRawUnsafe(query);
    const reviewedAt = new Date().toISOString();
    const auditRows = [];
    const ledgerProducts = {};

    for (const product of products) {
      const context = contextOf(product.aiContext);
      const review = reviewProduct(product, context);
      const fingerprint = labels.labelProductColorReviewFingerprint(product, context);
      ledgerProducts[product.id] = {
        sku: product.sku,
        brand: product.brand,
        name: product.name,
        fingerprint,
        fingerprintInput: labels.labelProductColorReviewFingerprintInput(product, context),
        status: review.status,
        color: review.color,
        issue: review.issue,
        reason: review.reason,
        evidence: review.evidence,
      };
      auditRows.push({
        product_id: product.id,
        sku: product.sku,
        internal_barcode: product.internalBarcode || '',
        brand: product.brand,
        product_name: product.name,
        category: product.category,
        subcategory: product.subcategory || '',
        updated_at: new Date(product.updatedAt).toISOString(),
        decision: review.status === 'confirmed' ? 'CONFIRMADA' : 'DÚVIDA',
        label_color: review.color,
        doubt_type: review.issue?.type || '',
        doubt_short: review.issue?.short || '',
        doubt_detail: review.issue?.detail || '',
        review_reason: review.reason,
        evidence: review.evidence,
        image_url: product.imageUrl || '',
      });
    }

    const ledger = {
      version: REVIEW_VERSION,
      reviewedAt,
      method: REVIEW_METHOD,
      scope: 'active-in-stock-products-with-positive-price',
      sourceQuery: query.trim(),
      products: ledgerProducts,
    };
    fs.writeFileSync(LEDGER_PATH, `${JSON.stringify(ledger, null, 2)}\n`, 'utf8');

    fs.mkdirSync(OUTPUT_DIR, { recursive: true });
    const jsonPath = path.join(OUTPUT_DIR, 'auditoria-individual-cor-etiquetas.json');
    const csvPath = path.join(OUTPUT_DIR, 'auditoria-individual-cor-etiquetas.csv');
    fs.writeFileSync(jsonPath, `${JSON.stringify(auditRows, null, 2)}\n`, 'utf8');
    const columns = [
      'product_id', 'sku', 'internal_barcode', 'brand', 'product_name', 'category', 'subcategory',
      'updated_at', 'decision', 'label_color', 'doubt_type', 'doubt_short', 'doubt_detail',
      'review_reason', 'evidence', 'image_url',
    ];
    const csv = [columns.map(csvValue).join(',')]
      .concat(auditRows.map((row) => columns.map((column) => csvValue(row[column])).join(',')))
      .join('\r\n');
    fs.writeFileSync(csvPath, `${csv}\r\n`, 'utf8');

    const counts = auditRows.reduce((acc, row) => {
      acc.total += 1;
      acc[row.decision === 'CONFIRMADA' ? 'confirmed' : 'doubt'] += 1;
      const reason = row.doubt_type || 'confirmed';
      acc.byReason[reason] = (acc.byReason[reason] || 0) + 1;
      return acc;
    }, { total: 0, confirmed: 0, doubt: 0, byReason: {} });
    console.log(JSON.stringify({ counts, ledgerPath: LEDGER_PATH, jsonPath, csvPath }, null, 2));
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
