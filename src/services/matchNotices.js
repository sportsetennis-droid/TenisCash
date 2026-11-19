// =====================================================================
// Liga Aberta F4 — AVISO DE FIM DE JOGO + convite de quem jogou sem conta
// ---------------------------------------------------------------------
// 1) schedule(matchId): chamado DEPOIS de fechar a súmula (finalize) ou lançar o
//    placar (/result). Roda assíncrono (setImmediate) e best-effort: nunca atrasa
//    nem derruba a resposta; erro só no log. Para cada jogador COM conta dos dois
//    times (EntryMember + RosterPlayer.userId) grava o aviso no app (sininho) e o
//    push segue a preferência dele (notify → clubPush). WhatsApp: só se ele LIGOU o
//    tipo "Resultado publicado" (notify.js, Liga F4) — padrão desligado.
//    Texto: o placar + o que mudou no histórico dele (gols/pontos, assistências e
//    cartões naquele jogo + total na temporada, ano de America/Fortaleza).
//    IDEMPOTENTE: chave ClubPushLog "mres:<matchId>:<versão>:<assinatura>" (assinatura =
//    placar, vencedor, pênaltis e os lances por jogador). Fechar de novo igual à última
//    versão = nada; corrigir (placar ou autor de gol mudou, inclusive voltar ao anterior)
//    = aviso de CORREÇÃO, uma vez por versão.
//    Fora: torneio arquivado, racha (PICKUP) e a LISTA DE EXCLUSÃO da F2
//    (clubIdentity.EXCLUDED_SLUGS — o Futsal Master Cup segue exatamente como era).
// 2) unclaimed(matchId, {create}): elenco SEM conta dos dois times + convite por vaga
//    (rosterInvite.sheetInvite: recupera o link já gerado ou gera um novo) com o texto
//    pronto e o link wa.me. Quem MANDA é o organizador/árbitro, pelo próprio WhatsApp:
//    o sistema não envia nada para quem não pediu.
// Desligar os avisos: env LIGA_MATCH_NOTICES=0.
// =====================================================================

const crypto = require('crypto');
const { prisma } = require('../middleware');
const gameRules = require('./tournamentRules');

const DONE = ['FINISHED', 'WALKOVER'];
const PLAYER_TYPES = ['ASSIST', 'YELLOW', 'RED', ...gameRules.PLAYER_POINT_TYPES];
const ASSIST_UNIT = { one: 'assistência', many: 'assistências' };

const pending = new Set();
function track(p) { pending.add(p); p.finally(() => pending.delete(p)).catch(() => {}); return p; }
async function flush() { while (pending.size) await Promise.allSettled([...pending]); }
function enabled() { return process.env.LIGA_MATCH_NOTICES !== '0'; }

// Fire-and-forget: devolve a promessa (testes esperam com flush()). Nunca lança.
function schedule(matchId, opts = {}) {
  if (!enabled() || !matchId) return null;
  // LIGA_MATCH_NOTICES_DELAY_MS: só para teste (prova que a resposta do fechamento não espera o aviso)
  const delay = Math.min(Number(process.env.LIGA_MATCH_NOTICES_DELAY_MS) || 0, 10000);
  const p = new Promise((r) => (delay > 0 ? setTimeout(r, delay) : setImmediate(r)))
    .then(() => run(String(matchId), opts))
    .catch((e) => { console.error('[matchNotices] aviso de fim de jogo falhou:', e.message); return { error: e.message }; });
  return track(p);
}

async function loadMatch(matchId) {
  return prisma.tournamentMatch.findUnique({
    where: { id: String(matchId) },
    select: {
      id: true, tournamentId: true, categoryId: true, stage: true, status: true,
      homeScore: true, awayScore: true, winnerEntryId: true, homePenalties: true, awayPenalties: true, decidedByPenalties: true,
      scheduledAt: true, updatedAt: true, homeEntryId: true, awayEntryId: true,
      homeEntry: { select: { id: true, name: true } },
      awayEntry: { select: { id: true, name: true } },
      category: { select: { name: true, gameRules: true } },
      tournament: { select: { id: true, slug: true, name: true, sport: true, archivedAt: true, suspendedAt: true } },
    },
  });
}

async function teamNames(m) {
  const list = [m.homeEntry, m.awayEntry].filter(Boolean).map((e) => ({ ...e }));
  await require('./clubIdentity').brand(list);
  const byId = Object.fromEntries(list.map((e) => [e.id, e.name]));
  return { home: byId[m.homeEntryId] || 'Casa', away: byId[m.awayEntryId] || 'Visitante' };
}

function matchLine(m, names) {
  const pen = m.decidedByPenalties && m.homePenalties != null ? ` (pên. ${m.homePenalties}×${m.awayPenalties})` : '';
  const wo = m.status === 'WALKOVER' ? ' (W.O.)' : '';
  return `${names.home} ${m.homeScore == null ? '-' : m.homeScore} × ${m.awayScore == null ? '-' : m.awayScore} ${names.away}${pen}${wo}`;
}

