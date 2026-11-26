// =====================================================================
// Meus Tênis — guarda-tênis digital do Club (dono 25/11/2026).
// "Os tênis que você tiver em casa podem ser mostrados no seu perfil
//  em clubsportsetennis.com.br/meustenis … link público estilo rede social,
//  pra colocar na bio do Instagram ou ver os tênis das pessoas no Club."
//
// Como entra um tênis:
//   1) catálogo da Sports & Tennis (já tem foto);
//   2) não achou → busca pública nos sites de revendedores/marcas (API de catálogo
//      sem chave, a mesma do gerente de marca). Nada de raspar buscador;
//   3) a própria pessoa envia a foto.
// A foto escolhida é copiada para o nosso armazenamento (mediaStore): não fica
// dependendo do site de fora e passa pela trava de imagem.
// Tabelas por SQL aditivo (o deploy não roda db push).
// =====================================================================
const crypto = require('crypto');

const LIMITE_ITENS = 300;
const HANDLE_RX = /^[a-z0-9](?:[a-z0-9._]{1,28}[a-z0-9])$/;
const httpErr = (status, message) => Object.assign(new Error(message), { status });
const clean = (v, n) => { const s = String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, n); return s || null; };
const id = () => crypto.randomUUID();

let ready = null;
function ensureSchema(prisma) {
  if (!ready) {
    const stmts = [
      `CREATE TABLE IF NOT EXISTS "ShoeClosetItem" ("id" TEXT PRIMARY KEY, "userId" TEXT NOT NULL, "productId" TEXT, "brand" TEXT, "model" TEXT NOT NULL,
        "color" TEXT, "size" TEXT, "note" TEXT, "photo" TEXT, "source" TEXT NOT NULL DEFAULT 'upload', "position" INT NOT NULL DEFAULT 0,
        "likes" INT NOT NULL DEFAULT 0, "hidden" BOOLEAN NOT NULL DEFAULT false, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT NOW(), "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT NOW())`,
      `CREATE INDEX IF NOT EXISTS "ShoeClosetItem_user_idx" ON "ShoeClosetItem" ("userId", "position")`,
      `CREATE INDEX IF NOT EXISTS "ShoeClosetItem_created_idx" ON "ShoeClosetItem" ("createdAt")`,
      `CREATE TABLE IF NOT EXISTS "ShoeClosetLike" ("itemId" TEXT NOT NULL, "userId" TEXT NOT NULL, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT NOW(), PRIMARY KEY ("itemId", "userId"))`,
      `CREATE TABLE IF NOT EXISTS "ShoeClosetProfile" ("userId" TEXT PRIMARY KEY, "isPublic" BOOLEAN NOT NULL DEFAULT true, "bio" TEXT, "views" INT NOT NULL DEFAULT 0,
        "createdAt" TIMESTAMP(3) NOT NULL DEFAULT NOW(), "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT NOW())`,
    ];
    ready = (async () => { for (const s of stmts) await prisma.$executeRawUnsafe(s); })().catch((e) => { ready = null; throw e; });
  }
  return ready;
}

// ───────── identidade (handle público) ─────────
async function userBasics(prisma, userId) {
  const u = await prisma.user.findUnique({ where: { id: userId }, select: { id: true, name: true, username: true, active: true } });
  if (!u) return null;
  const ap = await prisma.athleteProfile.findUnique({ where: { userId }, select: { username: true, avatarUrl: true } }).catch(() => null);
  let avatar = ap && ap.avatarUrl ? ap.avatarUrl : null;
  try { avatar = await require('./mediaStore').publicUrlFor(avatar); } catch (_) { /* sem foto */ }
  return { id: u.id, name: u.name, active: u.active, handle: u.username || (ap && ap.username) || null, avatar };
}

async function resolveHandle(prisma, handle) {
  const h = String(handle || '').replace(/^@/, '').trim().toLowerCase();
  if (!h || h.length > 40) return null;
  const u = await prisma.user.findFirst({ where: { username: { equals: h, mode: 'insensitive' } }, select: { id: true } });
  if (u) return u.id;
  const ap = await prisma.athleteProfile.findFirst({ where: { username: { equals: h, mode: 'insensitive' } }, select: { userId: true } }).catch(() => null);
  return ap ? ap.userId : null;
}

