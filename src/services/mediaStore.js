// =====================================================================
// Liga Aberta F5 — ARMAZENAMENTO DE MÍDIA (imagens fora do JSON)
// ---------------------------------------------------------------------
// Antes: escudo/logo/banner/foto eram gravados como data URI (até 800 KB) no
// próprio campo e devolvidos CRUS no JSON (no-store) — o mesmo escudo copiado em
// todas as inscrições do time ia N vezes em cada lista.
// Agora:
//   put(buffer | dataUri, { ownerUserId }) → { url } — grava UMA vez por conteúdo
//   (sha256 único: o mesmo escudo em 10 inscrições = 1 objeto) e o campo passa a
//   guardar só a URL curta "/media/<sha256>.<ext>".
//   GET /media/:sha.:ext (rota pública, src/index.js) serve o binário com cache de
//   1 ano (immutable — o endereço muda se a imagem mudar), ETag, nosniff e CSP
//   sandbox. Só PNG/JPEG/WEBP/GIF (SVG nunca).
//
// Adaptadores:
//   'db' (padrão) — tabela MediaObject (BYTEA).
//   's3'          — compatível S3/R2 (fetch + assinatura SigV4, sem SDK). Só liga
//                   se TODAS as variáveis existirem: MEDIA_S3_ENDPOINT (https),
//                   MEDIA_S3_BUCKET, MEDIA_S3_ACCESS_KEY_ID, MEDIA_S3_SECRET_ACCESS_KEY,
//                   MEDIA_S3_PUBLIC_URL (https, leitura pública). Opcionais:
//                   MEDIA_S3_REGION (padrão us-east-1; R2 = auto), MEDIA_S3_PREFIX
//                   (padrão "liga/"), MEDIA_S3_PATH_STYLE=0 (virtual-host; padrão
//                   path-style, que serve R2 e MinIO). O endpoint vem SÓ de variável
//                   de ambiente (nunca do usuário) — sem SSRF. A MediaObject continua
//                   guardando o registro (sha, tipo, dono) para dedup e para a cota do
//                   plano; os bytes vão pro bucket.
//
// Compatibilidade: leitura continua aceitando data URI antigo. As APIs JSON do
// torneio/clube/atleta passam pelo jsonMiddleware: todo "data:image/..." que ainda
// estiver no banco sai como "/media/<sha>.<ext>" (registro idempotente por conteúdo
// — o dado de origem NÃO muda; SVG antigo sai como null). Desligar em emergência:
// LIGA_MEDIA_JSON=0.
// =====================================================================

const crypto = require('crypto');
const { prisma } = require('../middleware');
const { sniffImageType, parseDataUri, guardImageField, ImageGuardError } = require('./imageGuard');

const EXT_OF = { png: 'png', jpeg: 'jpg', webp: 'webp', gif: 'gif' };
const MIME_OF = { png: 'image/png', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif' };
const MIME_BY_EXT = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif' };
const MEDIA_PATH_RX = /^\/media\/([a-f0-9]{64})\.(png|jpg|jpeg|webp|gif)$/;
const MAX_BYTES = 12 * 1024 * 1024;

class MediaError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

let db = prisma;
function setPrisma(p) { db = p; }

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

// ------------------------------------------------------------------ S3/R2
function s3Config() {
  const e = process.env;
  const endpoint = String(e.MEDIA_S3_ENDPOINT || '').trim().replace(/\/+$/, '');
  const bucket = String(e.MEDIA_S3_BUCKET || '').trim();
  const accessKeyId = String(e.MEDIA_S3_ACCESS_KEY_ID || '').trim();
  const secret = String(e.MEDIA_S3_SECRET_ACCESS_KEY || '').trim();
  const publicUrl = String(e.MEDIA_S3_PUBLIC_URL || '').trim().replace(/\/+$/, '');
  if (!endpoint || !bucket || !accessKeyId || !secret || !publicUrl) return null;
  if (!/^https:\/\/[a-z0-9.-]+(:\d+)?$/i.test(endpoint)) return null; // só https, sem caminho
  if (!/^https:\/\/[a-z0-9.-]+(:\d+)?(\/[A-Za-z0-9._~\/-]*)?$/i.test(publicUrl)) return null;
  if (!/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(bucket)) return null;
  const prefix = String(e.MEDIA_S3_PREFIX == null ? 'liga/' : e.MEDIA_S3_PREFIX).replace(/^\/+/, '');
  if (prefix && !/^[A-Za-z0-9._\/-]{0,100}$/.test(prefix)) return null;
  return {
    endpoint, bucket, accessKeyId, secret, publicUrl, prefix,
    region: String(e.MEDIA_S3_REGION || 'us-east-1').trim() || 'us-east-1',
    pathStyle: String(e.MEDIA_S3_PATH_STYLE || '1') !== '0',
  };
}
function adapterName() { return s3Config() ? 's3' : 'db'; }

const hmac = (key, data, enc) => crypto.createHmac('sha256', key).update(data, 'utf8').digest(enc);
const hexHash = (data) => crypto.createHash('sha256').update(data).digest('hex');
const encSeg = (s) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());

