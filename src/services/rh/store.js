// Arquivos do RH (currículo, documentos do funcionário). Ficam no volume do Railway;
// só saem por rota autenticada (ou pela rota pública de envio, que só grava).
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const IS_PROD = process.env.NODE_ENV === 'production' || !!process.env.RAILWAY_ENVIRONMENT;
const DIR = process.env.RH_FILES_DIR || (IS_PROD ? '/data/rh-files' : path.join(__dirname, '../../../tmp/rh-files'));

const EXT_BY_MIME = Object.freeze({
  'application/pdf': 'pdf',
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
});
const MAX_BYTES = 8 * 1024 * 1024;

function save(file) {
  const ext = EXT_BY_MIME[file && file.mimetype];
  if (!ext) throw Object.assign(new Error('Envie PDF ou foto (JPG, PNG, WEBP).'), { status: 400 });
  if (!file.buffer || file.buffer.length > MAX_BYTES) throw Object.assign(new Error('Arquivo grande demais (máx. 8 MB).'), { status: 400 });
  // Confere a assinatura do arquivo (não confia só no tipo declarado).
  const b = file.buffer;
  const sig = ext === 'pdf' ? b.slice(0, 4).toString() === '%PDF'
    : ext === 'jpg' ? b[0] === 0xff && b[1] === 0xd8
    : ext === 'png' ? b.slice(1, 4).toString() === 'PNG'
    : b.slice(0, 4).toString() === 'RIFF' && b.slice(8, 12).toString() === 'WEBP';
  if (!sig) throw Object.assign(new Error('O arquivo não parece ser um PDF ou imagem válida.'), { status: 400 });
  fs.mkdirSync(DIR, { recursive: true });
  const storedName = `${crypto.randomUUID()}.${ext}`;
  fs.writeFileSync(path.join(DIR, storedName), b);
  return {
    storedName,
    originalName: path.basename(String(file.originalname || `arquivo.${ext}`)).replace(/[^\w.\- ()À-ú]/g, '_').slice(0, 160),
    mimeType: file.mimetype,
    bytes: b.length,
  };
}

function resolve(storedName) {
  if (typeof storedName !== 'string' || !/^[a-f0-9-]{36}\.(pdf|jpg|png|webp)$/.test(storedName)) return null;
  const filePath = path.join(DIR, storedName);
  if (path.relative(DIR, filePath).startsWith('..')) return null;
  return fs.existsSync(filePath) ? filePath : null;
}

function remove(storedName) {
  const p = resolve(storedName);
  if (!p) return false;
  try { fs.unlinkSync(p); return true; } catch (_) { return false; }
}

module.exports = { DIR, save, resolve, remove, MAX_BYTES };
