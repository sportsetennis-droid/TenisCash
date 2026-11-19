// =====================================================================
// Liga Aberta F6 — MENORES DE 18 (fluxo do RESPONSÁVEL) — DESLIGADO por padrão
// ---------------------------------------------------------------------
// Lei: ECA Digital (Lei 15.211/2025) + LGPD (consentimento específico e em destaque de
// pai/mãe/responsável). Autodeclaração de idade NÃO basta (ECA Digital art. 9º §1º).
// LIGAR (env LIGA_MINORS=1) SÓ COM PARECER JURÍDICO + ORDEM DO DONO.
//
// Desligado (padrão):
//   - nenhum dado de menor é coletado (o cadastro de atleta recusa data de nascimento
//     de menor e não grava a data);
//   - as rotas do fluxo do responsável respondem 404 "indisponível";
//   - nada muda para quem já usa.
// Ligado (preparado e testado, não liberado):
//   - MinorProfile: o RESPONSÁVEL (conta logada) cria o perfil do menor com o primeiro
//     nome e a data declarada, aceitando o termo em destaque (versão + data + hash do texto);
//   - o menor NÃO é conta (User): sem login, sem @, sem busca, sem card público, sem ranking
//     público, sem telefone/WhatsApp/DM. Aviso vai só para o responsável (in-app);
//   - a vaga do elenco ligada a um menor sai como "Atleta (menor)" e fica fora da artilharia;
//   - ageVerification fica sempre 'NONE': nada aqui dá o menor como "verificado".
// =====================================================================

const crypto = require('crypto');
const { prisma } = require('../middleware');

const TZ = 'America/Fortaleza';
const CONSENT_VERSION = 'liga-menores-2026-11-v1';
const CONSENT_TEXT = [
  'Eu sou pai, mãe ou responsável legal por esta criança ou adolescente e autorizo, de forma específica e em destaque,',
  'o uso dos dados abaixo SOMENTE para a participação dele(a) em ligas e torneios no Club Sports & Tennis:',
  'primeiro nome, data de nascimento, time, número da camisa e os lances da súmula (gols, cartões).',
  'O perfil do menor não aparece em busca, não tem página pública, não entra em ranking público e não recebe',
  'mensagem direta: todo aviso vem para mim. Posso revogar esta autorização a qualquer momento na tela de privacidade.',
].join(' ');
const CONSENT_HASH = crypto.createHash('sha256').update(CONSENT_VERSION + '\n' + CONSENT_TEXT).digest('hex');
const MINOR_SIGNUP_MSG = 'Cadastro de menor de 18 anos só pelo responsável — e esse fluxo ainda não está disponível.';
const MINOR_LABEL = 'Atleta (menor)';

class MinorError extends Error { constructor(status, msg, extra) { super(msg); this.status = status; this.extra = extra; } }

function enabled() {
  return /^(1|true|on|sim)$/i.test(String(process.env.LIGA_MINORS || '').trim());
}

// Hoje (AAAA-MM-DD) em Fortaleza
function todayFortaleza(now = new Date()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
}
// "2012-05-30" | "30/05/2012" → "2012-05-30" (data real) ou null
function parseBirth(v) {
  const s = String(v == null ? '' : v).trim();
  let y; let m; let d;
  let r = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (r) [, y, m, d] = r;
  else if ((r = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(s))) [, d, m, y] = r;
  else return null;
  const dt = new Date(Date.UTC(+y, +m - 1, +d));
  if (dt.getUTCFullYear() !== +y || dt.getUTCMonth() !== +m - 1 || dt.getUTCDate() !== +d) return null;
  return `${y}-${m}-${d}`;
}
function ageOn(birthIso, todayIso = todayFortaleza()) {
  const [by, bm, bd] = birthIso.split('-').map(Number);
  const [ty, tm, td] = todayIso.split('-').map(Number);
  let a = ty - by;
  if (tm < bm || (tm === bm && td < bd)) a -= 1;
  return a;
}
// Data veio e indica MENOR de 18? (não grava nada; só para recusar o cadastro direto)
function declaresMinor(v, now) {
  const b = parseBirth(v);
  if (!b) return false;
  const a = ageOn(b, todayFortaleza(now));
  return a >= 0 && a < 18;
}

// Conta cujo cadastro do app declara MENOR de 18 (User.birthDate)? Não entra em elenco/time
// pela própria conta — com a flag desligada nada de menor é coletado; com ela ligada, menor
// só pelo fluxo do responsável. (Declaração não é prova de idade: serve só para RECUSAR.)
async function userDeclaredMinor(userId) {
  if (!userId) return false;
  try {
    const u = await prisma.user.findUnique({ where: { id: String(userId) }, select: { birthDate: true } });
    return !!(u && declaresMinor(u.birthDate));
  } catch (_) { return false; }
}
const MINOR_JOIN_MSG = 'Conta de menor de 18 anos não entra em elenco pela própria conta — só pelo fluxo do responsável (ainda indisponível).';

function assertEnabled() { if (!enabled()) throw new MinorError(404, 'indisponível'); }

function consentInfo() {
  assertEnabled();
  return { version: CONSENT_VERSION, text: CONSENT_TEXT, hash: CONSENT_HASH, ageVerification: 'NONE', note: 'Autodeclaração de idade não é prova: o perfil fica sem verificação.' };
}

function view(p) {
  return { id: p.id, firstName: p.firstName, birthDate: p.birthDate, status: p.status, consentVersion: p.consentVersion, consentAt: p.consentAt, ageVerification: p.ageVerification, revokedAt: p.revokedAt };
}

