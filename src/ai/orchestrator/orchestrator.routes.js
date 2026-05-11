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

module.exports = router;
