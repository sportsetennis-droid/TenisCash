// =====================================================================
// imageGuard — validação REAL de imagem enviada por usuário (Liga Aberta F0).
// ---------------------------------------------------------------------
// Antes, as rotas só conferiam o prefixo "data:image/..." e o tamanho: um
// texto qualquer com esse prefixo, um SVG (que carrega script) ou uma
// imagem de 20.000 px passavam. Aqui:
//   1. data URI → confere os MAGIC BYTES (PNG, JPEG, WEBP; GIF opcional).
//      SVG é recusado sempre em upload de usuário.
//   2. sharp lê a metadata (arquivo corrompido = recusado) e recusa
//      largura/altura acima do teto (padrão 4096 px).
//   3. Reencoda (tira EXIF/GPS e qualquer carga escondida) no MESMO formato
//      e, se passar do limite de tamanho da rota, encolhe até caber.
//   4. URL (banner/logo por link) → só https:// ou caminho do próprio site
//      ("/img/x.png"). Nada de javascript:, data: não-imagem, http://, //host.
// Erros saem como ImageGuardError { status, message } em português.
// =====================================================================

const sharp = require('sharp');

const DEFAULT_MAX_DIM = 4096;

class ImageGuardError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}
const fail = (status, msg) => { throw new ImageGuardError(status, msg); };

const DATA_URI_RX = /^data:([a-z0-9.+/-]+)?(;[a-z0-9=._-]+)*;base64,([A-Za-z0-9+/=\s]+)$/i;

function sniffImageType(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 12) return null;
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47 && buf[4] === 0x0d && buf[5] === 0x0a && buf[6] === 0x1a && buf[7] === 0x0a) return 'png';
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpeg';
  if (buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') return 'webp';
  const g = buf.toString('ascii', 0, 6);
  if (g === 'GIF87a' || g === 'GIF89a') return 'gif';
  return null;
}

function parseDataUri(value) {
  const m = DATA_URI_RX.exec(String(value || '').trim());
  if (!m) return null;
  const mime = String(m[1] || '').toLowerCase();
  const buf = Buffer.from(m[3].replace(/\s+/g, ''), 'base64');
  return { mime, buf };
}

const MIME_OF = { png: 'image/png', jpeg: 'image/jpeg', webp: 'image/webp' };

async function encode(input, type, maxSide) {
  let img = sharp(input, { failOn: 'error', limitInputPixels: false }).rotate();
  if (maxSide) img = img.resize({ width: maxSide, height: maxSide, fit: 'inside', withoutEnlargement: true });
  if (type === 'jpeg') return img.jpeg({ quality: maxSide ? 80 : 88, mozjpeg: true }).toBuffer();
  if (type === 'webp') return img.webp({ quality: maxSide ? 78 : 86 }).toBuffer();
  return img.png({ compressionLevel: 9, palette: !!maxSide }).toBuffer();
}

const uriLength = (buf, mime) => `data:${mime};base64,`.length + Math.ceil(buf.length / 3) * 4;

/**
 * Valida e normaliza uma imagem em data URI.
 * opts.maxChars  limite do data URI final (mesmo limite que a rota já usava)
 * opts.maxDim    teto de largura/altura do ARQUIVO ENVIADO (padrão 4096)
 * opts.allowGif  aceita GIF (vira PNG do 1º quadro)
 * Retorna { dataUri, mime, width, height, resized }.
 */
async function guardImageDataUri(value, opts = {}) {
  const maxChars = Number(opts.maxChars) || 800000;
  const maxDim = Number(opts.maxDim) || DEFAULT_MAX_DIM;
  const parsed = parseDataUri(value);
  if (!parsed) fail(400, 'imagem inválida (envie PNG, JPEG ou WEBP)');
  if (/svg/.test(parsed.mime)) fail(400, 'imagem SVG não é aceita (envie PNG, JPEG ou WEBP)');
  if (parsed.mime && !/^image\//.test(parsed.mime)) fail(400, 'o arquivo enviado não é uma imagem');
  if (parsed.buf.length > 12 * 1024 * 1024) fail(413, 'imagem muito grande — reduza antes de enviar');
  const real = sniffImageType(parsed.buf);
  if (!real || (real === 'gif' && !opts.allowGif)) fail(400, 'o arquivo não é uma imagem PNG, JPEG ou WEBP de verdade');

  let meta;
  try {
    meta = await sharp(parsed.buf, { failOn: 'error', limitInputPixels: false }).metadata();
  } catch (_) {
    fail(400, 'imagem corrompida ou ilegível');
  }
  if (!meta || !meta.width || !meta.height) fail(400, 'imagem corrompida ou ilegível');
  if (meta.width > maxDim || meta.height > maxDim) fail(400, `imagem grande demais (máximo ${maxDim} px de largura e altura)`);

  const outType = real === 'gif' ? 'png' : real;
  const mime = MIME_OF[outType];
  let out;
  try {
    out = await encode(parsed.buf, outType, null);
    let side = Math.max(meta.width, meta.height);
    let resized = false;
    // Encolhe até caber no limite da rota (mantém o formato).
    while (uriLength(out, mime) > maxChars && side > 64) {
      side = Math.max(64, Math.floor(side * 0.75));
      out = await encode(parsed.buf, outType, side);
      resized = true;
    }
    if (uriLength(out, mime) > maxChars) fail(413, 'imagem muito grande — reduza a imagem');
    const fm = await sharp(out).metadata();
    return { dataUri: `data:${mime};base64,${out.toString('base64')}`, mime, width: fm.width, height: fm.height, resized };
  } catch (e) {
    if (e instanceof ImageGuardError) throw e;
    fail(400, 'imagem corrompida ou ilegível');
  }
  return null;
}

/**
 * Valida um endereço de imagem informado por link.
 * Aceita https://... (sem espaço/aspas/<>) ou caminho do próprio site "/x/y.png".
 */
function guardImageUrl(value, opts = {}) {
  const maxLen = Number(opts.maxLen) || 1000;
  const s = String(value == null ? '' : value).trim();
  if (!s) return null;
  if (s.length > maxLen) fail(400, 'endereço da imagem muito longo');
  if (/[\s"'<>\\`]/.test(s)) fail(400, 'endereço da imagem inválido');
  if (/^https:\/\/[a-z0-9.-]+(:\d+)?(\/[^\s]*)?$/i.test(s)) return s;
  if (opts.allowRelative !== false && /^\/(?!\/)[A-Za-z0-9._~!$&()*+,;=:@%/?#-]*$/.test(s)) return s;
  fail(400, 'endereço da imagem inválido (use https:// ou envie a imagem)');
  return null;
}

/**
 * Campo que aceita imagem enviada (data URI) OU link.
 * null/'' → null (limpar). Retorna a string final a gravar.
 */
async function guardImageField(value, opts = {}) {
  if (value === null || value === undefined) return null;
  const s = String(value).trim();
  if (!s) return null;
  if (/^data:/i.test(s)) return (await guardImageDataUri(s, opts)).dataUri;
  if (opts.allowUrl === false) fail(400, 'envie a imagem (PNG, JPEG ou WEBP)');
  return guardImageUrl(s, opts);
}

module.exports = { ImageGuardError, sniffImageType, parseDataUri, guardImageDataUri, guardImageUrl, guardImageField, DEFAULT_MAX_DIM };
