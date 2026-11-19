// =====================================================================
// Club — Rankings: nível (Glicko-2), temporada/mês e CIRCUITO por pontos.
// ---------------------------------------------------------------------
//  - rating:   ordena pelo rating Glicko-2 (nível 0–7 + confiabilidade).
//  - season:   jogos do ANO (ou do MÊS) — V=3, E=1, D=0; desempate V,
//              aproveitamento, nível. Filtro de categoria/gênero vem da
//              categoria do torneio onde o jogo aconteceu.
//  - circuit:  pontos por COLOCAÇÃO final em cada categoria encerrada,
//              soma dos MELHORES N resultados em 52 semanas (padrão CBT
//              beach tennis: N = 10). Tabela de pontos configurável
//              (Config "club_circuit_points").
// Só lê dados reais; nada aqui grava resultado de jogo.
// =====================================================================

const { PrismaClient } = require('@prisma/client');
const rating = require('./clubRating');

let prisma = new PrismaClient();
function setPrisma(p) { prisma = p; rating.setPrisma(p); }

const CIRCUIT_CONFIG_KEY = 'club_circuit_points';
const DEFAULT_CIRCUIT = {
  best: 10,
  weeks: 52,
  points: {
    CHAMPION: 1000,
    RUNNER_UP: 700,
    THIRD: 550,
    SEMI: 450,
    QUARTER: 250,
    RO16: 120,
    RO32: 60,
    GROUP: 30,
    PARTICIPATION: 15,
  },
};
const PLACEMENT_LABEL = {
  CHAMPION: 'Campeão', RUNNER_UP: 'Vice', THIRD: '3º lugar', SEMI: 'Semifinal', QUARTER: 'Quartas',
  RO16: 'Oitavas', RO32: '16-avos', GROUP: 'Fase de grupos', PARTICIPATION: 'Participação',
};
const KO_STAGE_PLACE = { SEMI: 'SEMI', QUARTER: 'QUARTER', RO16: 'RO16', RO32: 'RO32' };
const DAY = 86400000;
const TZ_OFFSET_MS = 3 * 3600000;

async function getCircuitConfig() {
  const row = await prisma.config.findUnique({ where: { key: CIRCUIT_CONFIG_KEY } }).catch(() => null);
  if (!row) return JSON.parse(JSON.stringify(DEFAULT_CIRCUIT));
  try {
    const v = JSON.parse(row.value);
    return {
      best: Number(v.best) > 0 ? Math.floor(Number(v.best)) : DEFAULT_CIRCUIT.best,
      weeks: Number(v.weeks) > 0 ? Math.floor(Number(v.weeks)) : DEFAULT_CIRCUIT.weeks,
      points: { ...DEFAULT_CIRCUIT.points, ...(v.points || {}) },
    };
  } catch (_) {
    return JSON.parse(JSON.stringify(DEFAULT_CIRCUIT));
  }
}

async function setCircuitConfig(input = {}) {
  const cur = await getCircuitConfig();
  const next = { best: cur.best, weeks: cur.weeks, points: { ...cur.points } };
  if (input.best != null) {
    const b = Math.floor(Number(input.best));
    if (!(b >= 1 && b <= 100)) throw new Error('best deve ser entre 1 e 100');
    next.best = b;
  }
  if (input.weeks != null) {
    const w = Math.floor(Number(input.weeks));
    if (!(w >= 1 && w <= 260)) throw new Error('weeks deve ser entre 1 e 260');
    next.weeks = w;
  }
  if (input.points && typeof input.points === 'object') {
    for (const [k, v] of Object.entries(input.points)) {
      if (!(k in DEFAULT_CIRCUIT.points)) throw new Error('fase desconhecida: ' + k);
      const n = Number(v);
      if (!Number.isFinite(n) || n < 0 || n > 100000) throw new Error('pontos inválidos em ' + k);
      next.points[k] = n;
    }
  }
  await prisma.config.upsert({
    where: { key: CIRCUIT_CONFIG_KEY },
    update: { value: JSON.stringify(next) },
    create: { id: 'cfg_club_circuit_points', key: CIRCUIT_CONFIG_KEY, value: JSON.stringify(next) },
  });
  return next;
}

