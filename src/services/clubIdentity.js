// =====================================================================
// Liga Aberta F2 — CLUBE COMO IDENTIDADE do time (TournamentEntry.clubId)
// ---------------------------------------------------------------------
// Cada inscrição de TIME aponta para um Club (clube permanente). Nome, escudo
// e cores do time passam a vir do clube; inscrição sem clube (clubId nulo —
// ex.: o II Futsal Master Cup 2026, fora da migração) segue usando os campos
// da própria inscrição (name/logoUrl), exatamente como antes.
//
//   brand(entries)            sobrepõe nome/escudo/cores do clube na SAÍDA
//                             (nunca no banco). Mantém entryName = nome da inscrição.
//   clubForNewTeam(tx, ...)   escolhe/cria o clube de uma inscrição nova de time
//   planMigration / applyMigration   migração dos dados atuais (por torneio)
//   canEditClubViaEntry       editar clube = dono do clube OU MANAGE_TEAM no torneio
//
// Regras da migração (dono 2026-11-19):
//  - agrupa inscrições de time por NOME NORMALIZADO dentro do MESMO torneio
//    → 1 clube por grupo. NUNCA junta torneios diferentes só pelo nome igual.
//  - reaproveita o Club de um vínculo explícito (ClubTournamentLink) ou de uma
//    inscrição do grupo que já tenha clubId.
//  - torneios da LISTA DE EXCLUSÃO (EXCLUDED_SLUGS) ficam intactos.
//  - idempotente: inscrição que já tem clubId não é tocada.
// =====================================================================

const crypto = require('crypto');
const { prisma } = require('../middleware');

// Torneio real em andamento (20 a 22/11/2026): NÃO migrar agora. Rodar depois do
// evento com: node scripts/migrate-liga-f2-clubs.js --only=futsal-master-cup-2026 --include-excluded --apply
const EXCLUDED_SLUGS = Object.freeze(['futsal-master-cup-2026']);

function excludedSlugs() {
  const extra = String(process.env.LIGA_F2_EXCLUDE_SLUGS || '').split(',').map((s) => s.trim()).filter(Boolean);
  return new Set([...EXCLUDED_SLUGS, ...extra]);
}
function isExcludedSlug(slug) { return !!slug && excludedSlugs().has(String(slug)); }

