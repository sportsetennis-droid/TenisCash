// =====================================================================
// APEX COMPETIÇÃO — Rotas de torneios, partidas, ranking e desafios
// ---------------------------------------------------------------------
// Camada de competição do app esportivo (estilo CopaFácil + Playtomic),
// nativa no TenisCash. Mesmo User/identidade da loja. Premiação/inscrição
// em TenisCash real = fase 2 (gated). Aqui: gestão de torneio, chave,
// resultado, classificação, card do atleta (rating) e desafios 1v1.
// =====================================================================

const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { prisma, authMiddleware, JWT_SECRET } = require('../middleware');
const { instagramAvatar, fetchInstagramProfile, igConfigured } = require('../services/instagramPhoto');
const engine = require('../services/tournamentEngine');
const { notify, notifyMany } = require('../services/notify');
const cash = require('../services/tournamentCash');
const { importFutsalMasterCup } = require('../services/futsalMasterCupSeed');
const sheet = require('../services/matchSheet');
const roles = require('../services/tournamentRoles');
const membership = require('../services/teamMembership');
const training = require('../services/trainingSession');
const discipline = require('../services/tournamentDiscipline');
const F = require('../services/tournamentFormats');
const live = require('../services/tournamentLive');
const ftz = require('../services/fortalezaTime');
const { limits, onlyWhen } = require('../services/ligaRateLimit');
const { guardImageField, guardImageDataUri, ImageGuardError } = require('../services/imageGuard');
const signupCode = require('../services/athleteSignupCode');
const access = require('../services/tournamentAccess');
const audit = require('../services/tournamentAudit');
const clubIdentity = require('../services/clubIdentity');
const rosterInvite = require('../services/rosterInvite');
const athleteHistory = require('../services/athleteHistory');
const profileMerge = require('../services/profileMerge');
const gameRules = require('../services/tournamentRules');
const presets = require('../services/tournamentPresets');
const quick = require('../services/quickTournament');
const pickup = require('../services/pickup');
const matchNotices = require('../services/matchNotices');
const teamInvite = require('../services/teamInvite');
const { duplicateTournament } = require('../services/tournamentDuplicate');
const mediaStore = require('../services/mediaStore');
const pag = require('../services/pagination');
const plans = require('../services/organizerPlan');
const contentFilter = require('../services/contentFilter');
const minors = require('../services/ligaMinors');
const cashRules = require('../services/ligaCashRules');
const uniformQuote = require('../services/uniformQuote');

// Liga F7 — erro de serviço com status + código (CashRuleError, UniformQuoteError, ContentFilter).
function f7Err(res, e) {
  if (e && Number.isInteger(e.status) && e.status >= 400 && e.status < 500 && e.message) {
    res.status(e.status).json({ error: e.message, ...(e.code ? { code: e.code } : {}), ...(e.extra || {}) });
    return true;
  }
  return false;
}

// Liga F6 — filtro de nome/texto ofensivo. Torneio da lista de exclusão (Master Cup) NÃO
// passa pelo filtro (nada da F6 mexe nele durante o evento). false = já respondeu 400.
function cleanText(res, t, items) {
  if (t && t.slug && clubIdentity.isExcludedSlug(t.slug)) return true;
  return contentFilter.guard(res, items);
}
// Liga F6 — organizador suspenso não cria torneio (can CREATE_TOURNAMENT).
async function canCreateTournament(req, res) {
  if (await roles.can(req.userId, req.userRole, null, 'CREATE_TOURNAMENT')) return true;
  res.status(403).json({ error: 'Sua conta de organizador está suspensa pela moderação: não é possível criar torneio.', code: 'ORGANIZER_SUSPENDED' });
  return false;
}

// Erros de serviço da Liga F3 (QuickError, PickupError, TeamInviteError): status + mensagem em PT.
function svcErr(res, e) {
  if (e && Number.isInteger(e.status) && e.status >= 400 && e.status < 500 && e.message) {
    res.status(e.status).json({ error: e.message, ...(e.extra || {}) });
    return true;
  }
  return false;
}

const router = express.Router();

// =====================================================================
// Liga F1 (M9) — quem NÃO pode ver o torneio (privado sem ser membro, ou
// arquivado) recebe o MESMO 404 de "não existe" em QUALQUER rota que traga o
// torneio (ou algo dele) na URL — antes de qualquer 403. Roda antes do login
// (router.param), então anônimo em torneio privado também vê 404.
// Para cada parâmetro: como achar o torneio + a resposta de "não existe" da rota.
// =====================================================================
const NOT_TOURNAMENT_ID = /^\/(challenges|notifications)\//; // usam :id mas não são torneio
const ARCHIVED_ALLOWED = /^\/[^/]+\/(restore|audit)$/;        // fundador ainda restaura/lê auditoria
const PARAM_GUARDS = {
  id: {
    tid: async (v) => v,
    gone: (req, res) => access.sendNotFound(res),
  },
  entryId: {
    tid: async (v) => (await prisma.tournamentEntry.findUnique({ where: { id: String(v) }, select: { tournamentId: true } }))?.tournamentId,
    gone: (req, res) => res.status(404).json({ error: /\/(players|logo|uniform-quote)$/.test(req.path) ? 'time não encontrado' : 'inscrição não encontrada' }),
  },
  matchId: {
    tid: async (v) => (await prisma.tournamentMatch.findUnique({ where: { id: String(v) }, select: { tournamentId: true } }))?.tournamentId,
    gone: (req, res) => res.status(404).json({ error: /\/(events|lineup|officials|finalize|unclaimed|claim-invites|referees(\/[^/]+)?)$/.test(req.path) ? 'jogo não encontrado' : 'partida não encontrada' }),
  },
  eventId: {
    tid: async (v) => {
      const ev = await prisma.matchEvent.findUnique({ where: { id: String(v) }, select: { matchId: true } });
      return ev ? (await prisma.tournamentMatch.findUnique({ where: { id: ev.matchId }, select: { tournamentId: true } }))?.tournamentId : null;
    },
    gone: (req, res) => res.json({ ok: true }), // apagar evento que "não existe" responde ok
  },
  playerId: {
    tid: async (v) => {
      const p = await prisma.rosterPlayer.findUnique({ where: { id: String(v) }, select: { entryId: true } });
      return p ? (await prisma.tournamentEntry.findUnique({ where: { id: p.entryId }, select: { tournamentId: true } }))?.tournamentId : null;
    },
    gone: (req, res) => (req.method === 'DELETE' ? res.json({ ok: true }) : res.status(404).json({ error: 'jogador não encontrado' })),
  },
  postId: {
    tid: async (v) => (await prisma.tournamentPost.findUnique({ where: { id: String(v) }, select: { tournamentId: true } }))?.tournamentId,
    gone: (req, res) => res.status(404).json({ error: 'aviso não encontrado' }),
  },
  pickupPlayerId: {
    tid: async (v) => (await prisma.pickupPlayer.findUnique({ where: { id: String(v) }, select: { tournamentId: true } }))?.tournamentId,
    gone: (req, res) => res.status(404).json({ error: 'jogador não encontrado' }),
  },
  sid: {
    tid: async (v) => (await prisma.trainingSession.findUnique({ where: { id: String(v) }, select: { tournamentId: true } }))?.tournamentId,
    gone: (req, res) => (/\/remove$/.test(req.path) ? res.json({ ok: true }) : res.status(404).json({ error: 'treino não encontrado' })),
  },
};
for (const [name, g] of Object.entries(PARAM_GUARDS)) {
  router.param(name, async (req, res, next, value) => {
    try {
      if (name === 'id' && NOT_TOURNAMENT_ID.test(req.path)) return next();
      const tid = await g.tid(value);
      if (!tid) return name === 'id' ? g.gone(req, res) : next(); // entidade inexistente: a rota responde
      const t = await prisma.tournament.findUnique({ where: { id: String(tid) }, select: { id: true, ownerId: true, visibility: true, archivedAt: true, suspendedAt: true } });
      if (!t) return g.gone(req, res);
      if (t.archivedAt && name === 'id' && ARCHIVED_ALLOWED.test(req.path)) return next();
      const v = await access.viewer(req);
      if (!(await access.canSee(v, t))) return g.gone(req, res);
      // Liga F6: torneio SUSPENSO pela moderação não aceita NENHUMA escrita (nem do dono) —
      // só o admin global mexe. Quem não é dono/admin já recebeu o 404 acima.
      if (t.suspendedAt && !['GET', 'HEAD', 'OPTIONS'].includes(req.method) && !(await roles.can(v.userId, v.userRole, null, 'MODERATE'))) {
        return res.status(403).json({ error: 'Torneio suspenso pela moderação: nada pode ser alterado até a revisão.', code: 'SUSPENDED' });
      }
      return next();
    } catch (e) { return next(e); }
  });
}

// =====================================================================
// CONTAS / PAPÉIS do torneio (genérico pra todo torneio) — login real.
// =====================================================================

