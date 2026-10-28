'use strict';

const rounds = require('./stocktakeRounds');
const { learnScannerBarcode, validGtin } = require('./scannerReference');
const { parseScannerText } = require('./scannerText');
const { captureComplete } = require('./scannerCompletion');
const barcodePolicy = require('../../public/scanner-barcode-policy');
const { resolveBarcodeRows } = require('./scannerCatalog');

function sameBarcode(a, b) {
  return barcodePolicy.identity(a) === barcodePolicy.identity(b);
}

async function matchInternalBarcode(db, barcode, size) {
  // Internal printed barcodes keep their leading zeros and only resolve on an
  // exact, existing ProductSize link. They are never treated as fiscal GTINs.
  const rows = await db.productSize.findMany({ where: { barcode }, include: { product: true } });
  const matches = await resolveBarcodeRows(db, rows);
  if (matches.length > 1) return { reason: 'barcode_conflict' };
  const variant = matches[0];
  if (!variant) return { reason: 'barcode_not_linked' };
  if (!variant.product?.active) return { reason: 'inactive_product' };
  if (!variant.size || variant.size === '?' || /^T-/.test(variant.size)) return { reason: 'size_required' };
  if (size && String(size).trim().toUpperCase() !== String(variant.size).trim().toUpperCase()) return { reason: 'size_conflict' };
  return { reason: 'matched', productId: variant.productId, productSizeId: variant.id, name: variant.product.name };
}

function pendingMessage(reason) {
  const messages = {
    reference_not_found: 'Código lido. Continue aproximando a referência e o tamanho da mesma etiqueta.',
    size_required: 'Código lido. Continue aproximando o tamanho da mesma etiqueta.',
    reference_conflict: 'Há referências divergentes. Continue com a mesma etiqueta para conferir.',
    barcode_conflict: 'Este código possui cadastros divergentes. A leitura permanece pendente.',
    barcode_not_linked: 'Código lido e salvo. Ainda não há uma variante cadastrada para este código; o bipe continua pendente.',
    size_conflict: 'O tamanho lido difere do cadastro. A leitura permanece pendente.',
    size_barcode_conflict: 'O tamanho possui outro código de barras. A leitura permanece pendente.',
    brand_conflict: 'A marca lida difere do cadastro. A leitura permanece pendente.',
    inactive_product: 'O cadastro deste produto está inativo. A leitura permanece pendente.',
    invalid_barcode: 'Ainda falta ler um código de barras válido.',
  };
  return messages[reason] || 'Código registrado. Conferindo produto e tamanho.';
}

