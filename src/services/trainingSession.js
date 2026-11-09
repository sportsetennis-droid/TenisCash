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

// Lista os treinos do clube (histórico), com contadores de presença.
async function list(tournamentId, entryId) {
  const clubName = await clubOfEntry(entryId, tournamentId);
  if (!clubName) return { clubName: null, sessions: [] };
  const sessions = await prisma.trainingSession.findMany({ where: { tournamentId, clubName, status: { not: 'CANCELED' } }, orderBy: [{ scheduledAt: 'desc' }, { createdAt: 'desc' }] });
  const ids = sessions.map((s) => s.id);
  const att = ids.length ? await prisma.trainingAttendance.findMany({ where: { sessionId: { in: ids } }, select: { sessionId: true, confirmed: true, present: true } }) : [];
  const by = {};
  att.forEach((a) => { const c = (by[a.sessionId] = by[a.sessionId] || { confirmed: 0, present: 0, absent: 0 }); if (a.confirmed) c.confirmed++; if (a.present === true) c.present++; if (a.present === false) c.absent++; });
  return { clubName, sessions: sessions.map((s) => ({ ...s, counts: by[s.id] || { confirmed: 0, present: 0, absent: 0 } })) };
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
      confirmed: !!a.confirmed, present: a.present == null ? null : a.present,
      goals: a.goals == null ? null : a.goals, passes: a.passes == null ? null : a.passes,
      efficiency: a.efficiency == null ? null : a.efficiency, rating: a.rating == null ? null : a.rating,
      note: a.note || null, attendanceId: a.id || null,
    };
  }).sort((x, y) => String(x.name || '').localeCompare(String(y.name || '')));
  return { session: s, roster };
}

async function update(sessionId, body = {}) {
  const data = {};
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

// Atleta confirma/desmarca presença (RSVP).
async function confirm(sessionId, userId, confirmed) {
  const s = await sessionClub(sessionId);
  if (!s) return { ok: false, code: 404, error: 'treino não encontrado' };
  const a = await prisma.trainingAttendance.upsert({
    where: { sessionId_userId: { sessionId: s.id, userId } },
    create: { sessionId: s.id, userId, confirmed: !!confirmed },
    update: { confirmed: !!confirmed },
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
  return {
    user: user || { id: userId },
    clubs,
    summary: {
      treinos: sessions.length, marcados: marked, presencas: present, faltas: absent, confirmados: confirmed,
      presencaPct: marked ? Math.round((present / marked) * 100) : null,
      gols: goals, passes, eficienciaMedia: effN ? Math.round(effSum / effN) : null, notaMedia: ratN ? Math.round((ratSum / ratN) * 10) / 10 : null,
    },
    history,
  };
}

// Treinos dos clubes em que o atleta está vinculado (pra ele ver/confirmar).
async function forUser(tournamentId, userId) {
  const mine = await prisma.teamMembership.findMany({ where: { tournamentId, userId, status: 'ACTIVE' }, select: { clubName: true } });
  const clubs = [...new Set(mine.map((m) => m.clubName))];
  if (!clubs.length) return { sessions: [] };
  const sessions = await prisma.trainingSession.findMany({ where: { tournamentId, clubName: { in: clubs }, status: { not: 'CANCELED' } }, orderBy: [{ scheduledAt: 'desc' }, { createdAt: 'desc' }] });
  const ids = sessions.map((s) => s.id);
  const mineAtt = ids.length ? await prisma.trainingAttendance.findMany({ where: { sessionId: { in: ids }, userId }, select: { sessionId: true, confirmed: true, present: true } }) : [];
  const byId = Object.fromEntries(mineAtt.map((a) => [a.sessionId, a]));
  return { sessions: sessions.map((s) => ({ ...s, myConfirmed: !!(byId[s.id] && byId[s.id].confirmed), myPresent: byId[s.id] ? byId[s.id].present : null })) };
}

module.exports = { clubOfEntry, create, list, get, update, remove, confirm, mark, forUser, prontuario, sessionClub };