// Responsável cria o perfil do menor (termo em destaque aceito, versão atual).
async function createMinor(guardianUserId, body = {}) {
  assertEnabled();
  if (!guardianUserId) throw new MinorError(401, 'entre na sua conta');
  const c = body.consent || {};
  if (c.accepted !== true || c.version !== CONSENT_VERSION) throw new MinorError(400, 'aceite o termo do responsável (versão atual) para continuar', { consentVersion: CONSENT_VERSION });
  const first = String(body.firstName || '').trim().split(/\s+/)[0] || '';
  if (first.length < 2 || first.length > 40) throw new MinorError(400, 'informe só o primeiro nome do menor');
  require('./contentFilter').assertClean([{ field: 'name', value: first }]);
  const birth = parseBirth(body.birthDate);
  if (!birth) throw new MinorError(400, 'data de nascimento inválida (AAAA-MM-DD)');
  const age = ageOn(birth);
  if (age < 0) throw new MinorError(400, 'data de nascimento inválida');
  if (age >= 18) throw new MinorError(400, 'maior de 18 anos cria a própria conta');
  const g = await prisma.user.findUnique({ where: { id: String(guardianUserId) }, select: { id: true, active: true } });
  if (!g || !g.active) throw new MinorError(401, 'conta do responsável inválida');
  const n = await prisma.minorProfile.count({ where: { guardianUserId: g.id, status: 'ACTIVE' } });
  if (n >= 10) throw new MinorError(409, 'limite de 10 menores por responsável');
  const p = await prisma.minorProfile.create({
    data: { guardianUserId: g.id, firstName: first, birthDate: birth, ageVerification: 'NONE', consentVersion: CONSENT_VERSION, consentTextHash: CONSENT_HASH, consentAt: new Date(), status: 'ACTIVE' },
  });
  return view(p);
}

async function listMine(guardianUserId) {
  assertEnabled();
  const rows = await prisma.minorProfile.findMany({ where: { guardianUserId: String(guardianUserId) }, orderBy: { createdAt: 'asc' } });
  return rows.map(view);
}

async function ownMinor(guardianUserId, id) {
  const p = await prisma.minorProfile.findUnique({ where: { id: String(id) } });
  if (!p || p.guardianUserId !== guardianUserId) throw new MinorError(404, 'perfil não encontrado');
  return p;
}

// Revoga o consentimento: perfil REVOGADO, vaga segue anônima ("Atleta (menor)").
async function revokeMinor(guardianUserId, id) {
  assertEnabled();
  const p = await ownMinor(guardianUserId, id);
  if (p.status === 'REVOKED') return view(p);
  // revogar = a data de nascimento sai (o primeiro nome fica só para o responsável reconhecer)
  const r = await prisma.minorProfile.update({ where: { id: p.id }, data: { status: 'REVOKED', revokedAt: new Date(), birthDate: '' } });
  return view(r);
}

// Liga o menor a uma vaga do elenco. Precisa ser o RESPONSÁVEL e ter permissão de elenco
// no time (can SET_LINEUP). A vaga não pode ter conta; o nome público vira "Atleta (menor)".
async function linkRoster(actor, id, playerId) {
  assertEnabled();
  const p = await ownMinor(actor.userId, id);
  if (p.status !== 'ACTIVE') throw new MinorError(409, 'autorização revogada');
  const pl = await prisma.rosterPlayer.findUnique({ where: { id: String(playerId || '') }, select: { id: true, entryId: true, userId: true, minorProfileId: true } });
  if (!pl) throw new MinorError(404, 'vaga não encontrada');
  const entry = await prisma.tournamentEntry.findUnique({ where: { id: pl.entryId }, select: { id: true, tournamentId: true } });
  const roles = require('./tournamentRoles');
  if (!entry || !(await roles.can(actor.userId, actor.userRole, entry.tournamentId, 'SET_LINEUP', { entryId: entry.id }))) throw new MinorError(403, 'sem permissão no elenco deste time');
  if (pl.userId) throw new MinorError(409, 'essa vaga já tem conta ligada');
  if (pl.minorProfileId && pl.minorProfileId !== p.id) throw new MinorError(409, 'essa vaga já é de outro menor');
  await prisma.rosterPlayer.update({ where: { id: pl.id }, data: { minorProfileId: p.id, name: MINOR_LABEL } });
  return { ok: true, playerId: pl.id, publicName: MINOR_LABEL };
}

// Aviso de um menor: vai SÓ para o responsável, no app (nunca WhatsApp/DM ao menor).
async function notifyGuardian(minorProfileId, { title, body, link } = {}) {
  if (!enabled() || !minorProfileId) return null;
  const p = await prisma.minorProfile.findUnique({ where: { id: String(minorProfileId) }, select: { guardianUserId: true, status: true, firstName: true } });
  if (!p || p.status !== 'ACTIVE') return null;
  const { notify } = require('./notify');
  return notify(p.guardianUserId, { type: 'info', title: title || 'Aviso do Club', body: `${p.firstName}: ${body || ''}`.trim(), link: link || null }, { whatsapp: false });
}

module.exports = {
  enabled, declaresMinor, userDeclaredMinor, MINOR_JOIN_MSG, parseBirth, ageOn, todayFortaleza, consentInfo, createMinor, listMine, revokeMinor, linkRoster, notifyGuardian,
  MinorError, CONSENT_VERSION, CONSENT_HASH, MINOR_SIGNUP_MSG, MINOR_LABEL,
};