/**
 * Assinatura AWS SigV4 (serviço s3). Devolve os cabeçalhos a enviar (inclui Authorization).
 * headers: cabeçalhos extras (minúsculos ou não) que entram na assinatura.
 */
function signV4({ method, host, path, query = '', headers = {}, payloadHash, accessKeyId, secret, region, service = 's3', date = new Date() }) {
  const amzDate = date.toISOString().replace(/[:-]|\.\d{3}/g, ''); // 20130524T000000Z
  const day = amzDate.slice(0, 8);
  const h = { host, 'x-amz-content-sha256': payloadHash, 'x-amz-date': amzDate };
  for (const [k, v] of Object.entries(headers)) h[k.toLowerCase()] = String(v).trim().replace(/\s+/g, ' ');
  const names = Object.keys(h).sort();
  const canonicalHeaders = names.map((n) => `${n}:${h[n]}\n`).join('');
  const signedHeaders = names.join(';');
  const canonicalUri = path.split('/').map((seg) => encSeg(decodeURIComponent(seg))).join('/');
  const canonicalRequest = [method, canonicalUri, query, canonicalHeaders, signedHeaders, payloadHash].join('\n');
  const scope = `${day}/${region}/${service}/aws4_request`;
  const toSign = ['AWS4-HMAC-SHA256', amzDate, scope, hexHash(canonicalRequest)].join('\n');
  const kDate = hmac('AWS4' + secret, day);
  const kRegion = hmac(kDate, region);
  const kService = hmac(kRegion, service);
  const kSigning = hmac(kService, 'aws4_request');
  const signature = hmac(kSigning, toSign, 'hex');
  return {
    headers: { ...h, authorization: `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}` },
    signature, canonicalRequest, stringToSign: toSign,
  };
}

async function s3Put(cfg, key, buf, mime) {
  const u = new URL(cfg.endpoint);
  const host = cfg.pathStyle ? u.host : `${cfg.bucket}.${u.host}`;
  const path = cfg.pathStyle ? `/${cfg.bucket}/${key}` : `/${key}`;
  const payloadHash = sha256(buf);
  const signed = signV4({
    method: 'PUT', host, path, payloadHash,
    headers: { 'content-type': mime, 'cache-control': 'public, max-age=31536000, immutable' },
    accessKeyId: cfg.accessKeyId, secret: cfg.secret, region: cfg.region,
  });
  const { host: _h, ...sendHeaders } = signed.headers;
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 15000);
  try {
    const r = await fetch(`${u.protocol}//${host}${path}`, { method: 'PUT', headers: { ...sendHeaders, 'content-length': String(buf.length) }, body: buf, signal: ctl.signal, redirect: 'error' });
    if (!r.ok) throw new MediaError(502, `armazenamento de imagem recusou (${r.status})`);
  } finally { clearTimeout(timer); }
  return `${cfg.publicUrl}/${key}`;
}

