// =====================================================================
// Cron Daily Agents - America/Fortaleza
// =====================================================================
// 07:10 -> roda o Daily Market Engine. O motor e idempotente por data:
// se o servidor reiniciar, nao duplica o comando comercial do dia.
// =====================================================================

const cron = require('node-cron');
const { runDailyMarketEngine } = require('../ai/daily/daily-market-engine.service');
const { runForAll: copaMatchBotRunAll } = require('./copaMatchBot');

const TZ = 'America/Fortaleza';
const DEFAULT_SCHEDULE = '10 7 * * *';
let running = false;

async function runDailyAgentsCronTick({ force = false } = {}) {
  if (running) {
    console.log('[dailyAgentsCron] ja existe execucao em andamento; pulando tick');
    return { ok: true, skipped: true, reason: 'running' };
  }

  running = true;
  const startedAt = new Date();
  console.log(`[dailyAgentsCron] start | UTC=${startedAt.toISOString()} | PB=${startedAt.toLocaleString('pt-BR', { timeZone: TZ })}`);

  try {
    const result = await runDailyMarketEngine({ force });
    if (result.skipped) {
      console.log(`[dailyAgentsCron] skipped: ${result.reason}`);
    } else {
      console.log(`[dailyAgentsCron] ok | orchestration=${result.result?.orchestrationId || 'n/a'}`);
    }
    return result;
  } catch (err) {
    console.error('[dailyAgentsCron] erro:', err.message);
    return { ok: false, error: err.message };
  } finally {
    running = false;
  }
}

function startDailyAgentsCron() {
  if (process.env.DISABLE_DAILY_AGENTS_CRON === '1') {
    console.log('[dailyAgentsCron] desabilitado via DISABLE_DAILY_AGENTS_CRON=1');
    return;
  }

  const schedule = process.env.DAILY_AGENTS_CRON || DEFAULT_SCHEDULE;
  cron.schedule(schedule, () => runDailyAgentsCronTick(), { timezone: TZ });
  console.log(`[dailyAgentsCron] agendado: ${schedule} (timezone ${TZ})`);

  if (process.env.RUN_DAILY_AGENTS_ON_BOOT === '1') {
    runDailyAgentsCronTick().catch((e) => console.error('[dailyAgentsCron] boot failed', e.message));
  }

  // Robô de figurinhas Copa 2026 — roda às 9h todos os dias
  cron.schedule('0 9 * * *', () => {
    copaMatchBotRunAll().catch(e => console.error('[copaMatchBot] cron error:', e.message));
  }, { timezone: TZ });
  console.log('[copaMatchBot] cron agendado: 0 9 * * * (09:00 Fortaleza)');
}

module.exports = {
  startDailyAgentsCron,
  runDailyAgentsCronTick,
};
