// =====================================================================
// AUTOTESTE da súmula em PRODUÇÃO (temporário, sem token).
// ---------------------------------------------------------------------
// Monta um torneio-teste DESCARTÁVEL (mata-mata SEMI→FINAL), joga um
// empate, fecha nos PÊNALTIS e confere: placar não vira gol, vencedor por
// pênaltis, gravação de pênaltis+árbitro, e o vencedor SUBINDO na chave.
// Apaga TUDO no fim (inclusive RosterPlayer/MatchEvent, que não têm FK de
// cascade). Read-only no efeito final: não deixa nada no banco.
// Guarda ?g= numa rota fora de /api/admin. REMOVER após validar.
// =====================================================================

const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
const sheet = require('./matchSheet');

async function runSelfTest() {
  const suffix = Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
  const checks = [];
  const add = (name, ok) => checks.push({ name, ok: !!ok });

  let owner, t, A, B, semi, fin, pa, pb;
  try {
    owner = await prisma.user.create({ data: { name: 'selftest', phone: 'stx' + suffix, pin: 'x' } });
    t = await prisma.tournament.create({ data: { name: 'SELFTEST ' + suffix, slug: 'selftest-' + suffix, ownerId: owner.id, sport: 'FUTSAL', format: 'KNOCKOUT', visibility: 'private' } });
    const c = await prisma.tournamentCategory.create({ data: { tournamentId: t.id, name: 'T' } });
    A = await prisma.tournamentEntry.create({ data: { tournamentId: t.id, categoryId: c.id, name: 'Time A' } });
    B = await prisma.tournamentEntry.create({ data: { tournamentId: t.id, categoryId: c.id, name: 'Time B' } });
    // FINAL vazia + SEMI que alimenta a FINAL no slot "home"
    fin = await prisma.tournamentMatch.create({ data: { tournamentId: t.id, categoryId: c.id, stage: 'FINAL', ordering: 0 } });
    semi = await prisma.tournamentMatch.create({ data: { tournamentId: t.id, categoryId: c.id, stage: 'SEMI', ordering: 0, homeEntryId: A.id, awayEntryId: B.id, nextMatchId: fin.id, nextSlot: 'home', status: 'SCHEDULED' } });
    pa = await prisma.rosterPlayer.create({ data: { entryId: A.id, name: 'Craque A', number: 9 } });
    pb = await prisma.rosterPlayer.create({ data: { entryId: B.id, name: 'Craque B', number: 10 } });

    // 1x1 no tempo normal
    const g1 = await sheet.addEvent(semi.id, { entryId: A.id, type: 'GOAL', playerId: pa.id, minute: 5 });
    const g2 = await sheet.addEvent(semi.id, { entryId: B.id, type: 'GOAL', playerId: pb.id, minute: 12 });
    add('gols lançados (exigem jogador)', g1.ok && g2.ok);

    // fecha nos pênaltis 4x3 pra A
    const r = await sheet.finalizeMatch(semi.id, { homePenalties: 4, awayPenalties: 3, referee1: 'Juiz Selftest', referee2: 'Aux Selftest', scorer: 'Mesa Selftest' });
    const semiAfter = await prisma.tournamentMatch.findUnique({ where: { id: semi.id } });
    const finAfter = await prisma.tournamentMatch.findUnique({ where: { id: fin.id } });

    add('finalize ok', r.ok === true);
    add('placar segue 1x1 (pênalti não vira gol)', r.homeScore === 1 && r.awayScore === 1);
    add('vencedor = Time A (mais pênaltis)', r.winnerEntryId === A.id);
    add('decidedByPenalties = true', r.decidedByPenalties === true);
    add('gravou pênaltis 4x3', semiAfter && semiAfter.homePenalties === 4 && semiAfter.awayPenalties === 3);
    add('gravou arbitragem (árbitro1/2/mesa)', semiAfter && semiAfter.referee1 === 'Juiz Selftest' && semiAfter.referee2 === 'Aux Selftest' && semiAfter.scorer === 'Mesa Selftest');
    add('partida ficou FINISHED', semiAfter && semiAfter.status === 'FINISHED');
    add('vencedor SUBIU na chave (FINAL.home = Time A)', finAfter && finAfter.homeEntryId === A.id);
  } catch (e) {
    add('exceção: ' + e.message, false);
  } finally {
    // Limpeza total — RosterPlayer/MatchEvent não têm FK cascade, apaga na mão.
    try {
      const mids = [semi && semi.id, fin && fin.id].filter(Boolean);
      const eids = [A && A.id, B && B.id].filter(Boolean);
      if (mids.length) await prisma.matchEvent.deleteMany({ where: { matchId: { in: mids } } }).catch(() => {});
      if (eids.length) await prisma.rosterPlayer.deleteMany({ where: { entryId: { in: eids } } }).catch(() => {});
      if (t) await prisma.tournament.delete({ where: { id: t.id } }).catch(() => {});
      if (owner) await prisma.user.delete({ where: { id: owner.id } }).catch(() => {});
    } catch (e) { /* ignora falha de limpeza */ }
  }

  const pass = checks.filter((c) => c.ok).length;
  return { ok: pass === checks.length && checks.length > 0, pass, total: checks.length, checks, cleaned: true };
}

module.exports = { runSelfTest };
