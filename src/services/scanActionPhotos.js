'use strict';
const { createHash } = require('node:crypto');
const sharp = require('sharp');
const { operator, canSend } = require('./scanTransfers');
const metadataSelect = { id: true, scanId: true, sha256: true, mimeType: true, width: true, height: true, barcode: true, ocrText: true, capturedAt: true, archivedAt: true };
const uuid = value => typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value);
function fail(message, status = 400) { const error = Error(message); error.status = status; throw error; }
async function access(db, actor, sessionId, scanId, write = false) {
  if (!uuid(sessionId) || !uuid(scanId)) fail('Identificador da leitura inválido.');
  const actual = await operator(db, actor?.id);
  const where = require('./scanActionHistory').visibleWhere(actual, '');
  const scan = await db.scanActionRead.findFirst({ where: { clientScanId: scanId, lotId: sessionId, lot: where }, include: { lot: true } });
  if (!scan) fail('Leitura não encontrada nas lojas autorizadas.', 404);
  if (write && !['admin', 'superadmin'].includes(actual.role) && (scan.lot.operatorId !== actual.id || !canSend(actual, scan.lot.mode === 'transfer' ? scan.lot.fromStoreId : scan.lot.toStoreId))) fail('Você não pode anexar imagem à leitura de outro operador.', 403);
  return { actual, scan };
}
async function decode(input) {
  if (typeof input.photo !== 'string' || input.photo.length > 1400000) fail('A foto deve ter até 1 MB. Aproxime a etiqueta e tente novamente.');
  const match = input.photo.match(/^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/]+={0,2})$/);
  if (!match) fail('Formato de imagem inválido.');
  const image = Buffer.from(match[2], 'base64');
  if (!image.length || image.length > 1024 * 1024 || image.toString('base64') !== match[2]) fail('Imagem inválida ou muito grande.');
  let metadata;
  try { metadata = await sharp(image, { limitInputPixels: 16000000 }).metadata(); }
  catch (_) { fail('Não foi possível ler a imagem enviada.'); }
  if (!metadata.width || !metadata.height || metadata.width * metadata.height > 16000000 || (metadata.pages || 1) > 1 || 'image/' + metadata.format !== match[1]) fail('A imagem da etiqueta deve ser uma foto estática válida.');
  const capturedAt = new Date(input.capturedAt);
  if (typeof input.capturedAt !== 'string' || !Number.isFinite(capturedAt.getTime()) || capturedAt < new Date('2020-01-01') || capturedAt > new Date(Date.now() + 300000)) fail('Horário da captura inválido.');
  const barcode = String(input.barcode || '').trim();
  if (!barcode || barcode.length > 100) fail('Código da foto inválido.');
  return { image, mimeType: match[1], width: metadata.width, height: metadata.height, sha256: createHash('sha256').update(image).digest('hex'), capturedAt, barcode, ocrText: String(input.ocrText || '').slice(0, 12000) };
}
async function save(db, actor, sessionId, scanId, input = {}) {
  // Authorize before processing bytes; verify again inside the write transaction.
  await access(db, actor, sessionId, scanId, true);
  const data = await decode(input);
  return db.$transaction(async tx => {
    const { actual, scan } = await access(tx, actor, sessionId, scanId, true);
    const codes = [scan.barcode, scan.originalBarcode, ...(Array.isArray(scan.barcodeHistory) ? scan.barcodeHistory.flatMap(h => [h.from, h.to]) : [])].filter(Boolean);
    if (!codes.includes(data.barcode)) fail('O código da foto não corresponde a esta leitura.', 409);
    const photo = await tx.scanActionPhoto.upsert({ where: { scanId_sha256: { scanId, sha256: data.sha256 } }, create: { scanId, ...data, uploadedById: actual.id }, update: {}, select: metadataSelect });
    if (!photo.ocrText && data.ocrText) {
      await tx.scanActionPhoto.updateMany({ where: { id: photo.id, ocrText: '' }, data: { ocrText: data.ocrText } });
      return { photo: await tx.scanActionPhoto.findUnique({ where: { id: photo.id }, select: metadataSelect }), archived: true };
    }
    return { photo, archived: true };
  }, { timeout: 15000 });
}
async function image(db, actor, sessionId, scanId, photoId) {
  if (!uuid(photoId)) fail('Identificador da foto inválido.');
  await access(db, actor, sessionId, scanId);
  const photo = await db.scanActionPhoto.findFirst({ where: { id: photoId, scanId }, select: { image: true, mimeType: true, sha256: true } });
  if (!photo) fail('Foto não encontrada nesta leitura.', 404);
  return photo;
}
module.exports = { metadataSelect, save, image, decode };
