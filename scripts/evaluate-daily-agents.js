#!/usr/bin/env node

// Compara duas orquestracoes ja salvas sem chamar IA.
// Uso:
//   node scripts/evaluate-daily-agents.js --baseline=<id> --candidate=<id>

const { evaluateDailyMarketPair } = require('../src/ai/evals/daily-market-evaluator');
const { prisma } = require('../src/middleware');

function getArg(name) {
  const prefix = `${name}=`;
  const found = process.argv.find((arg) => arg.startsWith(prefix));
  return found ? found.slice(prefix.length) : null;
}

(async () => {
  const baselineId = getArg('--baseline');
  const candidateId = getArg('--candidate');
  const result = await evaluateDailyMarketPair({ baselineId, candidateId });
  console.log(JSON.stringify(result, null, 2));
})()
  .catch((err) => {
    console.error(JSON.stringify({ ok: false, error: err.message }, null, 2));
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect().catch(() => {});
  });