// Quem recebe: conta da inscrição (EntryMember) + nome do elenco ligado à conta.
async function audience(m) {
  const out = new Map(); // userId -> { rosterIds:Set }
  const get = (uid) => { if (!out.has(uid)) out.set(uid, { rosterIds: new Set() }); return out.get(uid); };
  const entryIds = [m.homeEntryId, m.awayEntryId].filter(Boolean);
  if (!entryIds.length) return out;
  const [members, roster] = await Promise.all([
    prisma.entryMember.findMany({ where: { entryId: { in: entryIds } }, select: { userId: true } }),
    prisma.rosterPlayer.findMany({ where: { entryId: { in: entryIds }, userId: { not: null } }, select: { id: true, userId: true } }),
  ]);
  members.forEach((x) => { if (x.userId) get(x.userId); });
  roster.forEach((r) => get(r.userId).rosterIds.add(r.id));
  return out;
}

function signature(m, events) {
  const raw = JSON.stringify([m.status, m.homeScore, m.awayScore, m.winnerEntryId, m.homePenalties, m.awayPenalties,
    events.map((e) => e.playerId + ':' + e.type).sort()]);
  return crypto.createHash('sha1').update(raw).digest('hex').slice(0, 20);
}

function personalLine(evs, unit) {
  let pts = 0; let ast = 0; let y = 0; let r = 0;
  for (const e of evs) {
    if (gameRules.PLAYER_POINT_VALUES[e.type]) pts += gameRules.PLAYER_POINT_VALUES[e.type];
    else if (e.type === 'ASSIST') ast += 1;
    else if (e.type === 'YELLOW') y += 1;
    else if (e.type === 'RED') r += 1;
  }
  const parts = [];
  if (pts) parts.push(gameRules.plural(pts, unit));
  if (ast) parts.push(gameRules.plural(ast, ASSIST_UNIT));
  if (y) parts.push(y === 1 ? '1 amarelo' : y + ' amarelos');
  if (r) parts.push(r === 1 ? '1 vermelho' : r + ' vermelhos');
  return { parts, pts, ast, y, r };
}

async function seasonLine(userId, season, unit) {
  try {
    const h = await require('./athleteHistory').history(userId, { viewer: { userId } });
    const s = (h.bySeason || []).find((x) => x.season === season);
    if (!s) return null;
    const parts = [s.games === 1 ? '1 jogo' : s.games + ' jogos'];
    if (s.goals) parts.push(gameRules.plural(s.goals, unit));
    if (s.assists) parts.push(gameRules.plural(s.assists, ASSIST_UNIT));
    if (s.yellow || s.red) parts.push(`${s.yellow || 0} amarelo(s), ${s.red || 0} vermelho(s)`);
    if (s.titles) parts.push(s.titles === 1 ? '1 título' : s.titles + ' títulos');
    return { text: `Temporada ${season}: ${parts.join(', ')}.`, season: s };
  } catch (e) {
    console.error('[matchNotices] histórico', e.message);
    return null;
  }
}

