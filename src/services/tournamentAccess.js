// =====================================================================
// Liga Aberta F1 — VISIBILIDADE do torneio (porta única de LEITURA)
// ---------------------------------------------------------------------
// visibility:
//   'public'   → aparece na vitrine/busca/ranking público e abre por link
//   'unlisted' → NÃO listado: só por link (fora da vitrine, da busca, das
//                séries e do ranking público), mas qualquer um com o link vê
//   'private'  → só MEMBROS: fundador (ownerId), quem tem papel no torneio
//                (TournamentRole), atleta inscrito (EntryMember), atleta com
//                vínculo ativo no time (TeamMembership), conta ligada ao
//                elenco (RosterPlayer.userId) e admin global
// Torneio ARQUIVADO (archivedAt) some de TODAS as rotas públicas (404).
// Liga F6: torneio SUSPENSO pela moderação (suspendedAt) também some com o MESMO 404
// para todo mundo — só o DONO (ownerId) e o admin global ainda veem (com aviso).
// Quem não pode ver recebe EXATAMENTE o mesmo 404 de "não existe".
// =====================================================================

const jwt = require('jsonwebtoken');
const { prisma, JWT_SECRET } = require('../middleware');
const { isGlobalAdmin } = require('./tournamentRoles');

const VISIBILITIES = ['public', 'unlisted', 'private'];
const NOT_FOUND_BODY = Object.freeze({ error: 'torneio não encontrado' });
const NOT_FOUND_HTML = '<html><body style="font-family:sans-serif;text-align:center;padding:60px"><h1>Torneio não encontrado</h1></body></html>';

function normalizeVisibility(v, fallback = 'public') {
  const s = String(v == null ? '' : v).trim().toLowerCase();
  if (s === 'nao-listado' || s === 'não-listado' || s === 'nao_listado' || s === 'link') return 'unlisted';
  return VISIBILITIES.includes(s) ? s : fallback;
}

// Mesmo corpo e status para "não existe" e "sem acesso" (não vaza existência).
function sendNotFound(res, kind = 'json') {
  if (kind === 'html') return res.status(404).send(NOT_FOUND_HTML);
  if (kind === 'text') return res.status(404).type('text').send('torneio não encontrado');
  return res.status(404).json({ ...NOT_FOUND_BODY });
}

// Quem está olhando? Usa o que o authMiddleware/designIsolation já resolveu
// (req.userId/req.userRole); senão lê o Bearer (login opcional — nunca bloqueia).
async function viewer(req) {
  if (!req) return { userId: null, userRole: null };
  if (req.__tViewer) return req.__tViewer;
  let out = { userId: req.userId || null, userRole: req.userRole || null };
  if (!out.userId) {
    const h = (req.headers && req.headers.authorization) || '';
    if (h.startsWith('Bearer ')) {
      try {
        const d = jwt.verify(h.slice(7), JWT_SECRET);
        if (d && typeof d.userId === 'string' && d.aud !== 'teniscash-mcp') {
          const u = await prisma.user.findUnique({ where: { id: d.userId }, select: { id: true, role: true, active: true } });
          if (u && u.active === true) out = { userId: u.id, userRole: u.role };
        }
      } catch (_) { /* token ruim = anônimo */ }
    }
  }
  req.__tViewer = out;
  return out;
}

// É membro do torneio (pode ver o privado)?
async function isMember(userId, t) {
  if (!userId || !t) return false;
  if (t.ownerId && t.ownerId === userId) return true;
  const tid = t.id;
  const [role, em, tm] = await Promise.all([
    prisma.tournamentRole.findFirst({ where: { tournamentId: tid, userId }, select: { id: true } }),
    prisma.entryMember.findFirst({ where: { userId, entry: { tournamentId: tid } }, select: { id: true } }),
    prisma.teamMembership.findFirst({ where: { tournamentId: tid, userId, status: 'ACTIVE' }, select: { id: true } }).catch(() => null),
  ]);
  if (role || em || tm) return true;
  // Liga F3: jogador do racha com conta ligada também é membro
  const pk = await prisma.pickupPlayer.findFirst({ where: { tournamentId: tid, userId }, select: { id: true } }).catch(() => null);
  if (pk) return true;
  // conta ligada a um nome do elenco (RosterPlayer não tem relação no schema)
  const linked = await prisma.rosterPlayer.findMany({ where: { userId }, select: { entryId: true }, take: 200 }).catch(() => []);
  if (!linked.length) return false;
  const e = await prisma.tournamentEntry.findFirst({ where: { tournamentId: tid, id: { in: linked.map((r) => r.entryId) } }, select: { id: true } });
  return !!e;
}