// ------------------------------------------------------------------ gravação
async function imageMeta(buf) {
  try {
    const m = await require('sharp')(buf, { failOn: 'none', limitInputPixels: false }).metadata();
    return { width: m.width || null, height: m.height || null };
  } catch (_) { return { width: null, height: null }; }
}

const KNOWN = new Map(); // sha → url (evita ir ao banco a cada resposta)
function remember(sha, url) {
  if (KNOWN.size > 5000) KNOWN.clear();
  KNOWN.set(sha, url);
}

/**
 * Grava os BYTES de uma imagem (sem reencodar — quem valida é o imageGuard antes).
 * opts.ownerUserId  quem enviou (cota do plano)
 * opts.source       'upload' (conta na cota) | 'legacy' (data URI antigo servido) | 'migration'
 * Retorna { url, sha256, mime, size, width, height, created, storage }.
 */
async function putBuffer(buf, opts = {}) {
  if (!Buffer.isBuffer(buf) || !buf.length) throw new MediaError(400, 'imagem vazia');
  if (buf.length > MAX_BYTES) throw new MediaError(413, 'imagem muito grande');
  const type = sniffImageType(buf);
  if (!type) throw new MediaError(400, 'o arquivo não é uma imagem PNG, JPEG, WEBP ou GIF');
  const sha = sha256(buf);
  const ext = EXT_OF[type];
  const mime = MIME_OF[type];
  const client = opts.db || db;
  const existing = await client.mediaObject.findUnique({ where: { sha256: sha }, select: { url: true, storage: true, mime: true, size: true, width: true, height: true } });
  if (existing) {
    const url = existing.storage === 's3' && existing.url ? existing.url : `/media/${sha}.${EXT_OF[Object.keys(MIME_OF).find((k) => MIME_OF[k] === existing.mime)] || ext}`;
    remember(sha, url);
    return { url, sha256: sha, mime: existing.mime, size: existing.size, width: existing.width, height: existing.height, created: false, storage: existing.storage };
  }
  const meta = await imageMeta(buf);
  const cfg = opts.forceDb ? null : s3Config();
  let storage = 'db';
  let url = `/media/${sha}.${ext}`;
  let bytes = buf;
  if (cfg) {
    url = await s3Put(cfg, `${cfg.prefix}${sha}.${ext}`, buf, mime);
    storage = 's3';
    bytes = null;
  }
  const r = await client.mediaObject.createMany({
    data: [{ sha256: sha, mime, bytes, size: buf.length, width: meta.width, height: meta.height, storage, url: storage === 's3' ? url : null, source: opts.source || 'upload', ownerUserId: opts.ownerUserId || null }],
    skipDuplicates: true,
  });
  remember(sha, url);
  return { url, sha256: sha, mime, size: buf.length, width: meta.width, height: meta.height, created: r.count === 1, storage };
}

/** put(buffer | dataUri) → { url, ... } */
async function put(input, opts = {}) {
  if (Buffer.isBuffer(input)) return putBuffer(input, opts);
  const p = parseDataUri(input);
  if (!p) throw new MediaError(400, 'imagem inválida');
  if (/svg/.test(p.mime)) throw new MediaError(400, 'imagem SVG não é aceita');
  return putBuffer(p.buf, opts);
}

function parseMediaPath(value) {
  const m = MEDIA_PATH_RX.exec(String(value || ''));
  if (!m) return null;
  return { sha256: m[1], ext: m[2] === 'jpeg' ? 'jpg' : m[2] };
}
const isMediaPath = (v) => !!parseMediaPath(v);

/** Linha do objeto (com os bytes) pelo sha — null se não existe. */
async function get(sha) {
  if (!/^[a-f0-9]{64}$/.test(String(sha || ''))) return null;
  return db.mediaObject.findUnique({ where: { sha256: String(sha) }, select: { sha256: true, mime: true, bytes: true, size: true, storage: true, url: true, createdAt: true } });
}

