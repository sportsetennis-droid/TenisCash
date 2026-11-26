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
//
// Dono 26/11 (depois de pesquisar os apps de coleção): bipar a caixa para incluir o tênis certo,
//   km de cada tênis pelas corridas do app com aviso de troca, e card pronto para o Story.
//
// Dono 26/11: "Não pode só salvar uma foto, tem que ser várias; se já tiver elas, já sobe todas."
//   → cada tênis guarda até 8 fotos (catálogo e site da marca trazem todas de uma vez).
// Dono 26/11: "a opção de deixar se eu quero receber oferta nesse tênis… alguém pode oferecer
//   preço e eu querer vender" → "Aceito ofertas" por tênis. Quem oferece concorda em mostrar o
//   WhatsApp; o dono só vê o número DEPOIS de aceitar. O Club não intermedia pagamento.
// =====================================================================
const crypto = require('crypto');

const LIMITE_ITENS = 300;
const MAX_FOTOS = 8;
const OFERTA_MIN = 1, OFERTA_MAX = 100000;
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
      `ALTER TABLE "ShoeClosetItem" ADD COLUMN IF NOT EXISTS "photos" JSONB NOT NULL DEFAULT '[]'::jsonb`,
      `ALTER TABLE "ShoeClosetItem" ADD COLUMN IF NOT EXISTS "acceptOffers" BOOLEAN NOT NULL DEFAULT false`,
      `ALTER TABLE "ShoeClosetItem" ADD COLUMN IF NOT EXISTS "barcode" TEXT`,
      `ALTER TABLE "ShoeClosetItem" ADD COLUMN IF NOT EXISTS "kmStart" DOUBLE PRECISION NOT NULL DEFAULT 0`,
      `ALTER TABLE "ShoeClosetItem" ADD COLUMN IF NOT EXISTS "kmLimit" INT NOT NULL DEFAULT 700`,
      `ALTER TABLE "ShoeClosetItem" ADD COLUMN IF NOT EXISTS "trackRuns" BOOLEAN NOT NULL DEFAULT false`,
      `ALTER TABLE "ShoeClosetItem" ADD COLUMN IF NOT EXISTS "trackSince" TIMESTAMP(3)`,
      `CREATE TABLE IF NOT EXISTS "ShoeClosetOffer" ("id" TEXT PRIMARY KEY, "itemId" TEXT NOT NULL, "ownerId" TEXT NOT NULL, "buyerId" TEXT NOT NULL,
        "amount" NUMERIC(10,2) NOT NULL, "message" TEXT, "status" TEXT NOT NULL DEFAULT 'PENDING', "createdAt" TIMESTAMP(3) NOT NULL DEFAULT NOW(),
        "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT NOW(), "answeredAt" TIMESTAMP(3))`,
      `CREATE INDEX IF NOT EXISTS "ShoeClosetOffer_owner_idx" ON "ShoeClosetOffer" ("ownerId", "status")`,
      `CREATE INDEX IF NOT EXISTS "ShoeClosetOffer_buyer_idx" ON "ShoeClosetOffer" ("buyerId", "status")`,
      `CREATE UNIQUE INDEX IF NOT EXISTS "ShoeClosetOffer_open_uq" ON "ShoeClosetOffer" ("itemId", "buyerId") WHERE "status"='PENDING'`,
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

