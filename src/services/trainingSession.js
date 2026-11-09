// =====================================================================
// APEX — TREINO: atividade OFICIAL do time (mesmo status do jogo).
// ---------------------------------------------------------------------
// Criado pelo TREINADOR (ou admin do time / coordenador / fundador).
// Súmula própria: CHAMADA/PRESENÇA dos atletas + O QUE FOI FEITO (foco + notas).
// Atleta vinculado confirma presença (RSVP); o treinador faz a chamada.
// Escopo por NOME do clube (clube = um só em várias categorias).
// NÃO entra em classificação/pontos (treino não tem adversário/placar).
// =====================================================================

const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
const { notifyMany } = require('./notify');

async function clubOfEntry(entryId, tournamentId) {
  const e = await prisma.tournamentEntry.findFirst({ where: { id: String(entryId), tournamentId }, select: { name: true } });
  return e ? e.name : null;
}
// Atletas do clube = vínculos ATIVOS (TeamMembership) — são quem entra na chamada.
async function clubMemberUserIds(tournamentId, clubName) {
  const rows = await prisma.teamMembership.findMany({ where: { tournamentId, clubName, status: 'ACTIVE' }, select: { userId: true } });
  return [...new Set(rows.map((r) => r.userId))];
}
async function sessionClub(sessionId) {
  return prisma.trainingSession.findUnique({ where: { id: String(sessionId) }, select: { id: true, tournamentId: true, clubName: true, status: true } });
}

// Cria um treino (atividade oficial) pro clube. entryId identifica o clube.
async function create({ tournamentId, entryId, createdByUserId, title, focus, scheduledAt, location }) {
  const clubName = await clubOfEntry(entryId, tournamentId);
  if (!clubName) return { ok: false, code: 404, error: 'time não encontrado neste torneio' };
  const s = await prisma.trainingSession.create({
    data: {
      tournamentId, clubName,
      title: (title && String(title).slice(0, 120)) || 'Treino',
      focus: focus ? String(focus).slice(0, 300) : null,
      scheduledAt: scheduledAt ? new Date(scheduledAt) : null,
      location: location ? String(location).slice(0, 160) : null,
      createdByUserId: createdByUserId || null,
    },
  });
  // avisa os atletas vinculados do clube
  const members = await clubMemberUserIds(tournamentId, clubName);
  const quando = s.scheduledAt ? new Date(s.scheduledAt).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : 'em breve';
  await notifyMany(members, { type: 'training', title: 'Novo treino marcado', body: `${clubName}: ${s.title} — ${quando}. Confirme presença.`, link: `/torneios.html#t/${tournamentId}` }, createdByUserId);
  return { ok: true, session: s };
}

// Cria uma SÉRIE recorrente (ex: toda terça e quinta por N semanas). padrão Spond/TeamSnap.
// weekdays: array 0-6 (0=domingo). time: "HH:MM". weeks: nº de semanas.
async function createRecurring({ tournamentId, entryId, createdByUserId, title, focus, location, weekdays, time, weeks, startDate }) {
  const clubName = await clubOfEntry(entryId, tournamentId);
  if (!clubName) return { ok: false, code: 404, error: 'time não encontrado neste torneio' };
  const wd = [...new Set((Array.isArray(weekdays) ? weekdays : [weekdays]).map(Number).filter((n) => n >= 0 && n <= 6))];
  if (!wd.length) return { ok: false, code: 400, error: 'escolha ao menos um dia da semana' };
  const parts = String(time || '19:00').split(':');
  const hh = Math.min(23, Math.max(0, Number(parts[0]) || 19));
  const mm = Math.min(59, Math.max(0, Number(parts[1]) || 0));
  const nWeeks = Math.min(Math.max(Number(weeks) || 4, 1), 26);
  const start = startDate ? new Date(startDate) : new Date();
  const groupId = 'rec_' + Math.random().toString(36).slice(2, 10);
  const dates = [];
  for (const d of wd) {
    const first = new Date(start); first.setHours(hh, mm, 0, 0);
    first.setDate(first.getDate() + ((d - first.getDay() + 7) % 7));
    for (let w = 0; w < nWeeks; w++) {
      const dt = new Date(first); dt.setDate(first.getDate() + w * 7);
      if (dt.getTime() >= Date.now() - 3600000) dates.push(dt);
    }
  }
  dates.sort((a, b) => a - b);
  const sessions = [];
  for (const dt of dates) {
    sessions.push(await prisma.trainingSession.create({
      data: { tournamentId, clubName, title: (title && String(title).slice(0, 120)) || 'Treino', focus: focus ? String(focus).slice(0, 300) : null, scheduledAt: dt, location: location ? String(location).slice(0, 160) : null, createdByUserId: createdByUserId || null, recurrenceGroupId: groupId },
    }));
  }
  const members = await clubMemberUserIds(tournamentId, clubName);
  await notifyMany(members, { type: 'training', title: 'Treinos agendados', body: `${clubName}: ${sessions.length} treinos de "${(title || 'Treino')}" marcados. Confirme presença.`, link: `/torneios.html#t/${tournamentId}` }, createdByUserId);
  return { ok: true, sessions, count: sessions.length, groupId };
}