// Liga F6: o objeto veio sem a coluna suspendedAt (select antigo)? Busca — nunca
// trata "não selecionado" como "não suspenso".
async function suspendedAtOf(t) {
  if (!t) return null;
  if (t.suspendedAt !== undefined) return t.suspendedAt;
  if (!t.id) return null;
  try {
    const r = await prisma.tournament.findUnique({ where: { id: String(t.id) }, select: { suspendedAt: true, ownerId: true } });
    if (r && t.ownerId === undefined) t.ownerId = r.ownerId;
    return r ? r.suspendedAt : null;
  } catch (_) { return null; } // coluna ainda nascendo logo após o deploy
}
// Suspenso: só o dono e o admin global passam.
async function suspendedBlocks(v, t) {
  if (!(await suspendedAtOf(t))) return false;
  if (v && isGlobalAdmin(v.userRole)) return false;
  return !(v && v.userId && t.ownerId && v.userId === t.ownerId);
}

// Pode VER este torneio? (t precisa ter id, ownerId, visibility, archivedAt)
async function canSee(v, t) {
  if (!t) return false;
  if (t.archivedAt) return false;
  if (await module.exports.suspendedBlocks(v, t)) return false; // via exports: o teste de sabotagem troca
  const vis = normalizeVisibility(t.visibility);
  if (vis !== 'private') return true;
  if (v && isGlobalAdmin(v.userRole)) return true;
  return isMember(v && v.userId, t);
}

// Pode aparecer numa LISTA (clube, vitrine de terceiros)? Público e não arquivado pra todos;
// não listado/privado só pra membro ou admin global (não listado não entra em lista pública).
async function canSeeListed(v, t) {
  if (!t || t.archivedAt) return false;
  if (await module.exports.suspendedBlocks(v, t)) return false; // via exports: o teste de sabotagem troca
  if (normalizeVisibility(t.visibility) === 'public') return true;
  if (v && isGlobalAdmin(v.userRole)) return true;
  return isMember(v && v.userId, t);
}

const BASE_SELECT = { id: true, slug: true, ownerId: true, visibility: true, archivedAt: true, suspendedAt: true };

// Carrega o torneio (por id ou slug) SÓ se quem pede pode ver. null = 404.
// opts.select / opts.include seguem o Prisma (id/ownerId/visibility/archivedAt entram sempre).
async function loadVisibleTournament(req, idOrSlug, opts = {}) {
  if (!idOrSlug) return null;
  const key = String(idOrSlug);
  const q = { where: { OR: [{ id: key }, { slug: key }] } };
  if (opts.select) q.select = { ...opts.select, ...BASE_SELECT };
  else if (opts.include) q.include = opts.include;
  const t = await prisma.tournament.findFirst(q);
  if (!t) return null;
  if (!(await canSee(await viewer(req), t))) return null;
  return t;
}

// Mesmo critério, a partir de um id de torneio já conhecido (entry/jogo/categoria).
async function canSeeTournamentId(req, tournamentId) {
  if (!tournamentId) return false;
  const t = await prisma.tournament.findUnique({ where: { id: String(tournamentId) }, select: BASE_SELECT });
  return canSee(await viewer(req), t);
}

// Filtro Prisma da VITRINE / busca / ranking público: só público, não arquivado e não suspenso.
const LISTED_WHERE = Object.freeze({ visibility: 'public', archivedAt: null, suspendedAt: null });
// Filtro Prisma para listas internas que já tiravam o arquivado (painel, lembretes): tira também o suspenso.
const ACTIVE_WHERE = Object.freeze({ archivedAt: null, suspendedAt: null });

module.exports = {
  VISIBILITIES, NOT_FOUND_BODY, NOT_FOUND_HTML, LISTED_WHERE, ACTIVE_WHERE, suspendedAtOf, suspendedBlocks,
  normalizeVisibility, sendNotFound, viewer, isMember, canSee, canSeeListed,
  loadVisibleTournament, canSeeTournamentId,
};
