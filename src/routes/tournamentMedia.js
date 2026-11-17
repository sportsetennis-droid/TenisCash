// =====================================================================
// APEX F2 — AO VIVO, MÍDIA E COMPARTILHAMENTO dos torneios
// ---------------------------------------------------------------------
// apiRouter     (montado em /api/tournaments)
//   GET  /:id/live                    SSE público (placar/eventos/cartões/fim)
//   GET  /:id/arte/:tipo.png          arte PNG (?formato=story|feed|quadrado|og)
//   GET  /:id/qr.png                  QR da página do torneio (?jogo=<matchId>)
//   GET  /:id/sponsors                patrocinadores (público)
//   POST /:id/sponsors                cria  (organizador: MANAGE_TOURNAMENT)
//   PATCH/DELETE /:id/sponsors/:sid   edita / remove (organizador)
// publicRouter  (montado em /api/public) — CORS aberto, só leitura
//   GET  /tournaments/:slug           jogos + classificação + artilharia + patrocínio
//   GET  /entries/:id/logo            escudo (data URI vira imagem cacheável)
//   GET  /sponsors/:id/logo           logo do patrocinador
// pageRouter    (montado em /t)
//   GET  /:slug/telao                 modo telão (TV do ginásio)
//   GET  /:slug/calendario.ics        agenda ICS (?categoria=, ?time=) fuso America/Fortaleza
//   GET  /:slug/embed                 tabela/jogos pra iframe
// =====================================================================

const express = require('express');
const QRCode = require('qrcode');
const { prisma, authMiddleware } = require('../middleware');
const roles = require('../services/tournamentRoles');
const live = require('../services/tournamentLive');
const art = require('../services/tournamentArt');
const sheet = require('../services/matchSheet');
const { publicBaseUrl } = require('../config/publicUrl');

const apiRouter = express.Router();
const publicRouter = express.Router();
const pageRouter = express.Router();

const TZ = 'America/Fortaleza';
const esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const jsonForScript = (v) => JSON.stringify(v).replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');

async function findTournament(key) {
  if (!key) return null;
  return prisma.tournament.findFirst({
    where: { OR: [{ id: String(key) }, { slug: String(key) }] },
    select: { id: true, slug: true, name: true, sport: true, status: true, format: true, bannerUrl: true, city: true, state: true, startDate: true, endDate: true, prizeDescription: true, visibility: true, ownerId: true, description: true },
  });
}

function originOf(req) {
  const host = req.get('host');
  return host ? `${req.protocol}://${host}` : publicBaseUrl();
}

// --------------------------------------------------------------------
// AO VIVO (SSE)
// --------------------------------------------------------------------
apiRouter.get('/:id/live', async (req, res) => {
  try {
    const t = await findTournament(req.params.id);
    if (!t || t.visibility === 'private') return res.status(404).json({ error: 'torneio não encontrado' });
    if (!live.subscribe(t.id, req, res)) return;
    // estado inicial: jogos AO VIVO agora (o cliente sincroniza sem esperar o próximo lance)
    const lives = await prisma.tournamentMatch.findMany({ where: { tournamentId: t.id, status: 'LIVE' }, select: { id: true } });
    const snaps = [];
    for (const m of lives) { const s = await live.matchSnapshot(m.id); if (s) snaps.push(s); }
    res.write(`data: ${JSON.stringify({ type: 'hello', at: new Date().toISOString(), tournamentId: t.id, live: snaps })}\n\n`);
    if (typeof res.flush === 'function') res.flush();
  } catch (err) {
    if (!res.headersSent) res.status(500).json({ error: err.message });
  }
});

// --------------------------------------------------------------------
// ARTES (PNG)
// --------------------------------------------------------------------
apiRouter.get('/:id/arte/:file', async (req, res) => {
  try {
    const m = /^([a-z]+)\.png$/i.exec(req.params.file || '');
    if (!m) return res.status(400).json({ error: 'use /arte/<tipo>.png' });
    const out = await art.buildArt(req.params.id, m[1].toLowerCase(), req.query || {});
    const etag = '"' + out.hash + '"';
    res.set('ETag', etag);
    res.set('Cache-Control', 'public, max-age=60');
    if (req.headers['if-none-match'] === etag) return res.status(304).end();
    res.type('png');
    if (req.query.download) {
      const name = String(req.query.download).replace(/[^a-z0-9-_]/gi, '').slice(0, 60) || 'arte';
      res.set('Content-Disposition', `attachment; filename="${name}.png"`);
    }
    res.send(out.png);
  } catch (err) {
    const st = err.status || 500;
    if (st >= 500) console.error('[tournamentMedia] arte', err);
    res.status(st).json({ error: err.message });
  }
});

