'use strict';

// Comunicação do contracheque pelo WhatsApp (dono, 16/11/2026: automático ao fechar +
// prévia semanal). Só manda para funcionário com cadastro de contrato ativo e telefone.
// O PDF vai por link assinado com validade; cada envio fica na auditoria.

const cal = require('./calendar');
const pcrypto = require('./crypto');
const { preview, audit, publicBase } = require('./service');

const brl = (c) => (Number(c || 0) / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
const LINK_DAYS = 30;

function defaultSender() {
  const wa = require('../../whatsapp');
  return { text: (phone, msg) => wa.sendCustomMessage(phone, msg), document: (phone, url, name, caption) => wa.sendEvolutionMedia(phone, url, name, caption) };
}
function enabled() { return String(process.env.PAYROLL_WHATSAPP || 'on').toLowerCase() !== 'off'; }
function firstName(name) { return String(name || '').trim().split(/\s+/)[0] || ''; }

async function notifyClosed(prisma, payslipId, { sender = defaultSender(), nowMs = Date.now() } = {}) {
  if (!enabled()) return { ok: false, skipped: 'desligado (PAYROLL_WHATSAPP=off)' };
  const p = await prisma.payslip.findUnique({ where: { id: payslipId } });
  if (!p || !['FECHADO', 'PAGO'].includes(p.status)) return { ok: false, skipped: 'contracheque não está fechado' };
  const user = await prisma.user.findUnique({ where: { id: p.userId }, select: { id: true, name: true, phone: true } });
  if (!user?.phone) return { ok: false, skipped: 'funcionário sem telefone' };
  const token = pcrypto.signLink(p.id, nowMs + LINK_DAYS * 86400000);
  const url = `${publicBase()}/api/payroll/file/${token}`;
  const comp = p.competence.split('-').reverse().join('/');
  const caption = `Olá, ${firstName(user.name)}! Seu contracheque de ${comp} (versão ${p.version}) está fechado.\n`
    + `Líquido: ${brl(p.netCents)}.\nVeja os detalhes no app TenisCash em "Meu pagamento". O link do PDF vale por ${LINK_DAYS} dias.`;
  let r = await sender.document(user.phone, url, `contracheque-${p.competence}.pdf`, caption).catch((e) => ({ ok: false, error: e.message }));
  if (!r?.ok) r = await sender.text(user.phone, `${caption}\nPDF: ${url}`).catch((e) => ({ ok: false, error: e.message }));
  await prisma.$transaction(async (tx) => {
    if (r?.ok) await tx.payslip.update({ where: { id: p.id }, data: { notifiedAt: new Date(nowMs) } });
    await audit(tx, { entity: 'Payslip', entityId: p.id, action: r?.ok ? 'WHATSAPP_SENT' : 'WHATSAPP_FAILED', subjectUserId: p.userId,
      after: { to: '…' + String(user.phone).slice(-4), error: r?.ok ? null : r?.error || 'falhou' } });
  });
  return r;
}

function previewText(user, result) {
  const c = result.commission?.confirmed;
  const lines = [
    `Olá, ${firstName(user.name)}! Prévia do seu pagamento de ${result.competence.split('-').reverse().join('/')} (até ${result.asOfDay.split('-').reverse().join('/')}).`,
    'É uma PRÉVIA: ainda não é o contracheque oficial e pode mudar até o fechamento.',
  ];
  if (c) lines.push(`Vendas confirmadas: ${brl(c.totalCents)} · comissão ${c.generalPct}%: ${brl(c.commissionCents)}${c.nextTier ? ` · faltam ${brl(c.nextTier.missingCents)} para ${c.nextTier.pct}%` : ''}.`);
  lines.push(`Líquido estimado até hoje: ${brl(result.totals.netCents)}${result.projection ? ` · projeção do mês: ${brl(result.projection.netCents)}` : ''}.`);
  const pend = result.pendencies.filter((p) => ['PONTO_INCOMPLETO', 'SEM_PONTO'].includes(p.code)).length;
  if (pend) lines.push(`Você tem ${pend} pendência(s) de ponto. Confira e peça correção em "Meu pagamento".`);
  lines.push(`${publicBase()}/meu-pagamento.html`);
  return lines.join('\n');
}

async function sendWeeklyPreviews(prisma, { sender = defaultSender(), nowMs = Date.now() } = {}) {
  if (!enabled()) return { sent: 0, skipped: 'desligado' };
  const competence = cal.competenceOf(nowMs);
  const profiles = await prisma.payrollEmployeeProfile.findMany({ where: { active: true }, select: { userId: true } });
  let sent = 0, failed = 0;
  for (const { userId } of profiles) {
    try {
      const { user, result } = await preview(prisma, userId, competence, { nowMs });
      if (!user.active || !user.phone) continue;
      const r = await sender.text(user.phone, previewText(user, result));
      if (r?.ok) sent++; else failed++;
      await audit(prisma, { entity: 'PayrollPreview', entityId: `${userId}:${competence}`, action: r?.ok ? 'WHATSAPP_PREVIEW_SENT' : 'WHATSAPP_PREVIEW_FAILED',
        subjectUserId: userId, after: { netCents: result.totals.netCents, error: r?.ok ? null : r?.error || null } });
    } catch (err) {
      failed++;
      console.error('[payroll] prévia semanal', userId, err.message);
    }
  }
  return { sent, failed, competence };
}

module.exports = { notifyClosed, sendWeeklyPreviews, previewText, LINK_DAYS };