// ---------------------------------------------------------- nomes/users
async function userInfo(ids) {
  const uniq = [...new Set(ids.filter(Boolean))];
  if (!uniq.length) return new Map();
  const [users, profiles] = await Promise.all([
    prisma.user.findMany({ where: { id: { in: uniq } }, select: { id: true, name: true, username: true, city: true, state: true } }),
    prisma.athleteProfile.findMany({ where: { userId: { in: uniq } }, select: { userId: true, username: true, avatarUrl: true, sex: true } }),
  ]);
  const pm = new Map(profiles.map((p) => [p.userId, p]));
  return new Map(users.map((u) => {
    const p = pm.get(u.id) || {};
    return [u.id, { id: u.id, name: u.name, username: u.username || p.username || null, city: u.city, state: u.state, avatarUrl: p.avatarUrl || null, sex: p.sex || null }];
  }));
}

function subjectView(row, info) {
  if (row.subjectType === 'TEAM') return { type: 'TEAM', key: row.subjectKey, name: row.teamName || row.subjectKey };
  const u = info.get(row.subjectKey) || {};
  return { type: 'USER', key: row.subjectKey, userId: row.subjectKey, name: u.name || 'Atleta', username: u.username || null, city: u.city || null, avatarUrl: u.avatarUrl || null };
}

function defaultFormat(sport) { return rating.TEAM_SPORTS.has(sport) ? 'TEAM' : 'SINGLES'; }
function normGender(g) { const x = String(g || '').toUpperCase(); return ['M', 'F', 'MIXED', 'OPEN'].includes(x) ? x : null; }

// --------------------------------------------------------------- rating
async function ratingRanking({ sport, format, gender, limit = 100, provisional = true, now = new Date() } = {}) {
  format = rating.FORMATS.includes(format) ? format : defaultFormat(sport);
  const g = normGender(gender);
  const rows = await prisma.glickoRating.findMany({ where: { sport, format }, orderBy: [{ rating: 'desc' }, { matches: 'desc' }, { id: 'asc' }] });
  const info = await userInfo(rows.filter((r) => r.subjectType === 'USER').map((r) => r.subjectKey));
  const list = [];
  for (const r of rows) {
    const p = rating.present(r, now);
    if (!provisional && p.provisional) continue;
    if (g && (g === 'M' || g === 'F')) {
      if (r.subjectType !== 'USER') continue;
      const u = info.get(r.subjectKey);
      if (!u || u.sex !== g) continue;
    }
    list.push({ ...subjectView(r, info), ...p });
  }
  const cap = limit === Infinity ? Infinity : Math.min(Math.max(Number(limit) || 100, 1), 500); // Liga F5: Infinity = lista inteira (a rota pagina)
  return {
    sport, format, gender: g, kind: 'rating',
    ranking: list.slice(0, cap).map((x, i) => ({ rank: i + 1, ...x })),
    total: list.length,
    scale: { levels: '0–7', provisionalRd: rating.PROVISIONAL_RD },
  };
}

// --------------------------------------------------------------- janela
function fortalezaParts(date) {
  const d = new Date(new Date(date).getTime() - TZ_OFFSET_MS);
  return { y: d.getUTCFullYear(), m: d.getUTCMonth() + 1 };
}
function monthStartUtc(y, m) { return new Date(Date.UTC(y, m - 1, 1) + TZ_OFFSET_MS); }

function eventFilter({ format, category, gender }) {
  const cat = category ? rating.normName(category) : null;
  const g = normGender(gender);
  return (ev) => {
    if (format && ev.format !== format) return false;
    if (cat && rating.normName(ev.categoryName) !== cat) return false;
    if (g && ev.categoryGender !== g) return false;
    return true;
  };
}

