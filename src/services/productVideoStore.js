// =====================================================================
// productVideoStore — guarda o vídeo (MP4/WebM/MOV) do produto em DISCO,
// NUNCA no Postgres (vídeo é MB→dezenas de MB; base64 no banco enche o disco).
// Em produção usa o VOLUME do Railway (/data/product-videos), separado do
// disco do Postgres. Local cai em tmp/. Trocar pra CDN (R2) depois = só mudar
// este arquivo, o resto do sistema usa a URL /media/product-video/<id>.<ext>.
// =====================================================================
const fs = require('fs');
const path = require('path');

const IS_PROD = process.env.NODE_ENV === 'production' || !!process.env.RAILWAY_ENVIRONMENT;
const DIR = process.env.PRODUCT_VIDEO_DIR || (IS_PROD ? '/data/product-videos' : path.join(__dirname, '../../tmp/product-videos'));
const EXTS = ['mp4', 'webm', 'mov'];
const EXT_BY_MIME = { 'video/mp4': 'mp4', 'video/webm': 'webm', 'video/quicktime': 'mov' };

const validId = (id) => typeof id === 'string' && /^[a-zA-Z0-9_-]+$/.test(id);

function ensureDir() { fs.mkdirSync(DIR, { recursive: true }); }

// Salva o buffer como <id>.<ext>, apagando qualquer versão anterior (qualquer ext).
function save(id, buffer, mime) {
  if (!validId(id)) throw new Error('id inválido');
  ensureDir();
  const ext = EXT_BY_MIME[mime] || 'mp4';
  remove(id);
  const dest = path.join(DIR, id + '.' + ext);
  fs.writeFileSync(dest, buffer);
  return { url: '/media/product-video/' + id + '.' + ext, ext, bytes: buffer.length };
}

function remove(id) {
  if (!validId(id)) return 0;
  let n = 0;
  for (const e of EXTS) {
    const f = path.join(DIR, id + '.' + e);
    try { if (fs.existsSync(f)) { fs.unlinkSync(f); n++; } } catch (_) {}
  }
  return n;
}

// Resolve "<id>.<ext>" pra um caminho de arquivo real (com trava anti path-traversal).
function resolvePublic(file) {
  if (typeof file !== 'string' || !/^[a-zA-Z0-9_-]+\.(mp4|webm|mov)$/.test(file)) return null;
  const f = path.join(DIR, file);
  // garante que continua dentro de DIR (defesa extra)
  if (path.relative(DIR, f).startsWith('..')) return null;
  return fs.existsSync(f) ? f : null;
}

module.exports = { DIR, save, remove, resolvePublic, ensureDir };
