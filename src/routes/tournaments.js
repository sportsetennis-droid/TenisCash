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

// Membros (userIds) de uma entry — pra notificar a dupla/atleta.
async function entryMemberIds(entryId) {
  const ms = await prisma.entryMember.findMany({ where: { entryId }, select: { userId: true } });
  return ms.map((m) => m.userId);
}

const SPORTS = new Set([
  'TENNIS', 'BEACH_TENNIS', 'PADEL', 'FUTSAL', 'SOCCER', 'VOLLEY',
  'BASKETBALL', 'HANDBALL', 'TABLE_TENNIS', 'OTHER',
]);
const FORMATS = new Set(['KNOCKOUT', 'ROUND_ROBIN', 'GROUPS', 'GROUPS_KNOCKOUT']);
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
router.post('/', authMiddleware, async (req, res) => {
  try {
    const b = req.body || {};
    if (!b.name) return res.status(400).json({ error: 'name obrigatório' });
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
        bannerUrl: b.bannerUrl || null,
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
      },
    });
    res.status(201).json(t);
  } catch (err) {
    console.error('[tournaments] create', err);
    res.status(500).json({ error: err.message });
  }
});

// Importa o II Futsal Master Cup 2026 da tabela oficial.
// ⚠️ TEMPORÁRIO (dono pediu "sem token por enquanto"): SEM auth. É seguro o
// suficiente porque é IDEMPOTENTE e cria só este torneio fixo (sem parâmetros,
// sem dinheiro, sem dados de usuário). Re-proteger depois de carregado.
// Sem token, o organizador vira o primeiro admin (findOwner trata null).
router.post('/import/futsal-master-cup', async (req, res) => {
  try {
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
router.patch('/:id', authMiddleware, async (req, res) => {
  try {
    const t = await loadOwned(req, res, req.params.id);
    if (!t) return;
    const b = req.body || {};
    const data = {};
    for (const f of ['name', 'description', 'rules', 'bannerUrl', 'city', 'state', 'prizeDescription']) {
      if (b[f] !== undefined) data[f] = b[f];
    }
    if (b.sport && SPORTS.has(b.sport)) data.sport = b.sport;
    if (b.format && FORMATS.has(b.format)) data.format = b.format;
    if (b.isDoubles !== undefined) data.isDoubles = !!b.isDoubles;
    if (b.maxEntries !== undefined) data.maxEntries = b.maxEntries ? Number(b.maxEntries) : null;
    for (const f of ['startDate', 'endDate', 'registrationCloseAt']) {
      if (b[f] !== undefined) data[f] = b[f] ? new Date(b[f]) : null;
    }
    if (b.visibility) data.visibility = b.visibility === 'private' ? 'private' : 'public';

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

// =====================================================================
// INSCRIÇÕES
// =====================================================================

// Inscreve uma entry (atleta ou dupla). Atleta logado se auto-inscreve,
// ou o dono inscreve terceiros via memberUserIds/memberUsernames.
router.post('/:id/entries', authMiddleware, async (req, res) => {
  try {
    const t = await prisma.tournament.findUnique({ where: { id: req.params.id } });
    if (!t) return res.status(404).json({ error: 'torneio não encontrado' });
    const b = req.body || {};
    if (!b.categoryId) return res.status(400).json({ error: 'categoryId obrigatório' });

    const cat = await prisma.tournamentCategory.findFirst({
      where: { id: b.categoryId, tournamentId: t.id },
    });
    if (!cat) return res.status(400).json({ error: 'categoria não pertence a este torneio' });

    // ---- INSCRIÇÃO DE TIME/CLUBE (sem conta): só o NOME ----
    // Pra torneio de equipes (futsal, society, vôlei...), a inscrição é o CLUBE.
    // Não exige atleta com conta TenisCash. Aciona com { team:true, name:"Clube" }.
    if (b.team === true || b.teamName) {
      const teamName = String(b.teamName || b.name || '').trim();
      if (!teamName) return res.status(400).json({ error: 'nome do time obrigatório' });
      const dupName = await prisma.tournamentEntry.findFirst({
        where: { categoryId: cat.id, name: teamName },
      });
      if (dupName) return res.status(409).json({ error: 'já existe um time com esse nome nesta categoria' });
      if (t.maxEntries) {
        const count = await prisma.tournamentEntry.count({ where: { tournamentId: t.id } });
        if (count >= t.maxEntries) return res.status(409).json({ error: 'torneio lotado' });
      }
      const teamEntry = await prisma.tournamentEntry.create({
        data: {
          tournamentId: t.id,
          categoryId: cat.id,
          name: teamName,
          seed: b.seed ? Number(b.seed) : null,
          groupName: b.groupName || null,
        },
        include: { members: true },
      });
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
    let name = b.name;
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
        seed: b.seed ? Number(b.seed) : null,
        groupName: b.groupName || null,
        members: { create: memberIds.map((userId) => ({ userId })) },
      },
      include: { members: true },
    });

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
router.post('/:id/entries/request', authMiddleware, async (req, res) => {
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
    if (standings.length) return res.json({ standings });

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
    res.json({ standings: zero, provisional: true });
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
    if (b.scheduledAt !== undefined) data.scheduledAt = b.scheduledAt ? new Date(b.scheduledAt) : null;
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
// ⚠️ Escritas SEM token por enquanto (dono pediu) — re-proteger depois com
// credencial de árbitro. Leituras são públicas.
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

// Adiciona jogador ao elenco (nome + número, opcional goleiro/capitão)
router.post('/entries/:entryId/players', async (req, res) => {
  try {
    const entry = await prisma.tournamentEntry.findUnique({ where: { id: req.params.entryId }, select: { id: true } });
    if (!entry) return res.status(404).json({ error: 'time não encontrado' });
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

// Define/limpa o escudo (logo) de um time — sem token (igual súmula/elenco).
// body { logo: dataURI } ou { logo: null } pra limpar. Guarda data URI pequeno.
router.post('/entries/:entryId/logo', async (req, res) => {
  try {
    const entry = await prisma.tournamentEntry.findUnique({ where: { id: req.params.entryId }, select: { id: true, name: true, tournamentId: true } });
    if (!entry) return res.status(404).json({ error: 'time não encontrado' });
    const raw = (req.body || {}).logo;
    let logoUrl = null;
    if (raw && typeof raw === 'string' && raw.trim()) {
      const v = raw.trim();
      const okFmt = v.startsWith('data:image/') || v.startsWith('http://') || v.startsWith('https://') || v.startsWith('/');
      if (!okFmt) return res.status(400).json({ error: 'logo inválida (envie uma imagem)' });
      if (v.length > 800000) return res.status(413).json({ error: 'logo muito grande — reduza a imagem' });
      logoUrl = v;
    }
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

// Remove jogador do elenco
router.delete('/players/:playerId', async (req, res) => {
  try {
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

// Registra um evento da súmula (gol, assistência, cartão, falta, tempo)
router.post('/matches/:matchId/events', async (req, res) => {
  try {
    const r = await sheet.addEvent(req.params.matchId, req.body || {});
    if (!r.ok) return res.status(400).json(r);
    res.status(201).json(r.event);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Remove um evento da súmula
router.delete('/events/:eventId', async (req, res) => {
  try {
    await sheet.deleteEvent(req.params.eventId);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Grava a arbitragem da partida (árbitro 1/2, mesa) — sem finalizar
router.post('/matches/:matchId/officials', async (req, res) => {
  try {
    const r = await sheet.setOfficials(req.params.matchId, req.body || {});
    if (!r.ok) return res.status(400).json(r);
    res.json(r);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Fecha a súmula: conta os gols e aplica o placar (classificação + chave).
// body opcional: { homePenalties, awayPenalties, referee1, referee2, scorer }
router.post('/matches/:matchId/finalize', async (req, res) => {
  try {
    const r = await sheet.finalizeMatch(req.params.matchId, req.body || {});
    if (!r.ok) return res.status(400).json(r);
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
    const rows = await sheet.playerStats(req.params.id, { kind, categoryId: req.query.categoryId || null });
    res.json({ kind, ranking: rows });
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
// CADASTRO DE ATLETA (sem token) — WhatsApp + senha + foto
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

// Cadastra atleta. body: { name, whatsapp, password, instagram?, photo?(dataURI) }
router.post('/athletes/register', async (req, res) => {
  try {
    const b = req.body || {};
    const name = String(b.name || '').trim();
    const password = String(b.password || '');
    const whatsapp = String(b.whatsapp || b.phone || '').replace(/\D/g, '');
    if (!name) return res.status(400).json({ error: 'nome obrigatório' });
    if (password.length < 4 || password.length > 20) return res.status(400).json({ error: 'senha deve ter 4 a 20 caracteres' });
    if (!whatsapp || whatsapp.length < 10) return res.status(400).json({ error: 'WhatsApp com DDD obrigatório' });

    const existing = await prisma.user.findUnique({ where: { phone: whatsapp }, select: { id: true } });
    if (existing) return res.status(409).json({ error: 'este WhatsApp já tem conta' });

    const igHandle = b.instagram ? String(b.instagram).replace(/^@/, '').trim() : null;

    // Foto: upload explícito vence; senão tenta Instagram automático.
    let avatar = typeof b.photo === 'string' && b.photo.startsWith('data:') ? b.photo : null;
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

    const token = jwt.sign({ userId: user.id, role: user.role }, JWT_SECRET, { expiresIn: '30d' });
    res.status(201).json({
      token,
      user: { id: user.id, name: user.name, phone: user.phone, username, role: user.role },
      instagram: igHandle, instagramName: igName,
      photoSource, hasPhoto: !!avatar,
    });
  } catch (err) {
    console.error('[tournaments] register athlete', err);
    res.status(500).json({ error: err.message });
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
router.post('/:id/posts', authMiddleware, async (req, res) => {
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