// "Cabo Branco", "CABO  BRANCO " e "Cabo Brânco" → "cabo branco"
function normName(s) {
  return String(s || '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase().replace(/\s+/g, ' ').trim();
}

function slugify(s) {
  return String(s || '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
    .slice(0, 60) || 'clube';
}
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
function newCode(len = 8) {
  const b = crypto.randomBytes(len);
  let out = '';
  for (let i = 0; i < len; i++) out += CODE_ALPHABET[b[i] % CODE_ALPHABET.length];
  return out;
}
async function uniqueSlug(db, base) {
  let slug = base;
  for (let i = 2; i < 500; i++) {
    const hit = await db.club.findFirst({ where: { slug }, select: { id: true } });
    if (!hit) return slug;
    slug = base.slice(0, 55) + '-' + i;
  }
  return base.slice(0, 50) + '-' + newCode(5).toLowerCase();
}
async function uniqueCode(db) {
  for (let i = 0; i < 30; i++) {
    const c = newCode();
    const hit = await db.club.findFirst({ where: { inviteCode: c }, select: { id: true } });
    if (!hit) return c;
  }
  return newCode(12);
}

// Inscrição de TIME = sem atleta com conta (EntryMember). Dupla/individual nunca vira clube.
const CLUB_SELECT = { id: true, name: true, slug: true, crestUrl: true, primaryColor: true, secondaryColor: true, ownerId: true, originTournamentId: true };

// ---------------------------------------------------------------------
// LEITURA: sobrepõe nome/escudo/cores do clube (fallback = campos da inscrição)
// ---------------------------------------------------------------------
async function clubsForEntryIds(ids, db = prisma) {
  const uniq = [...new Set((ids || []).filter(Boolean).map(String))];
  if (!uniq.length) return new Map();
  let rows = [];
  try {
    rows = await db.tournamentEntry.findMany({ where: { id: { in: uniq }, clubId: { not: null } }, select: { id: true, clubId: true } });
  } catch (_) { return new Map(); } // coluna ainda não criada (deploy antes do ensureApexSchema)
  if (!rows.length) return new Map();
  const clubs = await db.club.findMany({ where: { id: { in: [...new Set(rows.map((r) => r.clubId))] } }, select: CLUB_SELECT });
  const byId = new Map(clubs.map((c) => [c.id, c]));
  const out = new Map();
  rows.forEach((r) => { if (byId.has(r.clubId)) out.set(r.id, byId.get(r.clubId)); });
  return out;
}

function applyClub(e, c) {
  if (!e || !c) return e;
  if (e.entryName === undefined) e.entryName = e.name;
  e.name = c.name || e.name;
  e.logoUrl = c.crestUrl || e.logoUrl || null;
  e.primaryColor = c.primaryColor || null;
  e.secondaryColor = c.secondaryColor || null;
  e.clubId = c.id;
  e.clubSlug = c.slug || null;
  return e;
}

// entries: objeto, array de objetos ou array de "caminhos" já resolvidos.
// Mutável (devolve o mesmo objeto). Sem clube → não mexe (fallback dos campos da inscrição).
async function brand(entries, db = prisma) {
  const list = (Array.isArray(entries) ? entries : [entries]).filter((e) => e && e.id);
  if (!list.length) return entries;
  const map = await clubsForEntryIds(list.map((e) => e.id), db);
  if (map.size) list.forEach((e) => applyClub(e, map.get(String(e.id))));
  return entries;
}

// Atalho: sobrepõe em homeEntry/awayEntry (e entry/winnerEntry) de uma lista de objetos.
async function brandNested(rows, keys = ['homeEntry', 'awayEntry'], db = prisma) {
  const ents = [];
  for (const r of rows || []) for (const k of keys) if (r && r[k] && r[k].id) ents.push(r[k]);
  await brand(ents, db);
  return rows;
}

// Clube de UMA inscrição (para a rota do escudo, a página pública etc.).
async function clubOfEntry(entryId, db = prisma) {
  const m = await clubsForEntryIds([entryId], db);
  return m.get(String(entryId)) || null;
}

// ---------------------------------------------------------------------
// CRIAÇÃO de inscrição de time: escolhe/cria o clube
// ---------------------------------------------------------------------
class ClubLinkError extends Error { constructor(status, msg) { super(msg); this.status = status; } }

const ADMIN_ROLES = new Set(['admin', 'superadmin', 'manager']);

// O usuário administra o clube (dono ou técnico ativo, ou admin global)?
async function isClubManager(db, club, userId, userRole) {
  if (!club) return false;
  if (ADMIN_ROLES.has(userRole)) return true;
  if (!userId) return false;
  if (club.ownerId === userId) return true;
  const m = await db.clubMembership.findUnique({ where: { clubId_userId: { clubId: club.id, userId } } }).catch(() => null);
  return !!(m && m.status === 'ACTIVE' && ['owner', 'coach', 'admin'].includes(String(m.role).toLowerCase()));
}

// Decide o clube de uma inscrição NOVA de time.
// t: { id, slug, ownerId }; opts: { teamName, userId, userRole, requestedClubId, ownerMembership }
// Retorna { clubId, created } ou { clubId:null, skipped:'excluded' }.
// db precisa ser o tx da transação que cria a inscrição.
async function clubForNewTeam(db, t, opts = {}) {
  if (isExcludedSlug(t.slug)) return { clubId: null, skipped: 'excluded' };
  const key = normName(opts.teamName);
  if (!key) return { clubId: null };
  // 1) mesmo clube já inscrito neste torneio (outra categoria) → mesmo clube
  const siblings = await db.tournamentEntry.findMany({ where: { tournamentId: t.id, clubId: { not: null } }, select: { id: true, name: true, clubId: true } });
  const same = siblings.filter((e) => normName(e.name) === key);
  if (same.length) {
    const clubId = same[0].clubId;
    if (opts.requestedClubId && opts.requestedClubId !== clubId) throw new ClubLinkError(409, 'este time já está ligado a outro clube neste torneio');
    // Quem NÃO organiza só entra num clube que já existe aqui se já for admin dele (TEAM_ADMIN
    // de uma inscrição irmã) ou dono/técnico do clube. Senão um nome com acento/espaço diferente
    // sequestraria o clube de outro time.
    if (!opts.manager) {
      const adm = opts.userId ? await db.tournamentRole.findFirst({ where: { tournamentId: t.id, userId: opts.userId, role: 'TEAM_ADMIN', entryId: { in: same.map((e) => e.id) } }, select: { id: true } }) : null;
      const club = adm ? null : await db.club.findUnique({ where: { id: clubId }, select: CLUB_SELECT });
      if (!adm && !(await isClubManager(db, club, opts.userId, opts.userRole))) {
        throw new ClubLinkError(409, 'já existe um time com esse nome neste torneio — peça ao administrador do time para inscrever a categoria');
      }
    }
    return { clubId, created: false, reused: 'tournament' };
  }
  // 2) clube escolhido pelo usuário (precisa administrar o clube)
  if (opts.requestedClubId) {
    const club = await db.club.findUnique({ where: { id: String(opts.requestedClubId) }, select: CLUB_SELECT });
    if (!club) throw new ClubLinkError(404, 'clube não encontrado');
    if (!(await isClubManager(db, club, opts.userId, opts.userRole))) throw new ClubLinkError(403, 'você só pode inscrever um clube que você administra (dono ou técnico)');
    const taken = siblings.find((e) => e.clubId === club.id);
    if (taken) throw new ClubLinkError(409, 'este clube já está inscrito neste torneio com outro nome (' + taken.name + ')');
    return { clubId: club.id, created: false, reused: 'chosen' };
  }
  // 3) cria um clube novo com o nome do time
  const ownerId = opts.userId || t.ownerId;
  const club = await db.club.create({
    data: {
      ownerId,
      originTournamentId: t.id,
      name: String(opts.teamName).trim().slice(0, 80),
      privacyLevel: t.visibility === 'private' ? 'private' : 'public',
      sportScope: t.sport ? String(t.sport).toLowerCase() : null,
      sports: t.sport ? [String(t.sport).toUpperCase()] : [],
      slug: await uniqueSlug(db, slugify(opts.teamName)),
      inviteCode: await uniqueCode(db),
      ...(opts.ownerMembership && opts.userId ? { memberships: { create: { userId: opts.userId, role: 'owner', status: 'ACTIVE' } } } : {}),
    },
    select: { id: true },
  });
  return { clubId: club.id, created: true };
}

// Inscrição de time criada FORA da rota principal (inscrição online paga): liga o clube
// depois da transação do pagamento (best-effort: nunca derruba a confirmação).
async function attachClubToTeamEntry(entryId, { ownerUserId = null } = {}) {
  try {
    const e = await prisma.tournamentEntry.findUnique({ where: { id: String(entryId) }, select: { id: true, name: true, clubId: true, tournamentId: true, _count: { select: { members: true } } } });
    if (!e || e.clubId || e._count.members > 0) return null;
    const t = await prisma.tournament.findUnique({ where: { id: e.tournamentId }, select: { id: true, slug: true, ownerId: true, sport: true, visibility: true } });
    if (!t) return null;
    const r = await prisma.$transaction(async (tx) => {
      // inscrição online: quem pagou NÃO organiza → mesma trava anti-sequestro do clube
      const pick = await clubForNewTeam(tx, t, { teamName: e.name, userId: ownerUserId || t.ownerId, ownerMembership: !!ownerUserId, manager: !ownerUserId });
      if (pick.clubId) await tx.tournamentEntry.updateMany({ where: { id: e.id, clubId: null }, data: { clubId: pick.clubId } });
      return pick;
    });
    return r;
  } catch (err) {
    console.error('[clubIdentity] attachClubToTeamEntry', err.message);
    return null;
  }
}

// ---------------------------------------------------------------------
// PERMISSÃO: editar o clube a partir de um time do torneio
//  - dono/técnico do clube (ou admin global) → sempre
//  - MANAGE_TEAM no torneio para aquele time → só se o clube for EXCLUSIVO deste
//    torneio (clube permanente com inscrições em outros torneios = só o dono edita)
// ---------------------------------------------------------------------
async function canEditClubViaEntry(userId, userRole, entry) {
  if (!entry || !entry.clubId) return { ok: false, status: 404, error: 'este time não tem clube ligado' };
  const club = await prisma.club.findUnique({ where: { id: entry.clubId }, select: CLUB_SELECT });
  if (!club) return { ok: false, status: 404, error: 'clube não encontrado' };
  if (await isClubManager(prisma, club, userId, userRole)) return { ok: true, club, via: 'club' };
  const roles = require('./tournamentRoles');
  if (!(await roles.can(userId, userRole, entry.tournamentId, 'MANAGE_TEAM', { entryId: entry.id }))) {
    return { ok: false, status: 403, error: 'sem permissão (dono do clube, coordenação ou admin do time)' };
  }
  // Só clube que NASCEU neste torneio (inscrição/migração) e não joga outro campeonato.
  // Clube permanente (criado em /clubs) = só o dono/técnico do clube.
  if (club.originTournamentId !== entry.tournamentId) return { ok: false, status: 403, error: 'este é um clube permanente — só o dono do clube muda nome, escudo e cores' };
  const elsewhere = await prisma.tournamentEntry.findFirst({ where: { clubId: club.id, tournamentId: { not: entry.tournamentId } }, select: { id: true } });
  if (elsewhere) return { ok: false, status: 403, error: 'este clube joga outros campeonatos — só o dono do clube pode mudar nome, escudo e cores' };
  return { ok: true, club, via: 'tournament' };
}

// ---------------------------------------------------------------------
// MIGRAÇÃO dos dados atuais (idempotente, por torneio)
// ---------------------------------------------------------------------
// opts: { onlySlugs?: string[], includeExcluded?: bool }
async function planMigration(db = prisma, opts = {}) {
  const ex = excludedSlugs();
  const where = opts.onlySlugs && opts.onlySlugs.length ? { slug: { in: opts.onlySlugs } } : {};
  const tournaments = await db.tournament.findMany({ where, select: { id: true, slug: true, name: true, ownerId: true, sport: true, visibility: true, archivedAt: true }, orderBy: { createdAt: 'asc' } });
  const { TEAM_SPORTS } = require('./clubRating');
  const plan = { tournaments: [], skipped: [], conflicts: [], totals: { groups: 0, entriesToLink: 0, clubsToCreate: 0, clubsReused: 0, alreadyLinked: 0 } };
  for (const t of tournaments) {
    if (ex.has(t.slug) && !opts.includeExcluded) { plan.skipped.push({ tournamentId: t.id, slug: t.slug, reason: 'lista de exclusão' }); continue; }
    if (t.archivedAt) { plan.skipped.push({ tournamentId: t.id, slug: t.slug, reason: 'arquivado' }); continue; }
    const entries = await db.tournamentEntry.findMany({
      where: { tournamentId: t.id },
      select: { id: true, name: true, clubId: true, logoUrl: true, createdAt: true, _count: { select: { members: true } } },
      orderBy: { createdAt: 'asc' },
    });
    // TIME = sem atleta com conta E (esporte de equipe OU tem elenco OU tem admin de time).
    // Dupla/individual com o @ não achado (0 membros) NÃO vira clube.
    const teamSport = TEAM_SPORTS.has(t.sport);
    const noMember = entries.filter((e) => e._count.members === 0);
    let marked = new Set();
    if (!teamSport && noMember.length) {
      const ids = noMember.map((e) => e.id);
      const [rp, ta] = await Promise.all([
        db.rosterPlayer.findMany({ where: { entryId: { in: ids } }, select: { entryId: true }, distinct: ['entryId'] }),
        db.tournamentRole.findMany({ where: { tournamentId: t.id, role: 'TEAM_ADMIN', entryId: { in: ids } }, select: { entryId: true } }),
      ]);
      marked = new Set([...rp.map((r) => r.entryId), ...ta.map((r) => r.entryId)]);
    }
    const teams = noMember.filter((e) => teamSport || marked.has(e.id));
    if (!teams.length) continue;
    const links = await db.clubTournamentLink.findMany({ where: { tournamentId: t.id }, select: { clubId: true, entryName: true } });
    const linkClubIds = [...new Set(links.map((l) => l.clubId))];
    const existingClubs = linkClubIds.length ? await db.club.findMany({ where: { id: { in: linkClubIds } }, select: { id: true } }) : [];
    const liveClub = new Set(existingClubs.map((c) => c.id));
    const groups = new Map();
    for (const e of teams) {
      const k = normName(e.name);
      if (!k) continue;
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k).push(e);
    }
    const tp = { tournamentId: t.id, slug: t.slug, name: t.name, ownerId: t.ownerId, sport: t.sport, visibility: t.visibility, groups: [] };
    for (const [key, list] of groups) {
      const pending = list.filter((e) => !e.clubId);
      plan.totals.alreadyLinked += list.length - pending.length;
      if (!pending.length) continue; // idempotente: grupo todo já ligado
      const have = [...new Set(list.map((e) => e.clubId).filter(Boolean))];
      if (have.length > 1) { plan.conflicts.push({ tournamentId: t.id, slug: t.slug, key, reason: 'inscrições do mesmo nome já ligadas a clubes diferentes', clubIds: have }); continue; }
      let clubId = have[0] || null;
      let source = clubId ? 'grupo' : null;
      if (!clubId) {
        const viaLink = [...new Set(links.filter((l) => normName(l.entryName) === key && liveClub.has(l.clubId)).map((l) => l.clubId))];
        if (viaLink.length > 1) { plan.conflicts.push({ tournamentId: t.id, slug: t.slug, key, reason: 'vínculos explícitos para clubes diferentes', clubIds: viaLink }); continue; }
        if (viaLink.length === 1) { clubId = viaLink[0]; source = 'vinculo'; }
      }
      const g = {
        key, names: [...new Set(list.map((e) => e.name))], entryIds: pending.map((e) => e.id),
        clubId, source: source || 'novo',
        create: clubId ? null : { name: list[0].name.trim().slice(0, 80), crestFromEntryId: (list.find((e) => e.logoUrl) || {}).id || null },
      };
      tp.groups.push(g);
      plan.totals.groups += 1;
      plan.totals.entriesToLink += g.entryIds.length;
      if (g.create) plan.totals.clubsToCreate += 1; else plan.totals.clubsReused += 1;
    }
    if (tp.groups.length) plan.tournaments.push(tp);
  }
  return plan;
}

// Aplica o plano: 1 transação por torneio. Devolve o "backup" (o que mudou) para reverter.
async function applyMigration(db = prisma, plan, { onTournamentDone } = {}) {
  const done = { tournaments: [], linked: [], clubsCreated: [] };
  for (const tp of plan.tournaments) {
    await db.$transaction(async (tx) => {
      for (const g of tp.groups) {
        let clubId = g.clubId;
        if (!clubId) {
          const ids = g.entryIds;
          // dono do clube = 1º admin do time (TEAM_ADMIN) das inscrições do grupo; senão o organizador
          const adm = await tx.tournamentRole.findFirst({ where: { tournamentId: tp.tournamentId, role: 'TEAM_ADMIN', entryId: { in: ids } }, orderBy: { createdAt: 'asc' }, select: { userId: true } });
          const ownerId = adm ? adm.userId : tp.ownerId;
          let crestUrl = null;
          if (g.create.crestFromEntryId) {
            const src = await tx.tournamentEntry.findUnique({ where: { id: g.create.crestFromEntryId }, select: { logoUrl: true } });
            crestUrl = src ? src.logoUrl : null;
          }
          const club = await tx.club.create({
            data: {
              ownerId, originTournamentId: tp.tournamentId, name: g.create.name, privacyLevel: tp.visibility === 'private' ? 'private' : 'public',
              sportScope: tp.sport ? String(tp.sport).toLowerCase() : null,
              sports: tp.sport ? [String(tp.sport).toUpperCase()] : [],
              crestUrl,
              slug: await uniqueSlug(tx, slugify(g.create.name)),
              inviteCode: await uniqueCode(tx),
              ...(adm ? { memberships: { create: { userId: adm.userId, role: 'owner', status: 'ACTIVE' } } } : {}),
            },
            select: { id: true, slug: true },
          });
          clubId = club.id;
          done.clubsCreated.push({ clubId, slug: club.slug, name: g.create.name, tournamentId: tp.tournamentId, ownerId });
        }
        const r = await tx.tournamentEntry.updateMany({ where: { id: { in: g.entryIds }, clubId: null }, data: { clubId } });
        done.linked.push({ tournamentId: tp.tournamentId, key: g.key, clubId, entryIds: g.entryIds, updated: r.count, previousClubId: null });
      }
    }, { timeout: 60000 });
    done.tournaments.push(tp.slug);
    // backup a cada torneio (falha no meio = o arquivo já tem o que foi gravado)
    if (typeof onTournamentDone === 'function') await onTournamentDone(done);
  }
  return done;
}

// Reverte (pelo backup do apply): devolve clubId=null às inscrições ligadas. Clubes criados
// NÃO são apagados (nunca apagar) — ficam sem inscrição e aparecem no relatório.
async function revertMigration(db = prisma, backup) {
  let entries = 0;
  for (const l of (backup && backup.linked) || []) {
    const r = await db.tournamentEntry.updateMany({ where: { id: { in: l.entryIds }, clubId: l.clubId }, data: { clubId: l.previousClubId || null } });
    entries += r.count;
  }
  return { entries, clubsKept: ((backup && backup.clubsCreated) || []).length };
}

module.exports = {
  EXCLUDED_SLUGS, excludedSlugs, isExcludedSlug, normName, slugify,
  clubsForEntryIds, applyClub, brand, brandNested, clubOfEntry,
  ClubLinkError, isClubManager, clubForNewTeam, attachClubToTeamEntry, canEditClubViaEntry,
  planMigration, applyMigration, revertMigration,
};