// ----------------------------------------------------- temporada / mês
async function seasonRanking({ sport, format, year, month, gender, category, limit = 100, now = new Date() } = {}) {
  format = rating.FORMATS.includes(format) ? format : defaultFormat(sport);
  const cur = fortalezaParts(now);
  const y = Number(year) || cur.y;
  const m = month == null || month === '' ? null : Number(month);
  if (m != null && !(m >= 1 && m <= 12)) throw new Error('mês inválido (1–12)');
  const from = m ? monthStartUtc(y, m) : monthStartUtc(y, 1);
  const to = m ? (m === 12 ? monthStartUtc(y + 1, 1) : monthStartUtc(y, m + 1)) : monthStartUtc(y + 1, 1);

  const keep = eventFilter({ format, category, gender });
  const events = (await rating.collectEvents({ sport })).filter((ev) => keep(ev) && new Date(ev.time) >= from && new Date(ev.time) < to);

  const agg = new Map();
  const add = (s, score) => {
    let a = agg.get(s.key);
    if (!a) { a = { type: s.type, key: s.key, userId: s.userId || null, teamName: s.teamName || null, played: 0, wins: 0, draws: 0, losses: 0 }; agg.set(s.key, a); }
    if (s.teamName) a.teamName = s.teamName;
    a.played += 1;
    if (score === 1) a.wins += 1; else if (score === 0) a.losses += 1; else a.draws += 1;
  };
  for (const ev of events) {
    for (const s of ev.a) add(s, ev.score);
    for (const s of ev.b) add(s, 1 - ev.score);
  }
  const rows = await prisma.glickoRating.findMany({ where: { sport, format, subjectKey: { in: [...agg.keys()] } } });
  const rmap = new Map(rows.map((r) => [r.subjectType + '|' + r.subjectKey, r]));
  const info = await userInfo([...agg.values()].filter((a) => a.type === 'USER').map((a) => a.key));
  const list = [...agg.values()].map((a) => {
    const r = rmap.get(a.type + '|' + a.key);
    const p = r ? rating.present(r, now) : null;
    const view = a.type === 'TEAM'
      ? { type: 'TEAM', key: a.key, name: a.teamName || a.key }
      : subjectView({ subjectType: 'USER', subjectKey: a.key }, info);
    return {
      ...view,
      played: a.played, wins: a.wins, draws: a.draws, losses: a.losses,
      points: a.wins * 3 + a.draws,
      winRate: a.played ? Math.round(((a.wins + a.draws * 0.5) / a.played) * 100) : 0,
      level: p ? p.level : null, reliability: p ? p.reliability : null, provisional: p ? p.provisional : true,
    };
  });
  list.sort((a, b) => b.points - a.points || b.wins - a.wins || b.winRate - a.winRate || (b.level || 0) - (a.level || 0) || String(a.name).localeCompare(String(b.name)) || String(a.key).localeCompare(String(b.key)));
  const cap = limit === Infinity ? Infinity : Math.min(Math.max(Number(limit) || 100, 1), 500); // Liga F5: Infinity = lista inteira (a rota pagina)
  return {
    sport, format, kind: m ? 'month' : 'season', year: y, month: m,
    category: category || null, gender: normGender(gender),
    from, to, events: events.length,
    ranking: list.slice(0, cap).map((x, i) => ({ rank: i + 1, ...x })),
    total: list.length,
  };
}

// ------------------------------------------------------------- circuito
/**
 * Colocação final de cada inscrição numa categoria ENCERRADA.
 * Retorna null se a categoria ainda não acabou.
 */