// Automatic recognition retains a scan, never a camera photograph. OCR is
// transient input to the existing exact-identifier resolver. A manual picture
// already belonging to this physical scan may be linked, but is never replaced.
function createAutomaticRecognizer({ db, normalizeScannedSize, needsManualSize,
  sizeOptionsForBipe, learn = learnScannerBarcode }) {
  function validateCapture(capture, input, barcode) {
    if (!capture) return;
    if (capture.storeId !== input.storeId || capture.roundId !== input.roundId ||
        capture.excludedAt || capture.status === 'descartado')
      rounds.fail('Esta leitura não está ativa nesta loja e rodada.');
    if (capture.barcode && !sameBarcode(capture.barcode, barcode))
      rounds.fail('Código diferente da peça em leitura.');
  }

  return async function recognize(input, request = {}) {
    const barcodeRead = String(input.barcode || '').trim();
    if (!barcodePolicy.isInternalCode(barcodeRead) && !validGtin(barcodeRead)) {
      const error = new Error('Continue com a câmera na mesma etiqueta para ler o código de barras.');
      error.status = 422; error.barcodeRequired = true; throw error;
    }
    await rounds.roundForScan(db, input.storeId, input.roundId);
    const key = rounds.scanKey(input.roundId, input.clientScanId);
    const previous = await db.stocktakeBipe.findUnique({ where: { scanKey: key } });
    if (previous && (!sameBarcode(previous.barcode, barcodeRead) || previous.excludedAt ||
        previous.storeId !== input.storeId || previous.roundId !== input.roundId))
      rounds.fail('Conflito no identificador da leitura.');
    // Preserve the first actual representation (UPC/EAN leading-zero alias).
    const barcode = previous?.barcode || barcodeRead;
    const previousCapture = await db.productCapture.findUnique({ where: { scanKey: key } });
    validateCapture(previousCapture, input, barcode);
    const original = previous || previousCapture;
    const sellerId = original ? original.sellerId || null : input.sellerId ? String(input.sellerId) : null;
    const sellerName = original ? original.sellerName || null : input.sellerName ? String(input.sellerName).slice(0, 240) : null;

    // Each distinct scan ID is one physical piece. Retries of the same scan
    // remain idempotent through scanKey; repeated product barcodes are valid.
    const guarded = {
      $transaction: run => db.$transaction(async tx => {
        await rounds.roundForScan(tx, input.storeId, input.roundId, true);
        await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${key}))::text`;
        const current = await tx.stocktakeBipe.findUnique({ where: { scanKey: key } });
        if (current && (current.excludedAt || current.storeId !== input.storeId ||
            current.roundId !== input.roundId || !sameBarcode(current.barcode, barcode)))
          rounds.fail('Esta leitura foi excluída ou pertence a outro contexto.');
        const capture = await tx.productCapture.findUnique({ where: { scanKey: key } });
        validateCapture(capture, input, barcode);
        if (capture?.bipeId && capture.bipeId !== current?.id)
          rounds.fail('A foto já pertence a outra leitura.');
        const bipe = await run(tx);
        if (capture) await tx.productCapture.update({ where: { id: capture.id }, data: {
          barcode: bipe.barcode, bipeId: bipe.id,
        } });
        return bipe;
      }),
    };
    const bipe = await rounds.createRoundBipe(guarded, {
      roundId: input.roundId, scanKey: key, storeId: input.storeId, barcode,
      sellerId, sellerName, found: false, duplicate: false, applied: false,
      productId: null, productSizeId: null, productName: null, productSize: null, productBrand: null,
      ...(previousCapture?.createdAt ? { bipedAt: previousCapture.createdAt } : {}),
      ip: request.ip || null,
      userAgent: ('scanner-auto | cs:' + input.clientScanId).slice(0, 160),
    });
    const text = typeof input.ocrText === 'string' ? input.ocrText.slice(0, 4000) : '';
    const read = parseScannerText(text);
    const scannedSize = normalizeScannedSize(read?.tamanho);
    const match = barcodePolicy.isInternalCode(barcode)
      ? await matchInternalBarcode(db, barcode, scannedSize)
      : await learn(db, { barcode, read, size: scannedSize });

    const resolved = await db.$transaction(async tx => {
      await rounds.roundForScan(tx, input.storeId, input.roundId, true);
      await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${key}))::text`;
      const current = await tx.stocktakeBipe.findUnique({ where: { id: bipe.id } });
      if (!current || current.excludedAt || current.storeId !== input.storeId ||
          current.roundId !== input.roundId || current.scanKey !== key || !sameBarcode(current.barcode, barcode))
        rounds.fail('Esta leitura não está mais ativa nesta loja e rodada.');
      const capture = await tx.productCapture.findUnique({ where: { scanKey: key } });
      validateCapture(capture, input, barcode);
      if (capture?.bipeId && capture.bipeId !== current.id)
        rounds.fail('A foto já pertence a outra leitura.');
      // A manual tap can arrive while recognition is running. Link its already
      // saved photograph to the same scan without editing photo/revision/note.
      if (capture && (!capture.bipeId || !capture.barcode))
        await tx.productCapture.update({ where: { id: capture.id }, data: { barcode, bipeId: current.id } });
      const size = match.reason === 'matched' && match.productSizeId
        ? await tx.productSize.findUnique({ where: { id: match.productSizeId }, include: { product: true } }) : null;
      const matched = Boolean(size?.product?.active && size.productId === match.productId);
      if (current.applied && (!matched || current.productSizeId !== size.id))
        rounds.fail('Uma leitura já aplicada ao estoque não pode mudar de produto ou tamanho.');
      let updated = current;
      if (matched) updated = await tx.stocktakeBipe.update({ where: { id: current.id }, data: {
        productId: size.productId, productSizeId: size.id, productName: size.product.name,
        productSize: size.size, productBrand: size.product.brand, found: true, duplicate: false,
      } });
      // Explicit conflicting OCR must not leave this scan counted as confirmed.
      // A late attempt without readable OCR may not erase a newer valid match.
      else if (!current.applied && (!current.found || read)) updated = await tx.stocktakeBipe.update({ where: { id: current.id }, data: {
        productId: null, productSizeId: null, productName: null, productSize: null, productBrand: null,
        found: false, duplicate: match.reason === 'barcode_conflict',
      } });
      // Keep the photo polling API consistent with this synchronous result.
      // Original photo bytes, revision marker and OCR note remain untouched.
      if (capture && (matched || !current.found || read)) await tx.productCapture.update({
        where: { id: capture.id }, data: { status: matched ? 'vinculado' : 'pendente',
          matchedProductId: matched ? size.productId : null, resolvedAt: new Date() },
      });
      return { bipe: updated, size, matched };
    });
    const needsSize = Boolean(resolved.size && needsManualSize(resolved.size.product.brand, resolved.size));
    const complete = resolved.matched && captureComplete({ status: 'vinculado', barcode }, resolved.bipe, resolved.size, needsSize);
    const product = resolved.size ? { name: resolved.size.product.name, brand: resolved.size.product.brand,
      size: resolved.size.size, sku: resolved.size.product.sku || null,
      imageUrl: resolved.size.product.imageUrl || null, active: resolved.size.product.active } : null;
    return {
      ok: true, bipeId: resolved.bipe.id, barcode, complete: Boolean(complete),
      found: resolved.matched, duplicate: Boolean(resolved.bipe.duplicate), needsSize,
      product, pending: !complete, photoSaved: false,
      appliedToStock: Boolean(resolved.bipe.applied), blockedReason: resolved.bipe.applied ? null : 'round_count_only',
      sizeOptions: needsSize ? await sizeOptionsForBipe(resolved.size.product.name, barcode) : undefined,
      message: complete ? '✓ ' + product.name + ' — tamanho ' + product.size : needsSize
        ? 'Código e produto reconhecidos. Falta conferir o tamanho da caixa.' : pendingMessage(match.reason),
    };
  };
}

module.exports = { createAutomaticRecognizer, pendingMessage, matchInternalBarcode };