// Quem ainda não tem @ escolhe um (só uma vez, sem trocar o de quem já tem).
async function setHandle(prisma, userId, raw) {
  const h = String(raw || '').replace(/^@/, '').trim().toLowerCase();
  if (!HANDLE_RX.test(h)) throw httpErr(400, 'Use de 3 a 30 letras minúsculas, números, ponto ou _ (sem espaço).');
  const me = await userBasics(prisma, userId);
  if (!me) throw httpErr(404, 'Conta não encontrada.');
  if (me.handle) throw httpErr(409, 'Você já tem o @' + me.handle + '.');
  const taken = await resolveHandle(prisma, h);
  if (taken && taken !== userId) throw httpErr(409, 'Esse @ já é de outra pessoa. Escolha outro.');
  await prisma.user.update({ where: { id: userId }, data: { username: h } });
  return { handle: h };
}

// ───────── perfil ─────────
async function profileOf(prisma, userId) {
  await ensureSchema(prisma);
  const [p] = await prisma.$queryRaw`SELECT "isPublic", "bio", "views" FROM "ShoeClosetProfile" WHERE "userId"=${userId}`;
  return p || { isPublic: true, bio: null, views: 0 };
}
async function saveProfile(prisma, userId, body) {
  await ensureSchema(prisma);
  const isPublic = body.isPublic === undefined ? true : !!(body.isPublic === true || body.isPublic === 'true');
  const bio = clean(body.bio, 160);
  await prisma.$executeRaw`INSERT INTO "ShoeClosetProfile" ("userId","isPublic","bio") VALUES (${userId}, ${isPublic}, ${bio})
    ON CONFLICT ("userId") DO UPDATE SET "isPublic"=${isPublic}, "bio"=${bio}, "updatedAt"=NOW()`;
  return profileOf(prisma, userId);
}

const itemOut = (r, likedSet) => ({ id: r.id, productId: r.productId, brand: r.brand, model: r.model, color: r.color, size: r.size, note: r.note,
  photo: r.photo, source: r.source, likes: r.likes, liked: likedSet ? likedSet.has(r.id) : undefined, naLoja: r.naLoja === undefined ? undefined : !!r.naLoja, createdAt: r.createdAt });

async function itemsOf(prisma, userId, { viewerId = null, includeHidden = false } = {}) {
  await ensureSchema(prisma);
  const rows = await prisma.$queryRaw`SELECT i.*, (i."productId" IS NOT NULL AND EXISTS (SELECT 1 FROM "ProductSize" ps JOIN "StoreStock" ss ON ss."productSizeId"=ps.id
      WHERE ps."productId"=i."productId" AND ss.stock > 0)) AS "naLoja"
    FROM "ShoeClosetItem" i WHERE i."userId"=${userId} AND (${includeHidden} OR NOT i."hidden") ORDER BY i."position" ASC, i."createdAt" DESC`;
  let liked = null;
  if (viewerId && rows.length) {
    const ls = await prisma.$queryRaw`SELECT "itemId" FROM "ShoeClosetLike" WHERE "userId"=${viewerId}`;
    liked = new Set(ls.map((x) => x.itemId));
  }
  return rows.map((r) => itemOut(r, liked));
}

async function me(prisma, userId) {
  const u = await userBasics(prisma, userId);
  if (!u) throw httpErr(404, 'Conta não encontrada.');
  return { user: { name: u.name, handle: u.handle, avatar: u.avatar }, profile: await profileOf(prisma, userId), items: await itemsOf(prisma, userId, { viewerId: userId, includeHidden: true }) };
}