async function run(matchId, opts = {}) {
  const m = await loadMatch(matchId);
  if (!m) return { skipped: 'jogo não existe' };
  if (!DONE.includes(m.status)) return { skipped: 'jogo não encerrado' };
  if (!m.tournament || m.tournament.archivedAt) return { skipped: 'torneio arquivado' };
  if (m.tournament.suspendedAt) return { skipped: 'torneio suspenso' }; // F6
  if (require('./clubIdentity').isExcludedSlug(m.tournament.slug)) return { skipped: 'lista de exclusão (torneio real em andamento)' };
  if (m.stage === 'PICKUP') return { skipped: 'racha' };

  const events = await prisma.matchEvent.findMany({ where: { matchId: m.id, type: { in: PLAYER_TYPES }, playerId: { not: null } }, select: { playerId: true, type: true } });
  const sig = signature(m, events);
  // versão do aviso: "mres:<matchId>:<versão>:<assinatura>". Igual à ÚLTIMA versão avisada =
  // nada; diferente (inclusive voltar a um placar anterior) = nova versão (aviso de correção).
  // Duas execuções ao mesmo tempo calculam a mesma versão → a chave única deixa só uma passar.
  const prefix = 'mres:' + m.id + ':';
  const logs = await prisma.clubPushLog.findMany({ where: { key: { startsWith: prefix } }, select: { key: true } });
  const parsed = logs.map((l) => { const p = l.key.split(':'); return { v: Number(p[2]) || 0, sig: p[3] }; }).sort((a, b) => b.v - a.v);
  if (parsed.length && parsed[0].sig === sig) return { skipped: 'já avisado', duplicate: true, sig };
  const version = (parsed.length ? parsed[0].v : 0) + 1;
  try {
    // trava por VERSÃO (sem assinatura): duas execuções simultâneas com placares diferentes
    // não geram dois avisos da mesma versão — a que perder roda de novo no próximo fechamento
    await prisma.clubPushLog.create({ data: { key: 'mresv:' + m.id + ':' + version } });
    await prisma.clubPushLog.create({ data: { key: prefix + version + ':' + sig } });
  } catch (_) {
    return { skipped: 'já avisado', duplicate: true, sig };
  }
  const correction = version > 1;

  const names = await teamNames(m);
  const line = matchLine(m, names);
  const rules = gameRules.resolveRules(m.category, m.tournament.sport);
  const unit = gameRules.scoreUnit(rules);
  const personalUnit = unit.short === 'SETS' ? { one: 'gol', many: 'gols' } : unit; // set é do time
  const season = require('./athleteHistory').seasonOf(m.scheduledAt || m.updatedAt);
  const where = [m.tournament.name, m.category && m.category.name].filter(Boolean).join(' · ');
  const link = '/t/' + m.tournament.slug + '?jogo=' + m.id;
  const { notify } = require('./notify');

  const aud = await audience(m);
  let notified = 0;
  // placar manual (/result): quem lançou não recebe (como o aviso antigo)
  const skipUser = opts.source === 'result' ? opts.byUserId : null;
  for (const [uid, info] of aud) {
    if (skipUser && uid === skipUser) continue;
    try {
      const mine = events.filter((e) => info.rosterIds.has(e.playerId));
      const p = personalLine(mine, personalUnit);
      const bits = [where + '.'];
      if (p.parts.length) bits.push(`Você neste jogo: ${p.parts.join(', ')}.`);
      else if (info.rosterIds.size && unit.short !== 'SETS') bits.push(`Você não marcou ${unit.short === 'PTS' ? 'pontos' : 'gol'} neste jogo.`);
      const sl = season ? await seasonLine(uid, season, personalUnit) : null;
      if (sl) bits.push(sl.text);
      if (correction) bits.push('A organização corrigiu a súmula; seu histórico já está atualizado.');
      const n = await notify(uid, {
        type: 'result',
        title: (correction ? 'Resultado corrigido: ' : 'Fim de jogo: ') + line,
        body: bits.join(' '),
        link,
      });
      if (n) notified += 1;
    } catch (e) {
      console.error('[matchNotices] aviso', uid, e.message);
    }
  }
  return { notified, correction, sig, audience: aud.size, by: opts.byUserId || null };
}

// ---------------------------------------------------------------- sem conta
// Elenco sem conta dos dois times (+ convite recuperado ou, com create, gerado).
// inviteEntryIds: times em que quem pede pode gerar/ver o LINK (can SET_LINEUP); nos outros
// só o nome aparece. Torneio da lista de exclusão (Master Cup): nada (excluded:true).
async function unclaimed(matchId, { create = false, actorUserId = null, inviteEntryIds = [] } = {}) {
  const m = await loadMatch(matchId);
  if (!m) return null;
  if (m.tournament && require('./clubIdentity').isExcludedSlug(m.tournament.slug)) {
    return { match: { id: m.id, status: m.status, closed: DONE.includes(m.status), tournamentId: m.tournamentId }, excluded: true, players: [], created: 0, pendingInvites: 0, canInvite: false };
  }
  const canFor = new Set(inviteEntryIds || []);
  const closed = DONE.includes(m.status);
  const names = await teamNames(m);
  const line = closed ? matchLine(m, names) : `${names.home} × ${names.away}`;
  const entryIds = [m.homeEntryId, m.awayEntryId].filter(Boolean);
  const roster = entryIds.length
    ? await prisma.rosterPlayer.findMany({ where: { entryId: { in: entryIds }, userId: null, minorProfileId: null }, select: { id: true, name: true, number: true, role: true, entryId: true }, orderBy: [{ entryId: 'asc' }, { number: 'asc' }, { name: 'asc' }] })
    : [];
  const ri = require('./rosterInvite');
  const players = [];
  let created = 0;
  for (const p of roster) {
    const teamName = p.entryId === m.homeEntryId ? names.home : names.away;
    let invite = null;
    const canInvite = canFor.has(p.entryId);
    if (closed && canInvite) {
      invite = await ri.sheetInvite({ playerId: p.id, actorUserId, create, context: { teamName, tournamentName: m.tournament ? m.tournament.name : '', matchLine: line, matchId: m.id } });
      if (invite && invite.created) created += 1;
    }
    players.push({ playerId: p.id, name: p.name, number: p.number, role: p.role || 'PLAYER', entryId: p.entryId, team: teamName, invite, canInvite });
  }
  return {
    match: { id: m.id, status: m.status, closed, line, tournamentId: m.tournamentId },
    players, created, canInvite: canFor.size > 0, pendingInvites: players.filter((p) => p.canInvite && !p.invite).length,
  };
}

module.exports = { schedule, run, flush, unclaimed, signature, enabled };
