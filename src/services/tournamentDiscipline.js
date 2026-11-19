'use strict';
// =====================================================================
// APEX — Disciplina (suspensão automática) + Histórico de séries
// ---------------------------------------------------------------------
// Suspensão: calculada SEMPRE a partir dos MatchEvent de jogos ENCERRADOS
// (nada de contador manual que desalinha). Regra por categoria
// (TournamentCategory.suspensionRule) — padrão futsal: 3 amarelos = 1 jogo,
// vermelho = 1 jogo, zera ao cumprir. A súmula bloqueia evento/escalação
// de suspenso; só árbitro/coordenador libera, com motivo gravado em
// SuspensionOverride (auditoria).
// Séries: Tournament.seriesSlug liga as edições; campeões saem das FINAIS
// encerradas (ou da tabela final, em pontos corridos/americano/suíço).
// =====================================================================

const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
const F = require('./tournamentFormats');

const MIN_REASON = 5;

async function categorySuspensions(categoryId) {
  const category = await prisma.tournamentCategory.findUnique({ where: { id: categoryId } });
  if (!category) return null;
  const rule = F.normalizeSuspensionRule(category.suspensionRule);
  const matches = await prisma.tournamentMatch.findMany({
    where: { categoryId },
    select: {
      id: true, status: true, stage: true, round: true, ordering: true,
      homeEntryId: true, awayEntryId: true, scheduledAt: true, updatedAt: true,
    },
  });
  const entries = await prisma.tournamentEntry.findMany({
    where: { categoryId },
    select: { id: true, name: true },
  });
  const entryIds = entries.map((e) => e.id);
  const players = entryIds.length
    ? await prisma.rosterPlayer.findMany({
        where: { entryId: { in: entryIds } },
        select: { id: true, name: true, number: true, entryId: true },
      })
    : [];
  const finishedIds = matches
    .filter((m) => (m.status === 'FINISHED' || m.status === 'WALKOVER') && m.homeEntryId && m.awayEntryId)
    .map((m) => m.id);
  const events = finishedIds.length && rule.enabled
    ? await prisma.matchEvent.findMany({
        where: { matchId: { in: finishedIds }, type: { in: ['YELLOW', 'RED'] }, playerId: { not: null } },
        select: { matchId: true, playerId: true, entryId: true, type: true },
      })
    : [];
  const res = F.computeSuspensions({ matches, events, players, rule });
  const team = Object.fromEntries(entries.map((e) => [e.id, e.name]));
  const mById = Object.fromEntries(matches.map((m) => [m.id, m]));
  const decorate = (s) => ({
    ...s,
    categoryId,
    categoryName: category.name,
    team: team[s.entryId] || '',
    reasonText: F.suspensionReasonText(s),
    nextMatch: s.nextMatchId && mById[s.nextMatchId]
      ? {
          id: s.nextMatchId,
          scheduledAt: mById[s.nextMatchId].scheduledAt,
          opponent: team[
            mById[s.nextMatchId].homeEntryId === s.entryId ? mById[s.nextMatchId].awayEntryId : mById[s.nextMatchId].homeEntryId
          ] || null,
        }
      : null,
  });
  return {
    categoryId,
    rule: res.rule,
    suspended: res.suspended.map(decorate),
    hanging: res.hanging.map((h) => ({ ...h, categoryId, categoryName: category.name, team: team[h.entryId] || '' })),
  };
}

async function tournamentSuspensions(tournamentId, categoryId) {
  const cats = await prisma.tournamentCategory.findMany({
    where: categoryId ? { id: categoryId, tournamentId } : { tournamentId },
    select: { id: true },
  });
  const out = { suspended: [], hanging: [], rules: {} };
  for (const c of cats) {
    const r = await categorySuspensions(c.id);
    if (!r) continue;
    out.rules[c.id] = r.rule;
    out.suspended.push(...r.suspended);
    out.hanging.push(...r.hanging);
  }
  return out;
}

// Suspensões que valem PARA ESTE JOGO (por playerId).
async function suspensionsForMatch(matchId) {
  const match = await prisma.tournamentMatch.findUnique({
    where: { id: matchId },
    select: { id: true, categoryId: true, tournamentId: true },
  });
  if (!match) return { match: null, byPlayer: {} };
  const r = await categorySuspensions(match.categoryId);
  const byPlayer = {};
  for (const s of (r && r.suspended) || []) if (s.matchIds.includes(matchId)) byPlayer[s.playerId] = s;
  return { match, byPlayer, rule: r ? r.rule : null };
}

/**
 * Checa um atleta para um jogo. Se suspenso:
 *  - sem override → { ok:false, code:'SUSPENDED', suspension }
 *  - override sem permissão/motivo → { ok:false, code:'OVERRIDE_DENIED'|'REASON_REQUIRED' }
 *  - override válido → grava auditoria e { ok:true, overridden:true }
 * opts: { override, reason, canOverride, userId, action:'EVENT'|'LINEUP', eventType, entryId }
 */