// Página pública de uma pessoa. Conta apagada (LGPD), inativa ou fechada → não existe.
async function publicCloset(prisma, handle, { viewerId = null, countView = false } = {}) {
  const userId = await resolveHandle(prisma, handle);
  if (!userId) throw httpErr(404, 'Perfil não encontrado.');
  const u = await userBasics(prisma, userId);
  if (!u || u.active === false) throw httpErr(404, 'Perfil não encontrado.');
  if (await require('./ligaPrivacy').isErased(userId).catch(() => false)) throw httpErr(404, 'Perfil não encontrado.');
  const p = await profileOf(prisma, userId);
  const own = viewerId === userId;
  if (!p.isPublic && !own) throw httpErr(404, 'Este guarda-tênis é privado.');
  if (countView && !own) await prisma.$executeRaw`INSERT INTO "ShoeClosetProfile" ("userId","views") VALUES (${userId}, 1) ON CONFLICT ("userId") DO UPDATE SET "views"="ShoeClosetProfile"."views"+1`.catch(() => {});
  const items = await itemsOf(prisma, userId, { viewerId });
  return { user: { name: firstAndLast(u.name), handle: u.handle || userId, avatar: u.avatar }, bio: p.bio, own, views: p.views, likes: items.reduce((s, i) => s + i.likes, 0), items };
}
// Nome público: primeiro e último nome (sem expor nome completo).
function firstAndLast(name) { const p = String(name || '').trim().split(/\s+/).filter(Boolean); return p.length > 1 ? p[0] + ' ' + p[p.length - 1] : (p[0] || 'Atleta'); }

// Vitrine do Club: quem atualizou por último e os mais curtidos.
async function explore(prisma, { limit = 24 } = {}) {
  await ensureSchema(prisma);
  const lim = Math.max(1, Math.min(48, parseInt(limit, 10) || 24));
  const rows = await prisma.$queryRaw`SELECT i."userId", count(*)::int AS n, max(i."createdAt") AS last, sum(i."likes")::int AS likes
    FROM "ShoeClosetItem" i JOIN "User" u ON u.id=i."userId" LEFT JOIN "ShoeClosetProfile" p ON p."userId"=i."userId"
    WHERE NOT i."hidden" AND u."active" AND coalesce(p."isPublic", true)
      AND NOT EXISTS (SELECT 1 FROM "PrivacyRequest" pr WHERE pr."userId"=i."userId" AND pr."kind"='DELETE')
    GROUP BY i."userId" ORDER BY max(i."createdAt") DESC LIMIT ${lim}`.catch(async (e) => {
    if (!/PrivacyRequest/.test(e.message)) throw e; // banco sem a tabela da Liga: segue sem esse filtro
    return prisma.$queryRaw`SELECT i."userId", count(*)::int AS n, max(i."createdAt") AS last, sum(i."likes")::int AS likes
      FROM "ShoeClosetItem" i JOIN "User" u ON u.id=i."userId" LEFT JOIN "ShoeClosetProfile" p ON p."userId"=i."userId"
      WHERE NOT i."hidden" AND u."active" AND coalesce(p."isPublic", true) GROUP BY i."userId" ORDER BY max(i."createdAt") DESC LIMIT ${lim}`;
  });
  const out = [];
  for (const r of rows) {
    const u = await userBasics(prisma, r.userId);
    if (!u) continue;
    const thumbs = await prisma.$queryRaw`SELECT "photo", "model" FROM "ShoeClosetItem" WHERE "userId"=${r.userId} AND NOT "hidden" AND "photo" IS NOT NULL ORDER BY "position" ASC, "createdAt" DESC LIMIT 4`;
    out.push({ name: firstAndLast(u.name), handle: u.handle || r.userId, avatar: u.avatar, count: r.n, likes: r.likes || 0, thumbs: thumbs.map((t) => ({ photo: t.photo, model: t.model })) });
  }
  return out;
}

// ───────── busca ─────────
const FOOTWEAR = /t[eê]nis|chuteira|sand[aá]lia|chinelo|cal[cç]ado|bota|slide|papete/i;
const tokens = (q) => String(q || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length >= 2).slice(0, 6);

