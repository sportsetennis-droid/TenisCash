// Loja 05 is a passive inbox: linking its WhatsApp never enables an attendant.
const STORE_ARCHIVE = Object.freeze({
  key: 'tambau',
  label: 'Sports & Tennis Praia de Tambaú — Loja 05',
  storeCode: 'LOJA05',
  storeId: '5335ae55-d28b-486f-a459-7f352e3bf0c3',
});

function encodeArchiveCursor(row) {
  return Buffer.from(JSON.stringify({
    v: 1, instance: STORE_ARCHIVE.key,
    createdAt: new Date(row.createdAt).toISOString(), id: row.id,
  })).toString('base64url');
}

function decodeArchiveCursor(value) {
  if (!value) return null;
  try {
    if (typeof value !== 'string' || value.length > 1000 || !/^[A-Za-z0-9_-]+$/.test(value)) throw new Error();
    const cursor = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
    const createdAt = new Date(cursor.createdAt);
    if (cursor.v !== 1 || cursor.instance !== STORE_ARCHIVE.key ||
        typeof cursor.id !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(cursor.id) ||
        !Number.isFinite(createdAt.getTime()) || createdAt.toISOString() !== cursor.createdAt) throw new Error();
    return { createdAt, id: cursor.id };
  } catch (_) {
    const error = new Error('Cursor de arquivo inválido');
    error.status = 400;
    throw error;
  }
}

module.exports = { STORE_ARCHIVE, encodeArchiveCursor, decodeArchiveCursor };
