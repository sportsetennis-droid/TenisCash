'use strict';
const label = require('./scannerArchivedLabel');
const barcodePolicy = require('../../public/scanner-barcode-policy');
const { learnScannerBarcode } = require('./scannerReference');
const jobs = new Map();
async function identify(db, actor, sessionId, scanId, photoId) {
  const { actual, scan } = await require('./scanActionPhotos').access(db, actor, sessionId, scanId, true);
  const photo = await db.scanActionPhoto.findFirst({ where: { id: photoId, scanId } });
  if (!photo) { const e = Error('Foto não encontrada nesta leitura.'); e.status = 404; throw e; }
  if (scan.removed || scan.lot.status !== 'open') return { status: 'pending', reason: 'closed_or_removed' };
  if (scan.recognized && scan.productSizeId) {
    const prior = await db.adminAction.findUnique({ where: { id: 'scan-photo-link:' + scanId + ':' + barcodePolicy.identity(scan.barcode) } });
    let proof; try { proof = JSON.parse(prior?.metadata || '{}'); } catch (_) { proof = {}; }
    if (proof.barcode === scan.barcode && proof.productSizeId === scan.productSizeId) return proof.identification;
    return { status: 'not_needed' };
  }
  if (jobs.has(photoId)) return jobs.get(photoId);
  const task = (async () => {
    if (!(await label.fiscalRows(db, scan.barcode)).length) return { status: 'pending', reason: 'exact_invoice_missing' };
    const observed = await label.readImage(Buffer.from(photo.image), scan.barcode);
    if (!observed || observed.pending) return { status: 'pending', retry: !!observed?.retry, reason: observed?.reason || 'photo_pending' };
    const evidence = { ...observed, photoId, sha256: photo.sha256 };
    const learned = await learnScannerBarcode(db, { barcode: scan.barcode, archivedLabel: evidence });
    if (!learned.productSizeId) return { status: 'pending', reason: learned.reason };
    return db.$transaction(async tx => {
      await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${'scan-action-lot:' + sessionId}))::text`;
      const { scan: current } = await require('./scanActionPhotos').access(tx, actual, sessionId, scanId, true);
      if (current.removed || current.lot.status !== 'open' || current.barcode !== scan.barcode) return { status: 'pending', reason: 'read_changed' };
      const size = await tx.productSize.findUnique({ where: { id: learned.productSizeId }, include: { product: true } });
      if (!size?.product.active || size.size !== observed.size || barcodePolicy.identity(size.barcode) !== barcodePolicy.identity(scan.barcode)) return { status: 'pending', reason: 'variant_changed' };
      const identification = { status: 'linked', barcode: scan.barcode, confirmedSize: observed.size, requiresSizeConfirmation: false,
        product: { productSizeId: size.id, name: size.product.name, brand: size.product.brand, size: size.size, barcode: scan.barcode, imageUrl: size.product.imageUrl || null } };
      await tx.scanActionRead.update({ where: { clientScanId: scanId }, data: { recognized: true, productSizeId: size.id, productName: size.product.name,
        brand: size.product.brand, size: size.size, confirmedSize: observed.size, requiresSizeConfirmation: false, error: null } });
      await tx.scanActionPhoto.updateMany({ where: { id: photoId, ocrText: '' }, data: { ocrText: observed.text } });
      const auditId = 'scan-photo-link:' + scanId + ':' + barcodePolicy.identity(scan.barcode);
      await tx.adminAction.upsert({ where: { id: auditId }, update: {}, create: {
        id: auditId, adminId: actual.id, action: 'scan_photo_variant_linked',
        description: 'Código e tamanho vinculados automaticamente pela foto arquivada e NF-e de entrada. Sem alteração de estoque.',
        metadata: JSON.stringify({ source: observed.source, scanId, sessionId, photoId, sha256: photo.sha256, barcode: scan.barcode,
          productSizeId: size.id, productId: size.productId, size: size.size, references: observed.references, ocrText: observed.text, identification, at: new Date().toISOString(), stockChanged: false })
      } });
      return identification;
    }, { timeout: 15000 });
  })().finally(() => jobs.delete(photoId));
  jobs.set(photoId, task); return task;
}
module.exports = { identify };
