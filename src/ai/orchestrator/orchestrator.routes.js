// =====================================================================
// Admin AI Routes — Central IA Sports & Tennis (rotas administrativas)
// =====================================================================
// Montadas em /api/admin/ai
// Todas exigem auth + admin role.

const express = require('express');
const { authMiddleware, adminMiddleware } = require('../../middleware');
const {
  runOrchestration,
  listOrchestrations,
  getOrchestration,
  listAgents,
} = require('./orchestrator.service');
const {
  listPendingApprovals,
  decideApproval,
  getApproval,
  VALID_DECISIONS,
} = require('../approvals/approval.service');
const { executeApprovalById, pickRecipientsForCampaign } = require('../approvals/approval.executor');
const { listRecentLogs } = require('../logs/ai-log.service');
const instagram = require('../../services/instagram');
const cc = require('../command-center/command-center.service');
const memory = require('../memory/memory.service');
const dailyMarket = require('../daily/daily-market-engine.service');
const learning = require('../learning/learning.service');

const router = express.Router();
router.use(authMiddleware);
router.use(adminMiddleware);

// Lista os agentes disponíveis
router.get('/agents', (_req, res) => {
  try {
    res.json({ agents: listAgents() });
  } catch (err) {
    console.error('[ai/agents] erro:', err);
    res.status(500).json({ error: 'Erro ao listar agentes' });
  }
});

// Roda o orquestrador
router.post('/orchestrate', async (req, res) => {
  try {
    const { objective, storeId, notes, userId } = req.body || {};
    if (!objective || typeof objective !== 'string' || !objective.trim()) {
      return res.status(400).json({ error: 'objective é obrigatório' });
    }
    const result = await runOrchestration({
      objective: objective.trim(),
      storeId: storeId || null,
      notes: notes || null,
      userId: userId || null,
      createdById: req.userId || null,
    });
    // Memória: grava que esse objetivo foi rodado (não bloqueia a resposta).
    memory.recordEvent({
      category: 'ia',
      title: `Orquestrador rodou: ${objective.trim().slice(0, 140)}`,
      detail: notes ? `Observações: ${notes}` : null,
      source: 'orchestrator',
      refType: 'AIOrchestration',
      refId: result && result.orchestrationId ? result.orchestrationId : (result && result.id) || null,
      importance: 2,
      createdById: req.userId || null,
    });
    res.json(result);
  } catch (err) {
    console.error('[ai/orchestrate] erro:', err);
    res.status(500).json({ error: 'Erro ao rodar orquestração', detail: err.message });
  }
});

// Lista orquestrações recentes
router.post('/daily-market/run', async (req, res) => {
  try {
    const { force = false, dryRun = false, agentVariant = null } = req.body || {};
    const result = await dailyMarket.runDailyMarketEngine({
      force: !!force,
      dryRun: !!dryRun,
      agentVariant,
      createdById: req.userId || null,
    });
    res.json(result);
  } catch (err) {
    console.error('[ai/daily-market/run] erro:', err);
    res.status(500).json({ error: 'Erro ao rodar comando comercial diario', detail: err.message });
  }
});

router.get('/daily-market/status', async (_req, res) => {
  try {
    res.json(await dailyMarket.getDailyMarketStatus());
  } catch (err) {
    console.error('[ai/daily-market/status] erro:', err);
    res.status(500).json({ error: 'Erro ao ler status diario', detail: err.message });
  }
});

router.get('/orchestrations', async (req, res) => {
  try {
    const limit = parseInt(req.query.limit || '20', 10);
    const list = await listOrchestrations({ limit });
    res.json({ orchestrations: list });
  } catch (err) {
    console.error('[ai/orchestrations] erro:', err);
    res.status(500).json({ error: 'Erro ao listar orquestrações' });
  }
});

// Detalhe de orquestração
router.get('/orchestrations/:id', async (req, res) => {
  try {
    const orchestration = await getOrchestration(req.params.id);
    if (!orchestration) return res.status(404).json({ error: 'Orquestração não encontrada' });
    res.json({ orchestration });
  } catch (err) {
    console.error('[ai/orchestrations/:id] erro:', err);
    res.status(500).json({ error: 'Erro ao carregar orquestração' });
  }
});

// Aprovações pendentes
router.get('/approvals/pending', async (req, res) => {
  try {
    const limit = parseInt(req.query.limit || '100', 10);
    const approvals = await listPendingApprovals({ limit });
    res.json({ approvals });
  } catch (err) {
    console.error('[ai/approvals/pending] erro:', err);
    res.status(500).json({ error: 'Erro ao listar aprovações' });
  }
});

// Detalhe de aprovação
router.get('/approvals/:id', async (req, res) => {
  try {
    const approval = await getApproval(req.params.id);
    if (!approval) return res.status(404).json({ error: 'Aprovação não encontrada' });
    res.json({ approval });
  } catch (err) {
    console.error('[ai/approvals/:id] erro:', err);
    res.status(500).json({ error: 'Erro ao carregar aprovação' });
  }
});

