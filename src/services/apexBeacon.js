// =====================================================================
// APEX — Beacon (segurança): posição ao vivo pra até 3 contatos, por link
// ---------------------------------------------------------------------
// • Ao iniciar, cria a atividade em estado "recording" (privada) e uma
//   LiveTrackingSession com token aleatório (24 bytes). No banco fica SÓ o
//   hash SHA-256 do token; o token cru volta uma única vez pro dono.
// • O link /ao-vivo/<token> abre sem conta. Expira quando a atividade termina
//   (revokedAt) ou em 12 h (expiresAt), o que vier antes.
// • O envio do link aos contatos é feito pelo PRÓPRIO atleta (botão
//   WhatsApp/compartilhar no celular dele) — o servidor não manda mensagem.
// =====================================================================

const crypto = require('crypto');
const { prisma } = require('../middleware');

const MAX_HOURS = 12;
const TRAIL_MAX = 3000;
const MAX_CONTACTS = 3;

const hashToken = (t) => crypto.createHash('sha256').update(String(t)).digest('hex');

async function start(userId, { sportType = 'RUN' } = {}) {
  const { VALID_SPORTS } = require('./activityIngest');
  if (!VALID_SPORTS.has(sportType)) throw Object.assign(new Error('esporte inválido'), { status: 400 });
  const now = new Date();
  const token = crypto.randomBytes(24).toString('base64url');
  const activity = await prisma.activity.create({
    data: {
      userId, sportType, startedAt: now, elapsedTimeS: 0, movingTimeS: 0,
      visibility: 'private', deviceSource: 'phone', processingState: 'recording',
    },
  });
  const session = await prisma.liveTrackingSession.create({
    data: {
      activityId: activity.id, ownerId: userId, shareTokenHash: hashToken(token),
      expiresAt: new Date(now.getTime() + MAX_HOURS * 3600e3),
    },
  });
  // Consentimento explícito do compartilhamento ao vivo (LGPD)
  await prisma.consent.create({ data: { userId, scope: 'live_tracking', granted: true, version: 'apex-2026-11' } }).catch(() => {});
  const contacts = await prisma.safetyContact.findMany({ where: { userId }, take: MAX_CONTACTS });
  return { token, sessionId: session.id, activityId: activity.id, expiresAt: session.expiresAt, path: `/ao-vivo/${token}`, contacts };
}

function isActive(s) { return s && !s.revokedAt && s.expiresAt > new Date(); }

async function ownedSession(userId, sessionId) {
  const s = await prisma.liveTrackingSession.findUnique({ where: { id: String(sessionId) } });
  if (!s || s.ownerId !== userId) throw Object.assign(new Error('sessão não encontrada'), { status: 404 });
  return s;
}

async function position(userId, sessionId, pts) {
  const s = await ownedSession(userId, sessionId);
  if (!isActive(s)) throw Object.assign(new Error('sessão encerrada'), { status: 410 });
  const clean = (Array.isArray(pts) ? pts : [])
    .map((p) => [Number(p[0]), Number(p[1]), Number(p[2]) || Date.now()])
    .filter((p) => Number.isFinite(p[0]) && Number.isFinite(p[1]) && Math.abs(p[0]) <= 90 && Math.abs(p[1]) <= 180)
    .slice(-500);
  if (!clean.length) return { ok: true, stored: 0 };
  const trail = (Array.isArray(s.trail) ? s.trail : []).concat(clean.map((p) => [Math.round(p[0] * 1e6) / 1e6, Math.round(p[1] * 1e6) / 1e6, p[2]])).slice(-TRAIL_MAX);
  const last = clean[clean.length - 1];
  await prisma.liveTrackingSession.update({
    where: { id: s.id },
    data: { trail, lastLat: last[0], lastLng: last[1], lastAt: new Date(last[2]) },
  });
  return { ok: true, stored: clean.length };
}

async function stop(userId, sessionId) {
  const s = await ownedSession(userId, sessionId);
  if (!s.revokedAt) await prisma.liveTrackingSession.update({ where: { id: s.id }, data: { revokedAt: new Date() } });
  return { ok: true };
}

async function stopForActivity(activityId) {
  await prisma.liveTrackingSession.updateMany({ where: { activityId, revokedAt: null }, data: { revokedAt: new Date() } });
}

/** Leitura pública (sem conta). 404 se não existe, 410 se acabou. */
async function publicView(token) {
  if (!token || String(token).length < 20) return { status: 404 };
  const s = await prisma.liveTrackingSession.findUnique({
    where: { shareTokenHash: hashToken(token) },
    include: { activity: { select: { sportType: true, startedAt: true } }, owner: { select: { name: true } } },
  });
  if (!s) return { status: 404 };
  if (!isActive(s)) return { status: 410, body: { ended: true, endedAt: s.revokedAt || s.expiresAt } };
  await prisma.liveTrackingSession.update({ where: { id: s.id }, data: { viewerCount: { increment: 1 } } }).catch(() => {});
  return {
    status: 200,
    body: {
      athlete: (s.owner?.name || 'Atleta').split(' ')[0],
      sportType: s.activity?.sportType,
      startedAt: s.startedAt,
      expiresAt: s.expiresAt,
      last: s.lastLat != null ? { lat: s.lastLat, lng: s.lastLng, at: s.lastAt } : null,
      trail: (Array.isArray(s.trail) ? s.trail : []).map((p) => [p[0], p[1]]),
    },
  };
}

// ---- contatos de segurança (máx. 3)
async function listContacts(userId) { return prisma.safetyContact.findMany({ where: { userId } }); }
async function addContact(userId, body) {
  const n = await prisma.safetyContact.count({ where: { userId } });
  if (n >= MAX_CONTACTS) throw Object.assign(new Error('máximo de 3 contatos de segurança'), { status: 400 });
  const name = String(body.name || '').trim().slice(0, 60);
  const phone = String(body.phone || '').replace(/\D/g, '').slice(0, 15) || null;
  if (!name) throw Object.assign(new Error('nome obrigatório'), { status: 400 });
  if (!phone) throw Object.assign(new Error('telefone obrigatório'), { status: 400 });
  return prisma.safetyContact.create({ data: { userId, name, phone, relationship: body.relationship ? String(body.relationship).slice(0, 40) : null } });
}
async function removeContact(userId, id) {
  const r = await prisma.safetyContact.deleteMany({ where: { id: String(id), userId } });
  return { ok: r.count > 0 };
}

module.exports = { start, position, stop, stopForActivity, publicView, listContacts, addContact, removeContact, hashToken, MAX_CONTACTS };