// Lembra quem ainda não respondeu o RSVP (in-app; WhatsApp quando a API liberar).
async function remind(sessionId, byUserId) {
  const s = await prisma.trainingSession.findUnique({ where: { id: String(sessionId) } });
  if (!s) return { ok: false, code: 404, error: 'treino não encontrado' };
  const members = await clubMemberUserIds(s.tournamentId, s.clubName);
  const att = await prisma.trainingAttendance.findMany({ where: { sessionId: s.id }, select: { userId: true, rsvp: true } });
  const responded = new Set(att.filter((a) => a.rsvp).map((a) => a.userId));
  const pending = members.filter((u) => !responded.has(u));
  const quando = s.scheduledAt ? new Date(s.scheduledAt).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : 'em breve';
  await notifyMany(pending, { type: 'training', title: 'Confirma o treino?', body: `${s.clubName}: ${s.title} — ${quando}. Você ainda não respondeu.`, link: `/torneios.html#t/${s.tournamentId}` }, byUserId);
  return { ok: true, reminded: pending.length };
}

// Lista os treinos do clube (histórico), com contadores de presença.
async function list(tournamentId, entryId) {
  const clubName = await clubOfEntry(entryId, tournamentId);
  if (!clubName) return { clubName: null, sessions: [] };
  const sessions = await prisma.trainingSession.findMany({ where: { tournamentId, clubName, status: { not: 'CANCELED' } }, orderBy: [{ scheduledAt: 'desc' }, { createdAt: 'desc' }] });
  const ids = sessions.map((s) => s.id);
  const att = ids.length ? await prisma.trainingAttendance.findMany({ where: { sessionId: { in: ids } }, select: { sessionId: true, confirmed: true, present: true, rsvp: true } }) : [];
  const by = {};
  att.forEach((a) => { const c = (by[a.sessionId] = by[a.sessionId] || { confirmed: 0, going: 0, maybe: 0, declined: 0, present: 0, absent: 0 }); if (a.confirmed) c.confirmed++; if (a.rsvp === 'GOING') c.going++; if (a.rsvp === 'MAYBE') c.maybe++; if (a.rsvp === 'DECLINED') c.declined++; if (a.present === true) c.present++; if (a.present === false) c.absent++; });
  return { clubName, sessions: sessions.map((s) => ({ ...s, counts: by[s.id] || { confirmed: 0, going: 0, maybe: 0, declined: 0, present: 0, absent: 0 } })) };
}

// Súmula do treino: dados + chamada (todos os atletas do clube + marcação).
async function get(sessionId) {
  const s = await prisma.trainingSession.findUnique({ where: { id: String(sessionId) } });
  if (!s) return null;
  const memberIds = await clubMemberUserIds(s.tournamentId, s.clubName);
  const att = await prisma.trainingAttendance.findMany({ where: { sessionId: s.id } });
  const attByUser = Object.fromEntries(att.map((a) => [a.userId, a]));
  const allIds = [...new Set(memberIds.concat(att.map((a) => a.userId)))];
  const users = allIds.length ? await prisma.user.findMany({ where: { id: { in: allIds } }, select: { id: true, name: true, username: true } }) : [];
  const roster = users.map((u) => {
    const a = attByUser[u.id] || {};
    return {
      userId: u.id, name: u.name, username: u.username,
      confirmed: !!a.confirmed, rsvp: a.rsvp || null, present: a.present == null ? null : a.present,
      goals: a.goals == null ? null : a.goals, passes: a.passes == null ? null : a.passes,
      efficiency: a.efficiency == null ? null : a.efficiency, rating: a.rating == null ? null : a.rating,
      note: a.note || null, attendanceId: a.id || null,
    };
  }).sort((x, y) => String(x.name || '').localeCompare(String(y.name || '')));
  return { session: s, roster };
}