// Catálogo da loja: produtos de calçado com foto. Um resultado por modelo+cor.
async function searchCatalog(prisma, q, { limit = 24 } = {}) {
  const tk = tokens(q);
  if (!tk.length) return [];
  const conds = tk.map((t) => ({ OR: [{ name: { contains: t, mode: 'insensitive' } }, { brand: { contains: t, mode: 'insensitive' } }, { sku: { contains: t, mode: 'insensitive' } }] }));
  const rows = await prisma.product.findMany({
    where: { AND: [...conds, { OR: [{ imageUrl: { not: null } }, { NOT: { imageUrls: { equals: null } } }] }] },
    select: { id: true, name: true, brand: true, category: true, imageUrl: true, imageUrls: true, aiContext: true, active: true, updatedAt: true },
    orderBy: [{ active: 'desc' }, { updatedAt: 'desc' }],
    take: 120,
  });
  const ms = require('./mediaStore');
  const seen = new Set(); const out = [];
  for (const p of rows) {
    if (p.category && !FOOTWEAR.test(p.category) && !FOOTWEAR.test(p.name)) continue;
    const color = (p.aiContext && typeof p.aiContext === 'object' && p.aiContext.color) || null;
    const key = (p.brand + '|' + p.name + '|' + (color || '')).toLowerCase();
    if (seen.has(key)) continue;
    let img = p.imageUrl || (Array.isArray(p.imageUrls) ? p.imageUrls.find((x) => typeof x === 'string' && x) : null);
    img = await ms.publicUrlFor(img).catch(() => null);
    if (!img) continue;
    seen.add(key);
    out.push({ productId: p.id, brand: p.brand, model: p.name, color, photo: img });
    if (out.length >= limit) break;
  }
  return out;
}

// Sites de fora (API pública de catálogo, sem chave): revendedores multimarca + sites oficiais das marcas.
function webHosts() {
  const cor = require('./corOficialMarca');
  const marcas = Object.values(cor.LOJAS || {}).flat().filter((h) => typeof h === 'string');
  return [...new Set([...cor.revendedores(), ...marcas])];
}
async function searchWeb(q, { fetchFn = fetch, timeoutMs = 8000, hosts = null } = {}) {
  const tk = tokens(q);
  if (!tk.length) return [];
  // Site oficial da marca citada na busca primeiro (ex.: "mizuno wave"), depois os revendedores.
  const cor = require('./corOficialMarca');
  const daMarca = tk.flatMap((t) => { try { return cor.lojasDaMarca(t) || []; } catch (_) { return []; } });
  const lista = (hosts || [...new Set([...daMarca, ...cor.revendedores()])]).slice(0, 6);
  const UA = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130 Safari/537.36' };
  const porLoja = await Promise.all(lista.map(async (host) => {
    try {
      const url = 'https://' + host + '/api/catalog_system/pub/products/search?ft=' + encodeURIComponent(tk.join(' ')) + '&_from=0&_to=11';
      const r = await fetchFn(url, { headers: UA, signal: AbortSignal.timeout(timeoutMs) });
      if (!r.ok) return [];
      const arr = await r.json();
      return (Array.isArray(arr) ? arr : []).map((p) => {
        const item = (p.items || [])[0];
        const fotos = require('./corOficialMarca').imagensDoItem(item).slice(0, 3);
        const nome = String(p.productName || '').trim();
        if (!fotos.length || !nome || !FOOTWEAR.test(nome + ' ' + (p.categories || []).join(' '))) return null;
        return { brand: clean(p.brand, 60), model: clean(nome, 140), photo: fotos[0], photos: fotos, host };
      }).filter(Boolean);
    } catch (_) { return []; }
  }));
  const seen = new Set(); const out = [];
  for (const lista2 of porLoja) for (const x of lista2) {
    const k = (x.brand + '|' + x.model).toLowerCase();
    if (seen.has(k)) continue; seen.add(k); out.push(x);
  }
  return out.slice(0, 24);
}

