'use strict';
const { createHash } = require('node:crypto');
const rounds = require('./stocktakeRounds');
const barcodePolicy = require('../../public/scanner-barcode-policy');
const marker = /\n\[scanner-photo-revision:(\d{1,30})\]$/;
function revisionOf(note) { return String(note || '').match(marker)?.[1] || ''; }
function visibleNote(note) { return String(note || '').replace(marker, ''); }
function photoNote(note, message, revision = revisionOf(note)) {
  const suffix = revision ? '\n[scanner-photo-revision:' + revision + ']' : '';
  return visibleNote(message).slice(0, 480 - suffix.length) + suffix;
}
function hash(photo) { return createHash('sha256').update(photo).digest('hex'); }
function normalizeRevision(value) {
  const revision = String(value || '');
  if (revision && !/^\d{1,30}$/.test(revision)) rounds.fail('Identificador de foto inválido.', 400);
  return revision ? BigInt(revision).toString() : '0';
}
async function savePhoto(db, data) {
  const { roundId, storeId, scanKey, photo, barcode, sellerId, sellerName } = data;
  const suppliedRevision = normalizeRevision(data.photoRevision);
  return db.$transaction(async tx => {
    await rounds.roundForScan(tx, storeId, roundId, true);
    await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${scanKey}))::text`;
    const previous = await tx.productCapture.findUnique({ where: { scanKey } });
    if (previous && (previous.storeId !== storeId || previous.roundId !== roundId || previous.excludedAt || previous.status === 'descartado'))
      rounds.fail('A captura não pertence a esta loja e rodada ativa.');
    if (previous?.barcode && barcode && barcodePolicy.identity(previous.barcode) !== barcodePolicy.identity(barcode))
      rounds.fail('Código diferente da peça em leitura. Mantenha a mesma etiqueta ou feche o scanner para revisar.');
    const oldRevision = revisionOf(previous?.note);
    const revision = suppliedRevision;
    const stale = !!oldRevision && /^\d+$/.test(oldRevision) && /^\d+$/.test(revision) && BigInt(revision) < BigInt(oldRevision);
    const originals = new Map();
    for (const image of [previous?.photo, ...(Array.isArray(previous?.photos) ? previous.photos : []), photo])
      if (typeof image === 'string' && image) originals.set(hash(image), image);
    const primary = stale ? previous.photo : photo;
    const photos = [...originals.values()].filter(image => image !== primary);
    const changed = !stale && (previous?.photo !== photo || oldRevision !== revision);
    const note = photoNote(previous?.note, changed ? 'etiqueta Foto salva. Aguardando leitura.' : visibleNote(previous.note), stale ? oldRevision : revision);
    const knownBarcode = previous?.barcode || (!stale ? barcode : null) || null;
    const capture = previous
      ? await tx.productCapture.update({ where: { id: previous.id }, data: { photo: primary, photos, note, barcode: knownBarcode,
        ...(changed ? { status: 'pendente', resolvedAt: null } : {}) } })
      : await tx.productCapture.create({ data: { roundId, storeId, scanKey, sellerId: sellerId || null,
        sellerName: sellerName ? String(sellerName).slice(0, 80) : null, photo, photos, note, barcode: knownBarcode, status: 'pendente' } });
    return { capture, stale, photoRevision: revisionOf(capture.note), receivedPhotoRevision: revision };
  });
}
module.exports = { savePhoto, photoNote, revisionOf, visibleNote };