// Plano do treino em blocos cronometrados (aquecimento→técnico→...→volta à calma).
function sanitizePlan(plan) {
  if (!Array.isArray(plan)) return [];
  return plan.slice(0, 30).map((b) => ({
    name: String((b && b.name) || 'Bloco').slice(0, 60),
    minutes: Math.max(0, Math.min(240, Math.round(Number(b && b.minutes) || 0))),
    description: (b && b.description) ? String(b.description).slice(0, 500) : '',
  }));
}

async function update(sessionId, body = {}) {
  const data = {};
  if ('plan' in body) data.plan = sanitizePlan(body.plan);
  if ('title' in body) data.title = body.title ? String(body.title).slice(0, 120) : 'Treino';
  if ('focus' in body) data.focus = body.focus ? String(body.focus).slice(0, 300) : null;
  if ('location' in body) data.location = body.location ? String(body.location).slice(0, 160) : null;
  if ('notes' in body) data.notes = body.notes ? String(body.notes).slice(0, 2000) : null;
  if ('scheduledAt' in body) data.scheduledAt = body.scheduledAt ? new Date(body.scheduledAt) : null;
  if ('status' in body && ['SCHEDULED', 'DONE', 'CANCELED'].includes(String(body.status))) data.status = String(body.status);
  if (!Object.keys(data).length) return { ok: false, code: 400, error: 'nada pra atualizar' };
  const s = await prisma.trainingSession.update({ where: { id: String(sessionId) }, data }).catch(() => null);
  if (!s) return { ok: false, code: 404, error: 'treino não encontrado' };
  return { ok: true, session: s };
}

async function remove(sessionId) {
  await prisma.trainingAttendance.deleteMany({ where: { sessionId: String(sessionId) } }).catch(() => {});
  await prisma.trainingSession.delete({ where: { id: String(sessionId) } }).catch(() => {});
  return { ok: true };
}

// Atleta responde o RSVP: GOING | MAYBE | DECLINED (3 estados, padrão Spond/TeamSnap).
// Aceita também boolean (compat): true=GOING, false=DECLINED. confirmed espelha GOING.
const RSVP_STATES = ['GOING', 'MAYBE', 'DECLINED'];
async function confirm(sessionId, userId, rsvp) {
  const s = await sessionClub(sessionId);
  if (!s) return { ok: false, code: 404, error: 'treino não encontrado' };
  let val = typeof rsvp === 'string' ? String(rsvp).toUpperCase() : (rsvp === false ? 'DECLINED' : 'GOING');
  if (!RSVP_STATES.includes(val)) val = 'GOING';
  const confirmed = val === 'GOING';
  const a = await prisma.trainingAttendance.upsert({
    where: { sessionId_userId: { sessionId: s.id, userId } },
    create: { sessionId: s.id, userId, rsvp: val, confirmed },
    update: { rsvp: val, confirmed },
  });
  return { ok: true, attendance: a };
}

// Treinador/coordenador marca presença + PRODUÇÃO do atleta no treino (prontuário).
// fields: { present(true|false|null), goals, passes, efficiency(0-100), rating(0-10), note }
// Só grava o que vier no fields (patch parcial).
function clampNum(v, max) {
  if (v === undefined) return undefined;
  if (v === null || v === '') return null;
  let n = Number(v);
  if (Number.isNaN(n)) return undefined;
  n = Math.max(0, n);
  if (max != null) n = Math.min(max, n);
  return n;
}
async function mark(sessionId, athleteUserId, fields = {}) {
  const s = await sessionClub(sessionId);
  if (!s) return { ok: false, code: 404, error: 'treino não encontrado' };
  const data = {};
  if ('present' in fields) data.present = (fields.present == null || fields.present === 'null') ? null : !!fields.present;
  if ('note' in fields) data.note = fields.note ? String(fields.note).slice(0, 300) : null;
  const g = clampNum(fields.goals); if (g !== undefined) data.goals = g == null ? null : Math.round(g);
  const p = clampNum(fields.passes); if (p !== undefined) data.passes = p == null ? null : Math.round(p);
  const e = clampNum(fields.efficiency, 100); if (e !== undefined) data.efficiency = e == null ? null : Math.round(e);
  const r = clampNum(fields.rating, 10); if (r !== undefined) data.rating = r == null ? null : Math.round(r * 10) / 10;
  if (!Object.keys(data).length) return { ok: false, code: 400, error: 'nada pra marcar' };
  const a = await prisma.trainingAttendance.upsert({
    where: { sessionId_userId: { sessionId: s.id, userId: String(athleteUserId) } },
    create: { sessionId: s.id, userId: String(athleteUserId), ...data },
    update: data,
  });
  return { ok: true, attendance: a };
}

