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

const router = express.Router();

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
    res.json({ teams: await membership.listTeams(req.params.id) });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ATLETA pede pra entrar num time (entryId identifica o clube).
router.post('/:id/teams/:entryId/join', authMiddleware, async (req, res) => {
  try {
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
    if ((roleUp === 'FOUNDER' || roleUp === 'COORDINATOR')) {
      const isFounder = await roles.can(req.userId, req.userRole, tournamentId, 'MANAGE_TOURNAMENT');
      const amFounder = roles.isGlobalAdmin(req.userRole) || (await roles.rolesFor(req.userId, tournamentId)).some((x) => x.role === 'FOUNDER');
      if (!amFounder && !roles.isGlobalAdmin(req.userRole)) return res.status(403).json({ error: 'só o fundador nomeia fundador/coordenador' });
      void isFounder;
    }
    const r = await roles.assignRole(tournamentId, { userId: user.id, role: body.role, entryId: body.entryId });
    if (!r.ok) return res.status(400).json(r);
    res.status(201).json({ ok: true, user, role: r.role, already: !!r.already });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Remove um papel nomeado. Fundador/coordenador.
router.delete('/:id/roles/:roleId', authMiddleware, async (req, res) => {
  try {
    if (!(await roles.can(req.userId, req.userRole, req.params.id, 'ASSIGN_ROLES'))) {
      return res.status(403).json({ error: 'sem permissão (só fundador/coordenador)' });
    }
    res.json(await roles.removeRole(req.params.id, req.params.roleId));
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
    const ts = await prisma.tournament.findMany({ where: { id: { in: ids } }, select: { id: true, name: true, slug: true, sport: true, status: true, ownerId: true } });
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
    const officials = await prisma.matchOfficial.findMany({ where: { matchId: req.params.matchId }, orderBy: { createdAt: 'asc' } });
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
    res.status(201).json({ ok: true, user, official });
  } catch (err) { res.status(500).json({ error: err.message }); }
});
router.delete('/:id/matches/:matchId/referees/:officialId', authMiddleware, async (req, res) => {
  try {
    if (!(await roles.can(req.userId, req.userRole, req.params.id, 'MANAGE_TOURNAMENT'))) {
      return res.status(403).json({ error: 'sem permissão' });
    }
    await prisma.matchOfficial.deleteMany({ where: { id: req.params.officialId, matchId: req.params.matchId } });
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
  if (err instanceof ImageGuardError) { res.status(err.status).json({ error: err.message }); return true; }
  return false;
}
const hasBody = (field) => (req) => !!(req.body && Object.prototype.hasOwnProperty.call(req.body, field));

// Carrega torneio garantindo que req.userId é dono (ou admin)
async function loadOwned(req, res, tournamentId) {
  const t = await prisma.tournament.findUnique({ where: { id: tournamentId } });
  if (!t) {
    res.status(404).json({ error: 'torneio não encontrado' });
    return null;
  }
  const isAdmin = ['admin', 'superadmin', 'manager'].includes(req.userRole);
  if (t.ownerId !== req.userId && !isAdmin) {
    res.status(403).json({ error: 'só o organizador pode gerenciar este torneio' });
    return null;
  }
  return t;
}

// =====================================================================
// TORNEIOS — gestão (organizador autenticado)
// =====================================================================

// Cria torneio
router.post('/', authMiddleware, limits.createTournament, async (req, res) => {
  try {
    const b = req.body || {};
    if (!b.name) return res.status(400).json({ error: 'name obrigatório' });
    // Banner: só https:// ou caminho do próprio site / imagem PNG/JPEG/WEBP real (Liga F0).
    let bannerUrl = null;
    try { bannerUrl = await guardImageField(b.bannerUrl, { maxChars: 800000 }); } catch (e) { if (imageError(res, e)) return; throw e; }
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
        visibility: b.visibility === 'private' ? 'private' : 'public',
        ...seriesData(b),
      },
    });
    res.status(201).json(t);
  } catch (err) {
    console.error('[tournaments] create', err);
    res.status(500).json({ error: err.message });
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
    const list = await prisma.tournament.findMany({
      where: { ownerId: req.userId },
      orderBy: { createdAt: 'desc' },
      include: { _count: { select: { entries: true, categories: true } } },
    });
    res.json({ tournaments: list });
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
    const where = { visibility: 'public' };
    if (req.query.sport) where.sport = req.query.sport;
    if (req.query.status) where.status = req.query.status;
    if (req.query.storeId) where.storeId = req.query.storeId;
    const list = await prisma.tournament.findMany({
      where,
      orderBy: [{ status: 'asc' }, { startDate: 'desc' }],
      take: Math.min(Number(req.query.limit) || 50, 100),
      include: { _count: { select: { entries: true } } },
    });
    res.json({ tournaments: list });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Detalhe público do torneio (por slug ou id)
router.get('/:idOrSlug', async (req, res) => {
  try {
    const key = req.params.idOrSlug;
    const t = await prisma.tournament.findFirst({
      where: { OR: [{ id: key }, { slug: key }] },
      include: {
        categories: { include: { _count: { select: { entries: true } } } },
        _count: { select: { entries: true, matches: true } },
      },
    });
    if (!t) return res.status(404).json({ error: 'torneio não encontrado' });
    res.json(t);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Edita torneio (só dono)
router.patch('/:id', authMiddleware, onlyWhen(hasBody('bannerUrl'), limits.upload), async (req, res) => {
  try {
    const t = await loadOwned(req, res, req.params.id);
    if (!t) return;
    const b = req.body || {};
    const data = {};
    for (const f of ['name', 'description', 'rules', 'city', 'state', 'prizeDescription']) {
      if (b[f] !== undefined) data[f] = b[f];
    }
    if (b.bannerUrl !== undefined) {
      try { data.bannerUrl = await guardImageField(b.bannerUrl, { maxChars: 800000 }); } catch (e) { if (imageError(res, e)) return; throw e; }
    }
    if (b.sport && SPORTS.has(b.sport)) data.sport = b.sport;
    if (b.format && FORMATS.has(b.format)) data.format = b.format;
    if (b.isDoubles !== undefined) data.isDoubles = !!b.isDoubles;
    if (b.maxEntries !== undefined) data.maxEntries = b.maxEntries ? Number(b.maxEntries) : null;
    for (const f of ['startDate', 'endDate', 'registrationCloseAt']) {
      if (b[f] !== undefined) data[f] = b[f] ? new Date(b[f]) : null;
    }
    if (b.visibility) data.visibility = b.visibility === 'private' ? 'private' : 'public';
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
    res.json(updated);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Muda status do torneio (só dono)
router.post('/:id/status', authMiddleware, async (req, res) => {
  try {
    const t = await loadOwned(req, res, req.params.id);
    if (!t) return;
    const status = req.body?.status;
    if (!TOURNAMENT_STATUS.has(status)) return res.status(400).json({ error: 'status inválido' });
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
    const t = await loadOwned(req, res, req.params.id);
    if (!t) return;
    if (!cash.isAdmin(req.userRole) && t.ownerId !== req.userId) {
      return res.status(403).json({ error: 'sem permissão' });
    }
    const r = await cash.payPrize(t.id);
    if (!r.ok) return res.status(400).json(r);
    res.json(r);
  } catch (err) {
    console.error('[tournaments] pay-prize', err);
    res.status(500).json({ error: err.message });
  }
});

// =====================================================================
// CATEGORIAS
// =====================================================================

// Cria categoria (só dono)
router.post('/:id/categories', authMiddleware, async (req, res) => {
  try {
    const t = await loadOwned(req, res, req.params.id);
    if (!t) return;
    const b = req.body || {};
    if (!b.name) return res.status(400).json({ error: 'name obrigatório' });
    const rules = categoryRulesData({ tiebreakers: b.tiebreakers, doubleRound: b.doubleRound, suspensionRule: b.suspensionRule, formatConfig: b.formatConfig });
    if (rules.error) return res.status(400).json({ error: rules.error });
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
    const list = await prisma.tournamentCategory.findMany({
      where: { tournamentId: req.params.id },
      include: { _count: { select: { entries: true, matches: true } } },
    });
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
    const t = await loadOwned(req, res, req.params.id);
    if (!t) return;
    const cat = await prisma.tournamentCategory.findFirst({ where: { id: req.params.catId, tournamentId: t.id } });
    if (!cat) return res.status(404).json({ error: 'categoria não encontrada' });
    const b = req.body || {};
    const rules = categoryRulesData(b);
    if (rules.error) return res.status(400).json({ error: rules.error });
    const data = { ...rules.data };
    if (b.name !== undefined && String(b.name).trim()) data.name = String(b.name).trim().slice(0, 80);
    if (b.levelLabel !== undefined) data.levelLabel = b.levelLabel || null;
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
router.post('/:id/entries', authMiddleware, limits.entry, async (req, res) => {
  try {
    const t = await prisma.tournament.findUnique({ where: { id: req.params.id } });
    if (!t) return res.status(404).json({ error: 'torneio não encontrado' });
    const b = req.body || {};
    if (!b.categoryId) return res.status(400).json({ error: 'categoryId obrigatório' });

    const cat = await prisma.tournamentCategory.findFirst({
      where: { id: b.categoryId, tournamentId: t.id },
    });
    if (!cat) return res.status(400).json({ error: 'categoria não pertence a este torneio' });

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
      const dupName = await prisma.tournamentEntry.findFirst({
        where: { categoryId: cat.id, name: teamName },
      });
      if (dupName) return res.status(409).json({ error: 'já existe um time com esse nome nesta categoria' });
      if (!manager) {
        // Time = clube único entre categorias: quem não organiza não pode "entrar"
        // num clube que já existe no torneio só repetindo o nome.
        const sameClub = await prisma.tournamentEntry.findFirst({
          where: { tournamentId: t.id, name: { equals: teamName, mode: 'insensitive' } },
          select: { id: true },
        });
        if (sameClub) return res.status(409).json({ error: 'já existe um time com esse nome neste torneio — peça ao administrador do time para inscrever a categoria' });
      }
      if (t.maxEntries) {
        const count = await prisma.tournamentEntry.count({ where: { tournamentId: t.id } });
        if (count >= t.maxEntries) return res.status(409).json({ error: 'torneio lotado' });
      }
      const teamEntry = await prisma.tournamentEntry.create({
        data: {
          tournamentId: t.id,
          categoryId: cat.id,
          name: teamName,
          seed,
          groupName,
          status,
        },
        include: { members: true },
      });
      if (!manager) {
        // Quem criou o próprio time vira administrador DESTE time (só desta inscrição).
        await prisma.tournamentRole.create({ data: { tournamentId: t.id, userId: req.userId, role: 'TEAM_ADMIN', entryId: teamEntry.id } }).catch(() => {});
        try {
          await notify(t.ownerId, { type: 'entry', title: 'Novo pedido de inscrição', body: `${teamName} pediu vaga em "${t.name}". Aprove na categoria.`, link: '#/t/' + t.id });
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
        await notify(t.ownerId, { type: 'entry', title: 'Novo pedido de inscrição', body: `${name} pediu vaga em "${t.name}". Aprove na categoria.`, link: '#/t/' + t.id });
      } catch (_) {}
      return res.status(201).json(entry);
    }

    // Torneio com TenisCash real → cobra a inscrição na hora (entry nasce CONFIRMED).
    // Se o saldo não cobre, desfaz a inscrição e avisa (nada fica pela metade).
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
    const where = { tournamentId: req.params.id };
    if (req.query.categoryId) where.categoryId = req.query.categoryId;
    const list = await prisma.tournamentEntry.findMany({
      where,
      orderBy: [{ seed: 'asc' }, { createdAt: 'asc' }],
      include: {
        members: { include: { user: { select: { id: true, name: true, username: true } } } },
        category: { select: { id: true, name: true } },
      },
    });
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
      include: { members: true, tournament: { select: { ownerId: true, status: true, cashEnabled: true } } },
    });
    if (!entry) return res.status(404).json({ error: 'inscrição não encontrada' });
    const isOwner = entry.tournament.ownerId === req.userId;
    const isSelf = entry.members.some((m) => m.userId === req.userId);
    const isAdmin = ['admin', 'superadmin', 'manager'].includes(req.userRole);
    if (!isOwner && !isSelf && !isAdmin) return res.status(403).json({ error: 'sem permissão' });

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

    await prisma.tournamentEntry.delete({ where: { id: entry.id } });
    res.json({ ok: true, refunded });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Inscrição PÚBLICA (estilo formulário do CopaFácil): o atleta logado pede
// vaga e a inscrição entra como PENDING até o organizador aprovar.
router.post('/:id/entries/request', authMiddleware, limits.entry, async (req, res) => {
  try {
    const t = await prisma.tournament.findUnique({ where: { id: req.params.id } });
    if (!t) return res.status(404).json({ error: 'torneio não encontrado' });
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

    let name = b.name;
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
      });
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
      include: { tournament: { select: { ownerId: true, cashEnabled: true, entryFeeCash: true } } },
    });
    if (!entry) return res.status(404).json({ error: 'inscrição não encontrada' });
    const isAdmin = ['admin', 'superadmin', 'manager'].includes(req.userRole);
    if (entry.tournament.ownerId !== req.userId && !isAdmin) {
      return res.status(403).json({ error: 'só o organizador aprova' });
    }

    // Torneio com TenisCash real → cobra ANTES de confirmar. Saldo insuficiente
    // = não confirma (fica PENDING), nada pela metade.
    if (entry.tournament.cashEnabled && entry.tournament.entryFeeCash > 0 && !entry.entryPaid) {
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
    const isAdmin = ['admin', 'superadmin', 'manager'].includes(req.userRole);
    if (entry.tournament.ownerId !== req.userId && !isAdmin) {
      return res.status(403).json({ error: 'só o organizador define os grupos' });
    }
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

// Gera o chaveamento de uma categoria (só dono)
router.post('/:id/categories/:catId/generate', authMiddleware, async (req, res) => {
  try {
    const t = await loadOwned(req, res, req.params.id);
    if (!t) return;
    const cat = await prisma.tournamentCategory.findFirst({
      where: { id: req.params.catId, tournamentId: t.id },
    });
    if (!cat) return res.status(404).json({ error: 'categoria não encontrada' });

    const r = await engine.generateFixtures(cat.id, { groupCount: req.body?.groupCount });
    if (!r.ok) return res.status(400).json(r);

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
    const t = await loadOwned(req, res, req.params.id);
    if (!t) return;
    const cat = await prisma.tournamentCategory.findFirst({
      where: { id: req.params.catId, tournamentId: t.id },
    });
    if (!cat) return res.status(404).json({ error: 'categoria não encontrada' });

    const r = await engine.generateKnockoutFromGroups(cat.id, req.body?.qualifiersPerGroup || 2);
    if (!r.ok) return res.status(400).json(r);
    res.json(r);
  } catch (err) {
    console.error('[tournaments] knockout', err);
    res.status(500).json({ error: err.message });
  }
});

// SUÍÇO — gera a próxima rodada (pareamento por pontuação, sem repetir confronto).
router.post('/:id/categories/:catId/swiss-next', authMiddleware, async (req, res) => {
  try {
    const t = await loadOwned(req, res, req.params.id);
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
router.get('/:id/categories/:catId/matches', async (req, res) => {
  try {
    res.set('Cache-Control', 'no-store, no-cache, must-revalidate');
    const matches = await prisma.tournamentMatch.findMany({
      where: { categoryId: req.params.catId },
      orderBy: [{ round: 'asc' }, { ordering: 'asc' }],
      include: {
        homeEntry: { select: { id: true, name: true, seed: true, logoUrl: true } },
        awayEntry: { select: { id: true, name: true, seed: true, logoUrl: true } },
        games: { orderBy: { setNumber: 'asc' } },
      },
    });
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
    res.json({ matches });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Classificação da categoria (público)
router.get('/:id/categories/:catId/standings', async (req, res) => {
  try {
    res.set('Cache-Control', 'no-store, no-cache, must-revalidate');
    const catId = req.params.catId;
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
    if (standings.length) return res.json({ standings, ...meta });

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

// Registra resultado de partida (só dono). Aciona avanço de chave + rating.
router.post('/matches/:matchId/result', authMiddleware, async (req, res) => {
  try {
    const match = await prisma.tournamentMatch.findUnique({
      where: { id: req.params.matchId },
      include: { tournament: { select: { id: true, ownerId: true, name: true } } },
    });
    if (!match) return res.status(404).json({ error: 'partida não encontrada' });
    const isAdmin = ['admin', 'superadmin', 'manager'].includes(req.userRole);
    if (match.tournament.ownerId !== req.userId && !isAdmin) {
      return res.status(403).json({ error: 'só o organizador registra resultado' });
    }
    const r = await engine.applyMatchResult(match.id, req.body || {});
    if (!r.ok) return res.status(400).json(r);
    live.emitMatch(match.id, 'end');

    // avisa os atletas das duas entries (menos quem lançou o placar)
    try {
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

// Placar ao vivo (texto, sem câmera) — atualiza liveState (só dono)
router.post('/matches/:matchId/live', authMiddleware, async (req, res) => {
  try {
    const match = await prisma.tournamentMatch.findUnique({
      where: { id: req.params.matchId },
      include: { tournament: { select: { ownerId: true } } },
    });
    if (!match) return res.status(404).json({ error: 'partida não encontrada' });
    const isAdmin = ['admin', 'superadmin', 'manager'].includes(req.userRole);
    if (match.tournament.ownerId !== req.userId && !isAdmin) {
      return res.status(403).json({ error: 'sem permissão' });
    }
    const updated = await prisma.tournamentMatch.update({
      where: { id: match.id },
      data: { liveState: req.body?.liveState ?? null, status: req.body?.status || 'LIVE' },
    });
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
    const isAdmin = ['admin', 'superadmin', 'manager'].includes(req.userRole);
    if (match.tournament.ownerId !== req.userId && !isAdmin) {
      return res.status(403).json({ error: 'só o organizador agenda' });
    }
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
    const isAdmin = ['admin', 'superadmin', 'manager'].includes(req.userRole);
    if (match.tournament.ownerId !== req.userId && !isAdmin) {
      return res.status(403).json({ error: 'só o organizador define os times' });
    }
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
    const players = await prisma.rosterPlayer.findMany({
      where: { entryId: req.params.entryId },
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
    const role = ['PLAYER', 'COACH', 'ASSISTANT'].includes(String(b.role || '').toUpperCase()) ? String(b.role).toUpperCase() : 'PLAYER';
    const player = await prisma.rosterPlayer.create({
      data: {
        entryId: entry.id, name: name.slice(0, 80),
        number: b.number != null && b.number !== '' ? Number(b.number) : null,
        isGoalkeeper: !!b.isGoalkeeper, isCaptain: !!b.isCaptain,
        role, started: !!b.started,
        userId: b.userId || null,
      },
    });
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
    const entry = await prisma.tournamentEntry.findUnique({ where: { id: req.params.entryId }, select: { id: true, name: true, tournamentId: true } });
    if (!entry) return res.status(404).json({ error: 'time não encontrado' });
    if (!(await roles.can(req.userId, req.userRole, entry.tournamentId, 'MANAGE_TEAM', { entryId: entry.id }))) {
      return res.status(403).json({ error: 'sem permissão (coordenador ou admin do time)' });
    }
    const raw = (req.body || {}).logo;
    let logoUrl = null;
    if (raw != null && typeof raw !== 'string') return res.status(400).json({ error: 'logo inválida (envie uma imagem)' });
    // Liga F0: imagem PNG/JPEG/WEBP real (magic bytes + sharp, máx 4096 px,
    // reencodada até caber em ~800 KB) ou link https:// / caminho do próprio site.
    try { logoUrl = await guardImageField(raw, { maxChars: 800000 }); } catch (e) { if (imageError(res, e)) return; throw e; }
    // Time é UM clube só, em várias categorias: a logo é do CLUBE → aplica em TODAS as
    // inscrições do mesmo time (mesmo nome, mesmo torneio). Vale pra todos (dono 2026-11-09).
    const r = await prisma.tournamentEntry.updateMany({
      where: { tournamentId: entry.tournamentId, name: entry.name },
      data: { logoUrl },
    });
    res.json({ ok: true, logoUrl, entriesUpdated: r.count });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
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
    if (uid) {
      const entry = await prisma.tournamentEntry.findUnique({ where: { id: ctx.entry.id }, select: { name: true, tournamentId: true } });
      if (!(await isActiveMember(entry.tournamentId, entry.name, uid))) {
        return res.status(400).json({ error: 'esse atleta não tem vínculo ativo com o time — convide e espere ele aceitar' });
      }
      const dup = await prisma.rosterPlayer.findFirst({ where: { entryId: ctx.entry.id, userId: uid, NOT: { id: req.params.playerId } }, select: { name: true } });
      if (dup) return res.status(409).json({ error: 'essa conta já está ligada a "' + dup.name + '" neste time' });
    }
    const player = await prisma.rosterPlayer.update({ where: { id: req.params.playerId }, data: { userId: uid } });
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
    const s = await sheet.buildSheet(req.params.matchId);
    if (!s) return res.status(404).json({ error: 'partida não encontrada' });
    res.json(s);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Registra um evento da súmula (gol, assistência, cartão, falta, tempo).
// Permissão: árbitro nomeado pro jogo, árbitro do torneio, coordenador/fundador/admin.
router.post('/matches/:matchId/events', authMiddleware, async (req, res) => {
  try {
    const m = await roles.matchContext(req.params.matchId);
    if (!m) return res.status(404).json({ error: 'jogo não encontrado' });
    if (!(await roles.can(req.userId, req.userRole, m.tournamentId, 'REFEREE', { matchId: m.id }))) {
      return res.status(403).json({ error: 'sem permissão (arbitragem do jogo)' });
    }
    // Quem lança evento já é arbitragem/coordenação → pode liberar suspenso (com motivo auditado).
    const r = await sheet.addEvent(req.params.matchId, req.body || {}, { userId: req.userId, canOverride: true });
    if (!r.ok) return res.status(r.code ? 409 : 400).json(r);
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
    if (!(await roles.can(req.userId, req.userRole, ctx.match.tournamentId, 'REFEREE', { matchId: ctx.match.id }))) {
      return res.status(403).json({ error: 'sem permissão (arbitragem do jogo)' });
    }
    await sheet.deleteEvent(req.params.eventId);
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
    if (!(await roles.can(req.userId, req.userRole, m.tournamentId, 'REFEREE', { matchId: m.id }))) {
      return res.status(403).json({ error: 'sem permissão (arbitragem do jogo)' });
    }
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
    if (!(await roles.can(req.userId, req.userRole, m.tournamentId, 'REFEREE', { matchId: m.id }))) {
      return res.status(403).json({ error: 'sem permissão (arbitragem do jogo)' });
    }
    const r = await sheet.finalizeMatch(req.params.matchId, req.body || {});
    if (!r.ok) return res.status(400).json(r);
    live.emitMatch(req.params.matchId, 'end');
    require('../ai/rede/ganchos').jogoFinalizado(req.params.matchId);
    res.json(r);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Suspensos (automático, dos jogos encerrados) — público. ?categoryId= opcional.
// suspended: quem NÃO pode jogar (e em quais próximos jogos) · hanging: pendurados.
router.get('/:id/suspensions', async (req, res) => {
  try {
    res.set('Cache-Control', 'no-store, no-cache, must-revalidate');
    const r = await discipline.tournamentSuspensions(req.params.id, req.query.categoryId || null);
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
    const rows = await sheet.playerStats(req.params.id, { kind, scope, categoryId: req.query.categoryId || null });
    res.json({ kind, scope, ranking: rows });
  } catch (err) {
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
    const existing = await prisma.user.findUnique({ where: { phone: whatsapp }, select: { id: true } });
    if (existing) return res.status(409).json({ error: 'este WhatsApp já tem conta — entre com sua senha' });
    const r = await signupCode.startSignup(whatsapp);
    if (!r.ok) return res.status(r.status || 503).json({ error: r.error, whatsappDown: !!r.whatsappDown });
    res.json({ ok: true, expiresInSeconds: r.expiresInSeconds });
  } catch (err) {
    console.error('[tournaments] register start', err);
    res.status(500).json({ error: 'erro ao enviar o código' });
  }
});

// Passo 2: cadastra atleta. body: { name, whatsapp, password, code, instagram?, photo?(dataURI) }
router.post('/athletes/register', limits.signupIp, async (req, res) => {
  try {
    const b = req.body || {};
    const name = String(b.name || '').trim().slice(0, 100);
    const password = String(b.password || '');
    const whatsapp = signupCode.normalizePhone(b.whatsapp || b.phone);
    if (!name) return res.status(400).json({ error: 'nome obrigatório' });
    if (password.length < 4 || password.length > 20) return res.status(400).json({ error: 'senha deve ter 4 a 20 caracteres' });
    if (!whatsapp) return res.status(400).json({ error: 'WhatsApp com DDD obrigatório' });
    if (b.code == null || String(b.code).trim() === '') {
      return res.status(400).json({ error: 'informe o código de 6 dígitos enviado no seu WhatsApp', needsCode: true });
    }

    const existing = await prisma.user.findUnique({ where: { phone: whatsapp }, select: { id: true } });
    if (existing) return res.status(409).json({ error: 'este WhatsApp já tem conta' });

    // Foto enviada: valida ANTES de gastar o código (imagem real, máx 4096 px, ~800 KB).
    let avatar = null;
    if (b.photo != null && b.photo !== '') {
      try { avatar = (await guardImageDataUri(String(b.photo), { maxChars: 800000 })).dataUri; } catch (e) { if (imageError(res, e)) return; throw e; }
    }

    const v = await signupCode.consumeSignupCode(whatsapp, b.code);
    if (!v.ok) return res.status(v.status || 400).json({ error: v.error, needsCode: true });

    const igHandle = b.instagram ? String(b.instagram).replace(/^@/, '').trim().slice(0, 30) : null;

    // Foto: upload explícito vence; senão tenta Instagram automático.
    let photoSource = avatar ? 'upload' : 'none';
    let igName = null;
    if (!avatar && igHandle) {
      const ig = await instagramAvatar(igHandle);
      if (ig && ig.avatar) { avatar = ig.avatar; igName = ig.name; photoSource = 'instagram'; }
    }

    // @username único (User e AthleteProfile). Se o handle já existe, não grava username.
    let username = null;
    if (igHandle) {
      const taken = await prisma.user.findUnique({ where: { username: igHandle }, select: { id: true } });
      if (!taken) username = igHandle;
    }

    const hashed = await bcrypt.hash(password, 10);
    const user = await prisma.user.create({
      data: {
        name, phone: whatsapp, pin: hashed, balance: 0,
        lgpdAccepted: true, lgpdDate: new Date(),
        username: username || undefined,
      },
    });

    await prisma.athleteProfile.upsert({
      where: { userId: user.id },
      create: { userId: user.id, username: username || null, avatarUrl: avatar || null },
      update: { avatarUrl: avatar || undefined, username: username || undefined },
    });

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
      instagram: igHandle, instagramName: igName,
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
    if (!userId) return res.status(404).json({ error: 'atleta não encontrado' });
    const card = await engine.buildAthleteCard(userId);
    if (!card) return res.status(404).json({ error: 'atleta não encontrado' });
    res.json(card);
  } catch (err) {
    console.error('[tournaments] card', err);
    res.status(500).json({ error: err.message });
  }
});

// Ranking por esporte (rating)
// Artilharia/assistências do ESPORTE (todos os torneios dele) — pra esportes de time,
// onde o rating individual não se aplica. Público.
router.get('/rankings/:sport/scorers', async (req, res) => {
  try {
    res.set('Cache-Control', 'no-store');
    res.json(await require('../services/athleteDashboard').sportScorers(req.params.sport, { limit: req.query.limit }));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.get('/rankings/:sport', async (req, res) => {
  try {
    const ratings = await prisma.athleteRating.findMany({
      where: { sport: req.params.sport, matchesCount: { gt: 0 } },
      orderBy: { rating: 'desc' },
      take: Math.min(Number(req.query.limit) || 50, 200),
      include: { user: { select: { id: true, name: true, username: true, city: true, state: true } } },
    });
    res.json({
      sport: req.params.sport,
      ranking: ratings.map((r, i) => ({
        rank: i + 1,
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
    const t = await prisma.tournament.findFirst({
      where: { OR: [{ id: req.params.idOrSlug }, { slug: req.params.idOrSlug }] },
      select: { id: true },
    });
    if (!t) return res.status(404).json({ error: 'torneio não encontrado' });
    const posts = await prisma.tournamentPost.findMany({
      where: { tournamentId: t.id },
      orderBy: [{ pinned: 'desc' }, { createdAt: 'desc' }],
      take: 50,
    });
    res.json({ posts });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Publica um aviso (só dono)
router.post('/:id/posts', authMiddleware, limits.post, async (req, res) => {
  try {
    const t = await loadOwned(req, res, req.params.id);
    if (!t) return;
    const b = req.body || {};
    const body = String(b.body || '').trim();
    if (!body) return res.status(400).json({ error: 'escreva o aviso' });
    const post = await prisma.tournamentPost.create({
      data: {
        tournamentId: t.id,
        authorId: req.userId,
        title: b.title ? String(b.title).trim().slice(0, 120) : null,
        body: body.slice(0, 4000),
        pinned: !!b.pinned,
      },
    });
    res.status(201).json(post);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Remove um aviso (só dono)
router.delete('/posts/:postId', authMiddleware, async (req, res) => {
  try {
    const post = await prisma.tournamentPost.findUnique({
      where: { id: req.params.postId },
      include: { tournament: { select: { ownerId: true } } },
    });
    if (!post) return res.status(404).json({ error: 'aviso não encontrado' });
    const isAdmin = ['admin', 'superadmin', 'manager'].includes(req.userRole);
    if (post.tournament.ownerId !== req.userId && !isAdmin) {
      return res.status(403).json({ error: 'sem permissão' });
    }
    await prisma.tournamentPost.delete({ where: { id: post.id } });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
