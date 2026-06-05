// =====================================================================
// Daily Market Engine
// =====================================================================
// Roda o comando comercial diario com agentes. Ele analisa, planeja e cria
// aprovacoes; nao executa acoes sensiveis automaticamente.
// =====================================================================

const { prisma } = require('../../middleware');
const { buildMarketSnapshot, todayKeyFortaleza } = require('../context/market-snapshot.service');
const { runOrchestration, getOrchestration } = require('../orchestrator/orchestrator.service');
const { recordEvent } = require('../memory/memory.service');
const { logAIAction } = require('../logs/ai-log.service');

const LAST_RUN_KEY = 'daily_market_engine_last_run';
const LAST_ORCHESTRATION_KEY = 'daily_market_engine_last_orchestration_id';

function resolveDailyAgentVariant(agentVariant) {
  const requested = String(agentVariant || process.env.DAILY_MARKET_AGENT_VARIANT || '').toLowerCase();
  return ['market', 'experimental', 'v2', 'new'].includes(requested) ? 'market' : 'classic';
}

function configValue(key) {
  return prisma.config.findUnique({ where: { key } }).then((row) => row?.value || null).catch(() => null);
}

async function setConfigValue(key, value) {
  await prisma.config.upsert({
    where: { key },
    update: { value: String(value) },
    create: { id: key, key, value: String(value) },
  });
}

function buildObjective(runDate) {
  return [
    `Comando comercial diario ${runDate} da Sports & Tennis.`,
    'Meta: vender mais hoje com margem, girar estoque parado, proteger caixa, escolher produtos foco, criar campanha de loja, acao de Instagram, acao de WhatsApp, script de vendedor, plano B de meio-dia e relatorio de fechamento.',
    'Inclua desconto somente como recomendacao com aprovacao humana.',
  ].join(' ');
}

function buildNotes(snapshot) {
  return [
    'Voce esta recebendo o snapshot real do negocio em extraContext.marketSnapshot.',
    'Entregue um plano executivo do dia com:',
    '1. objetivo comercial do dia;',
    '2. 3 a 7 produtos foco com motivo;',
    '3. execucao loja a loja;',
    '4. acao WhatsApp pronta para aprovacao;',
    '5. acao Instagram/feed/story pronta para aprovacao;',
    '6. script de vendedor com 3 abordagens;',
    '7. trigger de intervencao ao meio-dia;',
    '8. riscos, limites de margem e aprovacoes necessarias;',
    '9. template do fechamento do dia.',
    '',
    'Regras: nunca envie WhatsApp, nunca altere preco, nunca altere saldo, nunca compre estoque, nunca publique campanha paga sem aprovacao humana.',
    '',
    `Resumo numerico: vendas ${snapshot.sales?.days || 30}d = R$ ${snapshot.sales?.total?.revenue || 0} em ${snapshot.sales?.total?.count || 0} vendas; ` +
      `produtos parados no radar = ${snapshot.inventory?.slowMovers?.length || 0}; ` +
      `aprovacoes pendentes = ${snapshot.ai?.pendingApprovals || 0}; ` +
      `custo IA hoje = R$ ${snapshot.ai?.todayCostBRL || 0}.`,
  ].join('\n');
}

function compactHighlights(snapshot) {
  return {
    runDate: snapshot.runDate,
    sales30d: snapshot.sales?.total || null,
    topStores: (snapshot.sales?.byStore || []).slice(0, 4),
    topProducts: (snapshot.sales?.topProducts || []).slice(0, 5),
    slowMovers: (snapshot.inventory?.slowMovers || []).slice(0, 5).map((p) => ({
      sku: p.sku, name: p.name, brand: p.brand, stock: p.stock, marginPct: p.marginPct,
    })),
    promoCandidates: (snapshot.inventory?.promoCandidates || []).slice(0, 5).map((p) => ({
      sku: p.sku, name: p.name, brand: p.brand, stock: p.stock, marginPct: p.marginPct,
    })),
    lowStockWinners: (snapshot.inventory?.lowStockWinners || []).slice(0, 5).map((p) => ({
      sku: p.sku, name: p.name, brand: p.brand, stock: p.stock, sold30: p.sold30,
    })),
    pendingApprovals: snapshot.ai?.pendingApprovals || 0,
    pendingCreatives: snapshot.campaigns?.pendingCreatives || 0,
  };
}

function compactAgentOutput(output) {
  if (!output || typeof output !== 'object') return null;
  return {
    agentCode: output.agentCode || null,
    summary: output.summary || '',
    nextAction: output.nextAction || '',
    degraded: !!output._degraded,
    error: output._error || null,
  };
}

function compactDailyOrchestration(orchestration) {
  if (!orchestration) return null;
  const result = orchestration.result || {};
  return {
    id: orchestration.id,
    objective: orchestration.objective,
    status: orchestration.status,
    createdAt: orchestration.createdAt,
    updatedAt: orchestration.updatedAt,
    source: orchestration.input?.source || null,
    agentVariant: orchestration.input?.metadata?.agentVariant || null,
    result: {
      agentsUsed: Array.isArray(result.agentsUsed) ? result.agentsUsed : [],
      consolidatedPlan: result.consolidatedPlan || '',
      nextRecommendedAction: result.nextRecommendedAction || '',
      safetyReview: result.safetyReview || null,
      risks: Array.isArray(result.risks) ? result.risks : [],
      canExecuteNow: Array.isArray(result.canExecuteNow) ? result.canExecuteNow : [],
      needsHumanValidation: Array.isArray(result.needsHumanValidation) ? result.needsHumanValidation : [],
      readyMaterials: result.readyMaterials || {},
    },
    tasks: (orchestration.tasks || []).map((t) => ({
      id: t.id,
      agentCode: t.agentCode,
      task: t.task,
      status: t.status,
      error: t.error || null,
      output: compactAgentOutput(t.output),
      createdAt: t.createdAt,
      updatedAt: t.updatedAt,
    })),
    approvals: (orchestration.approvals || []).map((a) => ({
      id: a.id,
      type: a.type,
      title: a.title,
      description: a.description,
      status: a.status,
      riskLevel: a.riskLevel,
      createdAt: a.createdAt,
      decidedAt: a.decidedAt,
    })),
  };
}

