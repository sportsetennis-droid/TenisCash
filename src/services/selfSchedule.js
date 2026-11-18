// Escala informada pelo próprio vendedor (dono 18/11/2026): "levar o link da agenda para cada um
// colocar os dias que vai trabalhar esse mês. Agenda tem que ser data e hora início e fim e intervalo.
// Coloque isso facilmente para eles preencherem."
//
// Ordem de prioridade da escala usada pelo sistema (mensagem 1h antes, agente, agenda do grupo):
//   1) escala do mês PUBLICADA pelo dono  2) esta escala informada pelo vendedor  3) escala fixa
//   4) horário habitual pelo ponto.
// Tabela por SQL aditivo/idempotente (o deploy não roda prisma db push).

const crypto = require('crypto');

const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const YMD_RE = /^\d{4}-\d{2}-\d{2}$/;

let ready = null;
function ensureSchema(prisma) {
  if (!ready) {
    ready = (async () => {
      await prisma.$executeRawUnsafe(`CREATE TABLE IF NOT EXISTS "SellerSelfShift" (
        "id" TEXT PRIMARY KEY, "sellerId" TEXT NOT NULL, "storeId" TEXT, "date" TEXT NOT NULL,
        "start" TEXT NOT NULL, "end" TEXT NOT NULL, "breakStart" TEXT, "breakEnd" TEXT,
        "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT NOW())`);
      await prisma.$executeRawUnsafe(`CREATE UNIQUE INDEX IF NOT EXISTS "SellerSelfShift_seller_date" ON "SellerSelfShift" ("sellerId", "date")`);
      await prisma.$executeRawUnsafe(`CREATE INDEX IF NOT EXISTS "SellerSelfShift_date" ON "SellerSelfShift" ("date")`);
    })().catch((e) => { ready = null; throw e; });
  }
  return ready;
}

function validYmd(v) {
  if (!YMD_RE.test(String(v || ''))) return false;
  const d = new Date(v + 'T12:00:00Z');
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v;
}

// Valida um dia. Devolve { error } ou { day }.
function normalizeDay(d) {
  const date = String(d && d.date || '').trim();
  if (!validYmd(date)) return { error: 'Data inválida.' };
  const start = String(d.start || '').trim(), end = String(d.end || '').trim();
  if (!TIME_RE.test(start) || !TIME_RE.test(end)) return { error: `Dia ${date.split('-').reverse().slice(0, 2).join('/')}: confira entrada e saída.` };
  if (start >= end) return { error: `Dia ${date.split('-').reverse().slice(0, 2).join('/')}: a saída tem que ser depois da entrada.` };
  let breakStart = String(d.breakStart || '').trim() || null, breakEnd = String(d.breakEnd || '').trim() || null;
  if (breakStart || breakEnd) {
    if (!breakStart || !breakEnd || !TIME_RE.test(breakStart) || !TIME_RE.test(breakEnd) || breakStart >= breakEnd || breakStart <= start || breakEnd >= end) {
      return { error: `Dia ${date.split('-').reverse().slice(0, 2).join('/')}: o intervalo tem que ficar entre a entrada e a saída.` };
    }
  }
  return { day: { date, start, end, breakStart, breakEnd } };
}

async function listMonth(prisma, sellerId, month) {
  await ensureSchema(prisma);
  return prisma.$queryRaw`SELECT "date","start","end","breakStart","breakEnd" FROM "SellerSelfShift"
    WHERE "sellerId" = ${sellerId} AND "date" LIKE ${month + '-%'} ORDER BY "date"`;
}

// Substitui os dias do mês A PARTIR DE HOJE (dias passados ficam como estavam).
async function replaceMonth(prisma, sellerId, storeId, month, days, todayYmd) {
  await ensureSchema(prisma);
  const clean = [];
  const seen = new Set();
  for (const raw of (Array.isArray(days) ? days : []).slice(0, 31)) {
    const n = normalizeDay(raw);
    if (n.error) return { error: n.error };
    if (!n.day.date.startsWith(month + '-')) return { error: 'Tem dia fora do mês escolhido.' };
    if (n.day.date < todayYmd || seen.has(n.day.date)) continue;
    seen.add(n.day.date); clean.push(n.day);
  }
  await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`DELETE FROM "SellerSelfShift" WHERE "sellerId" = ${sellerId} AND "date" LIKE ${month + '-%'} AND "date" >= ${todayYmd}`;
    for (const d of clean) {
      await tx.$executeRaw`INSERT INTO "SellerSelfShift" ("id","sellerId","storeId","date","start","end","breakStart","breakEnd","updatedAt")
        VALUES (${crypto.randomUUID()}, ${sellerId}, ${storeId || null}, ${d.date}, ${d.start}, ${d.end}, ${d.breakStart}, ${d.breakEnd}, NOW())`;
    }
  });
  return { saved: clean.length };
}

// Turnos informados num intervalo de datas: { [sellerId]: { [date]: {start,end,breakStart,breakEnd,storeId} } }
async function shiftsMap(prisma, fromYmd, toYmd, sellerId = null) {
  await ensureSchema(prisma);
  const rows = await prisma.$queryRaw`SELECT "sellerId","storeId","date","start","end","breakStart","breakEnd" FROM "SellerSelfShift"
    WHERE "date" >= ${fromYmd} AND "date" <= ${toYmd} AND (${sellerId}::text IS NULL OR "sellerId" = ${sellerId})`;
  const map = {};
  for (const r of rows) (map[r.sellerId] ||= {})[r.date] = r;
  return map;
}

// Link pessoal assinado (sem login) — vale só pra escala do próprio vendedor.
function signedLink(sellerId, baseUrl, days = 45) {
  const pcrypto = require('./payroll/crypto');
  const k = pcrypto.signLink('esc-' + sellerId, Date.now() + days * 86400000);
  return `${String(baseUrl || '').replace(/\/$/, '')}/minha-escala.html?k=${encodeURIComponent(k)}`;
}
function sellerFromLink(k) {
  const id = require('./payroll/crypto').verifyLink(k);
  return id && id.startsWith('esc-') ? id.slice(4) : null;
}

module.exports = { ensureSchema, normalizeDay, listMonth, replaceMonth, shiftsMap, signedLink, sellerFromLink };
