'use strict';
// Leituras de contagem que ainda estão SÓ no aparelho (dono 14/11/2026: "não quero que nada fique
// preso no telefone de ninguém"). Cada página do TenisCash aberta no celular informa quantas
// leituras ainda não chegaram; assim o escritório sabe de quem cobrar o envio sem depender de print.
// Tabela aditiva, criada no primeiro uso (deploy não roda prisma db push). Nunca altera estoque.

let ready = null;
function ensureTable(prisma) {
  if (!ready) {
    ready = prisma.$executeRawUnsafe(`CREATE TABLE IF NOT EXISTS "ScannerDevicePending" (
      "deviceId" TEXT PRIMARY KEY,
      "operatorName" TEXT,
      "sellerIds" JSONB NOT NULL DEFAULT '[]'::jsonb,
      "localCount" INTEGER NOT NULL DEFAULT 0,
      "pendingCount" INTEGER NOT NULL DEFAULT 0,
      "byRound" JSONB NOT NULL DEFAULT '[]'::jsonb,
      "page" TEXT,
      "userAgent" TEXT,
      "firstSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      "reportedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`).catch(error => { ready = null; throw error; });
  }
  return ready;
}

const text = (value, max) => (value == null ? null : String(value).slice(0, max));
const count = value => { const n = Number(value); return Number.isInteger(n) && n >= 0 && n < 100000 ? n : 0; };

function sanitize(body = {}) {
  const deviceId = String(body.deviceId || '').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 64);
  if (deviceId.length < 8) { const e = new Error('Aparelho sem identificação.'); e.status = 400; throw e; }
  const byRound = (Array.isArray(body.byRound) ? body.byRound : []).slice(0, 40).map(row => ({
    roundId: text(row?.roundId, 64), storeId: text(row?.storeId, 64), storeLabel: text(row?.storeLabel, 80),
    local: count(row?.local), pending: count(row?.pending),
    oldestAt: text(row?.oldestAt, 40), newestAt: text(row?.newestAt, 40),
  })).filter(row => row.roundId || row.storeId);
  const sellerIds = [...new Set((Array.isArray(body.sellerIds) ? body.sellerIds : []).map(v => text(v, 64)).filter(Boolean))].slice(0, 10);
  return { deviceId, operatorName: text(body.operatorName, 120), sellerIds, localCount: count(body.localCount),
    pendingCount: count(body.pendingCount), byRound, page: text(body.page, 120) };
}

async function report(prisma, body, userAgent) {
  await ensureTable(prisma);
  const row = sanitize(body);
  await prisma.$executeRawUnsafe(`INSERT INTO "ScannerDevicePending"
      ("deviceId","operatorName","sellerIds","localCount","pendingCount","byRound","page","userAgent","reportedAt")
    VALUES ($1,$2,$3::jsonb,$4,$5,$6::jsonb,$7,$8,CURRENT_TIMESTAMP)
    ON CONFLICT ("deviceId") DO UPDATE SET "operatorName"=COALESCE(EXCLUDED."operatorName","ScannerDevicePending"."operatorName"),
      "sellerIds"=EXCLUDED."sellerIds","localCount"=EXCLUDED."localCount","pendingCount"=EXCLUDED."pendingCount",
      "byRound"=EXCLUDED."byRound","page"=EXCLUDED."page","userAgent"=EXCLUDED."userAgent","reportedAt"=CURRENT_TIMESTAMP`,
    row.deviceId, row.operatorName, JSON.stringify(row.sellerIds), row.localCount, row.pendingCount,
    JSON.stringify(row.byRound), row.page, text(userAgent, 300));
  return { ok: true };
}

async function list(prisma) {
  await ensureTable(prisma);
  return prisma.$queryRawUnsafe(`SELECT * FROM "ScannerDevicePending" ORDER BY ("localCount"+"pendingCount") DESC, "reportedAt" DESC LIMIT 200`);
}

module.exports = { report, list, sanitize, ensureTable };
