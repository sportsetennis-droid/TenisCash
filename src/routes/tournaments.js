// =====================================================================
// APEX COMPETIÇÃO — Rotas de torneios, partidas, ranking e desafios
// ---------------------------------------------------------------------
// Camada de competição do app esportivo (estilo CopaFácil + Playtomic),
// nativa no TenisCash. Mesmo User/identidade da loja. Premiação/inscrição
// em TenisCash real = fase 2 (gated). Aqui: gestão de torneio, chave,
// resultado, classificação, card do atleta (rating) e desafios 1v1.
// =====================================================================

const express = require('express');
const { prisma, authMiddleware } = require('../middleware');
const engine = require('../services/tournamentEngine');

const router = express.Router();

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
        entryFeeCash: Number(b.entryFeeCash) || 0,
        prizeCash: Number(b.prizeCash) || 0,
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
    res.json(updated);
  } catch (err) {
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
      include: { members: true, tournament: { select: { ownerId: true } } },
    });
    if (!entry) return res.status(404).json({ error: 'inscrição não encontrada' });
    const isOwner = entry.tournament.ownerId === req.userId;
    const isSelf = entry.members.some((m) => m.userId === req.userId);
    const isAdmin = ['admin', 'superadmin', 'manager'].includes(req.userRole);
    if (!isOwner && !isSelf && !isAdmin) return res.status(403).json({ error: 'sem permissão' });
    await prisma.tournamentEntry.delete({ where: { id: entry.id } });
    res.json({ ok: true });
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

    const r = await engine.generateFixtures(cat.id);
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

// Partidas da categoria (público) — agrupadas por rodada
router.get('/:id/categories/:catId/matches', async (req, res) => {
  try {
    const matches = await prisma.tournamentMatch.findMany({
      where: { categoryId: req.params.catId },
      orderBy: [{ round: 'asc' }, { ordering: 'asc' }],
      include: {
        homeEntry: { select: { id: true, name: true, seed: true } },
        awayEntry: { select: { id: true, name: true, seed: true } },
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
    const standings = await prisma.tournamentStanding.findMany({
      where: { categoryId: req.params.catId },
      orderBy: [{ groupName: 'asc' }, { rank: 'asc' }, { points: 'desc' }],
      include: {
        entry: {
          select: {
            id: true,
            name: true,
            members: { include: { user: { select: { id: true, name: true, username: true } } } },
          },
        },
      },
    });
    res.json({ standings });
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
      include: { tournament: { select: { id: true, ownerId: true } } },
    });
    if (!match) return res.status(404).json({ error: 'partida não encontrada' });
    const isAdmin = ['admin', 'superadmin', 'manager'].includes(req.userRole);
    if (match.tournament.ownerId !== req.userId && !isAdmin) {
      return res.status(403).json({ error: 'só o organizador registra resultado' });
    }
    const r = await engine.applyMatchResult(match.id, req.body || {});
    if (!r.ok) return res.status(400).json(r);
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

module.exports = router;