// Baixa a foto de fora só de host conhecido (evita usar o servidor para buscar qualquer endereço).
async function copyWebPhoto(url, { fetchFn = fetch, ownerUserId = null } = {}) {
  let u;
  try { u = new URL(String(url || '')); } catch (_) { throw httpErr(400, 'Foto inválida.'); }
  const host = u.hostname.toLowerCase();
  const ok = u.protocol === 'https:' && webHosts().some((h) => host === h || host.endsWith('.' + h.replace(/^www\./, '')) || /(^|\.)vteximg\.com\.br$|(^|\.)vtexassets\.com$/.test(host));
  if (!ok) throw httpErr(400, 'Essa foto não veio da busca do Club.');
  const r = await fetchFn(u.href, { signal: AbortSignal.timeout(12000) });
  if (!r.ok) throw httpErr(502, 'Não deu para baixar a foto. Tente outra.');
  const buf = Buffer.from(await r.arrayBuffer());
  if (buf.length > 8 * 1024 * 1024) throw httpErr(413, 'Foto grande demais.');
  const saved = await require('./mediaStore').put(buf, { ownerUserId, source: 'upload' });
  return saved.url;
}

async function storeUpload(dataUri, ownerUserId) {
  const g = await require('./imageGuard').guardImageDataUri(dataUri, { maxChars: 3 * 1024 * 1024, maxDim: 6000 });
  const saved = await require('./mediaStore').put(g.dataUri, { ownerUserId, source: 'upload' });
  return saved.url;
}

// ───────── itens ─────────
async function addItem(prisma, userId, body, deps = {}) {
  await ensureSchema(prisma);
  const [{ n }] = await prisma.$queryRaw`SELECT count(*)::int AS n FROM "ShoeClosetItem" WHERE "userId"=${userId}`;
  if (n >= LIMITE_ITENS) throw httpErr(400, 'Limite de ' + LIMITE_ITENS + ' tênis atingido.');
  let brand = clean(body.brand, 60), model = clean(body.model, 140), color = clean(body.color, 60), photo = null, productId = null, source = 'upload';
  if (!body.productId && !model) throw httpErr(400, 'Informe o modelo do tênis.'); // antes de gravar qualquer foto
  if (body.productId) {
    const p = await prisma.product.findUnique({ where: { id: String(body.productId) }, select: { id: true, name: true, brand: true, imageUrl: true, imageUrls: true, aiContext: true } });
    if (!p) throw httpErr(404, 'Produto não encontrado no catálogo.');
    productId = p.id; brand = p.brand; model = p.name; source = 'catalogo';
    color = color || ((p.aiContext && p.aiContext.color) || null);
    const img = p.imageUrl || (Array.isArray(p.imageUrls) ? p.imageUrls.find((x) => typeof x === 'string' && x) : null);
    photo = await require('./mediaStore').publicUrlFor(img).catch(() => null);
    // foto antiga gravada em base64 no card: vira arquivo em /media (nunca guardar base64 no item)
    if (photo && /^data:/i.test(photo)) photo = await require('./mediaStore').put(photo, { source: 'legacy' }).then((r) => r.url).catch(() => null);
  } else if (body.webPhoto) {
    photo = await (deps.copyWebPhoto || copyWebPhoto)(body.webPhoto, { ownerUserId: userId });
    source = 'busca';
  }
  if (body.photo) { photo = await (deps.storeUpload || storeUpload)(body.photo, userId); if (!productId) source = body.webPhoto ? 'busca' : 'upload'; }
  if (!model) throw httpErr(400, 'Informe o modelo do tênis.');
  if (!photo) throw httpErr(400, 'Escolha uma foto do catálogo, da busca ou envie a sua.');
  const size = clean(body.size, 12), note = clean(body.note, 200);
  const newId = id();
  await prisma.$executeRaw`UPDATE "ShoeClosetItem" SET "position"="position"+1 WHERE "userId"=${userId}`;
  await prisma.$executeRaw`INSERT INTO "ShoeClosetItem" ("id","userId","productId","brand","model","color","size","note","photo","source","position")
    VALUES (${newId}, ${userId}, ${productId}, ${brand}, ${model}, ${color}, ${size}, ${note}, ${photo}, ${source}, 0)`;
  await prisma.$executeRaw`INSERT INTO "ShoeClosetProfile" ("userId") VALUES (${userId}) ON CONFLICT DO NOTHING`;
  return (await itemsOf(prisma, userId, { includeHidden: true })).find((i) => i.id === newId);
}

