// =====================================================================
// LIMPEZA ÚNICA — jogo de TESTE "Leões Teste × Tigres Teste" (futsal) que
// ficou no banco de produção e aparecia no ranking Glicko-2 (dono 18/11/2026:
// "Se vira e resolve"). TEMPORÁRIO: roda no boot, é idempotente (depois de
// limpo não acha nada) e este arquivo + a chamada em src/index.js saem no
// PR seguinte (padrão da constituição: criar, usar, remover).
//
// Regras de segurança:
//  - Só pega jogo cujos DOIS times têm exatamente os nomes de teste abaixo.
//  - Torneio em que TODOS os times são de teste → apaga o torneio inteiro
//    (cascata do Prisma leva categorias/inscrições/jogos/classificação;
//    RosterPlayer e MatchEvent não têm FK e são apagados antes, na mão).
//  - Torneio real com esses times misturados → apaga só os jogos de teste e
//    os dois times (se não tiverem outro jogo), nunca mexe nos times reais.
//  - Depois recalcula o ranking do esporte, que tira os times do ranking.
// =====================================================================

const TEST_NAMES = new Set(['leoes teste', 'tigres teste']);

function norm(s) {
  return String(s || '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase().replace(/\s+/g, ' ').trim();
}
const isTestName = (s) => TEST_NAMES.has(norm(s));
const looksTest = (s) => /\bteste?s?\b/.test(norm(s));

async function limparTimesTeste(prisma) {
  const out = { ok: true, torneiosApagados: [], jogosApagados: 0, timesApagados: 0, esportes: [] };
  const jogos = await prisma.tournamentMatch.findMany({
    where: {
      homeEntryId: { not: null },
      awayEntryId: { not: null },
      OR: [
        { homeEntry: { name: { contains: 'Teste', mode: 'insensitive' } } },
        { awayEntry: { name: { contains: 'Teste', mode: 'insensitive' } } },
      ],
    },
    select: {
      id: true, tournamentId: true,
      tournament: { select: { name: true, slug: true, sport: true } },
      homeEntry: { select: { id: true, name: true } },
      awayEntry: { select: { id: true, name: true } },
    },
  });
  const alvo = jogos.filter((m) => isTestName(m.homeEntry && m.homeEntry.name) && isTestName(m.awayEntry && m.awayEntry.name));
  if (!alvo.length) { out.nada = true; return out; }

  const porTorneio = new Map();
  for (const m of alvo) {
    if (!porTorneio.has(m.tournamentId)) porTorneio.set(m.tournamentId, { t: m.tournament, jogos: [] });
    porTorneio.get(m.tournamentId).jogos.push(m);
  }

  for (const [tid, { t, jogos: js }] of porTorneio) {
    if (t && t.sport && !out.esportes.includes(t.sport)) out.esportes.push(t.sport);
    const entries = await prisma.tournamentEntry.findMany({ where: { tournamentId: tid }, select: { id: true, name: true } });
    const todosTeste = entries.length > 0 && entries.every((e) => looksTest(e.name));
    if (todosTeste) {
      const matchIds = (await prisma.tournamentMatch.findMany({ where: { tournamentId: tid }, select: { id: true } })).map((x) => x.id);
      const entryIds = entries.map((e) => e.id);
      await prisma.$transaction(async (tx) => {
        if (matchIds.length) await tx.matchEvent.deleteMany({ where: { matchId: { in: matchIds } } });
        if (entryIds.length) await tx.rosterPlayer.deleteMany({ where: { entryId: { in: entryIds } } });
        // ponteiros de chave entre jogos do próprio torneio não travam a cascata
        await tx.tournamentMatch.updateMany({ where: { tournamentId: tid }, data: { nextMatchId: null, loserNextMatchId: null } });
        await tx.tournament.delete({ where: { id: tid } });
      });
      out.torneiosApagados.push({ id: tid, nome: t && t.name, slug: t && t.slug, times: entries.map((e) => e.name), jogos: matchIds.length });
      out.jogosApagados += matchIds.length;
      out.timesApagados += entryIds.length;
      continue;
    }
    // torneio real: só os jogos de teste e os dois times de teste
    const ids = js.map((m) => m.id);
    const testEntryIds = [...new Set(js.flatMap((m) => [m.homeEntry.id, m.awayEntry.id]))];
    await prisma.$transaction(async (tx) => {
      await tx.matchEvent.deleteMany({ where: { matchId: { in: ids } } });
      await tx.tournamentMatch.updateMany({ where: { OR: [{ nextMatchId: { in: ids } }, { loserNextMatchId: { in: ids } }] }, data: { nextMatchId: null, loserNextMatchId: null } });
      await tx.tournamentMatch.deleteMany({ where: { id: { in: ids } } });
      for (const eid of testEntryIds) {
        const resta = await tx.tournamentMatch.count({ where: { OR: [{ homeEntryId: eid }, { awayEntryId: eid }, { winnerEntryId: eid }] } });
        if (resta) continue;
        await tx.rosterPlayer.deleteMany({ where: { entryId: eid } });
        await tx.tournamentEntry.delete({ where: { id: eid } });
        out.timesApagados += 1;
      }
    });
    out.jogosApagados += ids.length;
  }

  const rating = require('./clubRating');
  for (const sp of out.esportes) {
    try { out['recalculo_' + sp] = await rating.recomputeSport(sp); } catch (e) { out['recalculo_' + sp] = { erro: e.message }; }
  }
  return out;
}

async function rodarNoBoot(prisma) {
  try {
    const r = await limparTimesTeste(prisma);
    if (!r.nada) console.log('[limpa-teste] ' + JSON.stringify(r).slice(0, 2000));
    return r;
  } catch (e) {
    console.error('[limpa-teste] falhou (nada foi apagado fora da transação):', e.message);
    return { ok: false, erro: e.message };
  }
}

module.exports = { limparTimesTeste, rodarNoBoot, _norm: norm };
