// =====================================================================
// Cron 00:00 (America/Fortaleza) — marca posts de timeline como expirados
// =====================================================================
// Railway roda em UTC. SEM timezone explícito no node-cron, '0 0 * * *'
// dispararia 21:00 horário de PB. PB é UTC-3 fixo (sem DST) → Fortaleza.
//
// Ver regra em CLAUDE.md (REGRA PERMANENTE — Timezone em jobs cron)
// =====================================================================

const cron = require('node-cron');
const { PrismaClient } = require('@prisma/client');

const prisma = new PrismaClient();
const TZ = 'America/Fortaleza';

async function expireOldPosts() {
  const startedAt = new Date();
  const fortalezaTime = startedAt.toLocaleString('pt-BR', { timeZone: TZ });
  console.log(`[messagesCron] expirePosts disparado | UTC=${startedAt.toISOString()} | PB=${fortalezaTime}`);

  try {
    const result = await prisma.$executeRaw`
      UPDATE "TimelinePost"
      SET "expiredAt" = NOW()
      WHERE "expiredAt" IS NULL
        AND "createdAt" < DATE_TRUNC('day', NOW() AT TIME ZONE 'America/Fortaleza')
    `;
    console.log(`[messagesCron] expirePosts OK | rows afetadas=${result}`);
  } catch (err) {
    console.error('[messagesCron] erro ao expirar posts:', err);
  }
}

function startMessagesCron() {
  // Roda 00:00 todo dia, horário Paraíba
  cron.schedule('0 0 * * *', expireOldPosts, { timezone: TZ });
  console.log(`[messagesCron] agendado: 0 0 * * * (timezone ${TZ})`);

  // Também roda 1x no startup pra limpar qualquer post de "ontem" que ficou
  // (caso o servidor tenha estado offline na hora do cron)
  expireOldPosts().catch((e) => console.error('[messagesCron] startup expire failed', e));
}

module.exports = { startMessagesCron, expireOldPosts };