// Decisão sobre aprovação
router.post('/approvals/:id/decision', async (req, res) => {
  try {
    const { decision, note } = req.body || {};
    if (!VALID_DECISIONS.includes(decision)) {
      return res.status(400).json({
        error: `decision inválida. Use uma de: ${VALID_DECISIONS.join(', ')}`,
      });
    }
    const updated = await decideApproval({
      approvalId: req.params.id,
      decision,
      note: note || null,
      approvedById: req.userId,
    });
    let promotedMemory = null;
    if (updated.type === 'memory_promotion' && updated.status === 'approved') {
      promotedMemory = await learning.promoteLearningFromApproval(updated, req.userId || null).catch((err) => {
        console.error('[learning/promote] erro:', err);
        return null;
      });
    }
    // Memória: a decisão do dono é registro permanente do "porquê".
    memory.recordEvent({
      category: 'decisao',
      title: `Decisão (${decision}): ${updated && updated.title ? updated.title : req.params.id}`,
      detail: note || null,
      source: 'approval',
      refType: 'AIApproval',
      refId: req.params.id,
      importance: 2,
      createdById: req.userId || null,
    });
    res.json({ approval: updated, promotedMemory });
  } catch (err) {
    console.error('[ai/approvals/decision] erro:', err);
    res.status(500).json({ error: 'Erro ao registrar decisão', detail: err.message });
  }
});

// Prévia de destinatários antes de executar
router.get('/approvals/:id/preview-recipients', async (req, res) => {
  try {
    const scope = req.query.scope || 'all';
    const limit = parseInt(req.query.limit || '200', 10);
    const recipients = await pickRecipientsForCampaign({ scope, limit });
    res.json({ total: recipients.length, recipients: recipients.slice(0, 20), scope });
  } catch (err) {
    console.error('[ai/preview-recipients] erro:', err);
    res.status(500).json({ error: 'Erro ao listar destinatários' });
  }
});

// EXECUTA uma aprovação aprovada (WhatsApp bulk/single, Instagram feed/story)
router.post('/approvals/:id/execute', async (req, res) => {
  try {
    const opts = req.body || {};
    const result = await executeApprovalById(req.params.id, opts);
    res.json(result);
  } catch (err) {
    console.error('[ai/execute] erro:', err);
    res.status(500).json({ error: 'Erro ao executar aprovação', detail: err.message });
  }
});

// Instagram — status da config
router.get('/instagram/status', async (_req, res) => {
  try {
    const configured = instagram.isConfigured();
    if (!configured) {
      return res.json({ configured: false, message: 'Faltam env vars META_IG_ACCESS_TOKEN e/ou META_IG_BUSINESS_ID' });
    }
    const info = await instagram.getAccountInfo();
    res.json({ configured: true, account: info.account || null, error: info.error || null });
  } catch (err) {
    console.error('[ai/instagram/status] erro:', err);
    res.status(500).json({ error: err.message });
  }
});

// Logs recentes (debug/admin)
router.get('/logs', async (req, res) => {
  try {
    const limit = parseInt(req.query.limit || '50', 10);
    const agentCode = req.query.agentCode || null;
    const logs = await listRecentLogs({ agentCode, limit });
    res.json({ logs });
  } catch (err) {
    console.error('[ai/logs] erro:', err);
    res.status(500).json({ error: 'Erro ao listar logs' });
  }
});

// =====================================================================
// CENTRO DE COMANDO — camada de governança (FinOps, medição, scorecard,
// funil de aprovações, briefing do COO). Tudo read-only sobre dado real.
// Montado em /api/admin/ai/command-center/*
// =====================================================================

// Briefing diário (a voz do COO): resumo + alertas acionáveis
router.get('/command-center/briefing', async (_req, res) => {
  try {
    res.json(await cc.getDailyBriefing());
  } catch (err) {
    console.error('[cc/briefing] erro:', err);
    res.status(500).json({ error: 'Erro ao gerar briefing', detail: err.message });
  }
});

// Custo / FinOps: total, por agente, mês/dia vs teto
router.get('/command-center/cost', async (req, res) => {
  try {
    const days = parseInt(req.query.days || '30', 10);
    res.json(await cc.getCost({ days }));
  } catch (err) {
    console.error('[cc/cost] erro:', err);
    res.status(500).json({ error: 'Erro ao calcular custo', detail: err.message });
  }
});

// Atividade / Medição: o que a IA realmente fez
router.get('/command-center/activity', async (req, res) => {
  try {
    const days = parseInt(req.query.days || '30', 10);
    res.json(await cc.getActivity({ days }));
  } catch (err) {
    console.error('[cc/activity] erro:', err);
    res.status(500).json({ error: 'Erro ao medir atividade', detail: err.message });
  }
});

// Scorecard por agente: confiabilidade + custo
router.get('/command-center/scorecard', async (req, res) => {
  try {
    const days = parseInt(req.query.days || '30', 10);
    res.json(await cc.getScorecard({ days }));
  } catch (err) {
    console.error('[cc/scorecard] erro:', err);
    res.status(500).json({ error: 'Erro ao montar scorecard', detail: err.message });
  }
});

