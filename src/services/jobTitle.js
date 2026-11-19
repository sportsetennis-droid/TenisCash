// Cargo do colaborador (dono 18/11/2026: "Crie o cargo de logística pra João e dê o mesmo acesso de
// vendedor pra ele, pq ele fica transferindo os produtos fazendo bipes").
// O ACESSO continua sendo o do role 'seller' (bipe, transferência, ponto, app) — mais de 100 pontos do
// sistema checam role === 'seller', então o cargo NÃO troca o role. O cargo só diz o que a pessoa faz:
// VENDEDOR (padrão), LOGISTICA ou SUPERVISOR. Mensagens de vendedor (meta, resultado) vão só pra VENDEDOR.

const TITLES = { VENDEDOR: 'Vendedor', LOGISTICA: 'Logística', SUPERVISOR: 'Supervisor de vendas' };

let ready = null;
function ensureSchema(prisma) {
  if (!ready) {
    ready = prisma.$executeRawUnsafe(`CREATE TABLE IF NOT EXISTS "UserJobTitle" (
      "userId" TEXT PRIMARY KEY, "title" TEXT NOT NULL, "updatedById" TEXT,
      "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT NOW())`).catch((e) => { ready = null; throw e; });
  }
  return ready;
}

// Mapa userId -> título (só quem tem cargo diferente do padrão aparece).
async function all(prisma) {
  await ensureSchema(prisma);
  const rows = await prisma.$queryRaw`SELECT "userId", "title" FROM "UserJobTitle"`;
  return Object.fromEntries(rows.map((r) => [r.userId, r.title]));
}

async function set(prisma, userId, title, updatedById) {
  const t = String(title || '').toUpperCase();
  if (!TITLES[t]) throw Object.assign(new Error('Cargo inválido.'), { statusCode: 400 });
  await ensureSchema(prisma);
  if (t === 'VENDEDOR') { await prisma.$executeRaw`DELETE FROM "UserJobTitle" WHERE "userId" = ${userId}`; return t; }
  await prisma.$executeRaw`INSERT INTO "UserJobTitle" ("userId","title","updatedById","updatedAt") VALUES (${userId}, ${t}, ${updatedById || null}, NOW())
    ON CONFLICT ("userId") DO UPDATE SET "title" = EXCLUDED."title", "updatedById" = EXCLUDED."updatedById", "updatedAt" = NOW()`;
  return t;
}

module.exports = { TITLES, ensureSchema, all, set };