// PRONTUÁRIO do atleta neste torneio: resumo de rendimento + histórico treino a treino.
async function prontuario(tournamentId, userId) {
  const mine = await prisma.teamMembership.findMany({ where: { tournamentId, userId, status: 'ACTIVE' }, select: { clubName: true } });
  const clubs = [...new Set(mine.map((m) => m.clubName))];
  const user = await prisma.user.findUnique({ where: { id: String(userId) }, select: { id: true, name: true, username: true } });
  const sessions = clubs.length ? await prisma.trainingSession.findMany({ where: { tournamentId, clubName: { in: clubs }, status: { not: 'CANCELED' } }, orderBy: [{ scheduledAt: 'desc' }, { createdAt: 'desc' }] }) : [];
  const att = sessions.length ? await prisma.trainingAttendance.findMany({ where: { sessionId: { in: sessions.map((s) => s.id) }, userId } }) : [];
  const attBy = Object.fromEntries(att.map((a) => [a.sessionId, a]));
  let marked = 0, present = 0, absent = 0, confirmed = 0, goals = 0, passes = 0, effSum = 0, effN = 0, ratSum = 0, ratN = 0;
  const history = sessions.map((s) => {
    const a = attBy[s.id] || {};
    if (a.present === true) { present++; marked++; } else if (a.present === false) { absent++; marked++; }
    if (a.confirmed) confirmed++;
    if (a.goals != null) goals += a.goals;
    if (a.passes != null) passes += a.passes;
    if (a.efficiency != null) { effSum += a.efficiency; effN++; }
    if (a.rating != null) { ratSum += a.rating; ratN++; }
    return { sessionId: s.id, title: s.title, scheduledAt: s.scheduledAt, status: s.status, clubName: s.clubName, present: a.present == null ? null : a.present, confirmed: !!a.confirmed, goals: a.goals == null ? null : a.goals, passes: a.passes == null ? null : a.passes, efficiency: a.efficiency == null ? null : a.efficiency, rating: a.rating == null ? null : a.rating, note: a.note || null };
  });
  // Avaliações (Four Corner) + curva de evolução
  const evals = await prisma.athleteEvaluation.findMany({ where: { tournamentId, userId: String(userId) }, orderBy: [{ evaluatedAt: 'asc' }, { createdAt: 'asc' }] });
  const latestEval = evals.length ? evals[evals.length - 1] : null;
  const curve = evals.filter((e) => e.overall != null).map((e) => ({ date: e.evaluatedAt || e.createdAt, overall: e.overall }));
  return {
    user: user || { id: userId },
    clubs,
    summary: {
      treinos: sessions.length, marcados: marked, presencas: present, faltas: absent, confirmados: confirmed,
      presencaPct: marked ? Math.round((present / marked) * 100) : null,
      gols: goals, passes, eficienciaMedia: effN ? Math.round(effSum / effN) : null, notaMedia: ratN ? Math.round((ratSum / ratN) * 10) / 10 : null,
    },
    history,
    evaluation: { latest: latestEval, count: evals.length, curve, history: evals.slice().reverse() },
  };
}

// ----- Avaliação do atleta (FA Four Corner Model) -----
const EVAL_CORNERS = ['technical', 'tactical', 'physical', 'psychological', 'social'];
function clampScore(v) {
  if (v == null || v === '') return null;
  let n = Number(v); if (Number.isNaN(n)) return null;
  return Math.max(0, Math.min(10, Math.round(n * 10) / 10));
}
async function createEvaluation({ tournamentId, userId, evaluatorId, clubName, scores, notes, evaluatedAt }) {
  const s = scores || {};
  const vals = {}; EVAL_CORNERS.forEach((k) => { vals[k] = clampScore(s[k]); });
  const present = EVAL_CORNERS.map((k) => vals[k]).filter((v) => v != null);
  if (!present.length && !notes) return { ok: false, code: 400, error: 'preencha ao menos uma nota ou observação' };
  const overall = present.length ? Math.round((present.reduce((a, b) => a + b, 0) / present.length) * 10) / 10 : null;
  const ev = await prisma.athleteEvaluation.create({ data: { tournamentId, userId: String(userId), evaluatorId: evaluatorId || null, clubName: clubName || null, ...vals, overall, notes: notes ? String(notes).slice(0, 1000) : null, evaluatedAt: evaluatedAt ? new Date(evaluatedAt) : new Date() } });
  return { ok: true, evaluation: ev };
}
async function listEvaluations(tournamentId, userId) {
  return prisma.athleteEvaluation.findMany({ where: { tournamentId, userId: String(userId) }, orderBy: [{ evaluatedAt: 'desc' }, { createdAt: 'desc' }] });
}
async function deleteEvaluation(tournamentId, evalId) {
  await prisma.athleteEvaluation.deleteMany({ where: { id: String(evalId), tournamentId } }).catch(() => {});
  return { ok: true };
}