/** Bytes de uma URL /media/... (para gerar arte no servidor). */
async function bytesOf(value) {
  const p = parseMediaPath(value);
  if (!p) return null;
  const row = await get(p.sha256);
  if (row && row.bytes) return Buffer.from(row.bytes);
  // no bucket (S3/R2): baixa do endereço público gravado (que veio da nossa configuração)
  if (row && row.storage === 's3' && /^https:\/\//.test(row.url || '')) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 5000);
    try {
      const r = await fetch(row.url, { signal: ctl.signal, redirect: 'error' });
      if (!r.ok) return null;
      const ab = await r.arrayBuffer();
      return ab.byteLength <= MAX_BYTES ? Buffer.from(ab) : null;
    } catch (_) { return null; } finally { clearTimeout(timer); }
  }
  return null;
}

// ------------------------------------------------------------------ data URI antigo → URL
const isImageDataUri = (v) => typeof v === 'string' && /^data:image\//i.test(v);
const RASTER = new Set(['png', 'jpeg', 'webp', 'gif']);

const INVALID = Symbol('imagem-invalida'); // SVG / data URI ilegível
/** data URI → URL /media | INVALID | o próprio data URI (falha de gravação: nunca some a imagem). */
async function resolveDataUri(value) {
  const p = parseDataUri(value);
  if (!p || /svg/.test(p.mime)) return INVALID;
  const type = sniffImageType(p.buf);
  if (!type || !RASTER.has(type)) return INVALID;
  const sha = sha256(p.buf);
  if (KNOWN.has(sha)) return KNOWN.get(sha);
  try {
    // sempre no banco: nada de upload pro bucket dentro de um GET (com S3 ligado também)
    return (await putBuffer(p.buf, { source: 'legacy', forceDb: true })).url;
  } catch (e) {
    console.error('[mediaStore] legado', e.message);
    return value; // falhou (ex.: tabela ainda nascendo logo após o deploy) → mantém a imagem como estava
  }
}

/**
 * Valor de campo de IMAGEM → endereço para devolver ao cliente.
 * data:image raster → "/media/<sha>.<ext>" (registro idempotente, dado de origem intacto)
 * data: SVG/ilegível → null · falha ao registrar → o próprio valor · outro valor → igual.
 */
async function publicUrlFor(value) {
  if (!isImageDataUri(value)) return value == null ? null : value;
  const r = await resolveDataUri(value);
  return r === INVALID ? null : r;
}

// Campos que SÃO imagem: SVG/ilegível sai null. Em qualquer outro campo, só imagem
// raster válida vira URL; texto que só "parece" data URI fica como está.
const IMAGE_KEYS = new Set(['logoUrl', 'crestUrl', 'bannerUrl', 'avatarUrl', 'imageUrl', 'photoUrl', 'photo', 'logo', 'crest', 'homeLogo', 'awayLogo', 'image', 'picture']);

// Reescreve um objeto/array (só caminhos que mudam; objetos de terceiros/Date ficam iguais).
function collectUris(v, out, depth = 0) {
  if (depth > 40 || v == null) return;
  if (typeof v === 'string') { if (isImageDataUri(v)) out.add(v); return; }
  if (Array.isArray(v)) { for (const x of v) collectUris(x, out, depth + 1); return; }
  if (typeof v === 'object') {
    const proto = Object.getPrototypeOf(v);
    if (proto !== Object.prototype && proto !== null) return;
    for (const k of Object.keys(v)) collectUris(v[k], out, depth + 1);
  }
}
function rewrite(v, map, depth = 0, key = null) {
  if (depth > 40 || v == null) return v;
  if (typeof v === 'string') {
    if (!isImageDataUri(v)) return v;
    const r = map.has(v) ? map.get(v) : v; // sem resolução → como estava (nunca some)
    if (r === INVALID) return IMAGE_KEYS.has(key) ? null : v;
    return r;
  }
  if (Array.isArray(v)) {
    let changed = false;
    const out = v.map((x) => { const y = rewrite(x, map, depth + 1, key); if (y !== x) changed = true; return y; });
    return changed ? out : v;
  }
  if (typeof v === 'object') {
    const proto = Object.getPrototypeOf(v);
    if (proto !== Object.prototype && proto !== null) return v;
    let out = null;
    for (const k of Object.keys(v)) {
      const y = rewrite(v[k], map, depth + 1, k);
      if (y !== v[k]) { if (!out) out = { ...v }; out[k] = y; }
    }
    return out || v;
  }
  return v;
}

