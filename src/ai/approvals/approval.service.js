// =====================================================================
// Approval Service — gestão de aprovações humanas geradas pela IA
// =====================================================================

const { prisma } = require('../../middleware');

const VALID_STATUSES = [
  'pending',
  'approved',
  'rejected',
  'correction_requested',
  'executed',
  'cancelled',
];

const VALID_DECISIONS = ['approved', 'rejected', 'correction_requested'];

async function createApproval({
  orchestrationId,
  type,
  title,
  description,
  riskLevel,
  payload,
} = {}) {
  if (!type || !title) throw new Error('type e title são obrigatórios');
  return prisma.aIApproval.create({
    data: {
      orchestrationId: orchestrationId || null,
      type,
      title,
      description: description || null,
      riskLevel: riskLevel || 'medium',
      status: 'pending',
      payload: payload || null,
    },
  });
}

async function createManyApprovals(orchestrationId, items = []) {
  if (!Array.isArray(items) || items.length === 0) return [];
  const created = [];
  for (const item of items) {
    if (!item || !item.type || !item.title) continue;
    const a = await createApproval({
      orchestrationId,
      type: item.type,
      title: item.title,
      description: item.description || '',
      riskLevel: item.riskLevel || 'medium',
      payload: item.payload || null,
    });
    created.push(a);
  }
  return created;
}

async function listPendingApprovals({ limit = 100 } = {}) {
  return prisma.aIApproval.findMany({
    where: { status: 'pending' },
    orderBy: { createdAt: 'desc' },
    take: Math.min(Math.max(limit, 1), 500),
  });
}

async function listApprovalsByOrchestration(orchestrationId) {
  if (!orchestrationId) return [];
  return prisma.aIApproval.findMany({
    where: { orchestrationId },
    orderBy: { createdAt: 'desc' },
  });
}

async function decideApproval({ approvalId, decision, note, approvedById }) {
  if (!approvalId) throw new Error('approvalId é obrigatório');
  if (!VALID_DECISIONS.includes(decision)) {
    throw new Error(`decision inválida. Use uma de: ${VALID_DECISIONS.join(', ')}`);
  }
  return prisma.aIApproval.update({
    where: { id: approvalId },
    data: {
      status: decision,
      decisionNote: note || null,
      approvedById: approvedById || null,
      decidedAt: new Date(),
    },
  });
}

async function getApproval(approvalId) {
  if (!approvalId) return null;
  return prisma.aIApproval.findUnique({ where: { id: approvalId } });
}

module.exports = {
  createApproval,
  createManyApprovals,
  listPendingApprovals,
  listApprovalsByOrchestration,
  decideApproval,
  getApproval,
  VALID_STATUSES,
  VALID_DECISIONS,
};