// Funil de aprovações: taxa de aprovação + tempo de decisão
router.get('/command-center/approvals', async (req, res) => {
  try {
    const days = parseInt(req.query.days || '30', 10);
    res.json(await cc.getApprovals({ days }));
  } catch (err) {
    console.error('[cc/approvals] erro:', err);
    res.status(500).json({ error: 'Erro ao montar funil de aprovações', detail: err.message });
  }
});

// Teto de custo (cap) — leitura
router.get('/command-center/cap', (_req, res) => {
  try {
    res.json(cc.getCostCap());
  } catch (err) {
    console.error('[cc/cap GET] erro:', err);
    res.status(500).json({ error: 'Erro ao ler teto', detail: err.message });
  }
});

// Teto de custo (cap) — atualização
router.post('/command-center/cap', (req, res) => {
  try {
    const { monthlyBRL, dailyBRL } = req.body || {};
    const next = cc.setCostCap({
      monthlyBRL: monthlyBRL != null ? Number(monthlyBRL) : undefined,
      dailyBRL: dailyBRL != null ? Number(dailyBRL) : undefined,
    });
    res.json(next);
  } catch (err) {
    console.error('[cc/cap POST] erro:', err);
    res.status(500).json({ error: 'Erro ao salvar teto', detail: err.message });
  }
});

// =====================================================================
// MEMÓRIA DA EMPRESA — o cérebro persistente que a IA lê antes de agir.
// Montado em /api/admin/ai/memory/*
// =====================================================================

// Linha do tempo (filtros: days, category, kind, source, limit)
router.get('/memory/timeline', async (req, res) => {
  try {
    const items = await memory.getTimeline({
      days: req.query.days != null ? parseInt(req.query.days, 10) : 30,
      category: req.query.category || null,
      kind: req.query.kind || null,
      source: req.query.source || null,
      limit: req.query.limit != null ? parseInt(req.query.limit, 10) : 100,
    });
    res.json({ items });
  } catch (err) {
    console.error('[memory/timeline] erro:', err);
    res.status(500).json({ error: 'Erro ao ler memória', detail: err.message });
  }
});

// Estatísticas (total, fatos, eventos, por categoria, desde quando)
router.get('/memory/stats', async (_req, res) => {
  try {
    res.json(await memory.getStats());
  } catch (err) {
    console.error('[memory/stats] erro:', err);
    res.status(500).json({ error: 'Erro ao calcular estatísticas', detail: err.message });
  }
});

// O cérebro: o que a IA carrega (fatos fixos + eventos recentes)
router.get('/memory/brain', async (req, res) => {
  try {
    res.json(await memory.getBrain({
      maxEvents: req.query.maxEvents != null ? parseInt(req.query.maxEvents, 10) : 40,
      eventDays: req.query.eventDays != null ? parseInt(req.query.eventDays, 10) : 14,
    }));
  } catch (err) {
    console.error('[memory/brain] erro:', err);
    res.status(500).json({ error: 'Erro ao montar cérebro', detail: err.message });
  }
});

// Cadastrar um FATO da empresa (o que ela É) — fixado por padrão
router.post('/memory/fact', async (req, res) => {
  try {
    const { category, title, detail, importance, pinned, company } = req.body || {};
    if (!title || !String(title).trim()) return res.status(400).json({ error: 'title é obrigatório' });
    const created = await memory.addFact({
      category: category || 'empresa',
      title,
      detail: detail || null,
      company: company || undefined,
      importance: importance != null ? importance : 2,
      pinned: pinned != null ? !!pinned : true,
      createdById: req.userId || null,
    });
    res.json({ memory: created });
  } catch (err) {
    console.error('[memory/fact] erro:', err);
    res.status(500).json({ error: 'Erro ao gravar fato', detail: err.message });
  }
});

// Anotação manual do dono na linha do tempo
router.post('/memory/note', async (req, res) => {
  try {
    const { category, title, detail, importance, company } = req.body || {};
    if (!title || !String(title).trim()) return res.status(400).json({ error: 'title é obrigatório' });
    const created = await memory.recordNote({
      category: category || 'nota',
      title,
      detail: detail || null,
      company: company || undefined,
      importance: importance != null ? importance : 1,
      createdById: req.userId || null,
    });
    res.json({ memory: created });
  } catch (err) {
    console.error('[memory/note] erro:', err);
    res.status(500).json({ error: 'Erro ao gravar anotação', detail: err.message });
  }
});

// Apagar um item de memória (fato ou anotação)
router.delete('/memory/:id', async (req, res) => {
  try {
    const ok = await memory.deleteMemory(req.params.id);
    if (!ok) return res.status(404).json({ error: 'Item não encontrado' });
    res.json({ ok: true });
  } catch (err) {
    console.error('[memory/delete] erro:', err);
    res.status(500).json({ error: 'Erro ao apagar', detail: err.message });
  }
});

module.exports = router;
