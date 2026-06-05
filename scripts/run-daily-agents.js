#!/usr/bin/env node

// Manual runner:
//   railway run --service TenisCash --environment production node scripts/run-daily-agents.js
// Flags:
//   --force   roda mesmo se ja concluiu hoje
//   --dry-run monta snapshot sem chamar agentes
//   --variant=market|classic escolhe o squad explicitamente

const { runDailyMarketEngine } = require('../src/ai/daily/daily-market-engine.service');
const { prisma } = require('../src/middleware');

function hasFlag(name) {
  return process.argv.includes(name);
}

function getArg(name) {
  const prefix = `${name}=`;
  const found = process.argv.find((arg) => arg.startsWith(prefix));
  return found ? found.slice(prefix.length) : null;
}

(async () => {
  const result = await runDailyMarketEngine({
    force: hasFlag('--force'),
    dryRun: hasFlag('--dry-run'),
    agentVariant: getArg('--variant'),
  });

  const summary = {
    ok: result.ok,
    skipped: !!result.skipped,
    dryRun: !!result.dryRun,
    runDate: result.runDate,
    agentVariant: result.agentVariant || null,
    reason: result.reason || null,
    orchestrationId: result.result?.orchestrationId || null,
    approvals: result.result?.approvalRequired?.length || 0,
    nextRecommendedAction: result.result?.nextRecommendedAction || null,
    highlights: result.highlights || null,
  };

  console.log(JSON.stringify(summary, null, 2));
})()
  .catch((err) => {
    console.error(JSON.stringify({ ok: false, error: err.message }, null, 2));
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect().catch(() => {});
  });
