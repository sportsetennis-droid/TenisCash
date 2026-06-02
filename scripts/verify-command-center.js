// =====================================================================
// verify-command-center.js
// Valida o Centro de Comando contra o BANCO REAL (read-only).
// Regra do projeto: NUNCA declarar "funciona" sem testar com script.
//
// Uso:  node scripts/verify-command-center.js
// Carrega .env manualmente (dotenv não é dependência do projeto).
// =====================================================================

const fs = require('fs');
const path = require('path');

// ---- carregador de .env minimalista ---------------------------------
(function loadEnv() {
  const envPath = path.join(__dirname, '..', '.env');
  if (!fs.existsSync(envPath)) {
    console.warn('[verify] .env não encontrado em', envPath, '— usando env do processo.');
    return;
  }
  const raw = fs.readFileSync(envPath, 'utf8');
  for (const line of raw.split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const eq = t.indexOf('=');
    if (eq === -1) continue;
    const key = t.slice(0, eq).trim();
    let val = t.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = val;
  }
})();

const cc = require('../src/ai/command-center/command-center.service');
const { prisma } = require('../src/middleware');

function hr(title) {
  console.log('\n' + '─'.repeat(70) + '\n' + title + '\n' + '─'.repeat(70));
}

(async () => {
  let failures = 0;
  const checks = [
    ['getCostCap', () => cc.getCostCap()],
    ['getDailyBriefing', () => cc.getDailyBriefing()],
    ['getCost(30d)', () => cc.getCost({ days: 30 })],
    ['getActivity(30d)', () => cc.getActivity({ days: 30 })],
    ['getScorecard(30d)', () => cc.getScorecard({ days: 30 })],
    ['getApprovals(30d)', () => cc.getApprovals({ days: 30 })],
  ];

  for (const [label, fn] of checks) {
    hr(label);
    try {
      const out = await fn();
      console.log(JSON.stringify(out, null, 2));
      console.log(`✅ ${label} OK`);
    } catch (err) {
      failures++;
      console.error(`❌ ${label} FALHOU:`, err.message);
      console.error(err.stack);
    }
  }

  // sanidade das janelas de tempo
  hr('janelas de tempo (Fortaleza UTC-3)');
  console.log('startOfDay  :', cc.startOfDayFortaleza().toISOString());
  console.log('startOfMonth:', cc.startOfMonthFortaleza().toISOString());

  hr('RESUMO');
  if (failures === 0) {
    console.log('✅ TODOS OS CHECKS PASSARAM — Centro de Comando lê o banco real sem erro.');
  } else {
    console.log(`❌ ${failures} check(s) falharam — ver acima.`);
  }

  await prisma.$disconnect();
  process.exit(failures === 0 ? 0 : 1);
})().catch(async (err) => {
  console.error('[verify] erro fatal:', err);
  try { await prisma.$disconnect(); } catch (_) {}
  process.exit(1);
});