async function ownItem(prisma, userId, itemId) {
  await ensureSchema(prisma);
  const [it] = await prisma.$queryRaw`SELECT * FROM "ShoeClosetItem" WHERE "id"=${String(itemId)}`;
  if (!it || it.userId !== userId) throw httpErr(404, 'Tênis não encontrado.');
  return it;
}
async function updateItem(prisma, userId, itemId, body, deps = {}) {
  const it = await ownItem(prisma, userId, itemId);
  const pick = (k, n) => (body[k] === undefined ? it[k] : clean(body[k], n));
  let photo = it.photo;
  if (body.photo) photo = await (deps.storeUpload || storeUpload)(body.photo, userId);
  const model = pick('model', 140);
  if (!model) throw httpErr(400, 'Informe o modelo do tênis.');
  const hidden = body.hidden === undefined ? it.hidden : !!(body.hidden === true || body.hidden === 'true');
  await prisma.$executeRaw`UPDATE "ShoeClosetItem" SET "brand"=${pick('brand', 60)}, "model"=${model}, "color"=${pick('color', 60)}, "size"=${pick('size', 12)},
    "note"=${pick('note', 200)}, "photo"=${photo}, "hidden"=${hidden}, "updatedAt"=NOW() WHERE "id"=${it.id}`;
  return (await itemsOf(prisma, userId, { includeHidden: true })).find((i) => i.id === it.id);
}
async function removeItem(prisma, userId, itemId) {
  const it = await ownItem(prisma, userId, itemId);
  await prisma.$executeRaw`DELETE FROM "ShoeClosetLike" WHERE "itemId"=${it.id}`;
  await prisma.$executeRaw`DELETE FROM "ShoeClosetItem" WHERE "id"=${it.id}`;
  return { ok: true };
}
async function reorder(prisma, userId, ids) {
  await ensureSchema(prisma);
  if (!Array.isArray(ids) || ids.length > LIMITE_ITENS) throw httpErr(400, 'Ordem inválida.');
  let pos = 0;
  for (const i of ids) await prisma.$executeRaw`UPDATE "ShoeClosetItem" SET "position"=${pos++} WHERE "id"=${String(i)} AND "userId"=${userId}`;
  return { ok: true };
}

// Curtir / descurtir (contador fica no item; quem curtiu só a própria pessoa sabe).
async function toggleLike(prisma, userId, itemId) {
  await ensureSchema(prisma);
  const [it] = await prisma.$queryRaw`SELECT i."id", i."userId", i."hidden", coalesce(p."isPublic", true) AS "pub" FROM "ShoeClosetItem" i
    LEFT JOIN "ShoeClosetProfile" p ON p."userId"=i."userId" WHERE i."id"=${String(itemId)}`;
  if (!it || it.hidden || (!it.pub && it.userId !== userId)) throw httpErr(404, 'Tênis não encontrado.');
  const del = await prisma.$executeRaw`DELETE FROM "ShoeClosetLike" WHERE "itemId"=${it.id} AND "userId"=${userId}`;
  if (!del) await prisma.$executeRaw`INSERT INTO "ShoeClosetLike" ("itemId","userId") VALUES (${it.id}, ${userId}) ON CONFLICT DO NOTHING`;
  const [{ n }] = await prisma.$queryRaw`SELECT count(*)::int AS n FROM "ShoeClosetLike" WHERE "itemId"=${it.id}`;
  await prisma.$executeRaw`UPDATE "ShoeClosetItem" SET "likes"=${n} WHERE "id"=${it.id}`;
  return { liked: !del, likes: n };
}

module.exports = { ensureSchema, setHandle, resolveHandle, me, saveProfile, publicCloset, explore, searchCatalog, searchWeb, copyWebPhoto,
  addItem, updateItem, removeItem, reorder, toggleLike, firstAndLast, HANDLE_RX, LIMITE_ITENS };