// --------------------------------------------------------------------
// QR CODE
// --------------------------------------------------------------------
apiRouter.get('/:id/qr.png', async (req, res) => {
  try {
    const t = await findTournament(req.params.id);
    if (!t || t.visibility === 'private') return res.status(404).json({ error: 'torneio não encontrado' });
    let url = `${publicBaseUrl()}/t/${t.slug}`;
    const jogo = req.query.jogo || req.query.matchId;
    if (jogo) {
      const m = await prisma.tournamentMatch.findFirst({ where: { id: String(jogo), tournamentId: t.id }, select: { id: true } });
      if (!m) return res.status(404).json({ error: 'jogo não encontrado' });
      url += `?jogo=${m.id}`;
    }
    const size = Math.min(Math.max(Number(req.query.size) || 600, 120), 1600);
    const png = await QRCode.toBuffer(url, { type: 'png', width: size, margin: 2, errorCorrectionLevel: 'M', color: { dark: '#0B0B0D', light: '#FFFFFF' } });
    res.set('Cache-Control', 'public, max-age=3600');
    res.set('X-QR-Url', url);
    res.type('png').send(png);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --------------------------------------------------------------------
// PATROCINADORES
// --------------------------------------------------------------------
const LOGO_DATA_RX = /^data:image\/(png|jpe?g|webp|gif|svg\+xml);base64,[a-z0-9+/=\s]+$/i;
function cleanSponsor(b, partial) {
  const out = {};
  if (!partial || 'name' in b) {
    const name = String(b.name || '').trim().slice(0, 80);
    if (!name) return { error: 'nome do patrocinador obrigatório' };
    out.name = name;
  }
  if ('logoUrl' in b) {
    const v = b.logoUrl == null ? '' : String(b.logoUrl).trim();
    if (!v) out.logoUrl = null;
    else if (/^https?:\/\/\S+$/i.test(v) && v.length <= 1000) out.logoUrl = v;
    else if (LOGO_DATA_RX.test(v) && v.length <= 600000) out.logoUrl = v;
    else return { error: 'logo inválido (URL https ou imagem até ~400 KB)' };
  }
  if ('link' in b) {
    const v = b.link == null ? '' : String(b.link).trim();
    if (!v) out.link = null;
    else if (/^https?:\/\/\S+$/i.test(v) && v.length <= 500) out.link = v;
    else if (/^@?[a-z0-9._]{2,30}$/i.test(v)) out.link = 'https://instagram.com/' + v.replace(/^@/, '');
    else return { error: 'link inválido (use https://...)' };
  }
  if ('ordering' in b) out.ordering = Math.max(-1000, Math.min(1000, Math.round(Number(b.ordering) || 0)));
  if ('active' in b) out.active = !!b.active;
  return { data: out };
}
function sponsorOut(s, origin) {
  return {
    id: s.id, name: s.name, link: s.link, ordering: s.ordering, active: s.active,
    logoUrl: s.logoUrl ? (s.logoUrl.startsWith('data:') ? `${origin}/api/public/sponsors/${s.id}/logo` : s.logoUrl) : null,
  };
}
async function listSponsors(tournamentId, origin, all) {
  try {
    const rows = await prisma.tournamentSponsor.findMany({
      where: { tournamentId, ...(all ? {} : { active: true }) },
      orderBy: [{ ordering: 'asc' }, { createdAt: 'asc' }],
    });
    return rows.map((s) => sponsorOut(s, origin));
  } catch (e) {
    return []; // tabela ainda não existe no banco
  }
}

async function canManage(req, res, t) {
  if (!(await roles.can(req.userId, req.userRole, t.id, 'MANAGE_TOURNAMENT'))) {
    res.status(403).json({ error: 'só a organização do torneio gerencia patrocinadores' });
    return false;
  }
  return true;
}

apiRouter.get('/:id/sponsors', async (req, res) => {
  try {
    res.set('Cache-Control', 'no-store');
    const t = await findTournament(req.params.id);
    if (!t) return res.status(404).json({ error: 'torneio não encontrado' });
    res.json({ sponsors: await listSponsors(t.id, originOf(req), req.query.all === '1') });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

apiRouter.post('/:id/sponsors', authMiddleware, async (req, res) => {
  try {
    const t = await findTournament(req.params.id);
    if (!t) return res.status(404).json({ error: 'torneio não encontrado' });
    if (!(await canManage(req, res, t))) return;
    const c = cleanSponsor(req.body || {}, false);
    if (c.error) return res.status(400).json({ error: c.error });
    const count = await prisma.tournamentSponsor.count({ where: { tournamentId: t.id } });
    if (count >= 40) return res.status(400).json({ error: 'limite de 40 patrocinadores por torneio' });
    if (c.data.ordering == null) c.data.ordering = count;
    const s = await prisma.tournamentSponsor.create({ data: { ...c.data, tournamentId: t.id } });
    res.status(201).json(sponsorOut(s, originOf(req)));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

apiRouter.patch('/:id/sponsors/:sid', authMiddleware, async (req, res) => {
  try {
    const t = await findTournament(req.params.id);
    if (!t) return res.status(404).json({ error: 'torneio não encontrado' });
    if (!(await canManage(req, res, t))) return;
    const cur = await prisma.tournamentSponsor.findFirst({ where: { id: req.params.sid, tournamentId: t.id } });
    if (!cur) return res.status(404).json({ error: 'patrocinador não encontrado' });
    const c = cleanSponsor(req.body || {}, true);
    if (c.error) return res.status(400).json({ error: c.error });
    const s = await prisma.tournamentSponsor.update({ where: { id: cur.id }, data: c.data });
    res.json(sponsorOut(s, originOf(req)));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

apiRouter.delete('/:id/sponsors/:sid', authMiddleware, async (req, res) => {
  try {
    const t = await findTournament(req.params.id);
    if (!t) return res.status(404).json({ error: 'torneio não encontrado' });
    if (!(await canManage(req, res, t))) return;
    const r = await prisma.tournamentSponsor.deleteMany({ where: { id: req.params.sid, tournamentId: t.id } });
    res.json({ ok: true, removed: r.count });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// --------------------------------------------------------------------
// API PÚBLICA (JSON, CORS aberto, só leitura)
// --------------------------------------------------------------------
publicRouter.use((req, res, next) => {
  res.set('Access-Control-Allow-Origin', '*');
  res.set('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.set('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'GET' && req.method !== 'HEAD') return res.status(405).json({ error: 'somente leitura' });
  next();
});

function entryOut(e, origin) {
  if (!e) return null;
  const logo = e.logoUrl ? (e.logoUrl.startsWith('data:') ? `${origin}/api/public/entries/${e.id}/logo` : e.logoUrl) : null;
  return { id: e.id, name: e.name, logoUrl: logo, groupName: e.groupName || undefined };
}

const SNAP_CACHE = new Map(); // tournamentId -> { at, data }
async function publicSnapshot(t, origin) {
  const key = t.id + '|' + origin;
  const hit = SNAP_CACHE.get(key);
  if (hit && Date.now() - hit.at < 3000) return hit.data;

  const categories = await prisma.tournamentCategory.findMany({ where: { tournamentId: t.id }, select: { id: true, name: true, gender: true } });
  const entrySel = { select: { id: true, name: true, logoUrl: true } };
  const matches = await prisma.tournamentMatch.findMany({
    where: { tournamentId: t.id },
    orderBy: [{ round: 'asc' }, { ordering: 'asc' }],
    select: {
      id: true, categoryId: true, stage: true, round: true, groupName: true, ordering: true, status: true,
      scheduledAt: true, location: true, homeScore: true, awayScore: true, winnerEntryId: true,
      homePenalties: true, awayPenalties: true, decidedByPenalties: true, homeEntryId: true, awayEntryId: true,
      homeSourceLabel: true, awaySourceLabel: true, liveState: true, updatedAt: true,
      homeEntry: entrySel, awayEntry: entrySel,
    },
  });
  await live.attachLive(matches);
  const standings = await prisma.tournamentStanding.findMany({
    where: { tournamentId: t.id },
    orderBy: [{ groupName: 'asc' }, { rank: 'asc' }, { points: 'desc' }],
    select: { categoryId: true, groupName: true, rank: true, played: true, won: true, drawn: true, lost: true, scoreFor: true, scoreAgainst: true, points: true, entry: entrySel },
  });
  const entries = await prisma.tournamentEntry.findMany({ where: { tournamentId: t.id, status: 'CONFIRMED' }, select: { id: true, name: true, logoUrl: true, groupName: true, categoryId: true }, orderBy: { name: 'asc' } });

  const cats = [];
  for (const c of categories) {
    let st = standings.filter((s) => s.categoryId === c.id);
    let provisional = false;
    if (!st.length) {
      provisional = true;
      st = entries.filter((e) => e.categoryId === c.id)
        .sort((a, b) => String(a.groupName || '').localeCompare(String(b.groupName || '')) || a.name.localeCompare(b.name))
        .map((e, i) => ({ groupName: e.groupName, rank: i + 1, played: 0, won: 0, drawn: 0, lost: 0, scoreFor: 0, scoreAgainst: 0, points: 0, entry: e }));
    }
    let scorers = [];
    try { scorers = (await sheet.playerStats(t.id, { kind: 'scorers', categoryId: c.id })).filter((r) => r.goals > 0).slice(0, 15); } catch (_) { /* sem súmula */ }
    cats.push({
      id: c.id, name: c.name,
      matches: matches.filter((m) => m.categoryId === c.id).map((m) => ({
        id: m.id, stage: m.stage, round: m.round, groupName: m.groupName, ordering: m.ordering, status: m.status,
        scheduledAt: m.scheduledAt, location: m.location, homeScore: m.homeScore, awayScore: m.awayScore,
        winnerEntryId: m.winnerEntryId, homePenalties: m.homePenalties, awayPenalties: m.awayPenalties,
        decidedByPenalties: m.decidedByPenalties, homeSourceLabel: m.homeSourceLabel, awaySourceLabel: m.awaySourceLabel,
        liveState: m.liveState || null, liveScore: m.liveScore || null, cards: m.cards || null, timeline: m.timeline || [],
        updatedAt: m.updatedAt,
        home: entryOut(m.homeEntry, origin), away: entryOut(m.awayEntry, origin),
      })),
      standings: st.map((s) => ({
        groupName: s.groupName || null, rank: s.rank, played: s.played, won: s.won, drawn: s.drawn, lost: s.lost,
        scoreFor: s.scoreFor, scoreAgainst: s.scoreAgainst, goalDiff: s.scoreFor - s.scoreAgainst, points: s.points,
        entry: entryOut(s.entry, origin),
      })),
      provisional,
      scorers: scorers.map((r) => ({ name: r.name, number: r.number, team: r.team, entryId: r.entryId, goals: r.goals, games: r.games })),
    });
  }
  const data = {
    tournament: {
      id: t.id, slug: t.slug, name: t.name, sport: t.sport, status: t.status, format: t.format,
      city: t.city, state: t.state, startDate: t.startDate, endDate: t.endDate, prizeDescription: t.prizeDescription,
      logoUrl: t.bannerUrl || null, url: `${publicBaseUrl()}/t/${t.slug}`,
    },
    categories: cats,
    sponsors: await listSponsors(t.id, origin, false),
    generatedAt: new Date().toISOString(),
  };
  if (SNAP_CACHE.size > 200) SNAP_CACHE.clear();
  SNAP_CACHE.set(key, { at: Date.now(), data });
  return data;
}

publicRouter.get('/tournaments/:slug', async (req, res) => {
  try {
    res.set('Cache-Control', 'no-store');
    const t = await findTournament(req.params.slug);
    if (!t || t.visibility === 'private') return res.status(404).json({ error: 'torneio não encontrado' });
    res.json(await publicSnapshot(t, originOf(req)));
  } catch (err) {
    console.error('[public api] torneio', err);
    res.status(500).json({ error: err.message });
  }
});

function sendDataUri(res, uri) {
  const m = /^data:(image\/[a-z0-9.+-]+);base64,(.+)$/i.exec(uri || '');
  if (!m) return res.status(404).json({ error: 'sem imagem' });
  res.set('Cache-Control', 'public, max-age=3600');
  res.type(m[1]).send(Buffer.from(m[2], 'base64'));
}
publicRouter.get('/entries/:id/logo', async (req, res) => {
  try {
    const e = await prisma.tournamentEntry.findUnique({ where: { id: req.params.id }, select: { logoUrl: true } });
    if (!e || !e.logoUrl) return res.status(404).json({ error: 'sem escudo' });
    if (!e.logoUrl.startsWith('data:')) return res.redirect(302, e.logoUrl);
    sendDataUri(res, e.logoUrl);
  } catch (err) { res.status(500).json({ error: err.message }); }
});
publicRouter.get('/sponsors/:id/logo', async (req, res) => {
  try {
    const s = await prisma.tournamentSponsor.findUnique({ where: { id: req.params.id }, select: { logoUrl: true } });
    if (!s || !s.logoUrl) return res.status(404).json({ error: 'sem logo' });
    if (!s.logoUrl.startsWith('data:')) return res.redirect(302, s.logoUrl);
    sendDataUri(res, s.logoUrl);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// --------------------------------------------------------------------
// CALENDÁRIO ICS (RFC 5545) — assinável via webcal://
// --------------------------------------------------------------------
const STAGE_TXT = { FINAL: 'Final', SEMI: 'Semifinal', THIRD: 'Disputa de 3º lugar', QUARTER: 'Quartas de final', RO16: 'Oitavas de final', RO32: '16-avos', RO64: '32-avos' };
const SPORT_MIN = { FUTSAL: 60, SOCCER: 110, VOLLEY: 90, BASKETBALL: 90, HANDBALL: 70, TENNIS: 90, BEACH_TENNIS: 60, PADEL: 75, TABLE_TENNIS: 45 };
// Fortaleza: UTC-3 fixo, sem horário de verão desde 2000 → VTIMEZONE estático.
function vtimezone(tz) {
  if (tz !== TZ) return null;
  return [
    'BEGIN:VTIMEZONE', 'TZID:America/Fortaleza', 'X-LIC-LOCATION:America/Fortaleza',
    'BEGIN:STANDARD', 'TZOFFSETFROM:-0300', 'TZOFFSETTO:-0300', 'TZNAME:-03', 'DTSTART:19700101T000000', 'END:STANDARD',
    'END:VTIMEZONE',
  ].join('\r\n');
}
function norm(s) { return String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim(); }

pageRouter.get('/:slug/calendario.ics', async (req, res) => {
  try {
    const t = await findTournament(req.params.slug);
    if (!t || t.visibility === 'private') return res.status(404).type('text').send('torneio não encontrado');
    const ical = require('ical-generator').default;
    const cats = await prisma.tournamentCategory.findMany({ where: { tournamentId: t.id }, select: { id: true, name: true } });
    const catQ = req.query.categoria ? String(req.query.categoria) : '';
    const cat = catQ ? cats.find((c) => c.id === catQ || norm(c.name) === norm(catQ)) : null;
    if (catQ && !cat) return res.status(404).type('text').send('categoria não encontrada');
    const where = { tournamentId: t.id, scheduledAt: { not: null }, status: { not: 'CANCELED' } };
    if (cat) where.categoryId = cat.id;
    const timeQ = req.query.time ? String(req.query.time) : '';
    if (timeQ) {
      // time = entryId OU nome do clube (clube único em várias categorias)
      const ents = await prisma.tournamentEntry.findMany({ where: { tournamentId: t.id }, select: { id: true, name: true } });
      const ids = ents.filter((e) => e.id === timeQ || norm(e.name) === norm(timeQ)).map((e) => e.id);
      if (!ids.length) return res.status(404).type('text').send('time não encontrado');
      where.OR = [{ homeEntryId: { in: ids } }, { awayEntryId: { in: ids } }];
    }
    const matches = await prisma.tournamentMatch.findMany({
      where, orderBy: { scheduledAt: 'asc' },
      select: { id: true, stage: true, round: true, groupName: true, status: true, scheduledAt: true, location: true, homeScore: true, awayScore: true, homeSourceLabel: true, awaySourceLabel: true, updatedAt: true, homeEntry: { select: { name: true } }, awayEntry: { select: { name: true } }, category: { select: { name: true } } },
    });
    const base = publicBaseUrl();
    const pageUrl = `${base}/t/${t.slug}`;
    const nameParts = [t.name, cat && cat.name, timeQ && matches.length ? (matches[0].homeEntry && norm(matches[0].homeEntry.name) === norm(timeQ) ? matches[0].homeEntry.name : timeQ) : null].filter(Boolean);
    const cal = ical({
      name: nameParts.join(' · '),
      description: `Jogos de ${t.name} — Club Sports & Tennis`,
      prodId: { company: 'Club Sports & Tennis', product: 'torneios', language: 'PT' },
      timezone: { name: TZ, generator: vtimezone },
      url: pageUrl,
      ttl: 60 * 30,
    });
    const dur = (SPORT_MIN[t.sport] || 60) * 60 * 1000;
    for (const m of matches) {
      const h = m.homeEntry ? m.homeEntry.name : m.homeSourceLabel || 'A definir';
      const a = m.awayEntry ? m.awayEntry.name : m.awaySourceLabel || 'A definir';
      const stage = m.stage === 'GROUP' ? `Grupo ${m.groupName || '?'} · Rodada ${m.round}` : m.stage === 'LEAGUE' ? `Rodada ${m.round}` : STAGE_TXT[m.stage] || m.stage;
      const done = (m.status === 'FINISHED' || m.status === 'WALKOVER') && m.homeScore != null;
      cal.createEvent({
        id: `${m.id}@clubsportsetennis`,
        start: m.scheduledAt,
        end: new Date(m.scheduledAt.getTime() + dur),
        timezone: TZ,
        stamp: m.updatedAt,
        summary: done ? `${h} ${m.homeScore} × ${m.awayScore} ${a}` : `${h} × ${a}`,
        description: [`${t.name} — ${m.category ? m.category.name : ''}`, stage, `Acompanhe ao vivo: ${pageUrl}?jogo=${m.id}`].filter(Boolean).join('\n'),
        location: m.location || undefined,
        url: `${pageUrl}?jogo=${m.id}`,
      });
    }
    res.set('Content-Type', 'text/calendar; charset=utf-8');
    res.set('Cache-Control', 'no-cache');
    const fname = (t.slug + (cat ? '-' + norm(cat.name).replace(/[^a-z0-9]+/g, '-') : '')).slice(0, 80);
    res.set('Content-Disposition', `inline; filename="${fname}.ics"`);
    // RFC 5545: DTSTAMP tem que ser UTC (o ical-generator escreve no fuso do calendário)
    const stampUtc = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
    res.send(cal.toString().replace(/^DTSTAMP:[0-9TZ]*/gm, 'DTSTAMP:' + stampUtc));
  } catch (err) {
    console.error('[ics]', err);
    res.status(500).type('text').send('erro ao gerar calendário');
  }
});

// --------------------------------------------------------------------
// Páginas: TELÃO e EMBED (HTML do servidor + JS que lê a API pública/SSE)
// --------------------------------------------------------------------

pageRouter.get('/:slug/telao', async (req, res) => {
  try {
    res.set('Cache-Control', 'no-store, no-cache, must-revalidate');
    const t = await findTournament(req.params.slug);
    if (!t || t.visibility === 'private') return res.status(404).send('Torneio não encontrado');
    const cfg = { tid: t.id, slug: t.slug, name: t.name, logo: t.bannerUrl || null, categoria: req.query.categoria ? String(req.query.categoria) : null, tempo: Math.min(Math.max(Number(req.query.tempo) || 12, 6), 60) };
    res.type('html').send(require('../services/tournamentPages').telaoHtml(cfg));
  } catch (err) {
    console.error('[telao]', err);
    res.status(500).send('Erro ao carregar telão');
  }
});

pageRouter.get('/:slug/embed', async (req, res) => {
  try {
    res.set('Cache-Control', 'no-store, no-cache, must-revalidate');
    const t = await findTournament(req.params.slug);
    if (!t || t.visibility === 'private') return res.status(404).send('Torneio não encontrado');
    // iframe em qualquer site: tira o X-Frame-Options do helmet e libera frame-ancestors
    res.removeHeader('X-Frame-Options');
    res.set('Content-Security-Policy', 'frame-ancestors *');
    const view = ['tabela', 'jogos', 'artilharia'].includes(String(req.query.view)) ? String(req.query.view) : 'tabela';
    const cfg = { tid: t.id, slug: t.slug, name: t.name, view, categoria: req.query.categoria ? String(req.query.categoria) : null, dark: req.query.tema === 'escuro' };
    res.type('html').send(require('../services/tournamentPages').embedHtml(cfg));
  } catch (err) {
    console.error('[embed]', err);
    res.status(500).send('Erro ao carregar');
  }
});

module.exports = { apiRouter, publicRouter, pageRouter, publicSnapshot, findTournament, listSponsors, jsonForScript, esc };
