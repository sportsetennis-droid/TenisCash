// =====================================================================
// Approval Executor — executa ações reais após aprovação humana
// =====================================================================
// Quando o admin aprova uma AIApproval, este módulo:
//   1. Olha o tipo (whatsapp_bulk, instagram_feed, instagram_story, ...)
//   2. Pega o payload da aprovação
//   3. Executa a ação real (Meta WhatsApp Cloud API, Meta Graph API, etc.)
//   4. Marca como 'executed' + registra resultado
// =====================================================================

const { prisma } = require('../../middleware');
const { logAIAction } = require('../logs/ai-log.service');
const { sendCampaignBatch } = require('../../whatsapp');
const instagram = require('../../services/instagram');

async function pickRecipientsForCampaign({ scope, storeId, limit = 200 } = {}) {
  // scope: 'all' | 'with_balance' | 'recent_buyers' | 'inactive'
  const where = { role: 'user', active: true, phone: { not: null } };
  let take = Math.min(Math.max(limit || 200, 1), 1000);
  let order = { createdAt: 'desc' };

  if (scope === 'with_balance') {
    where.balance = { gt: 0 };
  } else if (scope === 'inactive') {
    const since = new Date(Date.now() - 60 * 24 * 3600 * 1000);
    where.updatedAt = { lt: since };
  } else if (scope === 'recent_buyers') {
    // últimos 30 dias com transação positiva — simplificação: ordena por updatedAt
    const since = new Date(Date.now() - 30 * 24 * 3600 * 1000);
    where.updatedAt = { gte: since };
  }
  // store-aware filter pode entrar depois (precisa cruzar com Sale/SellerClient)
  const users = await prisma.user.findMany({
    where,
    select: { id: true, name: true, phone: true, balance: true },
    take,
    orderBy: order,
  });
  return users.map((u) => ({ phone: u.phone, name: u.name || '' }));
}

/**
 * executeApproval — dispara a ação real para uma aprovação.
 *
 * Tipos suportados nesta versão:
 *   - whatsapp_bulk      → envia campanha via Meta WhatsApp Cloud API
 *   - whatsapp_single    → envia mensagem individual
 *   - instagram_feed     → posta no feed (precisa imageUrl no payload)
 *   - instagram_story    → posta story (precisa imageUrl no payload)
 *
 * Não suportados ainda (retornam not_supported):
 *   - discount, paid_campaign, balance_change, contract, stock_purchase, ...
 *
 * @returns {Promise<{ok: boolean, error?: string, detail?: any}>}
 */
async function executeApproval(approval, opts = {}) {
  if (!approval) return { ok: false, error: 'approval inexistente' };
  if (approval.status !== 'approved') {
    return { ok: false, error: 'aprovação não está em status approved' };
  }
  const payload = approval.payload || {};
  const type = approval.type;

  try {
    if (type === 'whatsapp_bulk') {
      const message = opts.messageOverride || payload.campaignMessage || payload.message || payload.text;
      if (!message) return { ok: false, error: 'mensagem da campanha não encontrada no payload' };
      const recipients = opts.recipients
        || await pickRecipientsForCampaign({
          scope: opts.scope || payload.scope || 'all',
          storeId: opts.storeId || payload.storeId || null,
          limit: opts.limit || payload.limit || 200,
        });
      if (!recipients.length) return { ok: false, error: 'sem destinatários para envio' };
      const result = await sendCampaignBatch({ recipients, message, delayMs: opts.delayMs || 1500 });
      await logAIAction({
        agentCode: 'approval-executor',
        action: 'whatsapp_bulk',
        input: { approvalId: approval.id, total: result.total },
        output: result,
      });
      return { ok: result.failed < result.total, detail: result };
    }

    if (type === 'whatsapp_single') {
      const phone = opts.phone || payload.phone;
      const message = opts.messageOverride || payload.message || payload.text;
      if (!phone || !message) return { ok: false, error: 'phone e message são obrigatórios' };
      const { sendCustomMessage } = require('../../whatsapp');
      const result = await sendCustomMessage(phone, message);
      await logAIAction({
        agentCode: 'approval-executor',
        action: 'whatsapp_single',
        input: { approvalId: approval.id, phone },
        output: result,
      });
      return { ok: result.ok, detail: result, error: result.error };
    }

    if (type === 'instagram_feed') {
      const imageUrl = opts.imageUrl || payload.imageUrl;
      const caption = opts.caption || payload.caption || payload.instagramCaption;
      if (!imageUrl) return { ok: false, error: 'imageUrl é obrigatório (precisa subir a arte primeiro)' };
      const result = await instagram.postFeed({ imageUrl, caption });
      await logAIAction({
        agentCode: 'approval-executor',
        action: 'instagram_feed',
        input: { approvalId: approval.id, imageUrl },
        output: result,
      });
      return { ok: result.ok, detail: result, error: result.error };
    }

    if (type === 'instagram_story') {
      const imageUrl = opts.imageUrl || payload.imageUrl;
      if (!imageUrl) return { ok: false, error: 'imageUrl é obrigatório' };
      const result = await instagram.postStory({ imageUrl });
      await logAIAction({
        agentCode: 'approval-executor',
        action: 'instagram_story',
        input: { approvalId: approval.id, imageUrl },
        output: result,
      });
      return { ok: result.ok, detail: result, error: result.error };
    }

    return { ok: false, error: 'not_supported', detail: { type } };
  } catch (err) {
    await logAIAction({
      agentCode: 'approval-executor',
      action: 'error',
      input: { approvalId: approval.id, type },
      error: err.message,
    });
    return { ok: false, error: err.message };
  }
}

async function executeApprovalById(approvalId, opts = {}) {
  const approval = await prisma.aIApproval.findUnique({ where: { id: approvalId } });
  if (!approval) return { ok: false, error: 'aprovação não encontrada' };
  const result = await executeApproval(approval, opts);
  if (result.ok) {
    await prisma.aIApproval.update({
      where: { id: approvalId },
      data: { status: 'executed', decidedAt: approval.decidedAt || new Date() },
    });
  }
  return result;
}

module.exports = { executeApproval, executeApprovalById, pickRecipientsForCampaign };