// Treinos dos clubes em que o atleta está vinculado (pra ele ver/confirmar).
async function forUser(tournamentId, userId) {
  const mine = await prisma.teamMembership.findMany({ where: { tournamentId, userId, status: 'ACTIVE' }, select: { clubName: true } });
  const clubs = [...new Set(mine.map((m) => m.clubName))];
  if (!clubs.length) return { sessions: [], upcoming: [], past: [] };
  const sessions = await prisma.trainingSession.findMany({ where: { tournamentId, clubName: { in: clubs }, status: { not: 'CANCELED' } }, orderBy: [{ scheduledAt: 'desc' }, { createdAt: 'desc' }] });
  const ids = sessions.map((s) => s.id);
  const mineAtt = ids.length ? await prisma.trainingAttendance.findMany({ where: { sessionId: { in: ids }, userId }, select: { sessionId: true, confirmed: true, rsvp: true, present: true } }) : [];
  const byId = Object.fromEntries(mineAtt.map((a) => [a.sessionId, a]));
  const mapped = sessions.map((s) => ({ ...s, myRsvp: (byId[s.id] && byId[s.id].rsvp) || null, myConfirmed: !!(byId[s.id] && byId[s.id].confirmed), myPresent: byId[s.id] ? byId[s.id].present : null }));
  const now = Date.now();
  const isUpcoming = (s) => s.status === 'SCHEDULED' && (!s.scheduledAt || new Date(s.scheduledAt).getTime() >= now - 6 * 3600000);
  const upcoming = mapped.filter(isUpcoming).sort((a, b) => new Date(a.scheduledAt || 0) - new Date(b.scheduledAt || 0));
  const past = mapped.filter((s) => !isUpcoming(s));
  return { sessions: mapped, upcoming, past };
}

// ----- Templates de plano (reutilizáveis por clube) -----
async function createTemplate({ tournamentId, entryId, createdByUserId, name, plan }) {
  const clubName = await clubOfEntry(entryId, tournamentId);
  if (!clubName) return { ok: false, code: 404, error: 'time não encontrado neste torneio' };
  const tpl = await prisma.trainingTemplate.create({ data: { tournamentId, clubName, name: (name && String(name).slice(0, 80)) || 'Modelo', plan: sanitizePlan(plan), createdByUserId: createdByUserId || null } });
  return { ok: true, template: tpl };
}
async function listTemplates(tournamentId, entryId) {
  const clubName = await clubOfEntry(entryId, tournamentId);
  if (!clubName) return { templates: [] };
  const templates = await prisma.trainingTemplate.findMany({ where: { tournamentId, clubName }, orderBy: { createdAt: 'desc' } });
  return { templates };
}
async function applyTemplate(sessionId, templateId) {
  const s = await sessionClub(sessionId);
  if (!s) return { ok: false, code: 404, error: 'treino não encontrado' };
  const tpl = await prisma.trainingTemplate.findFirst({ where: { id: String(templateId), tournamentId: s.tournamentId, clubName: s.clubName } });
  if (!tpl) return { ok: false, code: 404, error: 'modelo não encontrado' };
  const up = await prisma.trainingSession.update({ where: { id: s.id }, data: { plan: sanitizePlan(tpl.plan) } });
  return { ok: true, session: up };
}
async function deleteTemplate(tournamentId, templateId) {
  await prisma.trainingTemplate.deleteMany({ where: { id: String(templateId), tournamentId } }).catch(() => {});
  return { ok: true };
}

module.exports = { clubOfEntry, create, createRecurring, remind, list, get, update, remove, confirm, mark, forUser, prontuario, sessionClub, createTemplate, listTemplates, applyTemplate, deleteTemplate, createEvaluation, listEvaluations, deleteEvaluation, EVAL_CORNERS };
