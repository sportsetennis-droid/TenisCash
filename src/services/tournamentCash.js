// =====================================================================
// APEX COMPETIÇÃO — Fase 2: movimento REAL de TenisCash (saldo do cliente)
// ---------------------------------------------------------------------
// Fecha o loop econômico: inscrição DEBITA TenisCash, prêmio CREDITA o
// campeão. Segue EXATAMENTE o padrão de ledger do transfer.js:
// prisma.$transaction + increment/decrement em User.balance + Transaction
// com balanceAfter + metadata.
//
// ⛔ TRAVAS DE SEGURANÇA (dinheiro de cliente — regra do CLAUDE.md):
//  - NADA move se `tournament.cashEnabled=false` (padrão). Torneio antigo
//    e torneio de atleta comum = cashEnabled false → ZERO cobrança.
//  - Só admin/gerente liga cashEnabled / define taxa+prêmio (antifraude:
//    atleta não cria torneio fajuto pra se auto-pagar). Enforcement na rota.
//  - Idempotente: inscrição cobra 1x (guarda entryTxId), prêmio paga 1x
//    (guarda prizePaidAt). Checa saldo antes de debitar (nunca negativa).
//  - Teto de prêmio automático (PRIZE_CASH_MAX); acima disso, bloqueia e
//    exige liberação explícita do dono.
//  - Nenhuma função LANÇA por regra de negócio — retorna {ok:false,error}.
//
// POLÍTICA (defaults — dono pode mudar depois):
//  1. Prêmio: creditado ao campeão por ação explícita do organizador/admin
//     (não automático ao fechar a final).
//  2. Só admin/gerente cria torneio com TenisCash real.
//  3. Teto automático = PRIZE_CASH_MAX.
//  4. Cobrança da inscrição: ao CONFIRMAR a inscrição.
//  5. Estorno: 100% enquanto DRAFT/OPEN (antes de começar); 0% depois.
// =====================================================================

const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
const { notifyMany } = require('./notify');

const ADMIN_ROLES = ['admin', 'superadmin', 'manager'];
const PRIZE_CASH_MAX = 2000; // teto de prêmio automático em TenisCash

function isAdmin(role) {
  return ADMIN_ROLES.includes(role);
}

// Debita a inscrição do atleta que registrou (members[0]).
// Só age se o torneio tem cash ligado e taxa > 0. Idempotente.
async function chargeEntry(entryId) {
  const entry = await prisma.tournamentEntry.findUnique({
    where: { id: entryId },
    include: { tournament: true, members: true },
  });
  if (!entry) return { ok: false, error: 'inscrição não encontrada' };
  const t = entry.tournament;
  if (!t.cashEnabled || !(t.entryFeeCash > 0)) return { ok: true, charged: false }; // sem cobrança
  if (entry.entryPaid || entry.entryTxId) return { ok: true, charged: false }; // já cobrado (idempotente)

  const payerId = entry.members[0] && entry.members[0].userId;
  if (!payerId) return { ok: false, error: 'inscrição sem atleta pra cobrar' };
  const payer = await prisma.user.findUnique({ where: { id: payerId } });
  if (!payer) return { ok: false, error: 'pagador não encontrado' };
  if (payer.balance < t.entryFeeCash) {
    return { ok: false, error: `saldo insuficiente — inscrição custa ${t.entryFeeCash} TenisCash` };
  }

  const r = await prisma.$transaction(async (tx) => {
    const u = await tx.user.update({
      where: { id: payerId },
      data: { balance: { decrement: t.entryFeeCash } },
    });
    const trx = await tx.transaction.create({
      data: {
        type: 'tournament_entry_fee',
        amount: t.entryFeeCash,
        description: `Inscrição: ${t.name}`,
        senderId: payerId,
        receiverId: null,
        balanceAfter: u.balance,
        metadata: JSON.stringify({ tournamentId: t.id, entryId }),
      },
    });
    await tx.tournamentEntry.update({
      where: { id: entryId },
      data: { entryPaid: true, entryTxId: trx.id },
    });
    return { balance: u.balance, txId: trx.id };
  });
  return { ok: true, charged: true, ...r };
}