function categoryPlacements(cat) {
  const done = (m) => m.status === 'FINISHED' || m.status === 'WALKOVER';
  const ms = cat.matches;
  if (!ms.length) return null;
  const ko = ms.filter((m) => !['LEAGUE', 'GROUP'].includes(m.stage));
  const played = new Set();
  for (const m of ms) if (done(m)) { if (m.homeEntryId) played.add(m.homeEntryId); if (m.awayEntryId) played.add(m.awayEntryId); }
  const place = new Map();
  let date = null;
  if (ko.length) {
    const final = ko.find((m) => m.stage === 'FINAL');
    if (!final || !done(final) || !final.winnerEntryId) return null;
    date = final.scheduledAt || final.updatedAt;
    const loser = final.winnerEntryId === final.homeEntryId ? final.awayEntryId : final.homeEntryId;
    place.set(final.winnerEntryId, 'CHAMPION');
    if (loser) place.set(loser, 'RUNNER_UP');
    const third = ko.find((m) => m.stage === 'THIRD');
    if (third && done(third) && third.winnerEntryId) place.set(third.winnerEntryId, 'THIRD');
    // perdedor de cada fase de mata-mata = colocação daquela fase
    for (const st of ['SEMI', 'QUARTER', 'RO16', 'RO32']) {
      for (const m of ko.filter((x) => x.stage === st && done(x) && x.winnerEntryId)) {
        const l = m.winnerEntryId === m.homeEntryId ? m.awayEntryId : m.homeEntryId;
        if (l && !place.has(l)) place.set(l, KO_STAGE_PLACE[st]);
      }
    }
    const hasGroups = ms.some((m) => m.stage === 'GROUP' || m.stage === 'LEAGUE');
    for (const e of played) if (!place.has(e)) place.set(e, hasGroups ? 'GROUP' : 'PARTICIPATION');
  } else {
    if (!ms.every((m) => done(m) || m.status === 'CANCELED')) return null;
    const last = ms.filter(done).sort((a, b) => new Date(b.scheduledAt || b.updatedAt) - new Date(a.scheduledAt || a.updatedAt))[0];
    if (!last) return null;
    date = last.scheduledAt || last.updatedAt;
    const st = [...cat.standings].filter((s) => played.has(s.entryId)).sort((a, b) => (a.rank || 999) - (b.rank || 999));
    if (!st.length) return null;
    const byRank = ['CHAMPION', 'RUNNER_UP', 'THIRD', 'SEMI'];
    st.forEach((s, i) => place.set(s.entryId, byRank[i] || (i < 8 ? 'QUARTER' : 'PARTICIPATION')));
    for (const e of played) if (!place.has(e)) place.set(e, 'PARTICIPATION');
  }
  return { date, place };
}

async function circuitResults({ sport, category, gender }) {
  const cats = await prisma.tournamentCategory.findMany({
    // Liga F1: circuito é público → só torneio PÚBLICO e não arquivado
    where: { tournament: { sport, status: { not: 'CANCELED' }, visibility: 'public', archivedAt: null, suspendedAt: null } }, // F6: suspenso fora
    select: {
      id: true, name: true, gender: true, tournamentId: true,
      tournament: { select: { id: true, name: true, slug: true, endDate: true } },
      matches: { select: { stage: true, status: true, homeEntryId: true, awayEntryId: true, winnerEntryId: true, scheduledAt: true, updatedAt: true } },
      standings: { select: { entryId: true, rank: true } },
      entries: { select: { id: true, name: true, status: true, members: { select: { userId: true } } } },
    },
  });
  const catNorm = category ? rating.normName(category) : null;
  const g = normGender(gender);
  const isTeam = rating.TEAM_SPORTS.has(sport);
  const results = [];
  for (const c of cats) {
    if (catNorm && rating.normName(c.name) !== catNorm) continue;
    if (g && c.gender !== g) continue;
    const pl = categoryPlacements(c);
    if (!pl) continue;
    const when = pl.date || c.tournament.endDate;
    for (const e of c.entries) {
      if (e.status === 'WITHDRAWN') continue;
      const placement = pl.place.get(e.id);
      if (!placement) continue;
      const base = { placement, date: when, tournamentId: c.tournamentId, tournament: c.tournament.name, slug: c.tournament.slug, categoryId: c.id, category: c.name, entryName: e.name };
      if (isTeam) {
        const key = rating.normName(e.name);
        if (key) results.push({ ...base, type: 'TEAM', key, teamName: e.name });
      } else {
        for (const u of new Set(e.members.map((m) => m.userId))) results.push({ ...base, type: 'USER', key: u, userId: u });
      }
    }
  }
  return results;
}