/** Troca todo data URI de imagem do payload pela URL /media (async). */
async function publicizePayload(body) {
  const uris = new Set();
  collectUris(body, uris);
  if (!uris.size) return body;
  const map = new Map();
  for (const u of uris) map.set(u, await resolveDataUri(u));
  return rewrite(body, map);
}

/**
 * Middleware: res.json passa pelo publicizePayload (nenhum base64 de imagem sai no JSON).
 * Montado em src/index.js nos prefixos do torneio/clube/atleta.
 * Robusto: se a rota já respondeu, não manda de novo; erro ao serializar vira 500 (sem
 * rejeição solta derrubando o processo); falha na troca = payload original (imagem não some).
 */
// A troca do base64 ANTIGO no JSON só começa depois do II Futsal Master Cup (20–22/11/2026):
// durante o evento as páginas dele respondem exatamente como antes. LIGA_MEDIA_JSON_START
// (ISO) muda a data; padrão 23/11/2026 00:00 de Fortaleza. Upload novo já vai para /media.
function jsonStart() {
  const v = process.env.LIGA_MEDIA_JSON_START;
  const d = v ? new Date(v) : new Date('2026-11-23T03:00:00Z');
  return Number.isNaN(d.getTime()) ? new Date('2026-11-23T03:00:00Z') : d;
}

function jsonMiddleware(req, res, next) {
  if (process.env.LIGA_MEDIA_JSON === '0') return next();
  if (Date.now() < jsonStart().getTime()) return next();
  const orig = res.json.bind(res);
  const send = (b) => {
    if (res.headersSent || res.writableEnded) return;
    try { orig(b); } catch (e) {
      console.error('[mediaStore] json send', e.message);
      if (!res.headersSent) { try { res.status(500).type('application/json').end('{"error":"erro ao montar a resposta"}'); } catch (_) { /* nada */ } }
    }
  };
  res.json = function jsonWithMedia(body) {
    const uris = new Set();
    collectUris(body, uris);
    if (!uris.size) return orig(body);
    publicizePayload(body)
      .then((b) => send(b))
      .catch((e) => { console.error('[mediaStore] json', e.message); send(body); });
    return res;
  };
  next();
}

// ------------------------------------------------------------------ upload (imageGuard + mediaStore)
/**
 * Campo de imagem enviado pelo usuário → valor a gravar.
 *  - null/'' → null (limpar)
 *  - "/media/<sha>.<ext>" já gravado → aceito como está (o objeto tem que existir)
 *  - data URI → imageGuard (magic bytes, sharp, tamanho) → mediaStore → "/media/..."
 *  - link https:// (ou caminho do site, se a rota permite) → imageGuard
 * store.ownerUserId  dono da cota · store.keepDataUri  grava o data URI como antes
 * (torneio da lista de exclusão — Master Cup — não muda o formato do dado).
 * Erros: ImageGuardError / MediaError (status + mensagem em PT).
 */
