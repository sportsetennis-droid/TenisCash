// Evidencias privadas da producao diaria dos vendedores.
// Arquivos permanecem no volume persistente e so saem por rota autenticada.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const IS_PROD = process.env.NODE_ENV === 'production' || !!process.env.RAILWAY_ENVIRONMENT;
const DIR = process.env.PRODUCTION_EVIDENCE_DIR || (IS_PROD
  ? '/data/seller-production-evidence'
  : path.join(__dirname, '../../tmp/seller-production-evidence'));

const EXT_BY_MIME = Object.freeze({
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'video/mp4': 'mp4',
  'video/webm': 'webm',
  'video/quicktime': 'mov',
});

function ensureDir() {
  fs.mkdirSync(DIR, { recursive: true });
}

function save(file) {
  const ext = EXT_BY_MIME[file?.mimetype];
  if (!ext) throw new Error('Formato de evidencia nao suportado');
  ensureDir();
  const storedName = `${crypto.randomUUID()}.${ext}`;
  fs.writeFileSync(path.join(DIR, storedName), file.buffer);
  return {
    storedName,
    originalName: path.basename(String(file.originalname || `evidencia.${ext}`)).slice(0, 180),
    mimeType: file.mimetype,
    mediaType: file.mimetype.startsWith('image/') ? 'photo' : 'video',
    bytes: file.buffer.length,
  };
}

function resolve(storedName) {
  if (typeof storedName !== 'string' || !/^[a-f0-9-]+\.(jpg|png|webp|mp4|webm|mov)$/.test(storedName)) return null;
  const filePath = path.join(DIR, storedName);
  if (path.relative(DIR, filePath).startsWith('..')) return null;
  return fs.existsSync(filePath) ? filePath : null;
}

function remove(storedName) {
  const filePath = resolve(storedName);
  if (!filePath) return false;
  try { fs.unlinkSync(filePath); return true; } catch (_) { return false; }
}

module.exports = { DIR, ensureDir, save, resolve, remove };
