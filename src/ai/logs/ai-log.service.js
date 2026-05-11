// =====================================================================
// AI Log Service — registro centralizado de toda ação de agente IA
// =====================================================================

const { prisma } = require('../../middleware');

/**
 * logAIAction — grava registro de execução de agente no AILog.
 * Nunca lança: falhas de log NÃO devem derrubar o fluxo do orquestrador.
 */
async function logAIAction({
  agentCode,
  action,
  input,
  output,
  error,
  cost,
  tokens,
  createdById,
} = {}) {
  try {
    return await prisma.aILog.create({
      data: {
        agentCode: agentCode || 'unknown',
        action: action || 'unspecified',
        input: input ?? null,
        output: output ?? null,
        error: error || null,
        cost: typeof cost === 'number' ? cost : null,
        tokens: typeof tokens === 'number' ? tokens : null,
        createdById: createdById || null,
      },
    });
  } catch (err) {
    console.error('[ai-log] falha ao gravar log:', err.message);
    return null;
  }
}

async function listRecentLogs({ agentCode, limit = 50 } = {}) {
  try {
    return await prisma.aILog.findMany({
      where: agentCode ? { agentCode } : {},
      orderBy: { createdAt: 'desc' },
      take: Math.min(Math.max(limit, 1), 200),
    });
  } catch (err) {
    console.error('[ai-log] falha ao listar logs:', err.message);
    return [];
  }
}

module.exports = {
  logAIAction,
  listRecentLogs,
};
