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
const { listRecentLogs } = require('../logs/ai-log.service');

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
    res.json(result);
  } catch (err) {
    console.error('[ai/orchestrate] erro:', err);
    res.status(500).json({ error: 'Erro ao rodar orquestração', detail: err.message });
  }
});

// Lista orquestrações recentes
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
    res.json({ approval: updated });
  } catch (err) {
    console.error('[ai/approvals/decision] erro:', err);
    res.status(500).json({ error: 'Erro ao registrar decisão', detail: err.message });
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

module.exports = router;