async function guardPlayer(matchId, playerId, opts = {}) {
  const { match, byPlayer } = await suspensionsForMatch(matchId);
  if (!match) return { ok: true };
  const s = byPlayer[playerId];
  if (!s) return { ok: true };
  const msg = `${s.name} está SUSPENSO para este jogo (${s.reasonText}).`;
  if (!opts.override) return { ok: false, code: 'SUSPENDED', error: msg, suspension: s };
  if (!opts.canOverride) {
    return { ok: false, code: 'OVERRIDE_DENIED', error: 'só o árbitro do jogo ou o coordenador libera atleta suspenso', suspension: s };
  }
  const reason = String(opts.reason || '').trim();
  if (reason.length < MIN_REASON) {
    return { ok: false, code: 'REASON_REQUIRED', error: `informe o motivo da liberação (mín. ${MIN_REASON} letras)`, suspension: s };
  }
  await prisma.suspensionOverride.create({
    data: {
      tournamentId: match.tournamentId,
      categoryId: match.categoryId,
      matchId,
      playerId,
      entryId: opts.entryId || s.entryId,
      action: opts.action || 'EVENT',
      eventType: opts.eventType || null,
      reason: reason.slice(0, 500),
      userId: opts.userId || null,
    },
  });
  return { ok: true, overridden: true, suspension: s };
}

async function overridesForMatch(matchId) {
  return prisma.suspensionOverride.findMany({ where: { matchId }, orderBy: { createdAt: 'asc' } });
}

// ---------------------------------------------------------------------
// Histórico de campeões por série
// ---------------------------------------------------------------------

function slugify(s) {
  return String(s || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
}

async function seriesChampions(slug) {
  const key = slugify(slug);
  if (!key) return null;
  // Liga F1: histórico público da série = só torneios PÚBLICOS e não arquivados
  // (não listado/privado/arquivado ficam fora da página da série).
  const tournaments = await prisma.tournament.findMany({
    where: { seriesSlug: key, visibility: 'public', archivedAt: null },
    include: { categories: true },
  });
  if (!tournaments.length) return { series: { slug: key, name: null }, editions: [], titles: [] };
  const editionSort = (t) => (t.startDate ? new Date(t.startDate).getTime() : 0) || Number(String(t.edition || '').replace(/\D/g, '')) || 0;
  tournaments.sort((a, b) => editionSort(b) - editionSort(a) || String(b.edition || '').localeCompare(String(a.edition || '')));

  const titles = {};
  const editions = [];
  for (const t of tournaments) {
    const cats = [];
    for (const c of t.categories) {
      const matches = await prisma.tournamentMatch.findMany({
        where: { categoryId: c.id },
        select: { id: true, stage: true, status: true, round: true, homeEntryId: true, awayEntryId: true, winnerEntryId: true },
      });
      const standings = await prisma.tournamentStanding.findMany({ where: { categoryId: c.id }, select: { entryId: true, rank: true } });
      const cfg = c.formatConfig && typeof c.formatConfig === 'object' ? c.formatConfig : {};
      const champ = F.categoryChampion(matches, standings, { swissRounds: Number(cfg.rounds) || null });
      let champion = null;
      let runnerUp = null;
      if (champ) {
        const ids = [champ.championId, champ.runnerUpId].filter(Boolean);
        const es = await prisma.tournamentEntry.findMany({ where: { id: { in: ids } }, select: { id: true, name: true, logoUrl: true } });
        await require('./clubIdentity').brand(es); // Liga F2: nome/escudo do clube
        const by = Object.fromEntries(es.map((e) => [e.id, e]));
        champion = by[champ.championId] || null;
        runnerUp = champ.runnerUpId ? by[champ.runnerUpId] || null : null;
        if (champion) {
          // clube = um só em várias categorias → títulos somam pelo NOME do clube
          const k = champion.name.trim().toUpperCase();
          titles[k] = titles[k] || { name: champion.name, logoUrl: champion.logoUrl, titles: 0, list: [] };
          titles[k].titles += 1;
          titles[k].list.push({ edition: t.edition || t.name, category: c.name });
          if (!titles[k].logoUrl && champion.logoUrl) titles[k].logoUrl = champion.logoUrl;
        }
      }
      cats.push({ categoryId: c.id, name: c.name, champion, runnerUp, decidedBy: champ ? champ.source : null });
    }
    editions.push({
      tournamentId: t.id,
      slug: t.slug,
      name: t.name,
      edition: t.edition,
      startDate: t.startDate,
      status: t.status,
      categories: cats,
    });
  }
  const seriesName = (tournaments.find((t) => t.seriesName) || {}).seriesName || null;
  return {
    series: { slug: key, name: seriesName },
    editions,
    titles: Object.values(titles).sort((a, b) => b.titles - a.titles || a.name.localeCompare(b.name)),
  };
}

module.exports = {
  categorySuspensions,
  tournamentSuspensions,
  suspensionsForMatch,
  guardPlayer,
  overridesForMatch,
  seriesChampions,
  slugify,
  MIN_REASON,
};