// Estorna a inscrição (crédito de volta). Idempotente: só se foi cobrada.
async function refundEntry(entryId, reason) {
  const entry = await prisma.tournamentEntry.findUnique({
    where: { id: entryId },
    include: { tournament: true, members: true },
  });
  if (!entry || !entry.entryPaid || !entry.entryTxId) return { ok: true, refunded: false };
  const fee = entry.tournament.entryFeeCash || 0;
  const payerId = entry.members[0] && entry.members[0].userId;
  if (!(fee > 0) || !payerId) {
    // nada a estornar em dinheiro, mas limpa as flags
    await prisma.tournamentEntry.update({ where: { id: entryId }, data: { entryPaid: false, entryTxId: null } });
    return { ok: true, refunded: false };
  }

  const r = await prisma.$transaction(async (tx) => {
    const u = await tx.user.update({
      where: { id: payerId },
      data: { balance: { increment: fee } },
    });
    const trx = await tx.transaction.create({
      data: {
        type: 'tournament_entry_refund',
        amount: fee,
        description: `Estorno inscrição: ${entry.tournament.name}${reason ? ' (' + reason + ')' : ''}`,
        senderId: null,
        receiverId: payerId,
        balanceAfter: u.balance,
        metadata: JSON.stringify({ tournamentId: entry.tournamentId, entryId }),
      },
    });
    await tx.tournamentEntry.update({
      where: { id: entryId },
      data: { entryPaid: false, entryTxId: null },
    });
    return { balance: u.balance, txId: trx.id };
  });
  return { ok: true, refunded: true, ...r };
}

// Estorna TODAS as inscrições pagas de um torneio (ex: torneio cancelado).
async function refundAllEntries(tournamentId, reason) {
  const entries = await prisma.tournamentEntry.findMany({
    where: { tournamentId, entryPaid: true },
    select: { id: true },
  });
  let refunded = 0;
  for (const e of entries) {
    const r = await refundEntry(e.id, reason);
    if (r.refunded) refunded += 1;
  }
  return { ok: true, refunded };
}

// Paga o prêmio ao campeão (vencedor da FINAL). Idempotente (prizePaidAt).
// Divide igualmente entre os membros da dupla, se for o caso.
async function payPrize(tournamentId) {
  const t = await prisma.tournament.findUnique({ where: { id: tournamentId } });
  if (!t) return { ok: false, error: 'torneio não encontrado' };
  if (!t.cashEnabled || !(t.prizeCash > 0)) return { ok: false, error: 'este torneio não tem prêmio em TenisCash' };
  if (t.prizePaidAt) return { ok: false, error: 'o prêmio deste torneio já foi pago' };
  if (t.prizeCash > PRIZE_CASH_MAX) {
    return { ok: false, error: `prêmio acima do teto automático (${PRIZE_CASH_MAX} TenisCash) — precisa de liberação do dono` };
  }

  const final = await prisma.tournamentMatch.findFirst({
    where: { tournamentId, stage: 'FINAL' },
    orderBy: { round: 'desc' },
  });
  if (!final || !final.winnerEntryId) return { ok: false, error: 'ainda não há campeão (final não concluída)' };
  const champ = await prisma.tournamentEntry.findUnique({
    where: { id: final.winnerEntryId },
    include: { members: true },
  });
  if (!champ || !champ.members.length) return { ok: false, error: 'campeão sem atletas pra receber' };

  const share = t.prizeCash / champ.members.length;
  const winners = await prisma.$transaction(async (tx) => {
    const paid = [];
    for (const m of champ.members) {
      const u = await tx.user.update({
        where: { id: m.userId },
        data: { balance: { increment: share } },
      });
      const trx = await tx.transaction.create({
        data: {
          type: 'tournament_prize',
          amount: share,
          description: `Prêmio campeão: ${t.name}`,
          senderId: null,
          receiverId: m.userId,
          balanceAfter: u.balance,
          metadata: JSON.stringify({ tournamentId, entryId: champ.id }),
        },
      });
      paid.push({ userId: m.userId, txId: trx.id });
    }
    await tx.tournament.update({ where: { id: tournamentId }, data: { prizePaidAt: new Date() } });
    return paid;
  });

  try {
    await notifyMany(champ.members.map((m) => m.userId), {
      type: 'result',
      title: '🏆 Prêmio recebido!',
      body: `Você recebeu ${share.toFixed(0)} TenisCash pelo título em ${t.name}.`,
      link: '#/t/' + t.id,
    });
  } catch (_) {}

  return { ok: true, prizeCash: t.prizeCash, perWinner: share, winners };
}

module.exports = { chargeEntry, refundEntry, refundAllEntries, payPrize, isAdmin, PRIZE_CASH_MAX };
