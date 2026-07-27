const crypto = require('crypto');

// Prefixo 20-29 é reservado para circulação interna. O dígito final é o
// verificador EAN-13, para que leitores configurados como EAN aceitem o código.
const INTERNAL_PREFIX = '20';
const INTERNAL_BODY_SPACE = 10_000_000_000n;

function ean13CheckDigit(body12) {
  const digits = String(body12).replace(/\D/g, '').slice(0, 12).padStart(12, '0');
  let sum = 0;
  for (let i = 0; i < digits.length; i++) sum += Number(digits[i]) * (i % 2 === 0 ? 1 : 3);
  return String((10 - (sum % 10)) % 10);
}

function internalBarcodeCandidate(productId, attempt = 0) {
  const seed = `${productId}:${attempt}`;
  const hash = crypto.createHash('sha256').update(seed).digest('hex');
  const body = `${INTERNAL_PREFIX}${(BigInt(`0x${hash.slice(0, 16)}`) % INTERNAL_BODY_SPACE).toString().padStart(10, '0')}`;
  return body + ean13CheckDigit(body);
}

async function barcodeConflicts(prisma, code, productId) {
  const [product, size, nfe] = await Promise.all([
    prisma.product.findFirst({
      where: { internalBarcode: code, ...(productId ? { id: { not: productId } } : {}) },
      select: { id: true },
    }),
    prisma.productSize.findFirst({ where: { barcode: code }, select: { id: true } }),
    prisma.xmlFiscalItem.findFirst({ where: { ean: code }, select: { id: true } }),
  ]);
  return Boolean(product || size || nfe);
}

async function allocateInternalBarcode(prisma, productId) {
  for (let attempt = 0; attempt < 100; attempt++) {
    const code = internalBarcodeCandidate(productId, attempt);
    if (!(await barcodeConflicts(prisma, code, productId))) return code;
  }
  throw new Error(`Não foi possível reservar código interno para o produto ${productId}`);
}

async function ensureProductInternalBarcode(prisma, productOrId) {
  const id = typeof productOrId === 'string' ? productOrId : productOrId?.id;
  if (!id) throw new Error('Produto sem id para gerar código interno');
  const current = typeof productOrId === 'object' && productOrId.internalBarcode
    ? productOrId
    : await prisma.product.findUnique({ where: { id }, select: { id: true, internalBarcode: true } });
  if (!current) return null;
  if (current.internalBarcode) return current.internalBarcode;

  const code = await allocateInternalBarcode(prisma, id);
  try {
    const updated = await prisma.product.update({
      where: { id },
      data: { internalBarcode: code },
      select: { internalBarcode: true },
    });
    return updated.internalBarcode;
  } catch (err) {
    // Duas requisições simultâneas podem tentar preencher o mesmo produto.
    // Nesse caso, usa o valor que venceu a corrida, sem criar outro código.
    const winner = await prisma.product.findUnique({ where: { id }, select: { internalBarcode: true } }).catch(() => null);
    if (winner?.internalBarcode) return winner.internalBarcode;
    throw err;
  }
}

async function ensureAllProductInternalBarcodes(prisma, options = {}) {
  const products = await prisma.product.findMany({
    where: options.activeOnly ? { active: true } : undefined,
    select: { id: true, internalBarcode: true },
    orderBy: { createdAt: 'asc' },
  });

  // O seed roda no boot. Carregamos os códigos ocupados uma única vez para
  // não fazer três consultas por produto (o backfill pode ter milhares de cards).
  const [internalRows, sizeRows, nfeRows] = await Promise.all([
    prisma.product.findMany({ where: { internalBarcode: { not: null } }, select: { internalBarcode: true } }),
    prisma.productSize.findMany({ where: { barcode: { startsWith: INTERNAL_PREFIX } }, select: { barcode: true } }),
    prisma.xmlFiscalItem.findMany({ where: { ean: { startsWith: INTERNAL_PREFIX } }, select: { ean: true } }),
  ]);
  const used = new Set([
    ...internalRows.map((row) => row.internalBarcode).filter(Boolean),
    ...sizeRows.map((row) => row.barcode).filter(Boolean),
    ...nfeRows.map((row) => row.ean).filter(Boolean),
  ]);

  let created = 0;
  let writes = [];
  const flush = async () => {
    if (!writes.length) return;
    const batch = writes;
    writes = [];
    await prisma.$transaction(batch);
  };
  for (const product of products) {
    if (product.internalBarcode) continue;
    let code = null;
    for (let attempt = 0; attempt < 100; attempt++) {
      const candidate = internalBarcodeCandidate(product.id, attempt);
      if (!used.has(candidate)) {
        code = candidate;
        used.add(candidate);
        break;
      }
    }
    if (!code) throw new Error(`NÃ£o foi possÃ­vel reservar cÃ³digo interno para o produto ${product.id}`);
    writes.push(prisma.product.update({ where: { id: product.id }, data: { internalBarcode: code } }));
    created++;
    if (writes.length >= 100) await flush();
  }
  await flush();
  return { total: products.length, created };
}

module.exports = {
  ean13CheckDigit,
  internalBarcodeCandidate,
  allocateInternalBarcode,
  ensureProductInternalBarcode,
  ensureAllProductInternalBarcodes,
};