async function notifyAdmins(summary) {
  try {
    const pushSvc = require('../../services/pushNotifications');
    const admins = await prisma.user.findMany({
      where: { role: { in: ['admin', 'superadmin', 'manager'] }, active: true },
      select: { id: true },
    });
    await Promise.all(admins.map((a) => pushSvc.sendToUser(a.id, {
      title: 'Comando comercial diario pronto',
      body: summary,
      url: '/admin.html?tab=ai',
      tag: 'daily-market-engine',
    }).catch(() => null)));
    return admins.length;
  } catch (_) {
    return 0;
  }
}

async function getDailyMarketStatus() {
  const [lastRun, lastOrchestrationId] = await Promise.all([
    configValue(LAST_RUN_KEY),
    configValue(LAST_ORCHESTRATION_KEY),
  ]);
  let orchestration = null;
  if (lastOrchestrationId) {
    orchestration = await getOrchestration(lastOrchestrationId).catch(() => null);
  }
  return {
    runDate: todayKeyFortaleza(),
    lastRun,
    lastOrchestrationId,
    orchestration: compactDailyOrchestration(orchestration),
  };
}

async function runDailyMarketEngine({ force = false, dryRun = false, createdById = null, agentVariant = null } = {}) {
  const runDate = todayKeyFortaleza();
  const startedAt = new Date();
  const previous = await configValue(LAST_RUN_KEY);
  const effectiveAgentVariant = resolveDailyAgentVariant(agentVariant);

  if (dryRun) {
    const snapshot = await buildMarketSnapshot({ days: 30 });
    const highlights = compactHighlights(snapshot);
    return { ok: true, dryRun: true, runDate, agentVariant: effectiveAgentVariant, snapshot, highlights };
  }

  if (!force && previous && previous.startsWith(`${runDate}:completed`)) {
    return {
      ok: true,
      skipped: true,
      reason: `Daily Market Engine ja rodou em ${runDate}. Use force=true para rodar de novo.`,
      runDate,
      agentVariant: effectiveAgentVariant,
      previous,
    };
  }

  if (!force && previous && previous.startsWith(`${runDate}:running`)) {
    return {
      ok: true,
      skipped: true,
      reason: `Daily Market Engine ja esta em execucao para ${runDate}.`,
      runDate,
      agentVariant: effectiveAgentVariant,
      previous,
    };
  }

  const snapshot = await buildMarketSnapshot({ days: 30 });
  const highlights = compactHighlights(snapshot);

  await setConfigValue(LAST_RUN_KEY, `${runDate}:running:${startedAt.toISOString()}`);

  try {
    const result = await runOrchestration({
      objective: buildObjective(runDate),
      notes: buildNotes(snapshot),
      createdById,
      source: 'daily-market-engine',
      metadata: {
        runDate,
        startedAt: startedAt.toISOString(),
        highlights,
        agentVariant: effectiveAgentVariant,
      },
      extraContext: {
        marketSnapshot: snapshot,
        operatingMode: {
          cadence: 'daily',
          autonomy: 'analysis_and_approval_only',
          agentVariant: effectiveAgentVariant,
          forbiddenAutomaticActions: [
            'send_whatsapp',
            'change_price',
            'change_teniscash_balance',
            'publish_paid_campaign',
            'buy_stock',
            'sign_contract',
            'make_payment',
          ],
        },
      },
    });

    await setConfigValue(LAST_ORCHESTRATION_KEY, result.orchestrationId);
    await setConfigValue(LAST_RUN_KEY, `${runDate}:completed:${new Date().toISOString()}`);

    await recordEvent({
      category: 'ia',
      title: `Comando comercial diario gerado (${runDate})`,
      detail: result.nextRecommendedAction || result.consolidatedPlan || null,
      data: { orchestrationId: result.orchestrationId, highlights },
      source: 'daily-market-engine',
      refType: 'AIOrchestration',
      refId: result.orchestrationId,
      importance: 3,
      createdById,
    });

    const summary = result.nextRecommendedAction
      || `Plano diario pronto com ${result.approvalRequired?.length || 0} aprovacao(oes).`;
    const notifiedAdmins = await notifyAdmins(summary);

    await logAIAction({
      agentCode: 'daily-market-engine',
      action: 'run_daily',
      input: { runDate, force, highlights },
      output: { orchestrationId: result.orchestrationId, notifiedAdmins },
      error: null,
      cost: 0,
      tokens: 0,
      createdById,
    });

    return {
      ok: true,
      skipped: false,
      runDate,
      agentVariant: effectiveAgentVariant,
      startedAt: startedAt.toISOString(),
      completedAt: new Date().toISOString(),
      highlights,
      notifiedAdmins,
      result,
    };
  } catch (err) {
    await setConfigValue(LAST_RUN_KEY, `${runDate}:failed:${new Date().toISOString()}`);
    await logAIAction({
      agentCode: 'daily-market-engine',
      action: 'run_daily',
      input: { runDate, force, highlights },
      output: null,
      error: err.message,
      cost: 0,
      tokens: 0,
      createdById,
    });
    throw err;
  }
}

module.exports = {
  runDailyMarketEngine,
  getDailyMarketStatus,
  buildObjective,
  buildNotes,
};