async function guardAndStore(value, guardOpts = {}, store = {}) {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string') throw new ImageGuardError(400, 'imagem inválida (envie PNG, JPEG ou WEBP)');
  const s = value.trim();
  if (!s) return null;
  const mp = parseMediaPath(s);
  if (mp) {
    const row = await db.mediaObject.findUnique({ where: { sha256: mp.sha256 }, select: { mime: true } });
    if (!row || MIME_BY_EXT[mp.ext] !== row.mime) throw new ImageGuardError(400, 'imagem não encontrada — envie de novo');
    return `/media/${mp.sha256}.${mp.ext}`;
  }
  // endereço das rotas de compatibilidade (/api/public/.../logo) não se grava: viraria laço
  if (/\/api\/public\//i.test(s)) throw new ImageGuardError(400, 'envie a imagem de novo (endereço interno não é aceito)');
  const guarded = await guardImageField(s, guardOpts);
  if (!guarded || !/^data:/i.test(guarded) || store.keepDataUri) return guarded;
  return (await put(guarded, { ownerUserId: store.ownerUserId || null, source: 'upload' })).url;
}

/** true se o valor vai virar um objeto NOVO de upload (data URI) — p/ checar a cota antes. */
function isUpload(value) {
  return typeof value === 'string' && /^data:/i.test(value.trim());
}

// ------------------------------------------------------------------ rota pública
/** Handler de GET/HEAD /media/:file */
// Cache em memória dos binários mais pedidos (teto por bytes) — poupa o banco quando a
// borda (Cloudflare) ainda não tem a imagem.
const BYTES_CACHE = new Map();
let bytesCached = 0;
const BYTES_CACHE_MAX = Math.max(0, Number(process.env.MEDIA_MEM_CACHE_MB) || 48) * 1024 * 1024;
function cacheRow(row) {
  if (!row || !row.bytes || row.size > 2 * 1024 * 1024 || !BYTES_CACHE_MAX) return;
  if (BYTES_CACHE.has(row.sha256)) return;
  BYTES_CACHE.set(row.sha256, row);
  bytesCached += row.size;
  while (bytesCached > BYTES_CACHE_MAX && BYTES_CACHE.size) {
    const k = BYTES_CACHE.keys().next().value;
    bytesCached -= BYTES_CACHE.get(k).size;
    BYTES_CACHE.delete(k);
  }
}

async function serveMedia(req, res) {
  try {
    const m = /^([a-f0-9]{64})\.(png|jpg|jpeg|webp|gif)$/.exec(String(req.params.file || ''));
    const notFound = () => res.status(404).set('Cache-Control', 'no-store').json({ error: 'imagem não encontrada' });
    if (!m) return notFound();
    // query string não faz parte do endereço (e furaria o cache da borda): manda pro canônico
    if (req.originalUrl.includes('?')) { res.set('Cache-Control', 'public, max-age=86400'); return res.redirect(301, `/media/${m[1]}.${m[2]}`); }
    let row = BYTES_CACHE.get(m[1]);
    if (row) { BYTES_CACHE.delete(m[1]); BYTES_CACHE.set(m[1], row); } // LRU
    else { row = await get(m[1]); cacheRow(row); }
    if (!row) return notFound();
    const ext = m[2] === 'jpeg' ? 'jpg' : m[2];
    if (MIME_BY_EXT[ext] !== row.mime || !RASTER.has(Object.keys(MIME_OF).find((k) => MIME_OF[k] === row.mime) || '')) return notFound();
    if (row.storage === 's3' && row.url) {
      res.set('Cache-Control', 'public, max-age=3600');
      return res.redirect(302, row.url);
    }
    if (!row.bytes) return notFound();
    const etag = `"${row.sha256}"`;
    res.set('ETag', etag);
    res.set('Cache-Control', 'public, max-age=31536000, immutable');
    res.set('X-Content-Type-Options', 'nosniff');
    res.set('Content-Security-Policy', "default-src 'none'; sandbox");
    res.set('Cross-Origin-Resource-Policy', 'cross-origin');
    res.set('Content-Disposition', `inline; filename="${row.sha256.slice(0, 16)}.${ext}"`);
    res.type(row.mime);
    if (req.headers['if-none-match'] === etag) return res.status(304).end();
    const buf = Buffer.from(row.bytes);
    res.set('Content-Length', String(buf.length));
    if (req.method === 'HEAD') return res.status(200).end();
    return res.status(200).end(buf);
  } catch (e) {
    console.error('[media] serve', e.message);
    if (!res.headersSent) res.status(500).json({ error: 'erro ao ler a imagem' });
  }
}

module.exports = {
  MediaError, setPrisma, adapterName, s3Config, signV4,
  put, putBuffer, get, bytesOf, parseMediaPath, isMediaPath,
  isImageDataUri, publicUrlFor, publicizePayload, jsonMiddleware,
  guardAndStore, isUpload, serveMedia, MEDIA_PATH_RX,
};