// Meus papéis neste torneio + o que posso fazer (pra UI rotear). Requer login.
router.get('/:id/my-roles', authMiddleware, async (req, res) => {
  try {
    const r = await roles.myRoles(req.userId, req.userRole, req.params.id);
    res.json(r);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Tela da arbitragem: jogos que EU devo apitar neste torneio. Requer login.
router.get('/:id/my-matches', authMiddleware, async (req, res) => {
  try {
    res.set('Cache-Control', 'no-store');
    const matches = await roles.myMatches(req.userId, req.userRole, req.params.id);
    res.json({ matches });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Tela do time (admin/treinador): meu clube com inscrições por categoria + elenco. Requer login.
router.get('/:id/my-team', authMiddleware, async (req, res) => {
  try {
    res.set('Cache-Control', 'no-store');
    const r = await roles.myTeam(req.userId, req.userRole, req.params.id);
    res.json(r);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// =====================================================================
// VÍNCULO ATLETA ↔ TIME — convite/aceite nos dois sentidos. Requer login.
// =====================================================================

// Times do torneio (pra o atleta escolher onde pedir pra entrar).
router.get('/:id/teams', authMiddleware, async (req, res) => {
  try {
    res.set('Cache-Control', 'no-store');
    const t = await access.loadVisibleTournament(req, req.params.id, { select: { id: true } });
    if (!t) return access.sendNotFound(res);
    res.json({ teams: await membership.listTeams(t.id) });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ATLETA pede pra entrar num time (entryId identifica o clube).
router.post('/:id/teams/:entryId/join', authMiddleware, async (req, res) => {
  try {
    const t = await access.loadVisibleTournament(req, req.params.id, { select: { id: true } });
    if (!t || t.id !== req.params.id) return access.sendNotFound(res);
    const r = await membership.requestJoin({ tournamentId: req.params.id, entryId: req.params.entryId, userId: req.userId });
    if (!r.ok) return res.status(r.code || 400).json(r);
    res.json(r);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// TIME convida um atleta (precisa de MANAGE_TEAM no clube). body {phone|username|userId}.
router.post('/:id/teams/:entryId/invite', authMiddleware, async (req, res) => {
  try {
    const entry = await roles.entryContext(req.params.entryId);
    if (!entry || entry.tournamentId !== req.params.id) return res.status(404).json({ error: 'time não encontrado' });
    if (!(await roles.can(req.userId, req.userRole, req.params.id, 'MANAGE_TEAM', { entryId: entry.id }))) {
      return res.status(403).json({ error: 'sem permissão (coordenador ou admin do time)' });
    }
    const b = req.body || {};
    const r = await membership.inviteAthlete({ tournamentId: req.params.id, entryId: req.params.entryId, inviterUserId: req.userId, invitee: { userId: b.userId, username: b.username, phone: b.phone } });
    if (!r.ok) return res.status(r.code || 400).json(r);
    res.json(r);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Lista do clube: atletas vinculados + pendências (admin/treinador do clube).
router.get('/:id/teams/:entryId/members', authMiddleware, async (req, res) => {
  try {
    res.set('Cache-Control', 'no-store');
    const entry = await roles.entryContext(req.params.entryId);
    if (!entry || entry.tournamentId !== req.params.id) return res.status(404).json({ error: 'time não encontrado' });
    if (!(await roles.can(req.userId, req.userRole, req.params.id, 'MANAGE_TEAM', { entryId: entry.id }))) {
      return res.status(403).json({ error: 'sem permissão' });
    }
    res.json(await membership.listForClub(req.params.id, req.params.entryId));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Do atleta: meus vínculos + convites de time pra aceitar.
router.get('/:id/my-memberships', authMiddleware, async (req, res) => {
  try {
    res.set('Cache-Control', 'no-store');
    res.json(await membership.listForUser(req.params.id, req.userId));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// O outro lado responde o convite/pedido. body { action: accept | decline }.
router.post('/:id/memberships/:mid/respond', authMiddleware, async (req, res) => {
  try {
    const action = String((req.body || {}).action || '').toLowerCase() === 'accept' ? 'accept' : 'decline';
    const r = await membership.respond({ tournamentId: req.params.id, membershipId: req.params.mid, userId: req.userId, userRole: req.userRole, action });
    if (!r.ok) return res.status(r.code || 400).json(r);
    res.json(r);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Desfaz o vínculo (atleta sai, ou gestor tira).
router.post('/:id/memberships/:mid/remove', authMiddleware, async (req, res) => {
  try {
    const r = await membership.removeMembership({ tournamentId: req.params.id, membershipId: req.params.mid, userId: req.userId, userRole: req.userRole });
    if (!r.ok) return res.status(r.code || 400).json(r);
    res.json(r);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// =====================================================================
// TREINO — atividade OFICIAL do time (criado pelo treinador). Requer login.
// =====================================================================

// Pode gerir treino do clube? coordenador/fundador/admin OU treinador/admin do time.
async function canTrainClub(req, tournamentId, clubName) {
  if (await roles.can(req.userId, req.userRole, tournamentId, 'MANAGE_TOURNAMENT')) return true;
  const entries = await prisma.tournamentEntry.findMany({ where: { tournamentId, name: clubName }, select: { id: true } });
  for (const e of entries) if (await roles.can(req.userId, req.userRole, tournamentId, 'TRAIN', { entryId: e.id })) return true;
  return false;
}
async function isActiveMember(tournamentId, clubName, userId) {
  const m = await prisma.teamMembership.findFirst({ where: { tournamentId, clubName, userId, status: 'ACTIVE' }, select: { id: true } });
  return !!m;
}

// Cria treino pro clube (entryId identifica o clube). TRAIN.
router.post('/:id/teams/:entryId/trainings', authMiddleware, async (req, res) => {
  try {
    const entry = await roles.entryContext(req.params.entryId);
    if (!entry || entry.tournamentId !== req.params.id) return res.status(404).json({ error: 'time não encontrado' });
    if (!(await roles.can(req.userId, req.userRole, req.params.id, 'TRAIN', { entryId: entry.id }))) {
      return res.status(403).json({ error: 'sem permissão (coordenador, admin ou treinador do time)' });
    }
    const b = req.body || {};
    const r = await training.create({ tournamentId: req.params.id, entryId: req.params.entryId, createdByUserId: req.userId, title: b.title, focus: b.focus, scheduledAt: b.scheduledAt, location: b.location });
    if (!r.ok) return res.status(r.code || 400).json(r);
    res.status(201).json(r);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Cria uma SÉRIE recorrente de treinos (ex: toda terça/quinta por N semanas). TRAIN.
// body { title, focus, location, weekdays:[1,3], time:'19:00', weeks:8 }
router.post('/:id/teams/:entryId/trainings/recurring', authMiddleware, async (req, res) => {
  try {
    const entry = await roles.entryContext(req.params.entryId);
    if (!entry || entry.tournamentId !== req.params.id) return res.status(404).json({ error: 'time não encontrado' });
    if (!(await roles.can(req.userId, req.userRole, req.params.id, 'TRAIN', { entryId: entry.id }))) {
      return res.status(403).json({ error: 'sem permissão (coordenador, admin ou treinador do time)' });
    }
    const b = req.body || {};
    const r = await training.createRecurring({ tournamentId: req.params.id, entryId: req.params.entryId, createdByUserId: req.userId, title: b.title, focus: b.focus, location: b.location, weekdays: b.weekdays, time: b.time, weeks: b.weeks, startDate: b.startDate });
    if (!r.ok) return res.status(r.code || 400).json(r);
    res.status(201).json(r);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Modelos de plano (templates do clube) — baseados no treino (sem precisar de entryId).
router.get('/trainings/:sid/templates', authMiddleware, async (req, res) => {
  try {
    res.set('Cache-Control', 'no-store');
    const s = await training.sessionClub(req.params.sid);
    if (!s) return res.status(404).json({ error: 'treino não encontrado' });
    if (!(await canTrainClub(req, s.tournamentId, s.clubName))) return res.status(403).json({ error: 'sem permissão' });
    const templates = await prisma.trainingTemplate.findMany({ where: { tournamentId: s.tournamentId, clubName: s.clubName }, orderBy: { createdAt: 'desc' } });
    res.json({ templates });
  } catch (err) { res.status(500).json({ error: err.message }); }
});
// Salva o plano atual do treino como modelo reutilizável. TRAIN.
router.post('/trainings/:sid/save-template', authMiddleware, async (req, res) => {
  try {
    const full = await training.get(req.params.sid);
    if (!full) return res.status(404).json({ error: 'treino não encontrado' });
    const s = full.session;
    if (!(await canTrainClub(req, s.tournamentId, s.clubName))) return res.status(403).json({ error: 'sem permissão' });
    const name = String((req.body || {}).name || s.title || 'Modelo').slice(0, 80);
    const tpl = await prisma.trainingTemplate.create({ data: { tournamentId: s.tournamentId, clubName: s.clubName, name, plan: Array.isArray(s.plan) ? s.plan : [], createdByUserId: req.userId } });
    res.status(201).json({ ok: true, template: tpl });
  } catch (err) { res.status(500).json({ error: err.message }); }
});
router.delete('/:id/training-templates/:tplId', authMiddleware, async (req, res) => {
  try {
    const tpl = await prisma.trainingTemplate.findFirst({ where: { id: req.params.tplId, tournamentId: req.params.id }, select: { clubName: true } });
    if (!tpl) return res.json({ ok: true });
    if (!(await canTrainClub(req, req.params.id, tpl.clubName))) return res.status(403).json({ error: 'sem permissão' });
    res.json(await training.deleteTemplate(req.params.id, req.params.tplId));
  } catch (err) { res.status(500).json({ error: err.message }); }
});
// Aplica um modelo ao treino (copia o plano). TRAIN.
router.post('/trainings/:sid/apply-template', authMiddleware, async (req, res) => {
  try {
    const s = await training.sessionClub(req.params.sid);
    if (!s) return res.status(404).json({ error: 'treino não encontrado' });
    if (!(await canTrainClub(req, s.tournamentId, s.clubName))) return res.status(403).json({ error: 'sem permissão' });
    const r = await training.applyTemplate(req.params.sid, (req.body || {}).templateId);
    if (!r.ok) return res.status(r.code || 400).json(r);
    res.json(r);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Lista treinos do clube (histórico). Gestor do treino OU atleta vinculado.
router.get('/:id/teams/:entryId/trainings', authMiddleware, async (req, res) => {
  try {
    res.set('Cache-Control', 'no-store');
    const clubName = await training.clubOfEntry(req.params.entryId, req.params.id);
    if (!clubName) return res.status(404).json({ error: 'time não encontrado' });
    if (!(await canTrainClub(req, req.params.id, clubName)) && !(await isActiveMember(req.params.id, clubName, req.userId)) && !roles.isGlobalAdmin(req.userRole)) {
      return res.status(403).json({ error: 'sem permissão' });
    }
    res.json(await training.list(req.params.id, req.params.entryId));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Súmula do treino (chamada). Gestor OU atleta vinculado do clube.
router.get('/trainings/:sid', authMiddleware, async (req, res) => {
  try {
    res.set('Cache-Control', 'no-store');
    const s = await training.sessionClub(req.params.sid);
    if (!s) return res.status(404).json({ error: 'treino não encontrado' });
    if (!(await canTrainClub(req, s.tournamentId, s.clubName)) && !(await isActiveMember(s.tournamentId, s.clubName, req.userId)) && !roles.isGlobalAdmin(req.userRole)) {
      return res.status(403).json({ error: 'sem permissão' });
    }
    const out = await training.get(req.params.sid);
    if (!out) return res.status(404).json({ error: 'treino não encontrado' });
    res.json(out);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Edita/finaliza o treino (status, foco, notas do que foi feito). TRAIN.
router.patch('/trainings/:sid', authMiddleware, async (req, res) => {
  try {
    const s = await training.sessionClub(req.params.sid);
    if (!s) return res.status(404).json({ error: 'treino não encontrado' });
    if (!(await canTrainClub(req, s.tournamentId, s.clubName))) return res.status(403).json({ error: 'sem permissão' });
    const r = await training.update(req.params.sid, req.body || {});
    if (!r.ok) return res.status(r.code || 400).json(r);
    res.json(r);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Remove/cancela o treino. TRAIN.
router.post('/trainings/:sid/remove', authMiddleware, async (req, res) => {
  try {
    const s = await training.sessionClub(req.params.sid);
    if (!s) return res.json({ ok: true });
    if (!(await canTrainClub(req, s.tournamentId, s.clubName))) return res.status(403).json({ error: 'sem permissão' });
    res.json(await training.remove(req.params.sid));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Atleta responde o RSVP. body { rsvp: 'GOING'|'MAYBE'|'DECLINED' } (ou { confirmed }).
router.post('/trainings/:sid/confirm', authMiddleware, async (req, res) => {
  try {
    const s = await training.sessionClub(req.params.sid);
    if (!s) return res.status(404).json({ error: 'treino não encontrado' });
    if (!(await isActiveMember(s.tournamentId, s.clubName, req.userId)) && !roles.isGlobalAdmin(req.userRole)) {
      return res.status(403).json({ error: 'só atleta vinculado ao time responde o treino' });
    }
    const b = req.body || {};
    const val = b.rsvp !== undefined ? b.rsvp : (b.confirmed !== false);
    const r = await training.confirm(req.params.sid, req.userId, val);
    if (!r.ok) return res.status(r.code || 400).json(r);
    res.json(r);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Treinador lembra quem ainda não respondeu o RSVP (aviso in-app). TRAIN.
router.post('/trainings/:sid/remind', authMiddleware, async (req, res) => {
  try {
    const s = await training.sessionClub(req.params.sid);
    if (!s) return res.status(404).json({ error: 'treino não encontrado' });
    if (!(await canTrainClub(req, s.tournamentId, s.clubName))) return res.status(403).json({ error: 'sem permissão' });
    res.json(await training.remind(req.params.sid, req.userId));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Treinador/coordenador faz a chamada + lança a PRODUÇÃO do atleta no treino.
// body { userId, present, goals, passes, efficiency, rating, note } — patch parcial.
router.post('/trainings/:sid/mark', authMiddleware, async (req, res) => {
  try {
    const s = await training.sessionClub(req.params.sid);
    if (!s) return res.status(404).json({ error: 'treino não encontrado' });
    if (!(await canTrainClub(req, s.tournamentId, s.clubName))) return res.status(403).json({ error: 'sem permissão (só treinador/coordenador lança produção)' });
    const b = req.body || {};
    if (!b.userId) return res.status(400).json({ error: 'userId do atleta obrigatório' });
    const r = await training.mark(req.params.sid, b.userId, b);
    if (!r.ok) return res.status(r.code || 400).json(r);
    res.json(r);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Treinos dos times do atleta (pra ele ver/confirmar).
router.get('/:id/my-trainings', authMiddleware, async (req, res) => {
  try {
    res.set('Cache-Control', 'no-store');
    res.json(await training.forUser(req.params.id, req.userId));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Meu prontuário (rendimento do próprio atleta neste torneio).
router.get('/:id/my-prontuario', authMiddleware, async (req, res) => {
  try {
    res.set('Cache-Control', 'no-store');
    res.json(await training.prontuario(req.params.id, req.userId));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Prontuário de um atleta (o próprio, OU treinador/coordenador/admin de um clube dele).
router.get('/:id/athletes/:userId/prontuario', authMiddleware, async (req, res) => {
  try {
    res.set('Cache-Control', 'no-store');
    const target = req.params.userId;
    const self = target === req.userId;
    const admin = roles.isGlobalAdmin(req.userRole);
    let allowed = self || admin;
    let canEvaluate = admin && !self;
    if (!self) {
      // treinador/coord pode ver (e avaliar) se o atleta está num clube que ele gere
      const mine = await prisma.teamMembership.findMany({ where: { tournamentId: req.params.id, userId: target, status: 'ACTIVE' }, select: { clubName: true } });
      for (const m of [...new Set(mine.map((x) => x.clubName))]) {
        if (await canTrainClub(req, req.params.id, m)) { allowed = true; canEvaluate = true; break; }
      }
    }
    if (!allowed) return res.status(403).json({ error: 'sem permissão' });
    const data = await training.prontuario(req.params.id, target);
    data.canEvaluate = canEvaluate;
    res.json(data);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Nova avaliação do atleta (Four Corner). Treinador/coordenador do time dele.
// body { scores:{technical,tactical,physical,psychological,social}, notes, evaluatedAt }
router.post('/:id/athletes/:userId/evaluations', authMiddleware, async (req, res) => {
  try {
    const target = req.params.userId;
    if (target === req.userId) return res.status(403).json({ error: 'não pode avaliar a si mesmo' });
    const mine = await prisma.teamMembership.findMany({ where: { tournamentId: req.params.id, userId: target, status: 'ACTIVE' }, select: { clubName: true } });
    let clubOk = null;
    for (const m of [...new Set(mine.map((x) => x.clubName))]) { if (await canTrainClub(req, req.params.id, m)) { clubOk = m; break; } }
    if (!clubOk && !roles.isGlobalAdmin(req.userRole)) return res.status(403).json({ error: 'sem permissão (treinador/coordenador do time do atleta)' });
    const b = req.body || {};
    const r = await training.createEvaluation({ tournamentId: req.params.id, userId: target, evaluatorId: req.userId, clubName: clubOk, scores: b.scores || b, notes: b.notes, evaluatedAt: b.evaluatedAt });
    if (!r.ok) return res.status(r.code || 400).json(r);
    res.status(201).json(r);
  } catch (err) { res.status(500).json({ error: err.message }); }
});
// Apaga uma avaliação. Treinador/coordenador do time do atleta.
router.delete('/:id/evaluations/:evalId', authMiddleware, async (req, res) => {
  try {
    const ev = await prisma.athleteEvaluation.findFirst({ where: { id: req.params.evalId, tournamentId: req.params.id }, select: { userId: true } });
    if (!ev) return res.json({ ok: true });
    let allowed = roles.isGlobalAdmin(req.userRole);
    if (!allowed) {
      const mine = await prisma.teamMembership.findMany({ where: { tournamentId: req.params.id, userId: ev.userId, status: 'ACTIVE' }, select: { clubName: true } });
      for (const m of [...new Set(mine.map((x) => x.clubName))]) { if (await canTrainClub(req, req.params.id, m)) { allowed = true; break; } }
    }
    if (!allowed) return res.status(403).json({ error: 'sem permissão' });
    res.json(await training.deleteEvaluation(req.params.id, req.params.evalId));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Lista os papéis do torneio (fundador/coordenador). Requer login + permissão.
router.get('/:id/roles', authMiddleware, async (req, res) => {
  try {
    if (!(await roles.can(req.userId, req.userRole, req.params.id, 'ASSIGN_ROLES'))) {
      return res.status(403).json({ error: 'sem permissão (só fundador/coordenador)' });
    }
    res.json({ roles: await roles.listRoles(req.params.id) });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Nomeia um papel. Body: { phone|username|userId, role, entryId? }. Fundador/coordenador.
router.post('/:id/roles', authMiddleware, async (req, res) => {
  try {
    const tournamentId = req.params.id;
    if (!(await roles.can(req.userId, req.userRole, tournamentId, 'ASSIGN_ROLES'))) {
      return res.status(403).json({ error: 'sem permissão (só fundador/coordenador)' });
    }
    const body = req.body || {};
    const user = await roles.resolveUser({ userId: body.userId, username: body.username, phone: body.phone });
    if (!user) return res.status(404).json({ error: 'usuário não encontrado — peça pra ele se cadastrar primeiro (telefone/@)' });
    // Coordenador não nomeia FOUNDER/COORDINATOR (só o fundador/admin global faz).
    const roleUp = String(body.role || '').toUpperCase();
    if ((roleUp === 'FOUNDER' || roleUp === 'COORDINATOR') && !(await roles.can(req.userId, req.userRole, tournamentId, 'ASSIGN_LEAD_ROLES'))) {
      return res.status(403).json({ error: 'só o fundador nomeia fundador/coordenador' });
    }
    const r = await roles.assignRole(tournamentId, { userId: user.id, role: body.role, entryId: body.entryId });
    if (!r.ok) return res.status(400).json(r);
    if (!r.already) {
      await audit.record({ tournamentId, userId: req.userId, action: 'role.add', entity: 'TournamentRole', entityId: r.role && r.role.id, before: null, after: { userId: user.id, role: roleUp, entryId: body.entryId || null, count: r.count || 1 } });
    }
    res.status(201).json({ ok: true, user, role: r.role, already: !!r.already });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Remove um papel nomeado. Fundador/coordenador.
router.delete('/:id/roles/:roleId', authMiddleware, async (req, res) => {
  try {
    if (!(await roles.can(req.userId, req.userRole, req.params.id, 'ASSIGN_ROLES'))) {
      return res.status(403).json({ error: 'sem permissão (só fundador/coordenador)' });
    }
    const row = await prisma.tournamentRole.findFirst({ where: { id: req.params.roleId, tournamentId: req.params.id } });
    if (!row) return res.json({ ok: true, removed: 0 });
    // Tirar fundador/coordenador é decisão do fundador (coordenador não derruba outro coordenador).
    if ((row.role === 'FOUNDER' || row.role === 'COORDINATOR') && !(await roles.can(req.userId, req.userRole, req.params.id, 'ASSIGN_LEAD_ROLES'))) {
      return res.status(403).json({ error: 'só o fundador tira fundador/coordenador' });
    }
    const out = await roles.removeRole(req.params.id, req.params.roleId);
    await audit.record({ tournamentId: req.params.id, userId: req.userId, action: 'role.remove', entity: 'TournamentRole', entityId: row.id, before: { userId: row.userId, role: row.role, entryId: row.entryId }, after: { removed: out.removed } });
    res.json(out);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Cria (ou acha) a conta de uma pessoa pra ser nomeada (coordenador vouch).
// Fundador/coordenador. Se criar, devolve uma senha provisória pra passar pra pessoa.
router.post('/:id/people', authMiddleware, async (req, res) => {
  try {
    if (!(await roles.can(req.userId, req.userRole, req.params.id, 'ASSIGN_ROLES'))) {
      return res.status(403).json({ error: 'sem permissão (só fundador/coordenador)' });
    }
    const b = req.body || {};
    const name = String(b.name || '').trim();
    const phone = String(b.phone || '').replace(/\D/g, '');
    if (!name || !phone) return res.status(400).json({ error: 'informe nome e telefone' });
    if (!cleanText(res, null, [{ field: 'name', value: name }])) return; // Liga F6
    let user = await prisma.user.findUnique({ where: { phone }, select: { id: true, name: true, phone: true, username: true } });
    let created = false, tempPassword = null;
    if (!user) {
      tempPassword = (String(b.password || '').trim()) || String(Math.floor(100000 + Math.random() * 900000)); // 6 dígitos
      const hash = await bcrypt.hash(tempPassword, 10);
      user = await prisma.user.create({
        data: { name, phone, pin: hash, lgpdAccepted: true, lgpdDate: new Date() },
        select: { id: true, name: true, phone: true, username: true },
      });
      created = true;
    }
    res.status(created ? 201 : 200).json({ ok: true, user, created, tempPassword });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Clubes distintos do torneio (pra o seletor ao nomear admin/treinador do time).
router.get('/:id/clubs', authMiddleware, async (req, res) => {
  try {
    if (!(await roles.can(req.userId, req.userRole, req.params.id, 'MANAGE_TOURNAMENT'))) {
      return res.status(403).json({ error: 'sem permissão' });
    }
    const entries = await prisma.tournamentEntry.findMany({ where: { tournamentId: req.params.id }, select: { id: true, name: true }, orderBy: { name: 'asc' } });
    const seen = {}; const clubs = [];
    for (const e of entries) { if (!seen[e.name]) { seen[e.name] = true; clubs.push({ name: e.name, entryId: e.id }); } }
    res.json({ clubs });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Painel do atleta: meus times, convites, próximos jogos/treinos oficiais e
// produção somada em TODOS os torneios/clubes. Requer login. Só leitura.
router.get('/my-dashboard', authMiddleware, async (req, res) => {
  try {
    res.set('Cache-Control', 'no-store');
    res.json(await require('../services/athleteDashboard').dashboard(req.userId));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Meus jogos oficiais (passados/próximos) — ?scope=past|upcoming|all&limit=. Requer login.
router.get('/my-games', authMiddleware, async (req, res) => {
  try {
    res.set('Cache-Control', 'no-store');
    res.json(await require('../services/athleteDashboard').myGames(req.userId, { scope: String(req.query.scope || 'all'), limit: req.query.limit }));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Torneios onde EU tenho papel (fundador ou nomeado) — pra home rotear. Requer login.
router.get('/my-tournaments', authMiddleware, async (req, res) => {
  try {
    const roleRows = await prisma.tournamentRole.findMany({ where: { userId: req.userId }, select: { tournamentId: true, role: true, entryId: true } });
    const owned = await prisma.tournament.findMany({ where: { ownerId: req.userId }, select: { id: true } });
    const ids = [...new Set(roleRows.map((r) => r.tournamentId).concat(owned.map((o) => o.id)))];
    if (!ids.length) return res.json({ tournaments: [] });
    const ts0 = await prisma.tournament.findMany({ where: { id: { in: ids } }, select: { id: true, name: true, slug: true, sport: true, status: true, ownerId: true, visibility: true, archivedAt: true, suspendedAt: true } });
    // Liga F6: torneio suspenso só aparece para o dono e o admin global (os outros recebem 404 nele)
    const ts = [];
    for (const t of ts0) if (!t.suspendedAt || (await access.canSee({ userId: req.userId, userRole: req.userRole }, t))) ts.push(t);
    const byId = {};
    roleRows.forEach((r) => { (byId[r.tournamentId] = byId[r.tournamentId] || []).push({ role: r.role, entryId: r.entryId }); });
    const out = ts.map((t) => ({ ...t, myRoles: (t.ownerId === req.userId ? [{ role: 'FOUNDER' }] : []).concat(byId[t.id] || []) }));
    res.json({ tournaments: out });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Nomeação da arbitragem POR JOGO (quem apita cada partida). Fundador/coordenador.
// role do official: REF1 | REF2 | REF3 | SCORER | TIMEKEEPER
router.get('/:id/matches/:matchId/referees', authMiddleware, async (req, res) => {
  try {
    if (!(await roles.can(req.userId, req.userRole, req.params.id, 'MANAGE_TOURNAMENT'))) {
      return res.status(403).json({ error: 'sem permissão' });
    }
    const match = await prisma.tournamentMatch.findFirst({ where: { id: req.params.matchId, tournamentId: req.params.id }, select: { id: true } });
    if (!match) return res.status(404).json({ error: 'jogo não encontrado' });
    const officials = await prisma.matchOfficial.findMany({ where: { matchId: match.id }, orderBy: { createdAt: 'asc' } });
    const users = await prisma.user.findMany({ where: { id: { in: officials.map((o) => o.userId) } }, select: { id: true, name: true, phone: true } });
    const uById = Object.fromEntries(users.map((u) => [u.id, u]));
    res.json({ officials: officials.map((o) => ({ id: o.id, role: o.role, user: uById[o.userId] || { id: o.userId } })) });
  } catch (err) { res.status(500).json({ error: err.message }); }
});
router.post('/:id/matches/:matchId/referees', authMiddleware, async (req, res) => {
  try {
    if (!(await roles.can(req.userId, req.userRole, req.params.id, 'MANAGE_TOURNAMENT'))) {
      return res.status(403).json({ error: 'sem permissão' });
    }
    const b = req.body || {};
    const role = String(b.role || '').toUpperCase();
    if (!roles.OFFICIAL_ROLES.includes(role)) return res.status(400).json({ error: 'função inválida (REF1/REF2/REF3/SCORER/TIMEKEEPER)' });
    const user = await roles.resolveUser({ userId: b.userId, username: b.username, phone: b.phone });
    if (!user) return res.status(404).json({ error: 'usuário não encontrado' });
    // garante que o árbitro tem o papel REFEREE no torneio (nomear na partida já credencia)
    await roles.assignRole(req.params.id, { userId: user.id, role: 'REFEREE' }).catch(() => {});
    const match = await prisma.tournamentMatch.findFirst({ where: { id: req.params.matchId, tournamentId: req.params.id }, select: { id: true } });
    if (!match) return res.status(404).json({ error: 'jogo não encontrado' });
    const existing = await prisma.matchOfficial.findFirst({ where: { matchId: match.id, userId: user.id, role } });
    const official = existing || (await prisma.matchOfficial.create({ data: { matchId: match.id, userId: user.id, role } }));
    if (!existing) await audit.record({ tournamentId: req.params.id, userId: req.userId, action: 'official.add', entity: 'MatchOfficial', entityId: official.id, after: { matchId: match.id, userId: user.id, role } });
    res.status(201).json({ ok: true, user, official });
  } catch (err) { res.status(500).json({ error: err.message }); }
});
router.delete('/:id/matches/:matchId/referees/:officialId', authMiddleware, async (req, res) => {
  try {
    if (!(await roles.can(req.userId, req.userRole, req.params.id, 'MANAGE_TOURNAMENT'))) {
      return res.status(403).json({ error: 'sem permissão' });
    }
    // o jogo tem que ser DESTE torneio (antes dava pra tirar árbitro de jogo de outro torneio)
    const match = await prisma.tournamentMatch.findFirst({ where: { id: req.params.matchId, tournamentId: req.params.id }, select: { id: true } });
    if (!match) return res.status(404).json({ error: 'jogo não encontrado' });
    const row = await prisma.matchOfficial.findFirst({ where: { id: req.params.officialId, matchId: match.id } });
    if (row) {
      await prisma.matchOfficial.delete({ where: { id: row.id } });
      await audit.record({ tournamentId: req.params.id, userId: req.userId, action: 'official.remove', entity: 'MatchOfficial', entityId: row.id, before: { matchId: row.matchId, userId: row.userId, role: row.role } });
    }
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Membros (userIds) de uma entry — pra notificar a dupla/atleta.
async function entryMemberIds(entryId) {
  const ms = await prisma.entryMember.findMany({ where: { entryId }, select: { userId: true } });
  return ms.map((m) => m.userId);
}

const SPORTS = new Set([
  'TENNIS', 'BEACH_TENNIS', 'PADEL', 'FUTSAL', 'SOCCER', 'VOLLEY',
  'BASKETBALL', 'HANDBALL', 'TABLE_TENNIS', 'OTHER',
]);
const FORMATS = new Set([
  'KNOCKOUT', 'ROUND_ROBIN', 'GROUPS', 'GROUPS_KNOCKOUT',
  'DOUBLE_ELIM', // dupla eliminação (vencedores + perdedores + grande final c/ reset opcional)
  'SWISS', // sistema suíço (N rodadas, pareamento por pontuação)
  'AMERICANO', // Americano / Super 8 / Super 12 (parceiros rotativos, ranking por games)
  'PICKUP', // Liga F3: racha (presença do dia + sorteio equilibrado + placar rápido)
]);

// Regras do motor por categoria (desempate, ida/volta, suspensão, config de formato).
// Só copia o que veio no body; valida e normaliza. Retorna { data } ou { error }.
function categoryRulesData(b = {}) {
  const data = {};
  if (b.tiebreakers !== undefined) {
    data.tiebreakers = b.tiebreakers === null ? null : F.normalizeTiebreakers(b.tiebreakers);
  }
  if (b.doubleRound !== undefined) data.doubleRound = b.doubleRound === true || b.doubleRound === 'true';
  if (b.suspensionRule !== undefined) {
    data.suspensionRule = b.suspensionRule === null ? null : F.normalizeSuspensionRule(b.suspensionRule);
  }
  if (b.formatConfig !== undefined) {
    if (b.formatConfig === null) data.formatConfig = null;
    else if (typeof b.formatConfig === 'object') {
      const fc = {};
      const r = Number(b.formatConfig.rounds);
      if (Number.isFinite(r) && r >= 1) fc.rounds = Math.min(30, Math.round(r));
      if (b.formatConfig.reset !== undefined) fc.reset = !!b.formatConfig.reset;
      if (['SUPER8', 'SUPER12', 'AMERICANO'].includes(b.formatConfig.variant)) fc.variant = b.formatConfig.variant;
      data.formatConfig = fc;
    } else return { error: 'formatConfig inválido' };
  }
  for (const f of ['pointsWin', 'pointsDraw', 'pointsLoss']) {
    if (b[f] !== undefined) {
      const x = Number(b[f]);
      if (!Number.isFinite(x) || x < -10 || x > 10) return { error: f + ' inválido' };
      data[f] = Math.round(x);
    }
  }
  return { data };
}

// Série/temporada do torneio (liga edições). seriesSlug vem do nome se não vier.
function seriesData(b = {}) {
  const data = {};
  if (b.seriesName !== undefined) data.seriesName = b.seriesName ? String(b.seriesName).slice(0, 120) : null;
  if (b.seriesSlug !== undefined) data.seriesSlug = b.seriesSlug ? discipline.slugify(b.seriesSlug) || null : null;
  else if (data.seriesName) data.seriesSlug = discipline.slugify(data.seriesName) || null;
  if (b.edition !== undefined) data.edition = b.edition ? String(b.edition).slice(0, 40) : null;
  return data;
}
const TOURNAMENT_STATUS = new Set(['DRAFT', 'OPEN', 'ONGOING', 'FINISHED', 'CANCELED']);

// ---------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------
function slugify(s) {
  return (
    String(s || '')
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 50) || 'torneio'
  );
}

async function uniqueSlug(base) {
  let slug = slugify(base);
  let n = 1;
  while (await prisma.tournament.findUnique({ where: { slug } })) {
    n += 1;
    slug = `${slugify(base)}-${n}`;
  }
  return slug;
}

// resolveUserId e buildAthleteCard ficam no engine (reusados pelas páginas server-rendered)
const { resolveUserId } = engine;

// Erro de validação de imagem (imageGuard) → status + mensagem em português.
function imageError(res, err) {
  if (err instanceof ImageGuardError || err instanceof mediaStore.MediaError) { res.status(err.status).json({ error: err.message }); return true; }
  return false;
}
// Liga F5: imagem enviada → imageGuard → mediaStore ("/media/<sha>.<ext>"), com a cota de
// imagens do plano conferida ANTES de gravar. Torneio da lista de exclusão (Master Cup)
// continua gravando o data URI como antes. Retorna { ok, value } ou responde o erro.
async function storeImage(req, res, raw, guardOpts, { tournament = null } = {}) {
  try {
    const keep = !!(tournament && clubIdentity.isExcludedSlug(tournament.slug));
    if (!keep && mediaStore.isUpload(raw) && !(await plans.guard(res, 'image', { actorId: req.userId, actorRole: req.userRole }))) return { ok: false };
    return { ok: true, value: await mediaStore.guardAndStore(raw, guardOpts, { ownerUserId: req.userId, keepDataUri: keep }) };
  } catch (e) {
    if (imageError(res, e)) return { ok: false };
    throw e;
  }
}
// Liga F5: ?limit/?cursor inválido = 400
function pageOf(req, res, opts) {
  try { return pag.parsePage(req.query || {}, opts); } catch (e) { if (pag.sendPageError(res, e)) return null; throw e; }
}
const hasBody = (field) => (req) => !!(req.body && Object.prototype.hasOwnProperty.call(req.body, field));

// Limitador de inscrição: NÃO se aplica a quem gerencia o torneio (organizador
// inscrevendo os times em massa). Para os demais, limits.entry.
async function entryLimitUnlessManager(req, res, next) {
  try {
    if (req.userId && (await roles.can(req.userId, req.userRole, req.params.id, 'MANAGE_TOURNAMENT'))) return next();
  } catch (_) { /* na dúvida, limita */ }
  return limits.entry(req, res, next);
}

// Liga F1 — PORTA ÚNICA DE ESCRITA. Carrega o torneio e passa por roles.can().
// Não existe / arquivado → 404 (igual a "não existe"); sem permissão → 403.
async function loadForAction(req, res, tournamentId, action, opts = {}, denyMsg) {
  const t = tournamentId ? await prisma.tournament.findUnique({ where: { id: String(tournamentId) } }) : null;
  if (!t || t.archivedAt) { access.sendNotFound(res); return null; }
  if (!(await roles.can(req.userId, req.userRole, t.id, action, opts))) {
    if (!(await access.canSee({ userId: req.userId, userRole: req.userRole }, t))) { access.sendNotFound(res); return null; }
    // Liga F6: diz o motivo quando é a moderação que trava (o dono ainda vê o torneio)
    if (t.suspendedAt) { res.status(403).json({ error: 'Torneio suspenso pela moderação: nada pode ser alterado até a revisão.', code: 'SUSPENDED' }); return null; }
    if (await roles.isOrganizerSuspended(req.userId)) { res.status(403).json({ error: 'Sua conta de organizador está suspensa pela moderação.', code: 'ORGANIZER_SUSPENDED' }); return null; }
    res.status(403).json({ error: denyMsg || 'sem permissão neste torneio' });
    return null;
  }
  return t;
}
// Mesma porta quando a rota já tem o tournamentId (entry/jogo/post). true = pode seguir.
async function allow(req, res, tournamentId, action, opts = {}, denyMsg) {
  return !!(await loadForAction(req, res, tournamentId, action, opts, denyMsg));
}

// =====================================================================
// TORNEIOS — gestão (organizador autenticado)
// =====================================================================

// Cria torneio
router.post('/', authMiddleware, limits.createTournament, async (req, res) => {
  try {
    const b = req.body || {};
    if (!b.name) return res.status(400).json({ error: 'name obrigatório' });
    if (!(await canCreateTournament(req, res))) return;
    if (!cleanText(res, null, [{ field: 'tournament', value: b.name }, { field: 'text', value: [b.description, b.rules, b.prizeDescription].filter(Boolean) }])) return;
    // Liga F5: limite de torneios ativos do plano (só nova criação; admin/equipe sem limite)
    if (!(await plans.guard(res, 'tournament', { actorId: req.userId, actorRole: req.userRole }))) return;
    // Banner: só https:// ou caminho do próprio site / imagem PNG/JPEG/WEBP real (Liga F0);
    // imagem enviada vai pro mediaStore (Liga F5) e o campo guarda "/media/<sha>.<ext>".
    const bn = await storeImage(req, res, b.bannerUrl, { maxChars: 800000 });
    if (!bn.ok) return;
    const bannerUrl = bn.value;
    const sport = SPORTS.has(b.sport) ? b.sport : 'TENNIS';
    const format = FORMATS.has(b.format) ? b.format : 'KNOCKOUT';

    // TenisCash real (fase 2): só admin/gerente pode ligar cobrança/prêmio.
    // Atleta comum cria torneio só com valores zerados (sem movimento de saldo).
    const entryFeeCash = Number(b.entryFeeCash) || 0;
    const prizeCash = Number(b.prizeCash) || 0;
    const wantsCash = !!b.cashEnabled || entryFeeCash > 0 || prizeCash > 0;
    if (wantsCash && !cash.isAdmin(req.userRole)) {
      return res.status(403).json({ error: 'só admin/gerente pode criar torneio com TenisCash real (inscrição/prêmio)' });
    }
    const cashEnabled = wantsCash && cash.isAdmin(req.userRole) ? !!b.cashEnabled || entryFeeCash > 0 || prizeCash > 0 : false;

    const t = await prisma.tournament.create({
      data: {
        slug: await uniqueSlug(b.slug || b.name),
        name: b.name,
        sport,
        format,
        isDoubles: !!b.isDoubles,
        ownerId: req.userId,
        storeId: b.storeId || null,
        description: b.description || null,
        rules: b.rules || null,
        bannerUrl,
        city: b.city || null,
        state: b.state || null,
        startDate: b.startDate ? new Date(b.startDate) : null,
        endDate: b.endDate ? new Date(b.endDate) : null,
        registrationCloseAt: b.registrationCloseAt ? new Date(b.registrationCloseAt) : null,
        maxEntries: b.maxEntries ? Number(b.maxEntries) : null,
        cashEnabled,
        entryFeeCash,
        prizeCash,
        prizeDescription: b.prizeDescription || null,
        visibility: access.normalizeVisibility(b.visibility),
        ...seriesData(b),
      },
    });
    res.status(201).json(t);
  } catch (err) {
    console.error('[tournaments] create', err);
    res.status(500).json({ error: err.message });
  }
});

// =====================================================================
// Liga Aberta F3 — CRIAÇÃO EM 2 MINUTOS
// =====================================================================
// Modelos prontos (racha semanal, pontos corridos, copa, torneio de um dia, ranking de duplas).
router.get('/presets', (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json({ presets: presets.publicList(), formats: presets.QUICK_FORMATS.map((f) => ({ id: f, label: presets.FORMAT_LABEL[f] })), sports: presets.SPORT_LABEL, eventTypes: gameRules.EVENT_CATALOG, sportRules: gameRules.SPORT_DEFAULTS, maxTeams: quick.MAX_TEAMS });
});
// Publica: torneio + categoria + inscrições (cada time com o seu clube) + tabela, numa transação.
// Qualquer usuário logado; limitador de criação de torneio da F0 (20/h).
router.post('/quick', authMiddleware, limits.createTournament, async (req, res) => {
  try {
    if (!(await canCreateTournament(req, res))) return;
    {
      const qb = req.body || {};
      const tl = Array.isArray(qb.teams) ? qb.teams.map((x) => (x && typeof x === 'object' ? x.name : x)) : typeof qb.teams === 'string' ? qb.teams.split(/\r?\n/) : [];
      if (!cleanText(res, null, [{ field: 'tournament', value: qb.name }, { field: 'team', value: tl.filter(Boolean).map(String) }])) return;
    }
    // Liga F5: limite do plano (torneios ativos + times por categoria) antes de gravar
    if (!(await plans.guard(res, 'tournament', { actorId: req.userId, actorRole: req.userRole }))) return;
    const teamsIn = (req.body || {}).teams;
    const nTeams = Array.isArray(teamsIn) ? teamsIn.length : typeof teamsIn === 'string' ? teamsIn.split(/\r?\n/).map((x) => x.trim()).filter(Boolean).length : 0;
    // acima do máximo do assistente quem responde é a validação do /quick (400), não o plano
    if (nTeams > 1 && nTeams <= quick.MAX_TEAMS && !plans.isStaffRole(req.userRole)) {
      const plan = await plans.planFor(req.userId);
      const lim = plan.limits.teamsPerCategory;
      if (lim != null && nTeams > lim) return res.status(402).json({ error: `${plan.key === 'free' ? 'Limite do plano grátis' : 'Limite do seu plano'}: até ${lim} times por categoria.`, code: 'PLAN_LIMIT', kind: 'teamsPerCategory', limit: lim, used: 0, plan: plan.key });
    }
    res.status(201).json(await quick.createQuick({ userId: req.userId, userRole: req.userRole, body: req.body || {} }));
  } catch (e) {
    if (svcErr(res, e)) return;
    console.error('[tournaments] quick', e);
    res.status(500).json({ error: 'não foi possível publicar agora — nada foi gravado. Tente de novo.' });
  }
});

// Importa o II Futsal Master Cup 2026 da tabela oficial.
// Liga Aberta F0: SÓ ADMIN GLOBAL (admin/superadmin/manager — mesmo critério de
// tournamentRoles.isGlobalAdmin). Idempotente; reconcilia jogo de grupo SCHEDULED.
router.post('/import/futsal-master-cup', authMiddleware, async (req, res) => {
  try {
    if (!roles.isGlobalAdmin(req.userRole)) {
      return res.status(403).json({ error: 'só administrador do sistema pode importar a tabela oficial' });
    }
    const r = await importFutsalMasterCup(req.userId || null);
    if (!r.ok) return res.status(400).json(r);
    res.json(r);
  } catch (err) {
    console.error('[tournaments] import futsal', err);
    res.status(500).json({ error: err.message });
  }
});

// Meus torneios (que eu organizo)
router.get('/mine', authMiddleware, async (req, res) => {
  try {
    // ?archived=1 + admin global: todos os torneios arquivados (pra restaurar). Senão, os que eu organizo.
    const adminArchived = req.query.archived === '1' && roles.isGlobalAdmin(req.userRole);
    const list = await prisma.tournament.findMany({
      where: adminArchived ? { archivedAt: { not: null } } : { ownerId: req.userId },
      orderBy: { createdAt: 'desc' },
      include: { _count: { select: { entries: true, categories: true } } },
    });
    res.json({ tournaments: list });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Liga F5 — MEU PLANO: uso × limite (torneios ativos, categorias, times, avisos e imagens
// do mês). Sem preço (decisão do dono). Admin/equipe: unlimited:true.
router.get('/me/plan', authMiddleware, async (req, res) => {
  try {
    res.set('Cache-Control', 'no-store');
    res.json(await plans.summary(req.userId, req.userRole));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Histórico de campeões de uma SÉRIE (todas as edições) — público.
// Campeão = vencedor da FINAL encerrada (dupla eliminação: o reset, se houve);
// em pontos corridos/americano/suíço, o 1º da tabela final.
router.get('/series/:slug/champions', async (req, res) => {
  try {
    res.set('Cache-Control', 'no-store, no-cache, must-revalidate');
    const r = await discipline.seriesChampions(req.params.slug);
    if (!r) return res.status(400).json({ error: 'série inválida' });
    res.json(r);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Lista pública (vitrine) — torneios públicos abertos/em andamento
router.get('/', async (req, res) => {
  try {
    const where = { ...access.LISTED_WHERE }; // só público e não arquivado (não listado/privado fora)
    if (req.query.sport) where.sport = req.query.sport;
    if (req.query.status) where.status = req.query.status;
    if (req.query.storeId) where.storeId = req.query.storeId;
    // Liga F5: com ?cursor (ou ?paged=1) → página por cursor estável { tournaments, nextCursor }.
    // Sem cursor: resposta antiga (até ?limit, máx. 100), agora com nextCursor quando há mais.
    const page = pageOf(req, res, { defaultLimit: 50, maxLimit: 100 });
    if (!page) return;
    const r = await pag.findPage(prisma.tournament, { where, include: { _count: { select: { entries: true } } } }, pag.VITRINE_SPEC, page);
    res.json({ tournaments: r.items, nextCursor: r.nextCursor });
  } catch (err) {
    if (pag.sendPageError(res, err)) return; // Liga F5: cursor inválido = 400
    res.status(500).json({ error: err.message });
  }
});

// Detalhe público do torneio (por slug ou id)
router.get('/:idOrSlug', async (req, res) => {
  try {
    const t = await access.loadVisibleTournament(req, req.params.idOrSlug, {
      include: {
        categories: { include: { _count: { select: { entries: true } } } },
        _count: { select: { entries: true, matches: true } },
      },
    });
    if (!t) return access.sendNotFound(res); // não existe, arquivado ou privado sem acesso: MESMO 404
    res.json(t);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Edita torneio (só dono)
router.patch('/:id', authMiddleware, onlyWhen(hasBody('bannerUrl'), limits.upload), async (req, res) => {
  try {
    const t = await loadForAction(req, res, req.params.id, 'MANAGE_TOURNAMENT', {}, 'só a organização (fundador/coordenador) edita este torneio');
    if (!t) return;
    const b = req.body || {};
    const data = {};
    for (const f of ['name', 'description', 'rules', 'city', 'state', 'prizeDescription']) {
      if (b[f] !== undefined) data[f] = b[f];
    }
    if (!cleanText(res, t, [{ field: 'tournament', value: data.name }, { field: 'text', value: [data.description, data.rules, data.prizeDescription, data.city].filter(Boolean) }])) return;
    if (b.bannerUrl !== undefined) {
      const bn = await storeImage(req, res, b.bannerUrl, { maxChars: 800000 }, { tournament: t });
      if (!bn.ok) return;
      data.bannerUrl = bn.value;
    }
    if (b.sport && SPORTS.has(b.sport)) data.sport = b.sport;
    if (b.format && FORMATS.has(b.format)) data.format = b.format;
    if (b.isDoubles !== undefined) data.isDoubles = !!b.isDoubles;
    if (b.maxEntries !== undefined) data.maxEntries = b.maxEntries ? Number(b.maxEntries) : null;
    for (const f of ['startDate', 'endDate', 'registrationCloseAt']) {
      if (b[f] !== undefined) data[f] = b[f] ? new Date(b[f]) : null;
    }
    // Exigir árbitro escalado em cada jogo (fundador/coordenador/admin — já passou no MANAGE_TOURNAMENT)
    if (b.requireRefereeAssignment !== undefined) data.requireRefereeAssignment = b.requireRefereeAssignment === true || b.requireRefereeAssignment === 'true';
    if (b.visibility !== undefined) {
      const v = access.normalizeVisibility(b.visibility, null);
      if (!v) return res.status(400).json({ error: 'visibilidade inválida (public | unlisted | private)' });
      data.visibility = v;
    }
    Object.assign(data, seriesData(b));

    // Campos de TenisCash real: só admin/gerente altera (antifraude).
    const touchesCash =
      b.cashEnabled !== undefined || b.entryFeeCash !== undefined || b.prizeCash !== undefined;
    if (touchesCash) {
      if (!cash.isAdmin(req.userRole)) {
        return res.status(403).json({ error: 'só admin/gerente altera inscrição/prêmio em TenisCash' });
      }
      if (b.entryFeeCash !== undefined) data.entryFeeCash = Number(b.entryFeeCash) || 0;
      if (b.prizeCash !== undefined) data.prizeCash = Number(b.prizeCash) || 0;
      if (b.cashEnabled !== undefined) data.cashEnabled = !!b.cashEnabled;
    }

    const updated = await prisma.tournament.update({ where: { id: t.id }, data });
    if (data.requireRefereeAssignment !== undefined && data.requireRefereeAssignment !== !!t.requireRefereeAssignment) {
      await audit.record({ tournamentId: t.id, userId: req.userId, action: 'tournament.refereeRule', entity: 'Tournament', entityId: t.id, before: { requireRefereeAssignment: !!t.requireRefereeAssignment }, after: { requireRefereeAssignment: data.requireRefereeAssignment } });
    }
    if (data.visibility && data.visibility !== (t.visibility || 'public')) {
      await audit.record({ tournamentId: t.id, userId: req.userId, action: 'tournament.visibility', entity: 'Tournament', entityId: t.id, before: { visibility: t.visibility || 'public' }, after: { visibility: data.visibility } });
    }
    res.json(updated);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Muda status do torneio (fundador/coordenador; cancelar com TenisCash = dinheiro → fundador)
router.post('/:id/status', authMiddleware, async (req, res) => {
  try {
    const t = await loadForAction(req, res, req.params.id, 'MANAGE_TOURNAMENT', {}, 'só a organização (fundador/coordenador) muda a situação');
    if (!t) return;
    const status = req.body?.status;
    if (!TOURNAMENT_STATUS.has(status)) return res.status(400).json({ error: 'status inválido' });
    // Cancelar torneio com TenisCash estorna inscrições = movimento de dinheiro → só fundador/admin.
    if (status === 'CANCELED' && t.cashEnabled && !(await roles.can(req.userId, req.userRole, t.id, 'MONEY'))) {
      return res.status(403).json({ error: 'cancelar torneio com TenisCash (estorno) é só do fundador' });
    }
    const updated = await prisma.tournament.update({ where: { id: t.id }, data: { status } });

    // Torneio cancelado → estorna 100% das inscrições pagas em TenisCash.
    let refund = null;
    if (status === 'CANCELED' && t.cashEnabled) {
      try {
        refund = await cash.refundAllEntries(t.id, 'torneio cancelado');
      } catch (e) {
        console.error('[tournaments] refund on cancel', e.message);
      }
    }
    res.json(refund && refund.refunded ? { ...updated, refundedEntries: refund.refunded } : updated);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Paga o prêmio em TenisCash ao campeão (só dono/admin). Idempotente + teto.
router.post('/:id/pay-prize', authMiddleware, async (req, res) => {
  try {
    // Dinheiro = só fundador (ou admin global). Coordenador não paga prêmio.
    const t = await loadForAction(req, res, req.params.id, 'MONEY', {}, 'só o fundador paga o prêmio');
    if (!t) return;
    const r = await cash.payPrize(t.id);
    if (!r.ok) return res.status(400).json(r);
    res.json(r);
  } catch (err) {
    console.error('[tournaments] pay-prize', err);
    res.status(500).json({ error: err.message });
  }
});

// =====================================================================
// Liga Aberta F7 — TenisCash POR CONQUISTA (título, vice, artilharia)
// Rascunho do fundador; só paga com cashEnabled (que só o admin global liga).
// =====================================================================
// Painel: regras, travas, prévia por categoria e o que já foi pago (fundador/coordenador/admin).
router.get('/:id/cash-rules', authMiddleware, async (req, res) => {
  try {
    res.set('Cache-Control', 'no-store');
    const t = await loadForAction(req, res, req.params.id, 'MANAGE_TOURNAMENT', {}, 'só a organização vê o TenisCash por conquista');
    if (!t) return;
    res.json(await cashRules.view({ userId: req.userId, userRole: req.userRole }, t));
  } catch (e) { if (f7Err(res, e)) return; console.error('[tournaments] cash-rules', e); res.status(500).json({ error: 'erro ao carregar as regras' }); }
});
// Grava o rascunho (dinheiro = só fundador/admin; com TenisCash ligado, só o admin global).
router.put('/:id/cash-rules', authMiddleware, async (req, res) => {
  try {
    const t = await loadForAction(req, res, req.params.id, 'MONEY', {}, 'só o fundador mexe no TenisCash por conquista');
    if (!t) return;
    res.json(await cashRules.saveRules({ userId: req.userId, userRole: req.userRole }, t, (req.body || {}).rules));
  } catch (e) { if (f7Err(res, e)) return; console.error('[tournaments] cash-rules save', e); res.status(500).json({ error: 'erro ao salvar as regras' }); }
});
// Paga o que falta (idempotente; tetos por conquista e por torneio). body { categoryId?, confirm:true }
router.post('/:id/cash-rules/pay', authMiddleware, limits.cashPay, async (req, res) => {
  try {
    const t = await loadForAction(req, res, req.params.id, 'MONEY', {}, 'só o fundador paga TenisCash por conquista');
    if (!t) return;
    const b = req.body || {};
    res.json(await cashRules.pay({ userId: req.userId, userRole: req.userRole }, t.id, { categoryId: b.categoryId || null, confirm: b.confirm }));
  } catch (e) { if (f7Err(res, e)) return; console.error('[tournaments] cash-rules pay', e); res.status(500).json({ error: 'erro ao pagar — nada foi creditado' }); }
});

// =====================================================================
// CATEGORIAS
// =====================================================================

// Cria categoria (só dono)
router.post('/:id/categories', authMiddleware, async (req, res) => {
  try {
    const t = await loadForAction(req, res, req.params.id, 'MANAGE_TOURNAMENT', {}, 'só a organização cria categoria');
    if (!t) return;
    const b = req.body || {};
    if (!b.name) return res.status(400).json({ error: 'name obrigatório' });
    if (!cleanText(res, t, [{ field: 'category', value: [b.name, b.levelLabel].filter(Boolean) }])) return;
    // Liga F5: categorias por torneio (plano do dono do torneio; torneio antigo não é limitado)
    if (!(await plans.guard(res, 'category', { actorId: req.userId, actorRole: req.userRole, tournament: t }))) return;
    const rules = categoryRulesData({ tiebreakers: b.tiebreakers, doubleRound: b.doubleRound, suspensionRule: b.suspensionRule, formatConfig: b.formatConfig });
    if (rules.error) return res.status(400).json({ error: rules.error });
    // Liga F3: categoria NOVA grava a regra do jogo (padrão do esporte + o que veio).
    const gr = b.gameRules !== undefined && b.gameRules !== null ? gameRules.normalizeGameRules(b.gameRules) : { data: {} };
    if (gr.error) return res.status(400).json({ error: gr.error });
    rules.data.gameRules = gameRules.defaultsFor(t.sport, gr.data);
    const cat = await prisma.tournamentCategory.create({
      data: {
        tournamentId: t.id,
        name: b.name,
        gender: ['M', 'F', 'MIXED', 'OPEN'].includes(b.gender) ? b.gender : 'OPEN',
        levelLabel: b.levelLabel || null,
        format: FORMATS.has(b.format) ? b.format : null,
        pointsWin: b.pointsWin !== undefined ? Number(b.pointsWin) : 3,
        pointsDraw: b.pointsDraw !== undefined ? Number(b.pointsDraw) : 1,
        pointsLoss: b.pointsLoss !== undefined ? Number(b.pointsLoss) : 0,
        ...rules.data,
      },
    });
    res.status(201).json(cat);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Lista categorias (público)
router.get('/:id/categories', async (req, res) => {
  try {
    const t = await access.loadVisibleTournament(req, req.params.id, { select: { id: true, sport: true } });
    if (!t) return access.sendNotFound(res);
    const list = await prisma.tournamentCategory.findMany({
      where: { tournamentId: t.id },
      include: { _count: { select: { entries: true, matches: true } } },
    });
    list.forEach((c) => { c.rules = gameRules.resolveRules(c, t.sport); }); // Liga F3: regra efetiva do jogo
    res.json({ categories: list });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Edita regras/formato da categoria (só dono): formato, ida/volta, critérios de
// desempate (ordem), regra de suspensão, config (rodadas do suíço, reset da
// dupla eliminação). Mudar desempate recalcula a classificação na hora.
router.patch('/:id/categories/:catId', authMiddleware, async (req, res) => {
  try {
    const t = await loadForAction(req, res, req.params.id, 'MANAGE_TOURNAMENT', {}, 'só a organização edita a categoria');
    if (!t) return;
    const cat = await prisma.tournamentCategory.findFirst({ where: { id: req.params.catId, tournamentId: t.id } });
    if (!cat) return res.status(404).json({ error: 'categoria não encontrada' });
    const b = req.body || {};
    const rules = categoryRulesData(b);
    if (rules.error) return res.status(400).json({ error: rules.error });
    const data = { ...rules.data };
    // Liga F3: regras do jogo. null = volta ao comportamento antigo (legado). Objeto = mescla
    // com a regra atual (categoria antiga sem regra parte do LEGADO, não do padrão do esporte).
    if (b.gameRules !== undefined) {
      if (b.gameRules === null) data.gameRules = null;
      else {
        const gr = gameRules.normalizeGameRules(b.gameRules);
        if (gr.error) return res.status(400).json({ error: gr.error });
        const cur = gameRules.resolveRules(cat, t.sport);
        const base = { periods: cur.periods, minutesPerPeriod: cur.minutesPerPeriod, playersOnField: cur.playersOnField, maxRoster: cur.maxRoster, foulLimit: cur.foulLimit, foulText: cur.foulText, foulWarnText: cur.foulWarnText, events: cur.events };
        data.gameRules = { ...base, ...gr.data };
      }
    }
    if (b.name !== undefined && String(b.name).trim()) data.name = String(b.name).trim().slice(0, 80);
    if (b.levelLabel !== undefined) data.levelLabel = b.levelLabel || null;
    if (!cleanText(res, t, [{ field: 'category', value: [data.name, data.levelLabel].filter(Boolean) }])) return;
    if (b.gender !== undefined && ['M', 'F', 'MIXED', 'OPEN'].includes(b.gender)) data.gender = b.gender;
    const generated = await prisma.tournamentMatch.count({ where: { categoryId: cat.id } });
    if (b.format !== undefined) {
      if (b.format !== null && b.format !== '' && !FORMATS.has(b.format)) return res.status(400).json({ error: 'formato inválido' });
      // Compara o formato EFETIVO (categoria sem formato herda o do torneio).
      const effOld = cat.format || t.format;
      const effNew = b.format || t.format;
      if (effNew !== effOld) {
        // formato só muda ANTES de gerar a chave (senão a tabela fica incoerente)
        if (generated) return res.status(409).json({ error: 'a chave já foi gerada — gere de novo depois de trocar o formato' });
        data.format = b.format || null;
      }
    }
    if (data.doubleRound !== undefined && data.doubleRound !== cat.doubleRound && generated) {
      return res.status(409).json({ error: 'a tabela já foi gerada — ida e volta vale ao gerar de novo' });
    }
    const updated = await prisma.tournamentCategory.update({ where: { id: cat.id }, data });
    updated.rules = gameRules.resolveRules(updated, t.sport);
    if (data.gameRules !== undefined) {
      await audit.record({ tournamentId: t.id, userId: req.userId, action: 'category.rules', entity: 'TournamentCategory', entityId: cat.id, before: { gameRules: cat.gameRules ?? null }, after: { gameRules: data.gameRules } });
    }
    if (generated && (data.tiebreakers !== undefined || data.pointsWin !== undefined || data.pointsDraw !== undefined || data.pointsLoss !== undefined)) {
      await engine.recomputeStandings(cat.id).catch((e) => console.error('[tournaments] recompute', e.message));
    }
    res.json(updated);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// =====================================================================
// INSCRIÇÕES
// =====================================================================

// Inscreve uma entry (atleta, dupla ou time).
// Permissão (Liga Aberta F0 — antes qualquer logado inscrevia em qualquer torneio):
//  - MANAGE_TOURNAMENT (fundador/coordenador/admin global): inscreve qualquer
//    time/atleta, inclusive terceiros via memberUserIds/memberUsernames.
//  - usuário comum: só com inscrições ABERTAS (status OPEN/ONGOING e antes de
//    registrationCloseAt), só a SI MESMO ou o PRÓPRIO time (vira admin do time),
//    nunca terceiros. Entra como PENDING (o organizador aprova; a cobrança em
//    TenisCash, se houver, acontece na aprovação). Dupla: usar /entries/request.
router.post('/:id/entries', authMiddleware, entryLimitUnlessManager, async (req, res) => {
  try {
    // privado: só membro (ou organização) chega aqui; arquivado/inexistente = 404
    const t = await access.loadVisibleTournament(req, req.params.id);
    if (!t || t.id !== req.params.id) return access.sendNotFound(res);
    const b = req.body || {};
    if (!b.categoryId) return res.status(400).json({ error: 'categoryId obrigatório' });

    const cat = await prisma.tournamentCategory.findFirst({
      where: { id: b.categoryId, tournamentId: t.id },
    });
    if (!cat) return res.status(400).json({ error: 'categoria não pertence a este torneio' });
    // Liga F5: times por categoria (plano do dono do torneio; torneio antigo não é limitado)
    if (!(await plans.guard(res, 'team', { actorId: req.userId, actorRole: req.userRole, tournament: t, categoryId: cat.id }))) return;

    const manager = await roles.can(req.userId, req.userRole, t.id, 'MANAGE_TOURNAMENT');
    if (!manager) {
      const open = ['OPEN', 'ONGOING'].includes(t.status)
        && !(t.registrationCloseAt && new Date(t.registrationCloseAt) < new Date());
      if (!open) return res.status(403).json({ error: 'as inscrições deste torneio não estão abertas — só a organização pode inscrever agora' });
    }
    // Cabeça de chave e grupo são decisão da organização.
    const seed = manager && b.seed ? Number(b.seed) : null;
    const groupName = manager ? (b.groupName || null) : null;
    const status = manager ? 'CONFIRMED' : 'PENDING';

    // ---- INSCRIÇÃO DE TIME/CLUBE (sem conta): só o NOME ----
    // Pra torneio de equipes (futsal, society, vôlei...), a inscrição é o CLUBE.
    // Não exige atleta com conta TenisCash. Aciona com { team:true, name:"Clube" }.
    if (b.team === true || b.teamName) {
      const teamName = String(b.teamName || b.name || '').trim().slice(0, 80);
      if (!teamName) return res.status(400).json({ error: 'nome do time obrigatório' });
      if (!cleanText(res, t, [{ field: 'team', value: teamName }])) return;
      const dupName = await prisma.tournamentEntry.findFirst({
        where: { categoryId: cat.id, name: teamName },
      });
      if (dupName) return res.status(409).json({ error: 'já existe um time com esse nome nesta categoria' });
      if (!manager) {
        // Time = clube único entre categorias: quem não organiza não pode "entrar"
        // num clube que já existe no torneio só repetindo o nome — a não ser que
        // já seja ADMIN desse clube (aí está inscrevendo o próprio time em outra categoria).
        // Liga F2: compara pelo nome NORMALIZADO (caixa, acento, espaço) — o mesmo critério
        // que o clube usa; "Cabo Brànco" não pode entrar no clube do "Cabo Branco".
        const key = clubIdentity.normName(teamName);
        const sameClub = (await prisma.tournamentEntry.findMany({ where: { tournamentId: t.id }, select: { id: true, name: true } }))
          .filter((e) => clubIdentity.normName(e.name) === key);
        if (sameClub.length) {
          const isClubAdmin = await prisma.tournamentRole.findFirst({
            where: { tournamentId: t.id, userId: req.userId, role: 'TEAM_ADMIN', entryId: { in: sameClub.map((e) => e.id) } },
            select: { id: true },
          });
          if (!isClubAdmin) return res.status(409).json({ error: 'já existe um time com esse nome neste torneio — peça ao administrador do time para inscrever a categoria' });
        }
      }
      if (t.maxEntries) {
        const count = await prisma.tournamentEntry.count({ where: { tournamentId: t.id } });
        if (count >= t.maxEntries) return res.status(409).json({ error: 'torneio lotado' });
      }
      // Inscrição + papel de admin do time + CLUBE (Liga F2) na MESMA transação:
      // sem papel/clube, sem inscrição. Clube: o mesmo time em outra categoria deste
      // torneio reaproveita o clube; senão o clube escolhido (body.clubId, que a pessoa
      // administra) ou um clube novo com o nome do time. Torneio da lista de exclusão
      // (Futsal Master Cup durante o evento) segue sem clube.
      let teamEntry;
      try {
        teamEntry = await prisma.$transaction(async (tx) => {
          const pick = await clubIdentity.clubForNewTeam(tx, t, {
            teamName, userId: req.userId, userRole: req.userRole, manager,
            requestedClubId: b.clubId ? String(b.clubId) : null, ownerMembership: !manager,
          });
          const created = await tx.tournamentEntry.create({
            data: {
              tournamentId: t.id,
              categoryId: cat.id,
              name: teamName,
              seed,
              groupName,
              status,
              clubId: pick.clubId || null,
            },
            include: { members: true },
          });
          if (!manager) {
            // Quem criou o próprio time vira administrador DESTE time (só desta inscrição).
            await tx.tournamentRole.create({ data: { tournamentId: t.id, userId: req.userId, role: 'TEAM_ADMIN', entryId: created.id } });
          }
          created.clubCreated = !!pick.created;
          return created;
        });
      } catch (e) {
        if (e instanceof clubIdentity.ClubLinkError) return res.status(e.status).json({ error: e.message });
        throw e;
      }
      await clubIdentity.brand(teamEntry);
      if (!manager) {
        try {
          await notify(t.ownerId, { type: 'entry', title: 'Novo pedido de inscrição', body: `${teamName} pediu vaga em "${t.name}". Aprove na categoria.`, link: '#/t/' + t.id }, { waCategory: 'organizer' });
        } catch (_) {}
      }
      return res.status(201).json(teamEntry);
    }

    // resolve membros
    let handles = b.memberUserIds || b.memberUsernames || [];
    if (!Array.isArray(handles)) handles = [handles];
    if (handles.length === 0) handles = [req.userId]; // auto-inscrição

    const memberIds = [];
    for (const h of handles) {
      const uid = await resolveUserId(h);
      if (!uid) return res.status(400).json({ error: `usuário não encontrado: ${h}` });
      if (!memberIds.includes(uid)) memberIds.push(uid);
    }

    if (manager && t.cashEnabled && t.entryFeeCash > 0 && !(await roles.can(req.userId, req.userRole, t.id, 'MONEY'))) {
      return res.status(403).json({ error: 'inscrever com cobrança em TenisCash é só do fundador' });
    }
    if (!manager && memberIds.some((id) => id !== req.userId)) {
      return res.status(403).json({ error: 'você só pode inscrever a si mesmo — para dupla, use "Pedir inscrição" (o organizador aprova)' });
    }

    const need = t.isDoubles ? 2 : 1;
    if (memberIds.length !== need) {
      return res.status(400).json({ error: `esta categoria precisa de ${need} atleta(s) por inscrição` });
    }

    // bloqueia se algum membro já está inscrito na categoria
    const dup = await prisma.entryMember.findFirst({
      where: { userId: { in: memberIds }, entry: { categoryId: cat.id } },
    });
    if (dup) return res.status(409).json({ error: 'atleta já inscrito nesta categoria' });

    if (t.maxEntries) {
      const count = await prisma.tournamentEntry.count({ where: { tournamentId: t.id } });
      if (count >= t.maxEntries) return res.status(409).json({ error: 'torneio lotado' });
    }

    // nome de exibição
    // Liga F6: nome digitado passa pelo filtro; conta de menor não entra pela própria conta
    if (!cleanText(res, t, [{ field: 'name', value: b.name ? String(b.name) : null }])) return;
    for (const mid of memberIds) if (await minors.userDeclaredMinor(mid)) return res.status(403).json({ error: minors.MINOR_JOIN_MSG, code: 'MINOR_UNAVAILABLE' });
    let name = b.name ? String(b.name).trim().slice(0, 80) : '';
    if (!name) {
      const users = await prisma.user.findMany({
        where: { id: { in: memberIds } },
        select: { name: true },
      });
      name = users.map((u) => u.name?.split(' ')[0] || 'Atleta').join(' & ');
    }

    const entry = await prisma.tournamentEntry.create({
      data: {
        tournamentId: t.id,
        categoryId: cat.id,
        name,
        seed,
        groupName,
        status,
        members: { create: memberIds.map((userId) => ({ userId })) },
      },
      include: { members: true },
    });

    if (!manager) {
      try {
        await notify(t.ownerId, { type: 'entry', title: 'Novo pedido de inscrição', body: `${name} pediu vaga em "${t.name}". Aprove na categoria.`, link: '#/t/' + t.id }, { waCategory: 'organizer' });
      } catch (_) {}
      return res.status(201).json(entry);
    }

    // Torneio com TenisCash real → cobra a inscrição na hora (entry nasce CONFIRMED).
    // Se o saldo não cobre, desfaz a inscrição e avisa (nada fica pela metade).
    // Cobrar é DINHEIRO: só fundador/admin (Liga F1). A trava vem antes de criar (abaixo).
    if (t.cashEnabled && t.entryFeeCash > 0) {
      const c = await cash.chargeEntry(entry.id);
      if (!c.ok) {
        await prisma.tournamentEntry.delete({ where: { id: entry.id } }).catch(() => {});
        return res.status(402).json({ error: c.error });
      }
      if (c.charged) entry.entryPaid = true;
    }

    res.status(201).json(entry);
  } catch (err) {
    console.error('[tournaments] entry', err);
    res.status(500).json({ error: err.message });
  }
});

// Lista inscritos (público)
router.get('/:id/entries', async (req, res) => {
  try {
    const t = await access.loadVisibleTournament(req, req.params.id, { select: { id: true } });
    if (!t) return access.sendNotFound(res);
    const where = { tournamentId: t.id };
    if (req.query.categoryId) where.categoryId = req.query.categoryId;
    const list = await prisma.tournamentEntry.findMany({
      where,
      orderBy: [{ seed: 'asc' }, { createdAt: 'asc' }],
      include: {
        members: { include: { user: { select: { id: true, name: true, username: true } } } },
        category: { select: { id: true, name: true } },
      },
    });
    await clubIdentity.brand(list); // Liga F2: nome/escudo/cores do clube
    res.json({ entries: list });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Remove inscrição (dono do torneio ou o próprio atleta)
router.delete('/entries/:entryId', authMiddleware, async (req, res) => {
  try {
    const entry = await prisma.tournamentEntry.findUnique({
      where: { id: req.params.entryId },
      include: { members: true, tournament: { select: { ownerId: true, status: true, cashEnabled: true, archivedAt: true } } },
    });
    if (!entry || entry.tournament.archivedAt) return res.status(404).json({ error: 'inscrição não encontrada' });
    // organização (fundador/coordenador/admin) OU o próprio atleta da inscrição.
    // Torneio com TenisCash: a organização tirar a inscrição (estorno) é DINHEIRO → fundador.
    const isSelf = entry.members.some((m) => m.userId === req.userId);
    if (!isSelf && !(await roles.can(req.userId, req.userRole, entry.tournamentId, 'MANAGE_TOURNAMENT'))) {
      return res.status(403).json({ error: 'sem permissão' });
    }
    if (!isSelf && entry.tournament.cashEnabled && !(await roles.can(req.userId, req.userRole, entry.tournamentId, 'MONEY'))) {
      return res.status(403).json({ error: 'remover inscrição de torneio com TenisCash (estorno) é só do fundador' });
    }

    // Estorno 100% da inscrição em TenisCash SE ainda não começou (DRAFT/OPEN).
    // Depois de começar (ONGOING/FINISHED) não há estorno (política padrão).
    let refunded = false;
    if (entry.entryPaid && entry.tournament.cashEnabled && ['DRAFT', 'OPEN'].includes(entry.tournament.status)) {
      try {
        const r = await cash.refundEntry(entry.id, 'inscrição removida');
        refunded = !!r.refunded;
      } catch (e) {
        console.error('[tournaments] refund on delete', e.message);
      }
    }

    // Papéis presos a esta inscrição (admin/treinador/jogador do time) saem junto.
    await prisma.$transaction([
      prisma.tournamentRole.deleteMany({ where: { tournamentId: entry.tournamentId, entryId: entry.id } }),
      prisma.tournamentEntry.delete({ where: { id: entry.id } }),
    ]);
    res.json({ ok: true, refunded });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Inscrição PÚBLICA (estilo formulário do CopaFácil): o atleta logado pede
// vaga e a inscrição entra como PENDING até o organizador aprovar.
router.post('/:id/entries/request', authMiddleware, entryLimitUnlessManager, async (req, res) => {
  try {
    const t = await access.loadVisibleTournament(req, req.params.id);
    if (!t || t.id !== req.params.id) return access.sendNotFound(res);
    if (!['OPEN', 'ONGOING'].includes(t.status)) {
      return res.status(409).json({ error: 'as inscrições não estão abertas' });
    }
    if (t.registrationCloseAt && new Date(t.registrationCloseAt) < new Date()) {
      return res.status(409).json({ error: 'inscrições encerradas' });
    }
    const b = req.body || {};
    if (!b.categoryId) return res.status(400).json({ error: 'categoryId obrigatório' });
    const cat = await prisma.tournamentCategory.findFirst({
      where: { id: b.categoryId, tournamentId: t.id },
    });
    if (!cat) return res.status(400).json({ error: 'categoria não pertence a este torneio' });

    const memberIds = [req.userId];
    if (t.isDoubles) {
      const partner = await resolveUserId(b.partner || b.partnerUsername || b.partnerId);
      if (!partner) return res.status(400).json({ error: 'informe o parceiro de dupla (@username)' });
      if (partner === req.userId) return res.status(400).json({ error: 'o parceiro não pode ser você' });
      memberIds.push(partner);
    }

    const dup = await prisma.entryMember.findFirst({
      where: { userId: { in: memberIds }, entry: { categoryId: cat.id } },
    });
    if (dup) return res.status(409).json({ error: 'já existe inscrição com esse(s) atleta(s) nesta categoria' });

    if (t.maxEntries) {
      const count = await prisma.tournamentEntry.count({ where: { tournamentId: t.id } });
      if (count >= t.maxEntries) return res.status(409).json({ error: 'torneio lotado' });
    }

    let name = b.name ? String(b.name).trim().slice(0, 80) : b.name;
    // Liga F6: filtro no nome + conta de menor não entra pela própria conta
    if (!cleanText(res, t, [{ field: 'name', value: name || null }])) return;
    for (const mid of memberIds) if (await minors.userDeclaredMinor(mid)) return res.status(403).json({ error: minors.MINOR_JOIN_MSG, code: 'MINOR_UNAVAILABLE' });
    if (!name) {
      const users = await prisma.user.findMany({ where: { id: { in: memberIds } }, select: { name: true } });
      name = users.map((u) => u.name?.split(' ')[0] || 'Atleta').join(' & ');
    }

    const entry = await prisma.tournamentEntry.create({
      data: {
        tournamentId: t.id,
        categoryId: cat.id,
        name,
        status: 'PENDING',
        members: { create: memberIds.map((userId) => ({ userId })) },
      },
      include: { members: true },
    });
    try {
      await notify(t.ownerId, {
        type: 'entry',
        title: 'Novo pedido de inscrição',
        body: `${name} pediu vaga em "${t.name}". Aprove na categoria.`,
        link: '#/t/' + t.id,
      }, { waCategory: 'organizer' });
    } catch (_) {}
    res.status(201).json(entry);
  } catch (err) {
    console.error('[tournaments] request entry', err);
    res.status(500).json({ error: err.message });
  }
});

// Aprova uma inscrição pendente → CONFIRMED (só dono/admin)
router.post('/entries/:entryId/approve', authMiddleware, async (req, res) => {
  try {
    const entry = await prisma.tournamentEntry.findUnique({
      where: { id: req.params.entryId },
      include: { tournament: { select: { ownerId: true, cashEnabled: true, entryFeeCash: true } }, _count: { select: { members: true } } },
    });
    if (!entry) return res.status(404).json({ error: 'inscrição não encontrada' });
    if (!(await allow(req, res, entry.tournamentId, 'MANAGE_TOURNAMENT', {}, 'só a organização (fundador/coordenador) aprova'))) return;
    // aprovar em torneio com TenisCash COBRA a inscrição = dinheiro → só fundador/admin
    if (entry.tournament.cashEnabled && !(await roles.can(req.userId, req.userRole, entry.tournamentId, 'MONEY'))) {
      return res.status(403).json({ error: 'aprovar inscrição de torneio com TenisCash (cobrança) é só do fundador' });
    }

    // Torneio com TenisCash real → cobra ANTES de confirmar. Saldo insuficiente
    // = não confirma (fica PENDING), nada pela metade. Inscrição de TIME (sem
    // membros com conta) não é cobrada — como era antes da Liga F0.
    const hasMembers = !!(entry._count && entry._count.members > 0);
    if (hasMembers && entry.tournament.cashEnabled && entry.tournament.entryFeeCash > 0 && !entry.entryPaid) {
      const c = await cash.chargeEntry(entry.id);
      if (!c.ok) return res.status(402).json({ error: c.error });
    }

    const updated = await prisma.tournamentEntry.update({
      where: { id: entry.id },
      data: { status: 'CONFIRMED' },
    });
    try {
      const ids = await entryMemberIds(entry.id);
      await notifyMany(ids, {
        type: 'entry',
        title: 'Inscrição confirmada ✅',
        body: 'O organizador confirmou sua inscrição. Bora jogar!',
        link: '#/t/' + entry.tournamentId,
      });
    } catch (_) {}
    res.json(updated);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Define/ajusta o grupo (A/B/...) de uma inscrição (só dono/admin).
// Usado pra montar grupos pré-definidos antes de gerar os jogos.
router.post('/entries/:entryId/group', authMiddleware, async (req, res) => {
  try {
    const entry = await prisma.tournamentEntry.findUnique({
      where: { id: req.params.entryId },
      include: { tournament: { select: { ownerId: true } } },
    });
    if (!entry) return res.status(404).json({ error: 'inscrição não encontrada' });
    if (!(await allow(req, res, entry.tournamentId, 'MANAGE_TOURNAMENT', {}, 'só a organização define os grupos'))) return;
    const groupName = req.body?.groupName ? String(req.body.groupName).trim().slice(0, 8) : null;
    const updated = await prisma.tournamentEntry.update({
      where: { id: entry.id },
      data: { groupName },
    });
    res.json(updated);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// =====================================================================
// CHAVEAMENTO / PARTIDAS
// =====================================================================

// Regerar chave APAGA jogos (e resultados). Liga F1:
//  - já existe jogo → exige body.confirm === true (senão 409 CONFIRM_REQUIRED)
//  - já existe jogo ENCERRADO → bloqueia (409 HAS_RESULTS), a não ser com a
//    confirmação reforçada do fundador: body.confirm === 'APAGAR RESULTADOS'
//    + ação REGENERATE_FORCE (fundador/admin). Tudo vai pra auditoria.
const FORCE_PHRASE = 'APAGAR RESULTADOS';
async function regenGuard(req, res, t, where) {
  const b = req.body || {};
  const existing = await prisma.tournamentMatch.count({ where });
  const finished = existing ? await prisma.tournamentMatch.count({ where: { ...where, status: { in: ['FINISHED', 'WALKOVER'] } } }) : 0;
  if (!existing) return { existing, finished, forced: false };
  if (b.confirm !== true && b.confirm !== FORCE_PHRASE) {
    res.status(409).json({ code: 'CONFIRM_REQUIRED', existingMatches: existing, finishedMatches: finished, error: `isso apaga os ${existing} jogo(s) já gerados — confirme para gerar de novo` });
    return null;
  }
  if (finished > 0) {
    if (b.confirm !== FORCE_PHRASE) {
      res.status(409).json({ code: 'HAS_RESULTS', existingMatches: existing, finishedMatches: finished, error: `já existem ${finished} jogo(s) encerrado(s) — gerar de novo apaga os resultados. Só o fundador pode, digitando "${FORCE_PHRASE}"` });
      return null;
    }
    if (!(await roles.can(req.userId, req.userRole, t.id, 'REGENERATE_FORCE'))) {
      res.status(403).json({ code: 'FOUNDER_ONLY', error: 'só o fundador pode apagar resultados e gerar a chave de novo' });
      return null;
    }
    return { existing, finished, forced: true };
  }
  return { existing, finished, forced: false };
}

// Gera o chaveamento de uma categoria (fundador/coordenador). Regerar exige confirmação.
router.post('/:id/categories/:catId/generate', authMiddleware, async (req, res) => {
  try {
    const t = await loadForAction(req, res, req.params.id, 'MANAGE_TOURNAMENT', {}, 'só a organização gera a chave');
    if (!t) return;
    const cat = await prisma.tournamentCategory.findFirst({
      where: { id: req.params.catId, tournamentId: t.id },
    });
    if (!cat) return res.status(404).json({ error: 'categoria não encontrada' });

    const g = await regenGuard(req, res, t, { categoryId: cat.id });
    if (!g) return;
    const r = await engine.generateFixtures(cat.id, { groupCount: req.body?.groupCount });
    if (!r.ok) return res.status(400).json(r);
    await audit.record({
      tournamentId: t.id, userId: req.userId, action: 'bracket.generate', entity: 'TournamentCategory', entityId: cat.id,
      before: { matches: g.existing, finishedMatches: g.finished },
      after: { matchesCreated: r.matchesCreated ?? null, deletedMatches: g.existing, deletedFinished: g.finished, forced: g.forced, groupCount: r.groupCount ?? null },
    });

    // ao gerar a primeira chave, marca torneio como ONGOING
    if (t.status === 'DRAFT' || t.status === 'OPEN') {
      await prisma.tournament.update({ where: { id: t.id }, data: { status: 'ONGOING' } });
    }
    res.json(r);
  } catch (err) {
    console.error('[tournaments] generate', err);
    res.status(500).json({ error: err.message });
  }
});

// GROUPS_KNOCKOUT — fase final: monta o mata-mata com os classificados da
// fase de grupos (só dono). Exige a fase de grupos concluída.
router.post('/:id/categories/:catId/knockout', authMiddleware, async (req, res) => {
  try {
    const t = await loadForAction(req, res, req.params.id, 'MANAGE_TOURNAMENT', {}, 'só a organização monta o mata-mata');
    if (!t) return;
    const cat = await prisma.tournamentCategory.findFirst({
      where: { id: req.params.catId, tournamentId: t.id },
    });
    if (!cat) return res.status(404).json({ error: 'categoria não encontrada' });

    // remontar o mata-mata apaga o mata-mata anterior → mesma trava da chave
    const g = await regenGuard(req, res, t, { categoryId: cat.id, stage: { notIn: ['GROUP'] } });
    if (!g) return;
    const r = await engine.generateKnockoutFromGroups(cat.id, req.body?.qualifiersPerGroup || 2);
    if (!r.ok) return res.status(400).json(r);
    await audit.record({
      tournamentId: t.id, userId: req.userId, action: 'bracket.knockout', entity: 'TournamentCategory', entityId: cat.id,
      before: { matches: g.existing, finishedMatches: g.finished },
      after: { matchesCreated: r.matchesCreated ?? null, deletedMatches: g.existing, deletedFinished: g.finished, forced: g.forced, qualifiers: r.qualifiers ?? null },
    });
    res.json(r);
  } catch (err) {
    console.error('[tournaments] knockout', err);
    res.status(500).json({ error: err.message });
  }
});

// SUÍÇO — gera a próxima rodada (pareamento por pontuação, sem repetir confronto).
router.post('/:id/categories/:catId/swiss-next', authMiddleware, async (req, res) => {
  try {
    const t = await loadForAction(req, res, req.params.id, 'MANAGE_TOURNAMENT', {}, 'só a organização gera a rodada');
    if (!t) return;
    const cat = await prisma.tournamentCategory.findFirst({ where: { id: req.params.catId, tournamentId: t.id } });
    if (!cat) return res.status(404).json({ error: 'categoria não encontrada' });
    const r = await engine.generateSwissNextRound(cat.id);
    if (!r.ok) return res.status(400).json(r);
    res.json(r);
  } catch (err) {
    console.error('[tournaments] swiss-next', err);
    res.status(500).json({ error: err.message });
  }
});

// Partidas da categoria (público) — agrupadas por rodada
// Categoria tem que ser DESTE torneio e o torneio visível (antes: id de categoria de
// torneio privado vazava por baixo de qualquer torneio público).
async function visibleCategory(req, res) {
  const t = await access.loadVisibleTournament(req, req.params.id, { select: { id: true } });
  if (!t) { access.sendNotFound(res); return null; }
  const cat = await prisma.tournamentCategory.findFirst({ where: { id: req.params.catId, tournamentId: t.id }, select: { id: true } });
  if (!cat) { res.status(404).json({ error: 'categoria não encontrada' }); return null; }
  return cat;
}

router.get('/:id/categories/:catId/matches', async (req, res) => {
  try {
    res.set('Cache-Control', 'no-store, no-cache, must-revalidate');
    const vc = await visibleCategory(req, res);
    if (!vc) return;
    // Liga F5: sem ?limit/?cursor e até o teto seguro → lista inteira, igual a antes (Master Cup
    // e telas atuais). Acima do teto, ou pedindo página → por cursor (rodada, ordem, id) + nextCursor.
    const page = pageOf(req, res, { defaultLimit: 200, maxLimit: 500 });
    if (!page) return;
    const include = {
      homeEntry: { select: { id: true, name: true, seed: true, logoUrl: true } },
      awayEntry: { select: { id: true, name: true, seed: true, logoUrl: true } },
      games: { orderBy: { setNumber: 'asc' } },
    };
    const SAFE = Math.max(50, Number(process.env.LIGA_MATCHES_SAFE_CAP) || 400);
    let matches;
    let nextCursor = null;
    if (!page.paged && (await prisma.tournamentMatch.count({ where: { categoryId: vc.id } })) <= SAFE) {
      matches = await prisma.tournamentMatch.findMany({ where: { categoryId: vc.id }, orderBy: [{ round: 'asc' }, { ordering: 'asc' }], include });
    } else {
      const r = await pag.findPage(prisma.tournamentMatch, { where: { categoryId: vc.id }, include }, pag.MATCH_SPEC, page);
      matches = r.items;
      nextCursor = r.nextCursor;
    }
    // Americano: cada lado é uma DUPLA rotativa — junta o parceiro no nome exibido.
    const partnerIds = [...new Set(matches.flatMap((m) => [m.homeEntry2Id, m.awayEntry2Id]).filter(Boolean))];
    if (partnerIds.length) {
      const ps = await prisma.tournamentEntry.findMany({ where: { id: { in: partnerIds } }, select: { id: true, name: true, logoUrl: true } });
      const by = Object.fromEntries(ps.map((p) => [p.id, p]));
      for (const m of matches) {
        if (m.homeEntry2Id && m.homeEntry && by[m.homeEntry2Id]) {
          m.homeEntry2 = by[m.homeEntry2Id];
          m.homeEntry = { ...m.homeEntry, name: m.homeEntry.name + ' & ' + by[m.homeEntry2Id].name };
        }
        if (m.awayEntry2Id && m.awayEntry && by[m.awayEntry2Id]) {
          m.awayEntry2 = by[m.awayEntry2Id];
          m.awayEntry = { ...m.awayEntry, name: m.awayEntry.name + ' & ' + by[m.awayEntry2Id].name };
        }
      }
    }
    // placar AO VIVO (gols da súmula) + lance a lance (gol/cartão com jogador e minuto)
    try { await live.attachLive(matches); } catch (e) { console.error('[tournaments] attachLive', e.message); }
    await clubIdentity.brandNested(matches); // Liga F2: nome/escudo/cores do clube
    res.json(nextCursor || page.paged ? { matches, nextCursor } : { matches });
  } catch (err) {
    if (pag.sendPageError(res, err)) return; // Liga F5: cursor inválido = 400
    res.status(500).json({ error: err.message });
  }
});

// Classificação da categoria (público)
router.get('/:id/categories/:catId/standings', async (req, res) => {
  try {
    res.set('Cache-Control', 'no-store, no-cache, must-revalidate');
    const vc = await visibleCategory(req, res);
    if (!vc) return;
    const catId = vc.id;
    // Critérios de desempate usados (pra exibir junto da tabela).
    const catRow = await prisma.tournamentCategory.findUnique({
      where: { id: catId },
      include: { tournament: { select: { format: true } } },
    });
    const isAm = !!catRow && (catRow.format || (catRow.tournament && catRow.tournament.format)) === 'AMERICANO';
    const criteria = engine.categoryTiebreakers(catRow, isAm);
    const meta = {
      criteria,
      criteriaLabels: criteria.map((k) => F.TIEBREAK_LABELS[k] || k),
      drawSeed: criteria.includes('DRAW') && catRow ? catRow.tiebreakSeed || null : null,
      pointsLabel: isAm ? 'Games' : 'Pts',
    };
    const standings = await prisma.tournamentStanding.findMany({
      where: { categoryId: catId },
      orderBy: [{ groupName: 'asc' }, { rank: 'asc' }, { points: 'desc' }],
      include: {
        entry: {
          select: {
            id: true,
            name: true,
            logoUrl: true,
            members: { include: { user: { select: { id: true, name: true, username: true } } } },
          },
        },
      },
    });
    if (standings.length) {
      await clubIdentity.brandNested(standings, ['entry']); // Liga F2
      return res.json({ standings, ...meta });
    }

    // Nenhum jogo finalizado ainda → monta a tabela ZERADA com todos os inscritos
    // (pra classificação aparecer desde o início, como todo sistema de torneio).
    const entries = await prisma.tournamentEntry.findMany({
      where: { categoryId: catId, status: 'CONFIRMED' },
      select: { id: true, name: true, logoUrl: true, groupName: true },
    });
    const zero = entries.map((e) => ({
      entryId: e.id, groupName: e.groupName || null, rank: 0,
      played: 0, won: 0, drawn: 0, lost: 0, scoreFor: 0, scoreAgainst: 0, points: 0,
      entry: { id: e.id, name: e.name, logoUrl: e.logoUrl, members: [] },
    }));
    await clubIdentity.brandNested(zero, ['entry']); // Liga F2
    zero.sort((a, b) => (a.groupName || '').localeCompare(b.groupName || '') || a.entry.name.localeCompare(b.entry.name));
    zero.forEach((r, i) => { r.rank = i + 1; });
    res.json({ standings: zero, provisional: true, ...meta });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// =====================================================================
// RESULTADO / PLACAR
// =====================================================================

// Registra resultado de partida. Fundador/coordenador OU o árbitro ESCALADO no jogo.
// Jogo já encerrado: só quem tem CORRECT_RESULT (fundador/coordenador) corrige — auditado.
router.post('/matches/:matchId/result', authMiddleware, async (req, res) => {
  try {
    const match = await prisma.tournamentMatch.findUnique({
      where: { id: req.params.matchId },
      include: { tournament: { select: { id: true, ownerId: true, name: true, slug: true } } },
    });
    if (!match) return res.status(404).json({ error: 'partida não encontrada' });
    if (!(await allow(req, res, match.tournamentId, 'RESULT', { matchId: match.id }, 'só a organização ou o árbitro escalado neste jogo registra o resultado'))) return;
    const closed = sheet.isClosedStatus(match.status);
    if (closed && !(await roles.can(req.userId, req.userRole, match.tournamentId, 'CORRECT_RESULT'))) {
      return res.status(409).json({ code: 'ALREADY_FINISHED', error: 'jogo já encerrado — só a coordenação corrige o resultado' });
    }
    const before = audit.matchSnap(match);
    const r = await engine.applyMatchResult(match.id, req.body || {});
    if (!r.ok) return res.status(400).json(r);
    const after = await prisma.tournamentMatch.findUnique({ where: { id: match.id } });
    await audit.record({ tournamentId: match.tournamentId, userId: req.userId, action: closed ? 'result.correct' : 'result.set', entity: 'TournamentMatch', entityId: match.id, before, after: audit.matchSnap(after) });
    live.emitMatch(match.id, 'end');

    // Liga F4: aviso detalhado (placar + o que mudou no histórico de cada jogador com conta),
    // assíncrono e idempotente (correção = aviso de correção). O torneio da LISTA DE EXCLUSÃO
    // (Futsal Master Cup, em andamento) segue com o aviso antigo, exatamente como antes.
    if (!clubIdentity.isExcludedSlug(match.tournament.slug)) {
      matchNotices.schedule(match.id, { byUserId: req.userId, source: 'result' });
    } else try {
      const ids = [
        ...(match.homeEntryId ? await entryMemberIds(match.homeEntryId) : []),
        ...(match.awayEntryId ? await entryMemberIds(match.awayEntryId) : []),
      ];
      await notifyMany(
        ids,
        {
          type: 'result',
          title: 'Resultado publicado',
          body: `Saiu o placar da sua partida em ${match.tournament.name}.`,
          link: '#/t/' + match.tournamentId,
        },
        req.userId
      );
    } catch (_) {}

    res.json(r);
  } catch (err) {
    console.error('[tournaments] result', err);
    res.status(500).json({ error: err.message });
  }
});

// Placar ao vivo (texto, sem câmera) — atualiza liveState. Organização OU árbitro escalado.
// Não encerra jogo (isso é /result ou /finalize) e não reabre jogo encerrado sem CORRECT_RESULT.
const LIVE_STATUSES = new Set(['LIVE', 'SCHEDULED']);
router.post('/matches/:matchId/live', authMiddleware, async (req, res) => {
  try {
    const match = await prisma.tournamentMatch.findUnique({
      where: { id: req.params.matchId },
      select: { id: true, tournamentId: true, status: true },
    });
    if (!match) return res.status(404).json({ error: 'partida não encontrada' });
    if (!(await allow(req, res, match.tournamentId, 'LIVE', { matchId: match.id }, 'só a organização ou o árbitro escalado neste jogo mexe no ao vivo'))) return;
    const status = req.body?.status || 'LIVE';
    if (!LIVE_STATUSES.has(status)) return res.status(400).json({ error: 'status do ao vivo inválido (LIVE | SCHEDULED) — para encerrar use o resultado/súmula' });
    if (sheet.isClosedStatus(match.status) && !(await roles.can(req.userId, req.userRole, match.tournamentId, 'CORRECT_RESULT'))) {
      return res.status(409).json({ code: 'ALREADY_FINISHED', error: 'jogo já encerrado — só a coordenação reabre' });
    }
    const updated = await prisma.tournamentMatch.update({
      where: { id: match.id },
      data: { liveState: req.body?.liveState ?? null, status },
    });
    if (sheet.isClosedStatus(match.status)) {
      await audit.record({ tournamentId: match.tournamentId, userId: req.userId, action: 'result.reopen', entity: 'TournamentMatch', entityId: match.id, before: { status: match.status }, after: { status } });
    }
    live.emitMatch(match.id, 'update');
    res.json(updated);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Agenda data/hora/quadra de uma partida (só dono). Avisa os atletas.
router.post('/matches/:matchId/schedule', authMiddleware, async (req, res) => {
  try {
    const match = await prisma.tournamentMatch.findUnique({
      where: { id: req.params.matchId },
      include: { tournament: { select: { id: true, ownerId: true, name: true } } },
    });
    if (!match) return res.status(404).json({ error: 'partida não encontrada' });
    if (!(await allow(req, res, match.tournamentId, 'MANAGE_TOURNAMENT', {}, 'só a organização agenda'))) return;
    const b = req.body || {};
    const data = {};
    if (b.scheduledAt !== undefined) data.scheduledAt = ftz.parseLocal(b.scheduledAt);
    if (b.location !== undefined) data.location = b.location ? String(b.location).slice(0, 120) : null;
    const updated = await prisma.tournamentMatch.update({ where: { id: match.id }, data });

    // avisa os atletas das duas entries sobre o agendamento
    try {
      const whenTxt = updated.scheduledAt
        ? new Date(updated.scheduledAt).toLocaleString('pt-BR', {
            day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', timeZone: 'America/Fortaleza',
          })
        : null;
      const parts = [whenTxt, updated.location].filter(Boolean).join(' · ');
      const ids = [
        ...(match.homeEntryId ? await entryMemberIds(match.homeEntryId) : []),
        ...(match.awayEntryId ? await entryMemberIds(match.awayEntryId) : []),
      ];
      await notifyMany(
        ids,
        {
          type: 'schedule',
          title: 'Jogo agendado',
          body: `Sua partida em ${match.tournament.name}${parts ? ': ' + parts : ' foi agendada'}.`,
          link: '#/t/' + match.tournamentId,
        },
        req.userId
      );
    } catch (_) {}

    res.json(updated);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Define/ajusta os times de uma partida (só dono/admin). Usado pros jogos
// "a confirmar" (mata-mata por classificação, jogos por-resultado, erros da
// tabela). Aceita homeEntryId/awayEntryId (ou null pra limpar). Valida que a
// entry pertence à mesma categoria.
router.post('/matches/:matchId/teams', authMiddleware, async (req, res) => {
  try {
    const match = await prisma.tournamentMatch.findUnique({
      where: { id: req.params.matchId },
      include: { tournament: { select: { ownerId: true } } },
    });
    if (!match) return res.status(404).json({ error: 'partida não encontrada' });
    if (!(await allow(req, res, match.tournamentId, 'MANAGE_TOURNAMENT', {}, 'só a organização define os times'))) return;
    const stTeams = await sheetOpenOrCorrector(req, res, { id: match.id, tournamentId: match.tournamentId });
    if (!stTeams) return;
    const b = req.body || {};
    const data = {};
    for (const [field, key] of [['homeEntryId', 'home'], ['awayEntryId', 'away']]) {
      if (b[field] === undefined) continue;
      if (b[field] === null || b[field] === '') { data[field] = null; continue; }
      const e = await prisma.tournamentEntry.findFirst({
        where: { id: String(b[field]), categoryId: match.categoryId },
        select: { id: true },
      });
      if (!e) return res.status(400).json({ error: `time ${key} não pertence a esta categoria` });
      data[field] = e.id;
    }
    if (!Object.keys(data).length) return res.status(400).json({ error: 'informe homeEntryId e/ou awayEntryId' });
    const updated = await prisma.tournamentMatch.update({ where: { id: match.id }, data });
    await audit.record({ tournamentId: match.tournamentId, userId: req.userId, action: stTeams === 'closed' ? 'match.teams.correct' : 'match.teams', entity: 'TournamentMatch', entityId: match.id, before: { homeEntryId: match.homeEntryId, awayEntryId: match.awayEntryId, status: match.status }, after: { homeEntryId: updated.homeEntryId, awayEntryId: updated.awayEntryId } });
    res.json(updated);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// =====================================================================
// SÚMULA DIGITAL + ELENCO + ESTATÍSTICAS (futsal)
// Escritas exigem login + papel (coordenador/árbitro/admin/treinador do time —
// ver tournamentRoles.can). Leituras são públicas.
// =====================================================================

// Elenco de um time (lista) — público
router.get('/entries/:entryId/players', async (req, res) => {
  try {
    const entry = await prisma.tournamentEntry.findUnique({ where: { id: req.params.entryId }, select: { id: true, tournamentId: true } });
    if (!entry || !(await access.canSeeTournamentId(req, entry.tournamentId))) return res.status(404).json({ error: 'time não encontrado' });
    const players = await prisma.rosterPlayer.findMany({
      where: { entryId: entry.id },
      orderBy: [{ number: 'asc' }, { name: 'asc' }],
    });
    res.json({ players });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Adiciona jogador ao elenco (nome + número, opcional goleiro/capitão).
// Permissão: coordenador/fundador/admin OU admin/treinador do PRÓPRIO time.
router.post('/entries/:entryId/players', authMiddleware, async (req, res) => {
  try {
    const entry = await prisma.tournamentEntry.findUnique({ where: { id: req.params.entryId }, select: { id: true, tournamentId: true } });
    if (!entry) return res.status(404).json({ error: 'time não encontrado' });
    if (!(await roles.can(req.userId, req.userRole, entry.tournamentId, 'SET_LINEUP', { entryId: entry.id }))) {
      return res.status(403).json({ error: 'sem permissão (coordenador, admin ou treinador do time)' });
    }
    const b = req.body || {};
    const name = String(b.name || '').trim();
    if (!name) return res.status(400).json({ error: 'nome do jogador obrigatório' });
    const tt = await prisma.tournament.findUnique({ where: { id: entry.tournamentId }, select: { slug: true } });
    if (!cleanText(res, tt, [{ field: 'player', value: name }])) return;
    const role = ['PLAYER', 'COACH', 'ASSISTANT'].includes(String(b.role || '').toUpperCase()) ? String(b.role).toUpperCase() : 'PLAYER';
    // Liga F2: conta na vaga só com vínculo ATIVO no time (igual a /players/:id/link) —
    // senão o gol entraria no histórico de quem não aceitou. Sem vínculo: gere o convite.
    if (b.userId) {
      const en = await prisma.tournamentEntry.findUnique({ where: { id: entry.id }, select: { name: true } });
      if (!(await isActiveMember(entry.tournamentId, en.name, String(b.userId)))) {
        return res.status(400).json({ error: 'esse atleta não tem vínculo ativo com o time — gere o convite da vaga para ele reivindicar' });
      }
      const dupLink = await prisma.rosterPlayer.findFirst({ where: { entryId: entry.id, userId: String(b.userId) }, select: { name: true } });
      if (dupLink) return res.status(409).json({ error: 'essa conta já está ligada a "' + dupLink.name + '" neste time' });
    }
    const data = {
      entryId: entry.id, name: name.slice(0, 80),
      number: b.number != null && b.number !== '' ? Number(b.number) : null,
      isGoalkeeper: !!b.isGoalkeeper, isCaptain: !!b.isCaptain,
      role, started: !!b.started,
      userId: b.userId || null,
    };
    // Liga F3: limite do elenco da categoria (gameRules.maxRoster) vale também na inclusão manual
    // (comissão técnica não conta). Sem limite configurado = como antes.
    const ent = await prisma.tournamentEntry.findUnique({ where: { id: entry.id }, select: { category: { select: { gameRules: true } }, tournament: { select: { sport: true } } } });
    const maxRoster = role === 'PLAYER' ? gameRules.resolveRules(ent && ent.category, ent && ent.tournament && ent.tournament.sport).maxRoster : null;
    let player;
    try {
      player = maxRoster
        ? await prisma.$transaction(async (tx) => {
          await tx.$queryRaw`SELECT "id" FROM "TournamentEntry" WHERE "id" = ${entry.id} FOR UPDATE`;
          const n = await tx.rosterPlayer.count({ where: { entryId: entry.id, role: 'PLAYER' } });
          if (n >= maxRoster) { const e = new Error(`elenco completo (máximo de ${maxRoster} jogadores nesta categoria)`); e.status = 409; throw e; }
          return tx.rosterPlayer.create({ data });
        })
        : await prisma.rosterPlayer.create({ data });
    } catch (e) { if (e.status === 409) return res.status(409).json({ error: e.message, status: 'full' }); throw e; }
    res.status(201).json(player);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Define/limpa o escudo (logo) de um time.
// Permissão: coordenador/fundador/admin OU admin do PRÓPRIO time.
// body { logo: dataURI } ou { logo: null } pra limpar. Guarda data URI pequeno.
router.post('/entries/:entryId/logo', authMiddleware, limits.upload, async (req, res) => {
  try {
    const entry = await prisma.tournamentEntry.findUnique({ where: { id: req.params.entryId }, select: { id: true, name: true, tournamentId: true, clubId: true } });
    if (!entry) return res.status(404).json({ error: 'time não encontrado' });
    // Liga F2: time com clube → editar o escudo = dono/técnico do clube OU MANAGE_TEAM no
    // torneio (este último só se o clube for exclusivo deste torneio). Sem clube: MANAGE_TEAM.
    const clubPerm = entry.clubId ? await clubIdentity.canEditClubViaEntry(req.userId, req.userRole, entry) : null;
    if (clubPerm && !clubPerm.ok) return res.status(clubPerm.status).json({ error: clubPerm.error });
    if (!clubPerm && !(await roles.can(req.userId, req.userRole, entry.tournamentId, 'MANAGE_TEAM', { entryId: entry.id }))) {
      return res.status(403).json({ error: 'sem permissão (coordenador ou admin do time)' });
    }
    const raw = (req.body || {}).logo;
    if (raw != null && typeof raw !== 'string') return res.status(400).json({ error: 'logo inválida (envie uma imagem)' });
    // Liga F0: imagem PNG/JPEG/WEBP real (magic bytes + sharp, máx 4096 px,
    // reencodada até caber em ~800 KB) ou link https:// / caminho do próprio site.
    // Liga F5: enviada → mediaStore ("/media/<sha>.<ext>", 1 objeto mesmo copiado em N inscrições).
    const tOfEntry = await prisma.tournament.findUnique({ where: { id: entry.tournamentId }, select: { id: true, slug: true } });
    const st = await storeImage(req, res, raw, { maxChars: 800000 }, { tournament: tOfEntry });
    if (!st.ok) return;
    const logoUrl = st.value;
    // Liga F2: time com clube → o escudo é do CLUBE (Club.crestUrl), vale em todas as
    // categorias e torneios desse clube. Limpar = limpa o clube e o escudo antigo das inscrições.
    if (entry.clubId) {
      await prisma.club.update({ where: { id: entry.clubId }, data: { crestUrl: logoUrl } });
      await audit.record({ tournamentId: entry.tournamentId, userId: req.userId, action: 'club.update', entity: 'Club', entityId: entry.clubId, after: { crestChanged: true, cleared: !logoUrl, via: clubPerm ? clubPerm.via : null } });
      let cleared = 0;
      if (!logoUrl) cleared = (await prisma.tournamentEntry.updateMany({ where: { clubId: entry.clubId }, data: { logoUrl: null } })).count;
      return res.json({ ok: true, logoUrl, clubId: entry.clubId, savedOn: 'club', entriesCleared: cleared });
    }
    // Sem clube (ex.: Futsal Master Cup): time é UM clube só, em várias categorias → a logo
    // vale em TODAS as inscrições do mesmo time (mesmo nome, mesmo torneio) (dono 2026-11-09).
    const r = await prisma.tournamentEntry.updateMany({
      where: { tournamentId: entry.tournamentId, name: entry.name },
      data: { logoUrl },
    });
    res.json({ ok: true, logoUrl, entriesUpdated: r.count });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// =====================================================================
// Liga Aberta F2 — CLUBE do time (nome, escudo, cores vêm do Club)
// Editar = dono/técnico do clube (ou admin global) OU MANAGE_TEAM no torneio para
// aquele time — este último só se o clube for exclusivo deste torneio.
// body { name?, primaryColor?, secondaryColor?, crestUrl? (null limpa) }
// =====================================================================
router.patch('/entries/:entryId/club', authMiddleware, onlyWhen(hasBody('crestUrl'), limits.upload), async (req, res) => {
  try {
    const entry = await prisma.tournamentEntry.findUnique({ where: { id: req.params.entryId }, select: { id: true, tournamentId: true, clubId: true } });
    if (!entry) return res.status(404).json({ error: 'time não encontrado' });
    const perm = await clubIdentity.canEditClubViaEntry(req.userId, req.userRole, entry);
    if (!perm.ok) return res.status(perm.status).json({ error: perm.error });
    const b = req.body || {};
    const data = {};
    if (b.name !== undefined) {
      const n = String(b.name || '').trim().slice(0, 80);
      if (n.length < 2) return res.status(400).json({ error: 'nome do clube inválido' });
      const tt = await prisma.tournament.findUnique({ where: { id: entry.tournamentId }, select: { slug: true } });
      if (!cleanText(res, tt, [{ field: 'club', value: n }])) return;
      data.name = n;
    }
    for (const k of ['primaryColor', 'secondaryColor']) {
      if (b[k] === undefined) continue;
      if (b[k] === null || b[k] === '') { data[k] = null; continue; }
      if (!/^#[0-9a-fA-F]{6}$/.test(String(b[k]).trim())) return res.status(400).json({ error: 'cor inválida (use #RRGGBB)' });
      data[k] = String(b[k]).trim().toUpperCase();
    }
    if (b.crestUrl !== undefined) {
      if (b.crestUrl != null && typeof b.crestUrl !== 'string') return res.status(400).json({ error: 'escudo inválido (envie uma imagem)' });
      const st = await storeImage(req, res, b.crestUrl, { maxChars: 800000 }); // Liga F5: → mediaStore
      if (!st.ok) return;
      data.crestUrl = st.value;
    }
    if (!Object.keys(data).length) return res.status(400).json({ error: 'nada para alterar' });
    const before = await prisma.club.findUnique({ where: { id: entry.clubId }, select: { name: true, primaryColor: true, secondaryColor: true } });
    const club = await prisma.club.update({ where: { id: entry.clubId }, data, select: { id: true, slug: true, name: true, crestUrl: true, primaryColor: true, secondaryColor: true } });
    if (data.crestUrl === null) await prisma.tournamentEntry.updateMany({ where: { clubId: entry.clubId }, data: { logoUrl: null } });
    await audit.record({ tournamentId: entry.tournamentId, userId: req.userId, action: 'club.update', entity: 'Club', entityId: club.id, before, after: { name: club.name, primaryColor: club.primaryColor, secondaryColor: club.secondaryColor, crestChanged: data.crestUrl !== undefined, via: perm.via } });
    res.json({ ok: true, club });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// =====================================================================
// Liga Aberta F2 — CONVITE DE ELENCO (o jogador reivindica a vaga)
// =====================================================================
function inviteErr(res, e) {
  if (e instanceof rosterInvite.InviteError) { res.status(e.status).json({ error: e.message, ...(e.extra || {}) }); return true; }
  return false;
}
// Gera o link (uso único, validade em dias — padrão 7) + texto pronto de WhatsApp.
// Quem manda é o organizador: o sistema NÃO envia nada sozinho.
router.post('/players/:playerId/invite', authMiddleware, limits.rosterInvite, async (req, res) => {
  try {
    res.status(201).json(await rosterInvite.createInvite({ playerId: req.params.playerId, userId: req.userId, userRole: req.userRole, days: (req.body || {}).days }));
  } catch (e) { if (inviteErr(res, e)) return; res.status(500).json({ error: e.message }); }
});
// O que o jogador vê ao abrir o link (público, sem login).
router.get('/roster-invites/:token', async (req, res) => {
  try {
    res.set('Cache-Control', 'no-store');
    const info = await rosterInvite.inviteInfo(req.params.token);
    if (info.status === 'invalid') return res.status(404).json({ status: 'invalid', error: 'convite inválido' });
    res.json(info);
  } catch (e) { res.status(500).json({ error: e.message }); }
});
// Reivindica a vaga (logado). Uso único.
router.post('/roster-invites/:token/claim', authMiddleware, limits.rosterClaim, async (req, res) => {
  try {
    res.json(await rosterInvite.claim(req.params.token, { userId: req.userId }));
  } catch (e) { if (inviteErr(res, e)) return; res.status(500).json({ error: e.message }); }
});
// Desvincula a conta da vaga: o próprio atleta ou a coordenação. Auditado.
router.post('/players/:playerId/unlink', authMiddleware, async (req, res) => {
  try {
    res.json(await rosterInvite.unlink({ playerId: req.params.playerId, userId: req.userId, userRole: req.userRole, reason: (req.body || {}).reason }));
  } catch (e) { if (inviteErr(res, e)) return; res.status(500).json({ error: e.message }); }
});

// ---------------------------------------------------------------------
// Liga Aberta F3 — LINK DO TIME (o time preenche o próprio elenco)
// ---------------------------------------------------------------------
// Gera (e revoga o anterior) — coordenação ou admin do PRÓPRIO time (can MANAGE_TEAM).
router.post('/entries/:entryId/team-invite', authMiddleware, limits.rosterInvite, async (req, res) => {
  try {
    res.status(201).json(await teamInvite.createInvite({ entryId: req.params.entryId, userId: req.userId, userRole: req.userRole, days: (req.body || {}).days, public: (req.body || {}).public === true }));
  } catch (e) { if (svcErr(res, e)) return; res.status(500).json({ error: e.message }); }
});
// Liga F4: link do time que está NA PÁGINA pública (o único que dá pra recuperar — os outros
// ficam só com o hash). A folha do organizador abre com ele em vez de gerar outro.
router.get('/entries/:entryId/team-invite', authMiddleware, async (req, res) => {
  try {
    res.set('Cache-Control', 'no-store');
    res.json(await teamInvite.currentPublic({ entryId: req.params.entryId, userId: req.userId, userRole: req.userRole }));
  } catch (e) { if (svcErr(res, e)) return; res.status(500).json({ error: e.message }); }
});
// Liga F4: mostrar (ou esconder) o link ativo do time no botão "Entrar neste time" da página
// pública. body { public:true, token } (o token do link ativo) | { public:false }.
router.patch('/entries/:entryId/team-invite', authMiddleware, async (req, res) => {
  try {
    const b = req.body || {};
    res.json(await teamInvite.setPublic({ entryId: req.params.entryId, userId: req.userId, userRole: req.userRole, token: b.token, public: b.public === true }));
  } catch (e) { if (svcErr(res, e)) return; res.status(500).json({ error: e.message }); }
});
// Liga F4: links públicos de "Entrar neste time" (só os times que escolheram mostrar). Leitura
// com a visibilidade do torneio (privado = mesmo 404).
router.get('/:id/join-links', async (req, res) => {
  try {
    res.set('Cache-Control', 'no-store');
    const t = await access.loadVisibleTournament(req, req.params.id, { select: { id: true } });
    if (!t) return access.sendNotFound(res);
    res.json({ links: await teamInvite.publicJoinLinks(t.id) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
// Revoga o link ativo do time.
router.delete('/entries/:entryId/team-invite', authMiddleware, async (req, res) => {
  try {
    res.json(await teamInvite.revokeInvite({ entryId: req.params.entryId, userId: req.userId, userRole: req.userRole }));
  } catch (e) { if (svcErr(res, e)) return; res.status(500).json({ error: e.message }); }
});
// Liga Aberta F7 — "Pedir orçamento de uniforme" (Meta Fardamentos). Quem gerencia o time
// (can MANAGE_TEAM). Gera um lead; o sistema NÃO envia mensagem nenhuma.
router.get('/entries/:entryId/uniform-quote', authMiddleware, async (req, res) => {
  try {
    res.set('Cache-Control', 'no-store');
    res.json(await uniformQuote.status(req.params.entryId, { id: req.userId, role: req.userRole }));
  } catch (e) { if (f7Err(res, e)) return; console.error('[tournaments] uniform-quote', e); res.status(500).json({ error: 'erro ao carregar o pedido' }); }
});
router.post('/entries/:entryId/uniform-quote', authMiddleware, limits.uniformQuote, async (req, res) => {
  try {
    const r = await uniformQuote.request(req.params.entryId, { id: req.userId, role: req.userRole }, req.body || {});
    res.status(r.duplicate ? 200 : 201).json(r);
  } catch (e) { if (f7Err(res, e)) return; console.error('[tournaments] uniform-quote create', e); res.status(500).json({ error: 'erro ao enviar o pedido — tente de novo' }); }
});
// O que a pessoa vê ao abrir o link (público): valid | expired | revoked | full.
router.get('/team-invites/:token', async (req, res) => {
  try {
    res.set('Cache-Control', 'no-store');
    const info = await teamInvite.inviteInfo(req.params.token);
    if (info.status === 'invalid') return res.status(404).json({ status: 'invalid', error: 'link inválido' });
    res.json(info);
  } catch (e) { res.status(500).json({ error: e.message }); }
});
// Entra no elenco do time (logado). Respeita o limite do elenco da categoria.
router.post('/team-invites/:token/join', authMiddleware, limits.rosterClaim, async (req, res) => {
  try {
    res.status(201).json(await teamInvite.join(req.params.token, { userId: req.userId }));
  } catch (e) { if (svcErr(res, e)) return; res.status(500).json({ error: e.message }); }
});

// Liga (ou desliga) um nome do elenco à CONTA do atleta, pra produção dos jogos
// (gols/assistências/cartões da súmula) somar no painel dele. body { userId | null }.
// Permissão: coordenador/admin/treinador do time. Só aceita atleta com vínculo
// ATIVO nesse clube (não liga conta aleatória) e 1 conta = 1 nome por time.
router.post('/players/:playerId/link', authMiddleware, async (req, res) => {
  try {
    const ctx = await roles.playerContext(req.params.playerId);
    if (!ctx || !ctx.entry) return res.status(404).json({ error: 'jogador não encontrado' });
    if (!(await roles.can(req.userId, req.userRole, ctx.entry.tournamentId, 'SET_LINEUP', { entryId: ctx.entry.id }))) {
      return res.status(403).json({ error: 'sem permissão (coordenador, admin ou treinador do time)' });
    }
    const uid = (req.body || {}).userId ? String(req.body.userId) : null;
    // Liga F2: tirar (ou trocar) a conta de uma vaga já ligada é do PRÓPRIO atleta ou da
    // COORDENAÇÃO — admin/treinador do time não desfaz o vínculo de outra pessoa. Auditado.
    const cur = await prisma.rosterPlayer.findUnique({ where: { id: req.params.playerId }, select: { userId: true, minorProfileId: true } });
    // Liga F6: vaga de menor (fluxo do responsável) não recebe conta; conta de menor não entra pela própria conta
    if (uid && cur && cur.minorProfileId) return res.status(409).json({ error: 'vaga de menor: não recebe conta' });
    if (uid && (await minors.userDeclaredMinor(uid))) return res.status(403).json({ error: minors.MINOR_JOIN_MSG, code: 'MINOR_UNAVAILABLE' });
    if (cur && cur.userId && cur.userId !== uid) {
      const self = cur.userId === req.userId && !uid;
      if (!self && !(await roles.can(req.userId, req.userRole, ctx.entry.tournamentId, 'MANAGE_TOURNAMENT'))) {
        return res.status(403).json({ error: 'só o próprio atleta ou a coordenação do campeonato desvincula a conta desta vaga' });
      }
    }
    if (uid) {
      const entry = await prisma.tournamentEntry.findUnique({ where: { id: ctx.entry.id }, select: { name: true, tournamentId: true } });
      if (!(await isActiveMember(entry.tournamentId, entry.name, uid))) {
        return res.status(400).json({ error: 'esse atleta não tem vínculo ativo com o time — convide e espere ele aceitar' });
      }
      const dup = await prisma.rosterPlayer.findFirst({ where: { entryId: ctx.entry.id, userId: uid, NOT: { id: req.params.playerId } }, select: { name: true } });
      if (dup) return res.status(409).json({ error: 'essa conta já está ligada a "' + dup.name + '" neste time' });
    }
    const player = await prisma.rosterPlayer.update({ where: { id: req.params.playerId }, data: { userId: uid } });
    if ((cur && cur.userId) !== uid) {
      await audit.record({ tournamentId: ctx.entry.tournamentId, userId: req.userId, action: uid ? 'roster.link' : 'roster.unlink', entity: 'RosterPlayer', entityId: player.id, before: { userId: (cur && cur.userId) || null }, after: { userId: uid } });
    }
    res.json({ ok: true, player });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Remove jogador do elenco — coordenador/admin/treinador do time.
router.delete('/players/:playerId', authMiddleware, async (req, res) => {
  try {
    const ctx = await roles.playerContext(req.params.playerId);
    if (!ctx || !ctx.entry) return res.json({ ok: true }); // já não existe
    if (!(await roles.can(req.userId, req.userRole, ctx.entry.tournamentId, 'SET_LINEUP', { entryId: ctx.entry.id }))) {
      return res.status(403).json({ error: 'sem permissão (coordenador, admin ou treinador do time)' });
    }
    await prisma.rosterPlayer.delete({ where: { id: req.params.playerId } }).catch(() => {});
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Súmula completa de uma partida (elenco + eventos + placar) — público
router.get('/matches/:matchId/sheet', async (req, res) => {
  try {
    const mc = await roles.matchContext(req.params.matchId);
    if (!mc || !(await access.canSeeTournamentId(req, mc.tournamentId))) return res.status(404).json({ error: 'partida não encontrada' });
    const s = await sheet.buildSheet(req.params.matchId);
    if (!s) return res.status(404).json({ error: 'partida não encontrada' });
    res.json(s);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Súmula FECHADA (jogo encerrado) só muda com CORRECT_RESULT (fundador/coordenador).
// Devolve false (já respondeu 409), 'open' ou 'closed' (correção autorizada → auditar).
async function sheetOpenOrCorrector(req, res, m) {
  const row = await prisma.tournamentMatch.findUnique({ where: { id: m.id }, select: { status: true } });
  const closed = !!(row && sheet.isClosedStatus(row.status));
  if (closed && !(await roles.can(req.userId, req.userRole, m.tournamentId, 'CORRECT_RESULT'))) {
    res.status(409).json({ code: 'ALREADY_FINISHED', error: 'súmula já fechada — só a coordenação corrige' });
    return false;
  }
  return closed ? 'closed' : 'open';
}

// Registra um evento da súmula (gol, assistência, cartão, falta, tempo).
// Permissão: árbitro nomeado pro jogo, árbitro do torneio, coordenador/fundador/admin.
router.post('/matches/:matchId/events', authMiddleware, async (req, res) => {
  try {
    const m = await roles.matchContext(req.params.matchId);
    if (!m) return res.status(404).json({ error: 'jogo não encontrado' });
    if (!(await allow(req, res, m.tournamentId, 'REFEREE', { matchId: m.id }, 'sem permissão (árbitro escalado no jogo ou coordenação)'))) return;
    const stEv = await sheetOpenOrCorrector(req, res, m);
    if (!stEv) return;
    // Quem lança evento já é arbitragem/coordenação → pode liberar suspenso (com motivo auditado).
    const r = await sheet.addEvent(req.params.matchId, req.body || {}, { userId: req.userId, canOverride: true });
    if (!r.ok) return res.status(r.code ? 409 : 400).json(r);
    if (stEv === 'closed') {
      await audit.record({ tournamentId: m.tournamentId, userId: req.userId, action: 'sheet.event.add', entity: 'MatchEvent', entityId: r.event.id, before: null, after: { matchId: m.id, type: r.event.type, entryId: r.event.entryId, playerId: r.event.playerId || null, minute: r.event.minute ?? null } });
    }
    live.emitMatch(req.params.matchId, r.wentLive ? 'start' : 'event', { eventId: r.event.id });
    res.status(201).json(r.event);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Escalação do jogo (por time). Treinador/admin do time OU arbitragem.
// Atleta SUSPENSO é bloqueado; só árbitro/coordenador libera (motivo auditado).
router.post('/matches/:matchId/lineup', authMiddleware, async (req, res) => {
  try {
    const m = await roles.matchContext(req.params.matchId);
    if (!m) return res.status(404).json({ error: 'jogo não encontrado' });
    const entryId = String((req.body || {}).entryId || '');
    const isRef = await roles.can(req.userId, req.userRole, m.tournamentId, 'REFEREE', { matchId: m.id });
    const isTeam = await roles.can(req.userId, req.userRole, m.tournamentId, 'SET_LINEUP', { entryId });
    if (!isRef && !isTeam) return res.status(403).json({ error: 'sem permissão (treinador do time ou arbitragem)' });
    if (!(await sheetOpenOrCorrector(req, res, m))) return;
    const r = await sheet.setLineup(req.params.matchId, req.body || {}, { userId: req.userId, canOverride: isRef });
    if (!r.ok) return res.status(r.code ? 409 : 400).json(r);
    res.json(r);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Remove um evento da súmula — arbitragem do jogo.
router.delete('/events/:eventId', authMiddleware, async (req, res) => {
  try {
    const ctx = await roles.eventContext(req.params.eventId);
    if (!ctx || !ctx.match) return res.json({ ok: true }); // já não existe
    if (!(await allow(req, res, ctx.match.tournamentId, 'REFEREE', { matchId: ctx.match.id }, 'sem permissão (árbitro escalado no jogo ou coordenação)'))) return;
    const stDel = await sheetOpenOrCorrector(req, res, ctx.match);
    if (!stDel) return;
    const evBefore = stDel === 'closed' ? await prisma.matchEvent.findUnique({ where: { id: req.params.eventId } }) : null;
    await sheet.deleteEvent(req.params.eventId);
    if (stDel === 'closed') {
      await audit.record({ tournamentId: ctx.match.tournamentId, userId: req.userId, action: 'sheet.event.remove', entity: 'MatchEvent', entityId: req.params.eventId, before: evBefore && { matchId: evBefore.matchId, type: evBefore.type, entryId: evBefore.entryId, playerId: evBefore.playerId || null, minute: evBefore.minute ?? null }, after: null });
    }
    live.emitMatch(ctx.match.id, 'event_removed', { removedEventId: req.params.eventId });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Grava a arbitragem da partida (árbitro 1/2, mesa) — sem finalizar. Arbitragem do jogo.
router.post('/matches/:matchId/officials', authMiddleware, async (req, res) => {
  try {
    const m = await roles.matchContext(req.params.matchId);
    if (!m) return res.status(404).json({ error: 'jogo não encontrado' });
    if (!(await allow(req, res, m.tournamentId, 'REFEREE', { matchId: m.id }, 'sem permissão (árbitro escalado no jogo ou coordenação)'))) return;
    if (!(await sheetOpenOrCorrector(req, res, m))) return;
    const r = await sheet.setOfficials(req.params.matchId, req.body || {});
    if (!r.ok) return res.status(400).json(r);
    res.json(r);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Fecha a súmula: conta os gols e aplica o placar (classificação + chave).
// Arbitragem do jogo. body opcional: { homePenalties, awayPenalties, referee1, referee2, scorer }
router.post('/matches/:matchId/finalize', authMiddleware, async (req, res) => {
  try {
    const m = await roles.matchContext(req.params.matchId);
    if (!m) return res.status(404).json({ error: 'jogo não encontrado' });
    if (!(await allow(req, res, m.tournamentId, 'REFEREE', { matchId: m.id }, 'sem permissão (árbitro escalado no jogo ou coordenação)'))) return;
    const prev = await prisma.tournamentMatch.findUnique({ where: { id: m.id } });
    const closed = sheet.isClosedStatus(prev && prev.status);
    const corrector = closed && (await roles.can(req.userId, req.userRole, m.tournamentId, 'CORRECT_RESULT'));
    const r = await sheet.finalizeMatch(req.params.matchId, { ...(req.body || {}), allowCorrection: !!corrector });
    if (!r.ok) return res.status(r.code === 409 ? 409 : 400).json(r);
    const after = await prisma.tournamentMatch.findUnique({ where: { id: m.id } });
    await audit.record({ tournamentId: m.tournamentId, userId: req.userId, action: closed ? 'sheet.correct' : 'sheet.finalize', entity: 'TournamentMatch', entityId: m.id, before: audit.matchSnap(prev), after: audit.matchSnap(after) });
    live.emitMatch(req.params.matchId, 'end');
    require('../ai/rede/ganchos').jogoFinalizado(req.params.matchId);
    // Liga F4: aviso aos jogadores (placar + histórico) — assíncrono, best-effort, idempotente
    matchNotices.schedule(req.params.matchId, { byUserId: req.userId, source: 'finalize' });
    res.json(r);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Liga F4 — súmula FECHADA: elenco SEM conta dos dois times + convite por vaga com texto
// pronto e link wa.me. Quem manda é o organizador/árbitro, pelo próprio WhatsApp (o sistema
// não envia nada). GET só lê (recupera os convites já gerados); POST gera os que faltam.
// Ver a lista: árbitro do jogo ou organização. O LINK do convite (que entrega a vaga a uma
// conta) só para quem pode mexer no elenco daquele time — coordenação, admin ou treinador
// (can SET_LINEUP, igual ao convite da F2). Árbitro vê só os nomes.
async function unclaimedCtx(req, res) {
  const m = await roles.matchContext(req.params.matchId);
  if (!m) { res.status(404).json({ error: 'jogo não encontrado' }); return null; } // = guarda do :matchId (privado)
  if (!(await allow(req, res, m.tournamentId, 'REFEREE', { matchId: m.id }, 'sem permissão (árbitro do jogo ou organização)'))) return null;
  const inviteEntryIds = [];
  for (const eid of [m.homeEntryId, m.awayEntryId].filter(Boolean)) {
    if (await roles.can(req.userId, req.userRole, m.tournamentId, 'SET_LINEUP', { entryId: eid })) inviteEntryIds.push(eid);
  }
  return { ...m, inviteEntryIds };
}
router.get('/matches/:matchId/unclaimed', authMiddleware, async (req, res) => {
  try {
    res.set('Cache-Control', 'no-store');
    const m = await unclaimedCtx(req, res); if (!m) return;
    res.json(await matchNotices.unclaimed(m.id, { create: false, actorUserId: req.userId, inviteEntryIds: m.inviteEntryIds }));
  } catch (err) { res.status(500).json({ error: err.message }); }
});
router.post('/matches/:matchId/claim-invites', authMiddleware, limits.rosterInvite, async (req, res) => {
  try {
    const m = await unclaimedCtx(req, res); if (!m) return;
    if (!m.inviteEntryIds.length) return res.status(403).json({ error: 'só a coordenação, o admin ou o treinador do time gera o convite da vaga' });
    const st = await prisma.tournamentMatch.findUnique({ where: { id: m.id }, select: { status: true } });
    if (!sheet.isClosedStatus(st && st.status)) return res.status(409).json({ code: 'NOT_FINISHED', error: 'feche a súmula antes de convidar quem jogou' });
    res.json(await matchNotices.unclaimed(m.id, { create: true, actorUserId: req.userId, inviteEntryIds: m.inviteEntryIds }));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Suspensos (automático, dos jogos encerrados) — público. ?categoryId= opcional.
// suspended: quem NÃO pode jogar (e em quais próximos jogos) · hanging: pendurados.
router.get('/:id/suspensions', async (req, res) => {
  try {
    res.set('Cache-Control', 'no-store, no-cache, must-revalidate');
    const t = await access.loadVisibleTournament(req, req.params.id, { select: { id: true } });
    if (!t) return access.sendNotFound(res);
    const r = await discipline.tournamentSuspensions(t.id, req.query.categoryId || null);
    res.json(r);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Ranking de jogadores (artilharia/assistências/cartões) — público
// kind = scorers | assists | cards · ?categoryId= opcional
router.get('/:id/stats/:kind', async (req, res) => {
  try {
    res.set('Cache-Control', 'no-store, no-cache, must-revalidate');
    const kind = ['scorers', 'assists', 'cards'].includes(req.params.kind) ? req.params.kind : 'scorers';
    // scope=official (padrão): só jogos ENCERRADOS. scope=live: inclui jogos em andamento (linhas marcadas partial).
    const scope = req.query.scope === 'live' ? 'live' : 'official';
    const t = await access.loadVisibleTournament(req, req.params.id, { select: { id: true } });
    if (!t) return access.sendNotFound(res);
    const rows = await sheet.playerStats(t.id, { kind, scope, categoryId: req.query.categoryId || null });
    // Liga F2: nome do time = nome do clube
    const clubs = await clubIdentity.clubsForEntryIds(rows.map((r) => r.entryId));
    if (clubs.size) rows.forEach((r) => { const c = clubs.get(String(r.entryId)); if (c) { r.team = c.name; r.clubSlug = c.slug; } });
    // Liga F5: ?limit/&cursor → página (chave = jogador + time) com nextCursor; sem → tudo (igual a antes)
    const page = pageOf(req, res, { defaultLimit: 30, maxLimit: 200 });
    if (!page) return;
    if (!page.paged) return res.json({ kind, scope, ranking: rows });
    const pg = pag.pageArray(rows, page, (r) => (r.playerId || r.name) + '|' + r.entryId);
    res.json({ kind, scope, ranking: pg.items, total: rows.length, nextCursor: pg.nextCursor });
  } catch (err) {
    if (pag.sendPageError(res, err)) return; // Liga F5: cursor inválido = 400
    res.status(500).json({ error: err.message });
  }
});

// =====================================================================
// NOTIFICAÇÕES IN-APP (central de avisos do atleta)
// =====================================================================

// Minhas notificações (+ contador de não lidas)
router.get('/notifications/mine', authMiddleware, async (req, res) => {
  try {
    const list = await prisma.appNotification.findMany({
      where: { userId: req.userId },
      orderBy: { createdAt: 'desc' },
      take: Math.min(Number(req.query.limit) || 50, 100),
    });
    const unread = await prisma.appNotification.count({ where: { userId: req.userId, read: false } });
    res.json({ notifications: list, unread });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Marca uma como lida
router.post('/notifications/:id/read', authMiddleware, async (req, res) => {
  try {
    const n = await prisma.appNotification.findUnique({ where: { id: req.params.id } });
    if (!n || n.userId !== req.userId) return res.status(404).json({ error: 'notificação não encontrada' });
    await prisma.appNotification.update({ where: { id: n.id }, data: { read: true } });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Marca todas as minhas como lidas
router.post('/notifications/read-all', authMiddleware, async (req, res) => {
  try {
    await prisma.appNotification.updateMany({ where: { userId: req.userId, read: false }, data: { read: true } });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// =====================================================================
// CADASTRO DE ATLETA (sem token) — WhatsApp + CÓDIGO + senha + foto
// Liga Aberta F0: a conta só nasce com o código de 6 dígitos que chegou no
// WhatsApp do próprio telefone (src/services/athleteSignupCode.js).
//   1) POST /athletes/register/start { whatsapp }  → manda o código (10 min)
//   2) POST /athletes/register { name, whatsapp, password, code, ... } → conta + token
// Foto: upload OU automática do Instagram (Business Discovery). WhatsApp é a
// conta (login por telefone). Instagram opcional → @username + foto automática.
// =====================================================================

// Preview da foto do Instagram (sem criar conta) — pra conferir o @.
router.get('/athletes/ig-photo/:handle', async (req, res) => {
  try {
    if (!igConfigured()) return res.json({ configured: false, found: false });
    const prof = await fetchInstagramProfile(req.params.handle);
    if (!prof) return res.json({ configured: true, found: false });
    res.json({ configured: true, found: true, username: prof.username, name: prof.name, picUrl: prof.picUrl });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Passo 1: manda o código de verificação pro WhatsApp. body: { whatsapp }
// Limites: 5 códigos/hora por telefone e 20/hora por IP. Sem canal de envio → 503.
router.post('/athletes/register/start', limits.signupCodeIp, limits.signupCodePhone, async (req, res) => {
  try {
    const b = req.body || {};
    const whatsapp = signupCode.normalizePhone(b.whatsapp || b.phone);
    if (!whatsapp) return res.status(400).json({ error: 'WhatsApp com DDD obrigatório' });
    // Resposta IGUAL com ou sem conta (não revela quem já é cadastrado). Quem já
    // tem conta não recebe código; o conflito só aparece no passo final.
    const existing = await prisma.user.findFirst({ where: { phone: { in: signupCode.phoneVariants(whatsapp) } }, select: { id: true } });
    if (!existing) {
      const r = await signupCode.startSignup(whatsapp);
      if (!r.ok) return res.status(r.status || 503).json({ error: r.error, whatsappDown: !!r.whatsappDown });
    }
    res.json({ ok: true, expiresInSeconds: signupCode.CODE_TTL_MS / 1000, message: 'Se este número puder receber, o código chega no WhatsApp em instantes.' });
  } catch (err) {
    console.error('[tournaments] register start', err);
    res.status(500).json({ error: 'erro ao enviar o código' });
  }
});

// Passo 2: cadastra atleta. body: { name, whatsapp, password, code, instagram?, photo?(dataURI) }
// Conta + perfil + consumo do código numa TRANSAÇÃO: ou nasce tudo e volta o token,
// ou não nasce nada e o código continua valendo.
router.post('/athletes/register', limits.signupIp, async (req, res) => {
  try {
    const b = req.body || {};
    const name = String(b.name || '').trim().slice(0, 100);
    const password = String(b.password || '');
    const whatsapp = signupCode.normalizePhone(b.whatsapp || b.phone);
    if (!name) return res.status(400).json({ error: 'nome obrigatório' });
    if (password.length < 4 || password.length > 20) return res.status(400).json({ error: 'senha deve ter 4 a 20 caracteres' });
    if (!whatsapp) return res.status(400).json({ error: 'WhatsApp com DDD obrigatório' });
    // Liga F6: nome e @ passam pelo filtro de texto ofensivo (antes de gastar o código)
    if (!cleanText(res, null, [{ field: 'name', value: name }, { field: 'handle', value: b.instagram ? String(b.instagram).replace(/^@/, '') : null }])) return;
    // Liga F6: menor de 18 — cadastro só pelo fluxo do responsável (LIGA_MINORS, desligado).
    // Não gravamos a data: só recusamos se ela vier e indicar menor (autodeclaração não vale como prova).
    if (minors.declaresMinor(b.birthDate || b.birthdate)) return res.status(403).json({ error: minors.MINOR_SIGNUP_MSG, code: 'MINOR_SIGNUP_UNAVAILABLE' });
    if (b.code == null || String(b.code).trim() === '') {
      return res.status(400).json({ error: 'informe o código de 6 dígitos enviado no seu WhatsApp', needsCode: true });
    }

    const existing = await prisma.user.findFirst({ where: { phone: { in: signupCode.phoneVariants(whatsapp) } }, select: { id: true } });
    if (existing) return res.status(409).json({ error: 'este WhatsApp já tem conta — entre com sua senha' });

    // Foto enviada: valida ANTES de gastar o código (imagem real, máx 4096 px, ~800 KB).
    let avatar = null;
    if (b.photo != null && b.photo !== '') {
      try { avatar = (await guardImageDataUri(String(b.photo), { maxChars: 800000 })).dataUri; } catch (e) { if (imageError(res, e)) return; throw e; }
    }

    const v = await signupCode.checkSignupCode(whatsapp, b.code);
    if (!v.ok) return res.status(v.status || 400).json({ error: v.error, needsCode: true });

    const igHandle = b.instagram ? String(b.instagram).replace(/^@/, '').trim().slice(0, 30) : null;

    // Foto: upload explícito vence; senão tenta Instagram automático.
    let photoSource = avatar ? 'upload' : 'none';
    let igName = null;
    if (!avatar && igHandle) {
      const ig = await instagramAvatar(igHandle);
      if (ig && ig.avatar) {
        // Liga F5: foto do Instagram também passa pelo imageGuard (antes ia crua pro banco)
        try { avatar = (await guardImageDataUri(String(ig.avatar), { maxChars: 800000 })).dataUri; igName = ig.name; photoSource = 'instagram'; } catch (_) { avatar = null; }
      }
    }
    // Liga F5: a foto vai pro mediaStore — o perfil guarda "/media/<sha>.<ext>", não o base64.
    if (avatar) {
      try { avatar = (await mediaStore.put(avatar, { source: 'upload' })).url; } catch (e) { if (imageError(res, e)) return; throw e; }
    }

    // @username: único em User E em AthleteProfile. Ocupado → a conta nasce sem @
    // (não é erro do cadastro; o atleta escolhe outro depois).
    let username = null;
    let usernameTaken = false;
    if (igHandle) {
      const [u1, p1] = await Promise.all([
        prisma.user.findFirst({ where: { username: { equals: igHandle, mode: 'insensitive' } }, select: { id: true } }),
        prisma.athleteProfile.findFirst({ where: { username: { equals: igHandle, mode: 'insensitive' } }, select: { userId: true } }),
      ]);
      if (u1 || p1) usernameTaken = true; else username = igHandle;
    }

    const hashed = await bcrypt.hash(password, 10);
    // Conta guardada no formato nacional (DDD+número), como o cadastro do app.
    const phoneStored = whatsapp.slice(2);
    const createAll = (handle) => prisma.$transaction(async (tx) => {
      if (!(await signupCode.markSignupCodeUsed(tx, v.rowId))) {
        const e = new Error('código já usado — peça um novo'); e.status = 400; throw e;
      }
      const user = await tx.user.create({
        data: { name, phone: phoneStored, pin: hashed, balance: 0, lgpdAccepted: true, lgpdDate: new Date(), username: handle || undefined },
      });
      await tx.athleteProfile.create({ data: { userId: user.id, username: handle || null, avatarUrl: avatar || null } });
      return user;
    });
    const targetOf = (e) => String((e && e.meta && e.meta.target) || '');
    let user;
    try {
      user = await createAll(username);
    } catch (e) {
      if (e && e.status === 400) return res.status(400).json({ error: e.message, needsCode: true });
      if (e && e.code === 'P2002' && /phone/.test(targetOf(e))) return res.status(409).json({ error: 'este WhatsApp já tem conta — entre com sua senha' });
      if (e && e.code === 'P2002' && /username/.test(targetOf(e)) && username) {
        // corrida no @: cria sem o @ (mesma transação, código ainda não consumido)
        usernameTaken = true; username = null;
        user = await createAll(null);
      } else {
        throw e;
      }
    }

    // Opcional: já pedir pra entrar num time na criação da conta (o time aceita depois).
    let joinedTeam = null;
    if (b.joinTournamentId && b.joinEntryId) {
      const jr = await membership.requestJoin({ tournamentId: String(b.joinTournamentId), entryId: String(b.joinEntryId), userId: user.id }).catch(() => null);
      if (jr && jr.ok) joinedTeam = { requested: !!jr.requested, active: !!jr.activated };
    }

    const token = jwt.sign({ userId: user.id, role: user.role }, JWT_SECRET, { expiresIn: '30d' });
    res.status(201).json({
      token,
      user: { id: user.id, name: user.name, phone: user.phone, username, role: user.role },
      instagram: igHandle, instagramName: igName, usernameTaken,
      photoSource, hasPhoto: !!avatar, joinedTeam,
    });
  } catch (err) {
    if (err && err.code === 'P2002') return res.status(409).json({ error: 'este WhatsApp já tem conta' });
    console.error('[tournaments] register athlete', err);
    res.status(500).json({ error: 'erro ao criar a conta' });
  }
});

// =====================================================================
// CARD DO ATLETA + RANKING
// =====================================================================

// Card do atleta por handle (id, username ou athlete username)
router.get('/athletes/:handle/card', async (req, res) => {
  try {
    const userId = await resolveUserId(req.params.handle);
    // Liga F6: atleta que apagou os dados esportivos não tem mais card/histórico público
    if (!userId || (await require('../services/ligaPrivacy').isErased(userId))) return res.status(404).json({ error: 'atleta não encontrado' });
    // Liga F2: torneio privado só entra para o próprio atleta / membro (login opcional)
    const card = await engine.buildAthleteCard(userId, { viewer: await access.viewer(req) });
    if (!card) return res.status(404).json({ error: 'atleta não encontrado' });
    res.json(card);
  } catch (err) {
    console.error('[tournaments] card', err);
    res.status(500).json({ error: err.message });
  }
});

// Liga F2 — HISTÓRICO do atleta entre ligas (jogos, V/E/D, gols, assistências, cartões,
// títulos; por esporte e por temporada). Público: só torneios públicos; o próprio atleta
// e membros veem também os privados/não listados dele (login opcional).
router.get('/athletes/:handle/history', async (req, res) => {
  try {
    res.set('Cache-Control', 'no-store');
    const userId = await resolveUserId(req.params.handle);
    // Liga F6: atleta que apagou os dados esportivos não tem mais card/histórico público
    if (!userId || (await require('../services/ligaPrivacy').isErased(userId))) return res.status(404).json({ error: 'atleta não encontrado' });
    const page = pageOf(req, res, { defaultLimit: 20, maxLimit: 100 });
    if (!page) return;
    const h = await athleteHistory.history(userId, { viewer: await access.viewer(req) });
    // Liga F5: ?limit/&cursor pagina a lista de CAMPEONATOS (totais/por esporte/temporada inteiros)
    if (page.paged) {
      const pg = pag.pageArray(h.tournaments || [], page, (x) => x.tournamentId);
      return res.json({ ...h, tournaments: pg.items, tournamentsNextCursor: pg.nextCursor });
    }
    res.json(h);
  } catch (err) {
    if (pag.sendPageError(res, err)) return; // Liga F5: cursor inválido = 400
    console.error('[tournaments] history', err);
    res.status(500).json({ error: err.message });
  }
});

// Liga F2 — JUNTAR PERFIS DUPLICADOS (só com confirmação do próprio atleta).
// start { phone | username | inviteToken, method: 'CODE' | 'PASSWORD' }
// confirm { requestId, code | password }
function mergeErr(res, e) {
  if (e instanceof profileMerge.MergeError) { res.status(e.status).json({ error: e.message }); return true; }
  return false;
}
router.post('/athletes/merge/start', authMiddleware, limits.mergeStart, async (req, res) => {
  try {
    const b = req.body || {};
    res.json(await profileMerge.start({ userId: req.userId, phone: b.phone || b.whatsapp, username: b.username, inviteToken: b.inviteToken, method: b.method }));
  } catch (e) { if (mergeErr(res, e)) return; console.error('[tournaments] merge start', e); res.status(500).json({ error: 'erro ao pedir a junção' }); }
});
router.post('/athletes/merge/confirm', authMiddleware, limits.mergeConfirm, async (req, res) => {
  try {
    const b = req.body || {};
    res.json(await profileMerge.confirm({ userId: req.userId, requestId: b.requestId, code: b.code, password: b.password }));
  } catch (e) { if (mergeErr(res, e)) return; console.error('[tournaments] merge confirm', e); res.status(500).json({ error: 'erro ao juntar os perfis' }); }
});

// Ranking por esporte (rating)
// Artilharia/assistências do ESPORTE (todos os torneios dele) — pra esportes de time,
// onde o rating individual não se aplica. Público.
router.get('/rankings/:sport/scorers', async (req, res) => {
  try {
    res.set('Cache-Control', 'no-store');
    // Liga F5: com ?cursor → página (keyset na lista ordenada) + nextCursor; sem → como antes
    if (req.query.cursor) {
      const page = pageOf(req, res, { defaultLimit: 50, maxLimit: 200 });
      if (!page) return;
      const all = await require('../services/athleteDashboard').sportScorers(req.params.sport, { all: true });
      const pg = pag.pageArray(all.scorers, page, (x) => (x.userId ? 'u:' + x.userId : 'n:' + x.name + '|' + x.team));
      return res.json({ sport: all.sport, scorers: pg.items, startRank: pg.start + 1, nextCursor: pg.nextCursor });
    }
    const lim = Math.max(1, Math.min(Number(req.query.limit) || 50, 200));
    const out = await require('../services/athleteDashboard').sportScorers(req.params.sport, { limit: lim + 1 });
    // diz se há mais (o front mostra "Ver mais")
    const more = out.scorers.length > lim;
    out.scorers = out.scorers.slice(0, lim);
    const last = out.scorers[out.scorers.length - 1];
    out.nextCursor = more && last ? pag.encodeCursor({ a: last.userId ? 'u:' + last.userId : 'n:' + last.name + '|' + last.team, i: out.scorers.length - 1 }) : null;
    res.json(out);
  } catch (err) { if (pag.sendPageError(res, err)) return; res.status(500).json({ error: err.message }); }
});

router.get('/rankings/:sport', async (req, res) => {
  try {
    // Liga F5: ?cursor → keyset (rating desc, userId) com nextCursor; sem cursor → como antes (até ?limit, máx. 200)
    const page = pageOf(req, res, { defaultLimit: 50, maxLimit: 200 });
    if (!page) return;
    const spec = [{ field: 'rating', dir: 'desc', type: 'number' }, { field: 'id', dir: 'asc', type: 'string' }];
    const r = await pag.findPage(prisma.athleteRating, {
      where: { sport: req.params.sport, matchesCount: { gt: 0 } },
      include: { user: { select: { id: true, name: true, username: true, city: true, state: true } } },
    }, spec, page);
    const ratings = r.items;
    const startRank = page.cursor && Number.isFinite(Number(page.cursor.r)) ? Math.max(0, Math.min(1e6, Math.floor(Number(page.cursor.r)))) : 0;
    const nextCursor = r.nextCursor ? pag.encodeCursor({ ...pag.decodeCursor(r.nextCursor), r: startRank + ratings.length }) : null;
    res.json({
      sport: req.params.sport,
      nextCursor,
      ranking: ratings.map((r, i) => ({
        rank: startRank + i + 1,
        userId: r.userId,
        name: r.user.name,
        username: r.user.username,
        city: r.user.city,
        rating: Number(r.rating.toFixed(2)),
        matches: r.matchesCount,
        wins: r.wins,
        losses: r.losses,
      })),
    });
  } catch (err) {
    if (pag.sendPageError(res, err)) return; // Liga F5: cursor inválido = 400
    res.status(500).json({ error: err.message });
  }
});

// =====================================================================
// DESAFIOS 1v1 (head-to-head)
// =====================================================================

// Cria um desafio
router.post('/challenges', authMiddleware, async (req, res) => {
  try {
    const b = req.body || {};
    const challengedId = await resolveUserId(b.challengedUserId || b.challengedUsername || b.to);
    if (!challengedId) return res.status(400).json({ error: 'oponente não encontrado' });
    if (challengedId === req.userId) return res.status(400).json({ error: 'não dá pra desafiar você mesmo' });
    const sport = SPORTS.has(b.sport) ? b.sport : 'TENNIS';

    const ch = await prisma.playChallenge.create({
      data: {
        challengerId: req.userId,
        challengedId,
        sport,
        proposedAt: b.proposedAt ? new Date(b.proposedAt) : null,
        location: b.location || null,
        message: b.message || null,
      },
    });
    try {
      const me = await prisma.user.findUnique({ where: { id: req.userId }, select: { name: true } });
      await notify(challengedId, {
        type: 'challenge',
        title: '⚔️ Novo desafio 1v1',
        body: `${(me && me.name) || 'Um atleta'} te desafiou${b.message ? ': "' + String(b.message).slice(0, 80) + '"' : ''}.`,
        link: '#/desafios',
      });
    } catch (_) {}
    res.status(201).json(ch);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Meus desafios (enviados + recebidos)
router.get('/challenges/mine', authMiddleware, async (req, res) => {
  try {
    const list = await prisma.playChallenge.findMany({
      where: { OR: [{ challengerId: req.userId }, { challengedId: req.userId }] },
      orderBy: { createdAt: 'desc' },
      include: {
        challenger: { select: { id: true, name: true, username: true } },
        challenged: { select: { id: true, name: true, username: true } },
      },
    });
    res.json({ challenges: list });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Responde um desafio: accept | decline | cancel
router.post('/challenges/:id/respond', authMiddleware, async (req, res) => {
  try {
    const ch = await prisma.playChallenge.findUnique({ where: { id: req.params.id } });
    if (!ch) return res.status(404).json({ error: 'desafio não encontrado' });
    const action = req.body?.action;
    if (action === 'cancel') {
      if (ch.challengerId !== req.userId) return res.status(403).json({ error: 'só quem criou cancela' });
      const u = await prisma.playChallenge.update({ where: { id: ch.id }, data: { status: 'CANCELED' } });
      return res.json(u);
    }
    if (action === 'accept' || action === 'decline') {
      if (ch.challengedId !== req.userId) return res.status(403).json({ error: 'só o desafiado responde' });
      if (ch.status !== 'PENDING') return res.status(409).json({ error: 'desafio já respondido' });
      const u = await prisma.playChallenge.update({
        where: { id: ch.id },
        data: { status: action === 'accept' ? 'ACCEPTED' : 'DECLINED' },
      });
      try {
        const me = await prisma.user.findUnique({ where: { id: req.userId }, select: { name: true } });
        await notify(ch.challengerId, {
          type: 'challenge',
          title: action === 'accept' ? 'Desafio aceito ✅' : 'Desafio recusado',
          body: `${(me && me.name) || 'O atleta'} ${action === 'accept' ? 'aceitou' : 'recusou'} seu desafio.`,
          link: '#/desafios',
        });
      } catch (_) {}
      return res.json(u);
    }
    return res.status(400).json({ error: 'action inválida (accept|decline|cancel)' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Registra resultado do desafio (qualquer um dos dois). Atualiza rating.
router.post('/challenges/:id/result', authMiddleware, async (req, res) => {
  try {
    const ch = await prisma.playChallenge.findUnique({ where: { id: req.params.id } });
    if (!ch) return res.status(404).json({ error: 'desafio não encontrado' });
    if (![ch.challengerId, ch.challengedId].includes(req.userId)) {
      return res.status(403).json({ error: 'só os participantes registram o resultado' });
    }
    if (ch.status === 'PLAYED') return res.status(409).json({ error: 'resultado já registrado' });

    const b = req.body || {};
    const homeScore = Number(b.homeScore) || 0; // challenger
    const awayScore = Number(b.awayScore) || 0; // challenged
    let winnerId = b.winnerId;
    if (!winnerId) {
      if (homeScore > awayScore) winnerId = ch.challengerId;
      else if (awayScore > homeScore) winnerId = ch.challengedId;
    }
    if (!winnerId) return res.status(400).json({ error: 'informe o vencedor (winnerId) ou placar' });

    const updated = await prisma.playChallenge.update({
      where: { id: ch.id },
      data: { status: 'PLAYED', homeScore, awayScore, winnerId },
    });

    const loserId = winnerId === ch.challengerId ? ch.challengedId : ch.challengerId;
    await engine.rateHeadToHead(winnerId, loserId, ch.sport);

    res.json(updated);
  } catch (err) {
    console.error('[tournaments] challenge result', err);
    res.status(500).json({ error: err.message });
  }
});

// =====================================================================
// MURAL / AVISOS (estilo "notícias" do CopaFácil) — texto, sem foto
// =====================================================================

// Lista avisos (público) por id ou slug
router.get('/:idOrSlug/posts', async (req, res) => {
  try {
    const t = await access.loadVisibleTournament(req, req.params.idOrSlug, { select: { id: true } });
    if (!t) return access.sendNotFound(res);
    // Liga F5: cursor estável (fixado, data, id). Sem ?limit/?cursor → 50, como antes, + nextCursor.
    const page = pageOf(req, res, { defaultLimit: 50, maxLimit: 100 });
    if (!page) return;
    // Liga F6: aviso ocultado pela moderação não sai no mural
    const r = await pag.findPage(prisma.tournamentPost, { where: { tournamentId: t.id, hiddenAt: null } }, pag.POST_SPEC, page);
    res.json({ posts: r.items, nextCursor: r.nextCursor });
  } catch (err) {
    if (pag.sendPageError(res, err)) return; // Liga F5: cursor inválido = 400
    res.status(500).json({ error: err.message });
  }
});

// Publica um aviso (fundador/coordenador)
router.post('/:id/posts', authMiddleware, limits.post, async (req, res) => {
  try {
    const t = await loadForAction(req, res, req.params.id, 'POST', {}, 'só a organização publica no mural');
    if (!t) return;
    const b = req.body || {};
    const body = String(b.body || '').trim();
    if (!body) return res.status(400).json({ error: 'escreva o aviso' });
    if (!cleanText(res, t, [{ field: 'post', value: [b.title, body].filter(Boolean).map(String) }])) return;
    // Liga F5: avisos por mês do plano do dono do torneio (só nova criação)
    if (!(await plans.guard(res, 'post', { actorId: req.userId, actorRole: req.userRole, tournament: t }))) return;
    // Liga F5: imagem do aviso (opcional) — imageGuard + mediaStore ("/media/<sha>.<ext>")
    let imageUrl = null;
    if (b.image != null && b.image !== '') {
      const st = await storeImage(req, res, b.image, { maxChars: 800000, allowRelative: false }, { tournament: t });
      if (!st.ok) return;
      imageUrl = st.value;
    }
    const post = await prisma.tournamentPost.create({
      data: {
        tournamentId: t.id,
        authorId: req.userId,
        title: b.title ? String(b.title).trim().slice(0, 120) : null,
        body: body.slice(0, 4000),
        pinned: !!b.pinned,
        ...(imageUrl ? { imageUrl } : {}),
      },
    });
    res.status(201).json(post);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Remove um aviso (fundador/coordenador)
router.delete('/posts/:postId', authMiddleware, async (req, res) => {
  try {
    const post = await prisma.tournamentPost.findUnique({
      where: { id: req.params.postId },
      select: { id: true, tournamentId: true },
    });
    if (!post) return res.status(404).json({ error: 'aviso não encontrado' });
    if (!(await allow(req, res, post.tournamentId, 'POST', {}, 'só a organização remove aviso'))) return;
    await prisma.tournamentPost.delete({ where: { id: post.id } });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// =====================================================================
// LIGA ABERTA F1 — ARQUIVAR (excluir reversível), RESTAURAR, TRANSFERIR, AUDITORIA
// =====================================================================
const RESTORE_DAYS = 30;

// Excluir = ARQUIVAR (some de todas as rotas públicas; reversível por 30 dias).
// Só fundador/admin. body { confirm: true }. Nada é apagado fisicamente.
async function archiveHandler(req, res) {
  try {
    const t = await loadForAction(req, res, req.params.id, 'DELETE_TOURNAMENT', {}, 'só o fundador exclui (arquiva) o torneio');
    if (!t) return;
    if ((req.body || {}).confirm !== true) {
      return res.status(409).json({ code: 'CONFIRM_REQUIRED', error: `confirme para excluir — o torneio sai do ar e pode ser restaurado em até ${RESTORE_DAYS} dias` });
    }
    const at = new Date();
    await prisma.tournament.update({ where: { id: t.id }, data: { archivedAt: at, archivedBy: req.userId } });
    await audit.record({ tournamentId: t.id, userId: req.userId, action: 'tournament.archive', entity: 'Tournament', entityId: t.id, before: { archivedAt: null, status: t.status }, after: { archivedAt: at } });
    const restoreUntil = new Date(at.getTime() + RESTORE_DAYS * 86400000);
    res.json({ ok: true, archivedAt: at, restoreUntil });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}
// =====================================================================
// Liga Aberta F3 — DUPLICAR para a próxima temporada (can MANAGE_TOURNAMENT)
// =====================================================================
router.post('/:id/duplicate', authMiddleware, limits.createTournament, async (req, res) => {
  try {
    const t = await loadForAction(req, res, req.params.id, 'MANAGE_TOURNAMENT', {}, 'só a organização (fundador/coordenador) duplica o torneio');
    if (!t) return;
    // Liga F6: a cópia nasce do MESMO dono — dono suspenso não ganha torneio novo
    if (!(await roles.can(t.ownerId, (await prisma.user.findUnique({ where: { id: t.ownerId }, select: { role: true } }) || {}).role, null, 'CREATE_TOURNAMENT'))) {
      return res.status(403).json({ error: 'O dono deste torneio está suspenso pela moderação: não é possível duplicar.', code: 'ORGANIZER_SUSPENDED' });
    }
    if (!cleanText(res, null, [{ field: 'tournament', value: (req.body || {}).name }])) return;
    // Liga F5: a cópia nasce com o MESMO dono → conta nos torneios ativos do plano dele
    if (!plans.isStaffRole(req.userRole) && !clubIdentity.isExcludedSlug(t.slug)) {
      const ownerRole = (await prisma.user.findUnique({ where: { id: t.ownerId }, select: { role: true } }) || {}).role;
      if (!(await plans.guard(res, 'tournament', { actorId: t.ownerId, actorRole: ownerRole }))) return;
    }
    const r = await duplicateTournament(t.id, { userId: req.userId, body: req.body || {} });
    if (!r) return access.sendNotFound(res);
    res.status(201).json(r);
  } catch (e) {
    if (svcErr(res, e)) return;
    console.error('[tournaments] duplicate', e);
    res.status(500).json({ error: 'não foi possível duplicar agora — nada foi gravado' });
  }
});

// =====================================================================
// Liga Aberta F3 — MODO RACHA (formato PICKUP)
// =====================================================================
// Estado do dia (presença, níveis, times sorteados, jogos). Login opcional. ?day=AAAA-MM-DD
router.get('/:idOrSlug/pickup', async (req, res) => {
  try {
    res.set('Cache-Control', 'no-store');
    const t = await access.loadVisibleTournament(req, req.params.idOrSlug);
    if (!t) return access.sendNotFound(res);
    res.json(await pickup.view(t, await access.viewer(req), req.query.day));
  } catch (e) { if (svcErr(res, e)) return; res.status(500).json({ error: e.message }); }
});
const pickupActor = (req) => ({ userId: req.userId, userRole: req.userRole });
async function pickupT(req, res) {
  const t = await access.loadVisibleTournament(req, req.params.id);
  if (!t || t.id !== req.params.id) { access.sendNotFound(res); return null; }
  return t;
}
// Jogadores do racha (organização): { names:[...] | "um por linha", level? (0–7) }
router.post('/:id/pickup/players', authMiddleware, async (req, res) => {
  try {
    const t = await pickupT(req, res); if (!t) return;
    const nm = (req.body || {}).names;
    const list = Array.isArray(nm) ? nm.map(String) : typeof nm === 'string' ? nm.split(/[\r\n,;]+/) : [];
    if (!cleanText(res, t, [{ field: 'pickup', value: list.map((x) => x.trim()).filter(Boolean) }])) return;
    res.status(201).json(await pickup.addPlayers(t, pickupActor(req), req.body || {}));
  }
  catch (e) { if (svcErr(res, e)) return; res.status(500).json({ error: e.message }); }
});
router.patch('/pickup/players/:pickupPlayerId', authMiddleware, async (req, res) => {
  try {
    if (!cleanText(res, null, [{ field: 'pickup', value: (req.body || {}).name }])) return;
    res.json(await pickup.updatePlayer(pickupActor(req), req.params.pickupPlayerId, req.body || {}));
  }
  catch (e) { if (svcErr(res, e)) return; res.status(500).json({ error: e.message }); }
});
// Presença: { confirm, playerId? } — sem playerId = eu mesmo (pelo link); outro = organização.
router.post('/:id/pickup/attendance', authMiddleware, async (req, res) => {
  try { const t = await pickupT(req, res); if (!t) return; res.json(await pickup.setAttendance(t, pickupActor(req), req.body || {}, req.query.day)); }
  catch (e) { if (svcErr(res, e)) return; res.status(500).json({ error: e.message }); }
});
// Sorteio equilibrado: { teamCount=2, seed? } (semente registrada; mesma semente = mesmos times).
router.post('/:id/pickup/draw', authMiddleware, async (req, res) => {
  try { const t = await pickupT(req, res); if (!t) return; res.json(await pickup.draw(t, pickupActor(req), req.body || {}, req.query.day)); }
  catch (e) { if (svcErr(res, e)) return; res.status(500).json({ error: e.message }); }
});
// Novo jogo entre dois times sorteados: { home, away } (índice do time).
router.post('/:id/pickup/games', authMiddleware, async (req, res) => {
  try { const t = await pickupT(req, res); if (!t) return; res.status(201).json(await pickup.createGame(t, pickupActor(req), req.body || {}, req.query.day)); }
  catch (e) { if (svcErr(res, e)) return; res.status(500).json({ error: e.message }); }
});
// Placar rápido: { side:'home'|'away', delta:1|-1, playerId? }
router.post('/pickup/games/:matchId/score', authMiddleware, async (req, res) => {
  try { const r = await pickup.score(pickupActor(req), req.params.matchId, req.body || {}); live.emitMatch(req.params.matchId, 'update'); res.json(r); }
  catch (e) { if (svcErr(res, e)) return; res.status(500).json({ error: e.message }); }
});
router.post('/pickup/games/:matchId/finish', authMiddleware, async (req, res) => {
  try { const r = await pickup.finishGame(pickupActor(req), req.params.matchId); live.emitMatch(req.params.matchId, 'end'); res.json(r); }
  catch (e) { if (svcErr(res, e)) return; res.status(500).json({ error: e.message }); }
});
// Artilharia acumulada da temporada (ano em America/Fortaleza). ?season=2026
router.get('/:idOrSlug/pickup/scorers', async (req, res) => {
  try {
    res.set('Cache-Control', 'no-store');
    const t = await access.loadVisibleTournament(req, req.params.idOrSlug);
    if (!t) return access.sendNotFound(res);
    const page = pageOf(req, res, { defaultLimit: 30, maxLimit: 200 });
    if (!page) return;
    const out = await pickup.seasonScorers(t, req.query.season);
    // Liga F5: ?limit/&cursor pagina a ARTILHARIA (scorers); "players" fica inteiro (presença/sorteio)
    if (page.paged) {
      const pg = pag.pageArray(out.scorers, page, (r) => r.playerId);
      return res.json({ ...out, scorers: pg.items, startRank: pg.start + 1, nextCursor: pg.nextCursor });
    }
    res.json(out);
  } catch (e) { if (pag.sendPageError(res, e)) return; if (svcErr(res, e)) return; res.status(500).json({ error: e.message }); }
});

router.post('/:id/archive', authMiddleware, archiveHandler);
router.delete('/:id', authMiddleware, archiveHandler);

// Restaura um torneio arquivado (fundador/admin, até 30 dias depois de arquivar).
router.post('/:id/restore', authMiddleware, async (req, res) => {
  try {
    const t = await prisma.tournament.findUnique({ where: { id: req.params.id } });
    if (!t) return access.sendNotFound(res);
    if (!(await roles.can(req.userId, req.userRole, t.id, 'RESTORE'))) {
      // não arquivado + sem acesso → mesmo 404; arquivado sem ser fundador → 404 também (não vaza)
      if (!t.archivedAt || !(await access.isMember(req.userId, t))) return access.sendNotFound(res);
      return res.status(403).json({ error: 'só o fundador restaura o torneio' });
    }
    if (!t.archivedAt) return res.status(409).json({ error: 'o torneio não está arquivado' });
    const limit = new Date(new Date(t.archivedAt).getTime() + RESTORE_DAYS * 86400000);
    if (Date.now() > limit.getTime()) {
      return res.status(410).json({ code: 'RESTORE_EXPIRED', error: `prazo de restauração (${RESTORE_DAYS} dias) encerrado — o torneio continua arquivado` });
    }
    await prisma.tournament.update({ where: { id: t.id }, data: { archivedAt: null, archivedBy: null } });
    await audit.record({ tournamentId: t.id, userId: req.userId, action: 'tournament.restore', entity: 'Tournament', entityId: t.id, before: { archivedAt: t.archivedAt, archivedBy: t.archivedBy }, after: { archivedAt: null } });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Transfere o torneio para outro dono (fundador/admin). body { userId | username | phone }.
// O dono antigo vira COORDENADOR. Auditado.
router.post('/:id/transfer', authMiddleware, async (req, res) => {
  try {
    const t = await loadForAction(req, res, req.params.id, 'TRANSFER', {}, 'só o dono atual do torneio transfere');
    if (!t) return;
    const b = req.body || {};
    const user = await roles.resolveUser({ userId: b.userId, username: b.username, phone: b.phone });
    if (!user) return res.status(404).json({ error: 'usuário não encontrado — a pessoa precisa ter conta (telefone/@)' });
    if (user.id === t.ownerId) return res.status(409).json({ error: 'essa pessoa já é a dona do torneio' });
    const oldOwner = t.ownerId;
    await prisma.$transaction(async (tx) => {
      await tx.tournament.update({ where: { id: t.id }, data: { ownerId: user.id } });
      // fundador explícito do dono antigo sai (senão ele continuaria fundador)
      await tx.tournamentRole.deleteMany({ where: { tournamentId: t.id, userId: oldOwner, role: 'FOUNDER' } });
      const hasCoord = await tx.tournamentRole.findFirst({ where: { tournamentId: t.id, userId: oldOwner, role: 'COORDINATOR', entryId: null } });
      if (!hasCoord) await tx.tournamentRole.create({ data: { tournamentId: t.id, userId: oldOwner, role: 'COORDINATOR', entryId: null } });
    });
    await audit.record({ tournamentId: t.id, userId: req.userId, action: 'tournament.transfer', entity: 'Tournament', entityId: t.id, before: { ownerId: oldOwner }, after: { ownerId: user.id, previousOwnerRole: 'COORDINATOR' } });
    try { await notify(user.id, { type: 'role', title: 'Torneio transferido para você', body: `Agora você é o fundador de "${t.name}".`, link: '#/t/' + t.id }); } catch (_) {}
    res.json({ ok: true, owner: user, previousOwnerId: oldOwner });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Auditoria do torneio (fundador/coordenador/admin). Paginado: ?limit=50&cursor=<id>&action=
router.get('/:id/audit', authMiddleware, async (req, res) => {
  try {
    res.set('Cache-Control', 'no-store');
    const t = await prisma.tournament.findUnique({ where: { id: req.params.id }, select: { id: true, ownerId: true, visibility: true, archivedAt: true } });
    if (!t) return access.sendNotFound(res);
    if (!(await roles.can(req.userId, req.userRole, t.id, 'VIEW_AUDIT'))) {
      if (!(await access.canSee({ userId: req.userId, userRole: req.userRole }, t))) return access.sendNotFound(res);
      return res.status(403).json({ error: 'só fundador/coordenador vê a auditoria' });
    }
    res.json(await audit.list(t.id, { limit: req.query.limit, cursor: req.query.cursor || null, action: req.query.action || null }));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
