// =====================================================================
// Liga Aberta F3 — DUPLICAR TORNEIO para a próxima temporada
// ---------------------------------------------------------------------
// POST /api/tournaments/:id/duplicate (can MANAGE_TOURNAMENT). Copia:
//   categorias + regras (pontos, desempate, ida/volta, suspensão, formato,
//   regras do jogo), inscrições com os MESMOS clubes (clubId), elencos
//   (RosterPlayer com userId), papéis (coordenação, arbitragem, admin/treinador
//   de cada time), vínculos ATIVOS de time e, no racha, os jogadores.
// NÃO copia: jogos, resultados, classificação, eventos, semente de sorteio,
// datas, dinheiro (nasce sem TenisCash). Nasce em RASCUNHO, nova edição da
// mesma série (seriesSlug, edition + 1). O torneio de origem não muda.
// =====================================================================

const { prisma } = require('../middleware');
const audit = require('./tournamentAudit');
const discipline = require('./tournamentDiscipline');
const { uniqueSlug } = require('./quickTournament');

const ROMAN = ['I', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII', 'IX', 'X', 'XI', 'XII', 'XIII', 'XIV', 'XV', 'XVI', 'XVII', 'XVIII', 'XIX', 'XX'];
const escRe = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Próxima edição + nome: "2026"→"2027" (e o ano no nome), "II"→"III", "3"→"4",
// sem edição: ano no nome sobe 1; senão "2".
function nextEdition(name, edition) {
  const ed = edition == null ? '' : String(edition).trim();
  const nm = String(name || '');
  if (/^\d+$/.test(ed)) {
    const next = String(Number(ed) + 1);
    const re = new RegExp('\\b' + escRe(ed) + '\\b');
    return { edition: next, name: re.test(nm) ? nm.replace(re, next) : nm };
  }
  const ri = ROMAN.indexOf(ed.toUpperCase());
  if (ri >= 0 && ri < ROMAN.length - 1) {
    const next = ROMAN[ri + 1];
    const re = new RegExp('\\b' + escRe(ROMAN[ri]) + '\\b');
    return { edition: next, name: re.test(nm) ? nm.replace(re, next) : nm };
  }
  if (!ed) {
    const y = nm.match(/\b(20\d{2})\b/);
    if (y) { const next = String(Number(y[1]) + 1); return { edition: next, name: nm.replace(y[1], next) }; }
    return { edition: '2', name: nm };
  }
  return { edition: ed + ' (nova)', name: nm };
}

async function duplicateTournament(sourceId, { userId, body = {} }) {
  const src = await prisma.tournament.findUnique({ where: { id: String(sourceId) } });
  if (!src || src.archivedAt) return null;
  const ne = nextEdition(src.name, src.edition);
  const name = String(body.name || '').trim().slice(0, 120) || ne.name;
  const seriesName = src.seriesName || src.name;
  const seriesSlug = src.seriesSlug || discipline.slugify(seriesName.replace(/\b(20\d{2})\b/g, '').trim()) || null;

  const out = await prisma.$transaction(async (tx) => {
    const t = await tx.tournament.create({
      data: {
        slug: await uniqueSlug(tx, name + (name === src.name ? ' ' + ne.edition : '')),
        name,
        sport: src.sport,
        format: src.format,
        isDoubles: src.isDoubles,
        status: 'DRAFT',
        ownerId: src.ownerId,
        storeId: src.storeId,
        description: src.description,
        rules: src.rules,
        bannerUrl: src.bannerUrl,
        city: src.city,
        state: src.state,
        maxEntries: src.maxEntries,
        prizeDescription: src.prizeDescription,
        cashEnabled: false, entryFeeCash: 0, prizeCash: 0, // dinheiro nunca é copiado
        seriesSlug, seriesName, edition: ne.edition,
        visibility: src.visibility || 'public',
        requireRefereeAssignment: !!src.requireRefereeAssignment,
      },
    });
    const cats = await tx.tournamentCategory.findMany({ where: { tournamentId: src.id }, orderBy: { id: 'asc' } });
    const catMap = {};
    for (const c of cats) {
      const nc = await tx.tournamentCategory.create({
        data: {
          tournamentId: t.id, name: c.name, gender: c.gender, levelLabel: c.levelLabel, format: c.format,
          pointsWin: c.pointsWin, pointsDraw: c.pointsDraw, pointsLoss: c.pointsLoss,
          tiebreakers: c.tiebreakers ?? undefined, doubleRound: c.doubleRound,
          suspensionRule: c.suspensionRule ?? undefined, formatConfig: c.formatConfig ?? undefined,
          gameRules: c.gameRules ?? undefined,
        },
      });
      catMap[c.id] = nc.id;
    }
    // Racha: as inscrições são os times sorteados de cada dia — não copia; copia os jogadores.
    const entryMap = {};
    let rosters = 0;
    if (src.format !== 'PICKUP') {
      const entries = await tx.tournamentEntry.findMany({ where: { tournamentId: src.id, status: 'CONFIRMED' }, include: { members: true }, orderBy: [{ seed: 'asc' }, { createdAt: 'asc' }] });
      for (const e of entries) {
        if (!catMap[e.categoryId]) continue;
        const ne2 = await tx.tournamentEntry.create({
          data: {
            tournamentId: t.id, categoryId: catMap[e.categoryId], name: e.name, seed: e.seed, logoUrl: e.logoUrl,
            status: 'CONFIRMED', clubId: e.clubId || null,
            members: e.members.length ? { create: e.members.map((m) => ({ userId: m.userId })) } : undefined,
          },
        });
        entryMap[e.id] = ne2.id;
      }
      const roster = await tx.rosterPlayer.findMany({ where: { entryId: { in: Object.keys(entryMap) } }, orderBy: { createdAt: 'asc' } });
      for (const r of roster) {
        await tx.rosterPlayer.create({ data: { entryId: entryMap[r.entryId], name: r.name, number: r.number, isGoalkeeper: r.isGoalkeeper, isCaptain: r.isCaptain, role: r.role, started: false, userId: r.userId || null } });
        rosters++;
      }
    }
    // Papéis (coordenação, arbitragem, fundador nomeado; de time só se o time foi copiado).
    const rolesSrc = await tx.tournamentRole.findMany({ where: { tournamentId: src.id } });
    let rolesCopied = 0;
    for (const r of rolesSrc) {
      if (r.entryId && !entryMap[r.entryId]) continue;
      await tx.tournamentRole.create({ data: { tournamentId: t.id, userId: r.userId, role: r.role, entryId: r.entryId ? entryMap[r.entryId] : null } });
      rolesCopied++;
    }
    // Vínculos ATIVOS de time (mesmo nome de clube).
    const names = new Set(Object.keys(entryMap).length ? (await tx.tournamentEntry.findMany({ where: { id: { in: Object.values(entryMap) } }, select: { name: true } })).map((e) => e.name) : []);
    const tms = names.size ? await tx.teamMembership.findMany({ where: { tournamentId: src.id, status: 'ACTIVE', clubName: { in: [...names] } } }) : [];
    for (const m of tms) {
      await tx.teamMembership.create({ data: { tournamentId: t.id, clubName: m.clubName, userId: m.userId, status: 'ACTIVE', initiatedBy: m.initiatedBy, invitedByUserId: m.invitedByUserId, respondedAt: new Date() } });
    }
    let pickupPlayers = 0;
    if (src.format === 'PICKUP') {
      const ps = await tx.pickupPlayer.findMany({ where: { tournamentId: src.id, active: true } });
      for (const p of ps) { await tx.pickupPlayer.create({ data: { tournamentId: t.id, userId: p.userId, name: p.name, level: p.level } }); pickupPlayers++; }
    }
    // Quem duplicou e não é dono nem tem papel de liderança herdado continua gerindo a nova edição.
    if (userId && userId !== src.ownerId) {
      const lead = await tx.tournamentRole.findFirst({ where: { tournamentId: t.id, userId, role: { in: ['FOUNDER', 'COORDINATOR'] } }, select: { id: true } });
      if (!lead) { await tx.tournamentRole.create({ data: { tournamentId: t.id, userId, role: 'COORDINATOR', entryId: null } }); rolesCopied++; }
    }
    return { t, categories: cats.length, entries: Object.keys(entryMap).length, rosters, roles: rolesCopied, memberships: tms.length, pickupPlayers };
  }, { timeout: 60000, maxWait: 10000 });

  const summary = { sourceId: src.id, categories: out.categories, entries: out.entries, rosters: out.rosters, roles: out.roles, memberships: out.memberships, pickupPlayers: out.pickupPlayers, edition: out.t.edition };
  await audit.record({ tournamentId: out.t.id, userId, action: 'tournament.duplicate', entity: 'Tournament', entityId: out.t.id, after: summary });
  await audit.record({ tournamentId: src.id, userId, action: 'tournament.duplicated', entity: 'Tournament', entityId: src.id, after: { newTournamentId: out.t.id, edition: out.t.edition } });
  return { ok: true, tournament: { id: out.t.id, slug: out.t.slug, name: out.t.name, edition: out.t.edition, seriesSlug: out.t.seriesSlug, status: out.t.status }, ...summary };
}

module.exports = { duplicateTournament, nextEdition };