// Dono 26/11: "O @ já gera automático e fica com a opção de a pessoa querer alterar."
// Gera do nome (primeiro.último, sem acento); se já existir, põe número no fim.
function handleBase(name) {
  const p = String(name || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  let b = p.length > 1 ? p[0] + '.' + p[p.length - 1] : (p[0] || 'atleta');
  b = b.slice(0, 26).replace(/[._]+$/, '');
  return b.length >= 3 ? b : b + '.club';
}
async function autoHandle(prisma, userId, name) {
  const base = handleBase(name);
  for (let i = 1; i <= 60; i++) {
    const h = i === 1 ? base : base + (i < 50 ? i : crypto.randomInt(1000, 9999));
    if (!HANDLE_RX.test(h) || (await resolveHandle(prisma, h))) continue;
    try {
      const r = await prisma.user.updateMany({ where: { id: userId, username: null }, data: { username: h } });
      if (r.count) return h;
      return ((await userBasics(prisma, userId)) || {}).handle || null; // outro pedido já gravou
    } catch (e) { if (e && e.code === 'P2002') continue; throw e; }
  }
  return null;
}

// Trocar o @ (o gerado automaticamente ou um escolhido antes).
async function setHandle(prisma, userId, raw) {
  const h = String(raw || '').replace(/^@/, '').trim().toLowerCase();
  if (!HANDLE_RX.test(h)) throw httpErr(400, 'Use de 3 a 30 letras minúsculas, números, ponto ou _ (sem espaço).');
  const me = await userBasics(prisma, userId);
  if (!me) throw httpErr(404, 'Conta não encontrada.');
  if (me.handle === h) return { handle: h };
  const taken = await resolveHandle(prisma, h);
  if (taken && taken !== userId) throw httpErr(409, 'Esse @ já é de outra pessoa. Escolha outro.');
  try {
    await prisma.user.update({ where: { id: userId }, data: { username: h } });
  } catch (e) {
    if (e && e.code === 'P2002') throw httpErr(409, 'Esse @ já é de outra pessoa. Escolha outro.'); // dois pedidos ao mesmo tempo
    throw e;
  }
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

const photosOf = (r) => { const p = Array.isArray(r.photos) ? r.photos.filter((x) => typeof x === 'string' && x) : []; return p.length ? p : (r.photo ? [r.photo] : []); };
const itemOut = (r, likedSet, myOffers) => ({ id: r.id, productId: r.productId, brand: r.brand, model: r.model, color: r.color, size: r.size, note: r.note,
  photo: r.photo, photos: photosOf(r), source: r.source, likes: r.likes, liked: likedSet ? likedSet.has(r.id) : undefined, naLoja: r.naLoja === undefined ? undefined : !!r.naLoja,
  acceptOffers: !!r.acceptOffers, myOffer: myOffers && myOffers.has(r.id) ? myOffers.get(r.id) : undefined,
  km: Math.round((Number(r.kmStart || 0) + Number(r.kmLive || 0)) * 10) / 10, kmStart: Math.round(Number(r.kmStart || 0) * 10) / 10, kmLimit: r.kmLimit || 700, trackRuns: !!r.trackRuns, createdAt: r.createdAt });

// Km das atividades a pé do app (corrida, caminhada, trilha) desde que o tênis virou o "tênis das corridas".
const FOOT_RX = '(run|walk|hike|trail|corr|camin)';
async function liveKm(prisma, userId, since) {
  if (!since) return 0;
  try {
    const [r] = await prisma.$queryRaw`SELECT coalesce(sum("distanceM"), 0)::float AS m FROM "Activity" WHERE "userId"=${userId} AND "startedAt" >= ${since}
      AND "sportType" ~* ${FOOT_RX} AND "processingState" NOT IN ('recording','failed')`;
    return (Number(r && r.m) || 0) / 1000;
  } catch (_) { return 0; } // banco sem a tabela do app de atividade
}

async function itemsOf(prisma, userId, { viewerId = null, includeHidden = false } = {}) {
  await ensureSchema(prisma);
  const rows = await prisma.$queryRaw`SELECT i.*, (i."productId" IS NOT NULL AND EXISTS (SELECT 1 FROM "ProductSize" ps JOIN "StoreStock" ss ON ss."productSizeId"=ps.id
      WHERE ps."productId"=i."productId" AND ss.stock > 0)) AS "naLoja"
    FROM "ShoeClosetItem" i WHERE i."userId"=${userId} AND (${includeHidden} OR NOT i."hidden") ORDER BY i."position" ASC, i."createdAt" DESC`;
  let liked = null, mine = null;
  if (viewerId && rows.length) {
    const ls = await prisma.$queryRaw`SELECT "itemId" FROM "ShoeClosetLike" WHERE "userId"=${viewerId}`;
    liked = new Set(ls.map((x) => x.itemId));
    if (viewerId !== userId) {
      const os = await prisma.$queryRaw`SELECT "itemId", "amount" FROM "ShoeClosetOffer" WHERE "buyerId"=${viewerId} AND "ownerId"=${userId} AND "status"='PENDING'`;
      mine = new Map(os.map((o) => [o.itemId, Number(o.amount)]));
    }
  }
  for (const r of rows) if (r.trackRuns) r.kmLive = await liveKm(prisma, userId, r.trackSince);
  return rows.map((r) => itemOut(r, liked, mine));
}

// Liga/desliga o "tênis das corridas". Só um por pessoa: o que sai guarda os km que já rodou.
async function setTracking(prisma, userId, itemId, on) {
  const ativos = await prisma.$queryRaw`SELECT "id", "trackSince" FROM "ShoeClosetItem" WHERE "userId"=${userId} AND "trackRuns"`;
  for (const a of ativos) {
    if (on && a.id === itemId) continue; // já é o das corridas
    const km = await liveKm(prisma, userId, a.trackSince);
    await prisma.$executeRaw`UPDATE "ShoeClosetItem" SET "kmStart"="kmStart"+${km}, "trackRuns"=false, "trackSince"=NULL, "updatedAt"=NOW() WHERE "id"=${a.id}`;
  }
  if (on && !ativos.some((a) => a.id === itemId)) await prisma.$executeRaw`UPDATE "ShoeClosetItem" SET "trackRuns"=true, "trackSince"=NOW(), "updatedAt"=NOW() WHERE "id"=${itemId} AND "userId"=${userId}`;
}
const numIn = (v, min, max) => { const n = Number(String(v == null ? '' : v).replace(',', '.')); return Number.isFinite(n) && n >= min && n <= max ? n : null; };

// Bipar a caixa: o código de barras acha o tênis certo no catálogo (modelo, cor e tamanho).
// Tamanho só se o card tiver o número confirmado (placeholder T-<EAN> não vira tamanho).
async function lookupBarcode(prisma, raw) {
  const code = String(raw || '').replace(/\D/g, '');
  if (code.length < 8 || code.length > 14) throw httpErr(400, 'Código inválido. Bipe o código de barras da caixa.');
  const alts = [...new Set([code, code.replace(/^0+/, ''), '0' + code])];
  const ps = await prisma.productSize.findFirst({ where: { barcode: { in: alts } }, select: { size: true, product: { select: { id: true, name: true, brand: true, category: true, imageUrl: true, imageUrls: true, aiContext: true } } } });
  if (!ps || !ps.product) throw httpErr(404, 'Não achei esse código no catálogo. Procure pelo nome ou envie suas fotos.');
  const p = ps.product;
  const photos = await catalogPhotos(p);
  const size = /^(?:[1-5]\d(?:[.,]5)?|PP|P|M|G|GG|XG|XGG|\d{1,2}A)$/i.test(String(ps.size || '').trim()) ? String(ps.size).trim() : null;
  return { productId: p.id, brand: p.brand, model: p.name, color: (p.aiContext && p.aiContext.color) || null, size, photo: photos[0] || null, photoCount: photos.length, barcode: code };
}

async function me(prisma, userId) {
  await ensureSchema(prisma); // tabela de ofertas é lida abaixo
  const u = await userBasics(prisma, userId);
  if (!u) throw httpErr(404, 'Conta não encontrada.');
  if (!u.handle) u.handle = await autoHandle(prisma, userId, u.name).catch(() => null);
  const [{ n }] = await prisma.$queryRaw`SELECT count(*)::int AS n FROM "ShoeClosetOffer" WHERE "ownerId"=${userId} AND "status"='PENDING'`;
  return { user: { name: u.name, handle: u.handle, avatar: u.avatar }, profile: await profileOf(prisma, userId), items: await itemsOf(prisma, userId, { viewerId: userId, includeHidden: true }), offersPending: n };
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
  return { user: { name: firstAndLast(u.name), handle: u.handle || null, avatar: u.avatar }, bio: p.bio, own, views: p.views, likes: items.reduce((s, i) => s + i.likes, 0), items };
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
    if (!u || !u.handle) continue; // sem @ não tem página pública
    const thumbs = await prisma.$queryRaw`SELECT "photo", "model" FROM "ShoeClosetItem" WHERE "userId"=${r.userId} AND NOT "hidden" AND "photo" IS NOT NULL ORDER BY "position" ASC, "createdAt" DESC LIMIT 4`;
    out.push({ name: firstAndLast(u.name), handle: u.handle, avatar: u.avatar, count: r.n, likes: r.likes || 0, thumbs: thumbs.map((t) => ({ photo: t.photo, model: t.model })) });
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
    const n = new Set([p.imageUrl, ...(Array.isArray(p.imageUrls) ? p.imageUrls : [])].filter((x) => typeof x === 'string' && x)).size;
    out.push({ productId: p.id, brand: p.brand, model: p.name, color, photo: img, photoCount: Math.min(n, MAX_FOTOS) });
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
        const fotos = require('./corOficialMarca').imagensDoItem(item).slice(0, MAX_FOTOS);
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
  // sem seguir redirecionamento (a trava de site vale só para o endereço conferido) e com teto de tamanho na leitura
  const r = await fetchFn(u.href, { signal: AbortSignal.timeout(12000), redirect: 'manual' });
  if (!r.ok) throw httpErr(502, 'Não deu para baixar a foto. Tente outra.');
  const MAX = 8 * 1024 * 1024;
  if (Number(r.headers && r.headers.get && r.headers.get('content-length')) > MAX) throw httpErr(413, 'Foto grande demais.');
  const chunks = []; let total = 0;
  if (r.body && typeof r.body.getReader === 'function') {
    const rd = r.body.getReader();
    for (;;) {
      const { done, value } = await rd.read();
      if (done) break;
      total += value.length;
      if (total > MAX) { rd.cancel().catch(() => {}); throw httpErr(413, 'Foto grande demais.'); }
      chunks.push(Buffer.from(value));
    }
  } else chunks.push(Buffer.from(await r.arrayBuffer()));
  const buf = Buffer.concat(chunks);
  if (buf.length > MAX) throw httpErr(413, 'Foto grande demais.');
  const saved = await require('./mediaStore').put(buf, { ownerUserId, source: 'upload' });
  return saved.url;
}

async function storeUpload(dataUri, ownerUserId) {
  const g = await require('./imageGuard').guardImageDataUri(dataUri, { maxChars: 3 * 1024 * 1024, maxDim: 6000 });
  const saved = await require('./mediaStore').put(g.dataUri, { ownerUserId, source: 'upload' });
  return saved.url;
}

// ───────── itens ─────────
// Fotos do card do catálogo: todas (capa primeiro), base64 antigo vira arquivo em /media.
async function catalogPhotos(p) {
  const ms = require('./mediaStore');
  const list = [...new Set([p.imageUrl, ...(Array.isArray(p.imageUrls) ? p.imageUrls : [])].filter((x) => typeof x === 'string' && x))];
  const out = [];
  for (const img of list) {
    if (out.length >= MAX_FOTOS) break;
    let u = await ms.publicUrlFor(img).catch(() => null);
    if (u && /^data:/i.test(u)) u = await ms.put(u, { source: 'legacy' }).then((r) => r.url).catch(() => null);
    if (u && !out.includes(u)) out.push(u);
  }
  return out;
}
const asList = (many, one) => (Array.isArray(many) ? many : one ? [one] : []).filter((x) => typeof x === 'string' && x).slice(0, MAX_FOTOS);

async function addItem(prisma, userId, body, deps = {}) {
  await ensureSchema(prisma);
  const [{ n }] = await prisma.$queryRaw`SELECT count(*)::int AS n FROM "ShoeClosetItem" WHERE "userId"=${userId}`;
  if (n >= LIMITE_ITENS) throw httpErr(400, 'Limite de ' + LIMITE_ITENS + ' tênis atingido.');
  let brand = clean(body.brand, 60), model = clean(body.model, 140), color = clean(body.color, 60), productId = null, source = 'upload';
  if (!body.productId && !model) throw httpErr(400, 'Informe o modelo do tênis.'); // antes de gravar qualquer foto
  let photos = [];
  if (body.productId) {
    const p = await prisma.product.findUnique({ where: { id: String(body.productId) }, select: { id: true, name: true, brand: true, imageUrl: true, imageUrls: true, aiContext: true } });
    if (!p) throw httpErr(404, 'Produto não encontrado no catálogo.');
    productId = p.id; brand = p.brand; model = p.name; source = 'catalogo';
    color = color || ((p.aiContext && p.aiContext.color) || null);
    photos = await (deps.catalogPhotos || catalogPhotos)(p);
  } else {
    const web = asList(body.webPhotos, body.webPhoto);
    if (web.length) {
      source = 'busca';
      const copy = deps.copyWebPhoto || copyWebPhoto;
      const got = await Promise.all(web.map((w) => copy(w, { ownerUserId: userId }).catch(() => null)));
      for (const u of got) if (u && !photos.includes(u)) photos.push(u);
      if (!photos.length) throw httpErr(502, 'Não deu para baixar as fotos. Tente outro resultado.');
    }
  }
  // fotos do celular: sozinhas ou junto das que vieram do catálogo/site
  for (const up of asList(body.photos, body.photo)) {
    if (photos.length >= MAX_FOTOS) break;
    const u = await (deps.storeUpload || storeUpload)(up, userId);
    if (!photos.includes(u)) photos.push(u);
  }
  if (!model) throw httpErr(400, 'Informe o modelo do tênis.');
  if (!photos.length) throw httpErr(400, 'Escolha uma foto do catálogo, da busca ou envie a sua.');
  const size = clean(body.size, 12), note = clean(body.note, 200);
  const barcode = body.barcode ? String(body.barcode).replace(/\D/g, '').slice(0, 14) || null : null;
  const kmStart = numIn(body.kmStart, 0, 10000) || 0;
  const acceptOffers = body.acceptOffers === true || body.acceptOffers === 'true';
  const newId = id();
  await prisma.$executeRaw`UPDATE "ShoeClosetItem" SET "position"="position"+1 WHERE "userId"=${userId}`;
  await prisma.$executeRaw`INSERT INTO "ShoeClosetItem" ("id","userId","productId","brand","model","color","size","note","photo","photos","source","position","acceptOffers","barcode","kmStart")
    VALUES (${newId}, ${userId}, ${productId}, ${brand}, ${model}, ${color}, ${size}, ${note}, ${photos[0]}, ${JSON.stringify(photos)}::jsonb, ${body.barcode && productId ? 'bipe' : source}, 0, ${acceptOffers}, ${barcode}, ${kmStart})`;
  if (body.trackRuns === true || body.trackRuns === 'true') await setTracking(prisma, userId, newId, true);
  await prisma.$executeRaw`INSERT INTO "ShoeClosetProfile" ("userId") VALUES (${userId}) ON CONFLICT DO NOTHING`;
  return (await itemsOf(prisma, userId, { includeHidden: true })).find((i) => i.id === newId);
}

async function ownItem(prisma, userId, itemId) {
  await ensureSchema(prisma);
  const [it] = await prisma.$queryRaw`SELECT * FROM "ShoeClosetItem" WHERE "id"=${String(itemId)}`;
  if (!it || it.userId !== userId) throw httpErr(404, 'Tênis não encontrado.');
  return it;
}
// body.keepPhotos = fotos atuais que ficam, na ordem (a 1ª é a capa); body.photos = fotos novas do celular.
async function updateItem(prisma, userId, itemId, body, deps = {}) {
  const it = await ownItem(prisma, userId, itemId);
  const pick = (k, n) => (body[k] === undefined ? it[k] : clean(body[k], n));
  const atuais = photosOf(it);
  let photos = Array.isArray(body.keepPhotos) ? body.keepPhotos.filter((u) => atuais.includes(u)) : atuais.slice();
  photos = [...new Set(photos)];
  for (const up of asList(body.photos, body.photo)) {
    if (photos.length >= MAX_FOTOS) throw httpErr(400, 'No máximo ' + MAX_FOTOS + ' fotos por tênis.');
    const u = await (deps.storeUpload || storeUpload)(up, userId);
    if (!photos.includes(u)) photos.push(u);
  }
  if (!photos.length) throw httpErr(400, 'Deixe pelo menos uma foto.');
  const model = pick('model', 140);
  if (!model) throw httpErr(400, 'Informe o modelo do tênis.');
  const bool = (k) => (body[k] === undefined ? it[k] : !!(body[k] === true || body[k] === 'true'));
  const hidden = bool('hidden'), acceptOffers = bool('acceptOffers');
  const kmStart = body.kmStart === undefined ? it.kmStart : numIn(body.kmStart, 0, 10000);
  const kmLimit = body.kmLimit === undefined ? it.kmLimit : numIn(body.kmLimit, 100, 5000);
  if (kmStart === null) throw httpErr(400, 'Km inválido (0 a 10.000).');
  if (kmLimit === null) throw httpErr(400, 'Limite de km inválido (100 a 5.000).');
  await prisma.$executeRaw`UPDATE "ShoeClosetItem" SET "brand"=${pick('brand', 60)}, "model"=${model}, "color"=${pick('color', 60)}, "size"=${pick('size', 12)},
    "note"=${pick('note', 200)}, "photo"=${photos[0]}, "photos"=${JSON.stringify(photos)}::jsonb, "hidden"=${hidden}, "acceptOffers"=${acceptOffers}, "kmStart"=${kmStart}, "kmLimit"=${Math.round(kmLimit)}, "updatedAt"=NOW() WHERE "id"=${it.id}`;
  if (body.trackRuns !== undefined) await setTracking(prisma, userId, it.id, body.trackRuns === true || body.trackRuns === 'true');
  return (await itemsOf(prisma, userId, { includeHidden: true })).find((i) => i.id === it.id);
}
async function removeItem(prisma, userId, itemId) {
  const it = await ownItem(prisma, userId, itemId);
  await prisma.$executeRaw`DELETE FROM "ShoeClosetLike" WHERE "itemId"=${it.id}`;
  await prisma.$executeRaw`UPDATE "ShoeClosetOffer" SET "status"='WITHDRAWN', "updatedAt"=NOW() WHERE "itemId"=${it.id} AND "status"='PENDING'`;
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

// ───────── ofertas ─────────
// Valor em reais: aceita "350", "350,00", "1.234,56", "1234.56".
function parseValor(v) {
  if (typeof v === 'number') return Number.isFinite(v) && v > 0 ? Math.round(v * 100) / 100 : NaN;
  const raw = String(v == null ? '' : v).replace(/r\$/i, '').replace(/\s+/g, '');
  if (!/^[0-9.,]+$/.test(raw)) return NaN;
  if (/\.\d*,|,\d{3}\./.test(raw) && raw.indexOf(',') < raw.lastIndexOf('.')) return NaN; // 1,234.56 (formato americano)
  let t = raw;
  if (t.includes(',')) t = t.replace(/\./g, '').replace(',', '.');
  else if (/^\d{1,3}(\.\d{3})+$/.test(t)) t = t.replace(/\./g, '');
  const n = Number(t);
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : NaN;
}
const brl = (n) => 'R$ ' + Number(n).toFixed(2).replace('.', ',').replace(/\B(?=(\d{3})+(?!\d))/g, '.');
const notifyUser = (deps, userId, payload) => {
  try { return (deps.notify || require('./notify').notify)(userId, Object.assign({ type: 'info' }, payload), { whatsapp: false }); } catch (_) { return null; }
};

async function makeOffer(prisma, buyerId, itemId, body, deps = {}) {
  await ensureSchema(prisma);
  const [it] = await prisma.$queryRaw`SELECT i."id", i."userId", i."model", i."hidden", i."acceptOffers", coalesce(p."isPublic", true) AS "pub"
    FROM "ShoeClosetItem" i LEFT JOIN "ShoeClosetProfile" p ON p."userId"=i."userId" WHERE i."id"=${String(itemId)}`;
  if (!it || it.hidden || !it.pub) throw httpErr(404, 'Tênis não encontrado.');
  if (it.userId === buyerId) throw httpErr(400, 'Esse tênis é seu.');
  if (!it.acceptOffers) throw httpErr(400, 'O dono não está recebendo ofertas por este tênis.');
  const owner = await userBasics(prisma, it.userId);
  if (!owner || owner.active === false) throw httpErr(404, 'Tênis não encontrado.');
  const amount = parseValor(body.amount);
  if (!(amount >= OFERTA_MIN && amount <= OFERTA_MAX)) throw httpErr(400, 'Informe um valor entre R$ 1 e R$ 100.000.');
  if (!(body.consent === true || body.consent === 'true')) throw httpErr(400, 'Para enviar a oferta, autorize o dono a ver o seu WhatsApp se ele aceitar.');
  const buyer = await prisma.user.findUnique({ where: { id: buyerId }, select: { name: true, phone: true, active: true } });
  if (!buyer || buyer.active === false) throw httpErr(404, 'Conta não encontrada.');
  if (!String(buyer.phone || '').replace(/\D/g, '')) throw httpErr(400, 'Sua conta não tem WhatsApp cadastrado. Cadastre no seu perfil do Club.');
  const message = clean(body.message, 300);
  const [aberta] = await prisma.$queryRaw`SELECT "id" FROM "ShoeClosetOffer" WHERE "itemId"=${it.id} AND "buyerId"=${buyerId} AND "status"='PENDING'`;
  let offerId = null;
  if (aberta) {
    const upd = await prisma.$executeRaw`UPDATE "ShoeClosetOffer" SET "amount"=${amount}, "message"=${message}, "updatedAt"=NOW() WHERE "id"=${aberta.id} AND "status"='PENDING'`;
    if (upd) offerId = aberta.id;
  }
  if (!offerId) {
    const [{ n }] = await prisma.$queryRaw`SELECT count(*)::int AS n FROM "ShoeClosetOffer" WHERE "buyerId"=${buyerId} AND "status"='PENDING'`;
    if (n >= 30) throw httpErr(429, 'Você tem muitas ofertas em aberto. Espere as respostas.');
    offerId = id();
    try {
      await prisma.$executeRaw`INSERT INTO "ShoeClosetOffer" ("id","itemId","ownerId","buyerId","amount","message") VALUES (${offerId}, ${it.id}, ${it.userId}, ${buyerId}, ${amount}, ${message})`;
    } catch (e) {
      if (/ShoeClosetOffer_open_uq|unique/i.test(String(e && e.message))) throw httpErr(409, 'Você já tem uma oferta aberta neste tênis. Tente de novo.');
      throw e;
    }
  }
  await notifyUser(deps, it.userId, { title: 'Oferta no seu tênis', body: firstAndLast(buyer.name) + ' ofereceu ' + brl(amount) + ' pelo ' + it.model + '.', link: '/meustenis?ofertas=1' });
  return { id: offerId, amount, status: 'PENDING', updated: !!(aberta && offerId === aberta.id) };
}

async function myOffers(prisma, userId) {
  await ensureSchema(prisma);
  const rec = await prisma.$queryRaw`SELECT o.*, i."model", i."brand", i."photo", u."name" AS "buyerName", u."phone" AS "buyerPhone", u."username" AS "buyerHandle", u."active" AS "buyerActive"
    FROM "ShoeClosetOffer" o JOIN "ShoeClosetItem" i ON i."id"=o."itemId" JOIN "User" u ON u."id"=o."buyerId"
    WHERE o."ownerId"=${userId} AND o."status" IN ('PENDING','ACCEPTED','DECLINED') ORDER BY (o."status"='PENDING') DESC, o."updatedAt" DESC LIMIT 100`;
  const sent = await prisma.$queryRaw`SELECT o.*, i."model", i."brand", i."photo", u."name" AS "ownerName", u."username" AS "ownerHandle"
    FROM "ShoeClosetOffer" o JOIN "ShoeClosetItem" i ON i."id"=o."itemId" JOIN "User" u ON u."id"=o."ownerId"
    WHERE o."buyerId"=${userId} ORDER BY o."updatedAt" DESC LIMIT 100`;
  const base = (o) => ({ id: o.id, itemId: o.itemId, model: o.model, brand: o.brand, photo: o.photo, amount: Number(o.amount), message: o.message, status: o.status, createdAt: o.createdAt, answeredAt: o.answeredAt });
  const isErased = require('./ligaPrivacy').isErased;
  const apagado = new Set();
  for (const o of rec) if (o.status === 'ACCEPTED' && (o.buyerActive === false || (await isErased(o.buyerId).catch(() => false)))) apagado.add(o.id);
  return {
    received: rec.map((o) => Object.assign(base(o), {
      buyer: { name: firstAndLast(o.buyerName), handle: o.buyerHandle || null },
      // WhatsApp de quem ofereceu: só depois que o dono aceita (a pessoa autorizou ao enviar)
      whatsapp: o.status === 'ACCEPTED' && !apagado.has(o.id) ? String(o.buyerPhone || '').replace(/\D/g, '') || null : null,
    })),
    sent: sent.map((o) => Object.assign(base(o), { owner: { name: firstAndLast(o.ownerName), handle: o.ownerHandle || null } })),
  };
}

// Dono: accept | decline. Quem ofereceu: cancel.
async function answerOffer(prisma, userId, offerId, action, deps = {}) {
  await ensureSchema(prisma);
  const [o] = await prisma.$queryRaw`SELECT o.*, i."model" FROM "ShoeClosetOffer" o JOIN "ShoeClosetItem" i ON i."id"=o."itemId" WHERE o."id"=${String(offerId)}`;
  if (!o || (o.ownerId !== userId && o.buyerId !== userId)) throw httpErr(404, 'Oferta não encontrada.');
  if (o.status !== 'PENDING') throw httpErr(409, 'Essa oferta já foi respondida.');
  const act = String(action || '');
  if (act === 'cancel') {
    if (o.buyerId !== userId) throw httpErr(403, 'Só quem fez a oferta pode cancelar.');
    const c = await prisma.$executeRaw`UPDATE "ShoeClosetOffer" SET "status"='WITHDRAWN', "updatedAt"=NOW() WHERE "id"=${o.id} AND "status"='PENDING'`;
    if (!c) throw httpErr(409, 'O dono já respondeu essa oferta.');
    return { status: 'WITHDRAWN' };
  }
  if (o.ownerId !== userId) throw httpErr(403, 'Só o dono do tênis responde a oferta.');
  if (act !== 'accept' && act !== 'decline') throw httpErr(400, 'Resposta inválida.');
  const status = act === 'accept' ? 'ACCEPTED' : 'DECLINED';
  const upd = await prisma.$executeRaw`UPDATE "ShoeClosetOffer" SET "status"=${status}, "answeredAt"=NOW(), "updatedAt"=NOW() WHERE "id"=${o.id} AND "status"='PENDING'`;
  if (!upd) throw httpErr(409, 'Essa oferta já foi respondida.');
  await notifyUser(deps, o.buyerId, status === 'ACCEPTED'
    ? { title: 'Oferta aceita', body: 'O dono aceitou sua oferta de ' + brl(o.amount) + ' pelo ' + o.model + '. Ele vai chamar você no WhatsApp.', link: '/meustenis?ofertas=1' }
    : { title: 'Oferta recusada', body: 'O dono não aceitou sua oferta de ' + brl(o.amount) + ' pelo ' + o.model + '.', link: '/meustenis?ofertas=1' });
  return (await myOffers(prisma, userId)).received.find((x) => x.id === o.id) || { status };
}

module.exports = { ensureSchema, setHandle, resolveHandle, me, saveProfile, publicCloset, explore, searchCatalog, searchWeb, copyWebPhoto, lookupBarcode, setTracking, liveKm,
  addItem, updateItem, removeItem, reorder, toggleLike, makeOffer, myOffers, answerOffer, parseValor, handleBase, firstAndLast, HANDLE_RX, LIMITE_ITENS, MAX_FOTOS };
