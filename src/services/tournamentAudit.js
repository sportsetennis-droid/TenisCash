// =====================================================================
// Liga Aberta F1 — AUDITORIA do torneio (TournamentAudit)
// ---------------------------------------------------------------------
// Quem, quando, o quê, valor anterior e novo. Grava em:
//   result.set / result.correct   resultado lançado / corrigido (jogo já encerrado)
//   sheet.finalize / sheet.correct súmula fechada / reaberta e corrigida
//   bracket.generate / bracket.knockout  geração da chave (com nº de jogos apagados)
//   role.add / role.remove / official.add / official.remove  papéis
//   tournament.archive / tournament.restore / tournament.transfer
//   tournament.visibility          mudança de visibilidade
// Não substitui TournamentRegistrationAudit (inscrição paga), que segue igual.
// Gravar auditoria NUNCA derruba a operação principal (loga e segue).
// =====================================================================

const { prisma } = require('../middleware');

// JSON seguro para a coluna jsonb (Date vira ISO; undefined some).
function clean(v) {
  if (v === undefined) return null;
  try { return JSON.parse(JSON.stringify(v)); } catch (_) { return null; }
}

async function record({ tournamentId, userId = null, action, entity = null, entityId = null, before = null, after = null }) {
  if (!tournamentId || !action) return null;
  try {
    return await prisma.tournamentAudit.create({
      data: {
        tournamentId: String(tournamentId),
        userId: userId ? String(userId) : null,
        action: String(action).slice(0, 60),
        entity: entity ? String(entity).slice(0, 40) : null,
        entityId: entityId ? String(entityId) : null,
        before: clean(before),
        after: clean(after),
      },
    });
  } catch (e) {
    console.error('[tournamentAudit] falhou ao gravar', action, e.message);
    return null;
  }
}

// Lista paginada (mais novo primeiro). cursor = id do último item da página anterior.
async function list(tournamentId, { limit = 50, cursor = null, action = null } = {}) {
  const take = Math.max(1, Math.min(Number(limit) || 50, 100));
  const where = { tournamentId: String(tournamentId) };
  if (action) where.action = String(action);
  const q = { where, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: take + 1 };
  if (cursor) { q.cursor = { id: String(cursor) }; q.skip = 1; }
  const rows = await prisma.tournamentAudit.findMany(q);
  const hasMore = rows.length > take;
  const items = hasMore ? rows.slice(0, take) : rows;
  const targetOf = (r) => (r.after && (r.after.userId || r.after.ownerId)) || (r.before && r.before.userId) || null;
  const userIds = [...new Set(items.map((r) => r.userId).concat(items.map(targetOf)).filter(Boolean))];
  const users = userIds.length ? await prisma.user.findMany({ where: { id: { in: userIds } }, select: { id: true, name: true, username: true } }) : [];
  const uById = Object.fromEntries(users.map((u) => [u.id, u]));
  return {
    items: items.map((r) => {
      const tg = targetOf(r);
      return { ...r, user: r.userId ? (uById[r.userId] || { id: r.userId }) : null, target: tg ? (uById[tg] || { id: tg }) : null };
    }),
    nextCursor: hasMore ? items[items.length - 1].id : null,
  };
}

// Foto do placar de um jogo (antes/depois do resultado).
function matchSnap(m) {
  if (!m) return null;
  return {
    status: m.status, homeScore: m.homeScore, awayScore: m.awayScore, winnerEntryId: m.winnerEntryId,
    homePenalties: m.homePenalties ?? null, awayPenalties: m.awayPenalties ?? null,
  };
}

module.exports = { record, list, matchSnap };