async function circuitRanking({ sport, category, gender, best, weeks, asOf, limit = 200 } = {}) {
  const cfg = await getCircuitConfig();
  const N = Number(best) > 0 ? Math.min(Math.floor(Number(best)), 100) : cfg.best;
  const W = Number(weeks) > 0 ? Math.min(Math.floor(Number(weeks)), 260) : cfg.weeks;
  const end = asOf ? new Date(asOf) : new Date();
  if (Number.isNaN(end.getTime())) throw new Error('asOf inválido');
  const start = new Date(end.getTime() - W * 7 * DAY);
  const all = await circuitResults({ sport, category, gender });
  const inWin = all.filter((r) => r.date && new Date(r.date) > start && new Date(r.date) <= end);
  const by = new Map();
  for (const r of inWin) {
    const pts = Number(cfg.points[r.placement]) || 0;
    if (!by.has(r.key)) by.set(r.key, { type: r.type, key: r.key, teamName: r.teamName || null, results: [] });
    const s = by.get(r.key);
    if (r.teamName) s.teamName = r.teamName;
    s.results.push({ ...r, points: pts, label: PLACEMENT_LABEL[r.placement] });
  }
  const info = await userInfo([...by.values()].filter((s) => s.type === 'USER').map((s) => s.key));
  const list = [...by.values()].map((s) => {
    s.results.sort((a, b) => b.points - a.points || new Date(b.date) - new Date(a.date));
    const counted = s.results.slice(0, N);
    const view = s.type === 'TEAM' ? { type: 'TEAM', key: s.key, name: s.teamName || s.key } : subjectView({ subjectType: 'USER', subjectKey: s.key }, info);
    return {
      ...view,
      points: counted.reduce((t, r) => t + r.points, 0),
      counted: counted.length,
      events: s.results.length,
      titles: s.results.filter((r) => r.placement === 'CHAMPION').length,
      results: s.results.map((r, i) => ({ tournament: r.tournament, slug: r.slug, category: r.category, placement: r.placement, label: r.label, points: r.points, date: r.date, counted: i < N })),
    };
  });
  list.sort((a, b) => b.points - a.points || b.titles - a.titles || b.counted - a.counted || String(a.name).localeCompare(String(b.name)) || String(a.key).localeCompare(String(b.key)));
  const cap = limit === Infinity ? Infinity : Math.min(Math.max(Number(limit) || 200, 1), 500); // Liga F5: Infinity = lista inteira (a rota pagina)
  return {
    sport, kind: 'circuit', category: category || null, gender: normGender(gender),
    best: N, weeks: W, from: start, to: end, points: cfg.points,
    ranking: list.slice(0, cap).map((x, i) => ({ rank: i + 1, ...x })),
    total: list.length,
  };
}

async function sportCategories(sport) {
  const cats = await prisma.tournamentCategory.findMany({ where: { tournament: { sport } }, select: { name: true, gender: true } });
  const seen = new Map();
  for (const c of cats) { const k = rating.normName(c.name); if (k && !seen.has(k)) seen.set(k, { name: c.name, gender: c.gender }); }
  return [...seen.values()].sort((a, b) => a.name.localeCompare(b.name));
}

module.exports = {
  setPrisma, DEFAULT_CIRCUIT, PLACEMENT_LABEL,
  getCircuitConfig, setCircuitConfig, ratingRanking, seasonRanking, circuitRanking, circuitResults,
  categoryPlacements, sportCategories, userInfo,
};
