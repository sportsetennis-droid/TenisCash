const express = require('express');
const { authMiddleware, adminMiddleware, prisma } = require('../middleware');
const sportmonks = require('../services/sportmonksClient');
const copaNews = require('../services/copaNewsClient');

const router = express.Router();

const CONFIG_KEY = 'copa2026_bolao_state_v1';

const FALLBACK_MATCHES = [
  {
    id: 'm1',
    stage: 'Grupo A',
    group: 'Grupo A',
    groupId: 'A',
    home: 'Mexico',
    away: 'Africa do Sul',
    homeCode: 'MEX',
    awayCode: 'RSA',
    kickoff: '2026-06-11T19:00:00.000Z',
    status: 'FINAL',
    homeScore: 1,
    awayScore: 1,
    venue: 'Estadio Azteca',
  },
  {
    id: 'm2',
    stage: 'Grupo B',
    group: 'Grupo B',
    groupId: 'B',
    home: 'Canada',
    away: 'Equador',
    homeCode: 'CAN',
    awayCode: 'ECU',
    kickoff: '2026-06-12T00:00:00.000Z',
    status: 'FINAL',
    homeScore: 2,
    awayScore: 1,
    venue: 'BMO Field',
  },
  {
    id: 'm3',
    stage: 'Grupo D',
    group: 'Grupo D',
    groupId: 'D',
    home: 'Brasil',
    away: 'Marrocos',
    homeCode: 'BRA',
    awayCode: 'MAR',
    kickoff: '2026-06-15T19:00:00.000Z',
    status: 'SCHEDULED',
    venue: 'SoFi Stadium',
  },
  {
    id: 'm4',
    stage: 'Grupo F',
    group: 'Grupo F',
    groupId: 'F',
    home: 'Portugal',
    away: 'Japao',
    homeCode: 'POR',
    awayCode: 'JPN',
    kickoff: '2026-06-15T22:00:00.000Z',
    status: 'SCHEDULED',
    venue: 'MetLife Stadium',
  },
];

const RULES = {
  exactScore: 100,
  result: 40,
  goalDifference: 20,
  participationBonus: 10,
  tenisCashExact: 10,
  tenisCashResult: 3,
};

const DEFAULT_POOL = {
  title: 'Bolao da Copa Sports & Tennis',
  subtitle: 'Palpites, ranking e recompensas em TenisCash',
  status: 'Aberto',
  prize: 'Camisa oficial + bonus TenisCash',
};

const DEFAULT_PRIZES = [
  {
    id: 'camisa-oficial',
    title: 'Camisa oficial da selecao',
    criteria: 'Campeao geral do ranking ao final da Copa',
    quantity: 1,
    status: 'planejado',
    sponsor: 'Sports & Tennis',
    notes: 'Definir selecao, tamanho e prazo de entrega.',
  },
  {
    id: 'bonus-teniscash',
    title: 'Bonus TenisCash',
    criteria: 'Top 10 do ranking geral',
    quantity: 10,
    status: 'planejado',
    sponsor: 'TenisCash',
    notes: 'Valor do bonus pode ser ajustado pela operacao.',
  },
  {
    id: 'rodada-brasil',
    title: 'Premio relampago Brasil',
    criteria: 'Placar exato em jogos do Brasil',
    quantity: 1,
    status: 'rascunho',
    sponsor: 'Sports & Tennis',
    notes: 'Usar para gerar pico de audiencia antes do jogo.',
  },
];

const DEFAULT_BRAZIL_LINEUP = {
  formation: '4-3-3',
  confidence: 'media',
  source: 'editorial',
  status: 'rascunho',
  notes: 'Escalacao provavel para alimentar pre-jogo. A oficial costuma chegar perto da partida.',
  players: [
    { slot: 'GOL', name: '', role: 'Goleiro' },
    { slot: 'LD', name: '', role: 'Defensor' },
    { slot: 'ZAG', name: '', role: 'Defensor' },
    { slot: 'ZAG', name: '', role: 'Defensor' },
    { slot: 'LE', name: '', role: 'Defensor' },
    { slot: 'VOL', name: '', role: 'Meio-campista' },
    { slot: 'MEI', name: '', role: 'Meio-campista' },
    { slot: 'MEI', name: '', role: 'Meio-campista' },
    { slot: 'ATA', name: '', role: 'Atacante' },
    { slot: 'ATA', name: '', role: 'Atacante' },
    { slot: 'ATA', name: '', role: 'Atacante' },
  ],
};

function emptyState() {
  return {
    version: 1,
    predictions: {},
    pool: DEFAULT_POOL,
    prizes: DEFAULT_PRIZES,
    lineups: {},
    userBrazilLineups: {},
    updatedAt: new Date().toISOString(),
  };
}

function safeParse(value) {
  try {
    const parsed = JSON.parse(value || '');
    if (!parsed || typeof parsed !== 'object') return emptyState();
    const base = emptyState();
    return {
      ...base,
      ...parsed,
      predictions: parsed.predictions || {},
      pool: { ...base.pool, ...(parsed.pool || {}) },
      prizes: Array.isArray(parsed.prizes) && parsed.prizes.length ? parsed.prizes : base.prizes,
      lineups: parsed.lineups && typeof parsed.lineups === 'object' ? parsed.lineups : {},
      userBrazilLineups: parsed.userBrazilLineups && typeof parsed.userBrazilLineups === 'object' ? parsed.userBrazilLineups : {},
    };
  } catch (_) {
    return emptyState();
  }
}

async function getPoolState() {
  const row = await prisma.config.findUnique({ where: { key: CONFIG_KEY } }).catch(() => null);
  if (!row) return emptyState();
  return safeParse(row.value);
}

async function savePoolState(state) {
  const next = { ...state, updatedAt: new Date().toISOString() };
  await prisma.config.upsert({
    where: { key: CONFIG_KEY },
    update: { value: JSON.stringify(next) },
    create: { id: CONFIG_KEY, key: CONFIG_KEY, value: JSON.stringify(next) },
  });
  return next;
}

function normalize(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim();
}

function groupIdFromText(value) {
  const match = String(value || '').match(/(?:Group|Grupo)\s+([A-L])/i);
  return match ? match[1].toUpperCase() : '';
}

function emptyTeamStats(match, side) {
  const groupId = match.groupId || groupIdFromText(match.group || match.stage);
  const name = side === 'home' ? match.home : match.away;
  const code = side === 'home' ? match.homeCode : match.awayCode;
  const logo = side === 'home' ? match.homeLogo : match.awayLogo;
  const id = side === 'home' ? match.homeTeamId : match.awayTeamId;

  return {
    id: id || code || name,
    name,
    originalName: name,
    code,
    logo,
    groupId,
    group: groupId ? `Grupo ${groupId}` : (match.group || 'Copa'),
    position: 0,
    points: 0,
    played: 0,
    won: 0,
    drawn: 0,
    lost: 0,
    goalsFor: 0,
    goalsAgainst: 0,
    goalDifference: 0,
  };
}

function updateStanding(team, goalsFor, goalsAgainst) {
  team.played += 1;
  team.goalsFor += goalsFor;
  team.goalsAgainst += goalsAgainst;
  team.goalDifference = team.goalsFor - team.goalsAgainst;
  if (goalsFor > goalsAgainst) {
    team.won += 1;
    team.points += 3;
  } else if (goalsFor === goalsAgainst) {
    team.drawn += 1;
    team.points += 1;
  } else {
    team.lost += 1;
  }
}

function buildFallbackTables(matches) {
  const groups = new Map();

  matches.forEach((match) => {
    const groupId = match.groupId || groupIdFromText(match.group || match.stage) || 'GERAL';
    if (!groups.has(groupId)) {
      groups.set(groupId, { id: groupId, name: groupId === 'GERAL' ? 'Copa' : `Grupo ${groupId}`, teams: new Map() });
    }

    const group = groups.get(groupId);
    const homeKey = match.homeTeamId || match.homeCode || match.home;
    const awayKey = match.awayTeamId || match.awayCode || match.away;
    if (!group.teams.has(homeKey)) group.teams.set(homeKey, emptyTeamStats(match, 'home'));
    if (!group.teams.has(awayKey)) group.teams.set(awayKey, emptyTeamStats(match, 'away'));

    if (matchHasResult(match)) {
      updateStanding(group.teams.get(homeKey), match.homeScore, match.awayScore);
      updateStanding(group.teams.get(awayKey), match.awayScore, match.homeScore);
    }
  });

  return [...groups.values()].map((group) => {
    const teams = [...group.teams.values()]
      .sort((a, b) => (
        b.points - a.points
        || b.goalDifference - a.goalDifference
        || b.goalsFor - a.goalsFor
        || a.name.localeCompare(b.name)
      ))
      .map((team, index) => ({ ...team, position: index + 1 }));
    return { id: group.id, name: group.name, teams };
  }).sort((a, b) => a.id.localeCompare(b.id));
}

function sameTeam(team, match, side) {
  const sideId = side === 'home' ? match.homeTeamId : match.awayTeamId;
  const sideCode = side === 'home' ? match.homeCode : match.awayCode;
  const sideName = side === 'home' ? match.home : match.away;
  return Boolean(
    (team.id && sideId && String(team.id) === String(sideId))
    || (team.code && sideCode && normalize(team.code) === normalize(sideCode))
    || (team.name && sideName && normalize(team.name) === normalize(sideName))
  );
}

function teamSideInMatch(team, match) {
  if (sameTeam(team, match, 'home')) return 'home';
  if (sameTeam(team, match, 'away')) return 'away';
  return null;
}

function compactMatchForTeam(match, team) {
  if (!match) return null;
  const side = teamSideInMatch(team, match);
  const opponentSide = side === 'home' ? 'away' : 'home';
  return {
    id: match.id,
    kickoff: match.kickoff,
    status: match.status,
    stage: match.stage,
    venue: match.venue,
    home: match.home,
    away: match.away,
    homeScore: match.homeScore,
    awayScore: match.awayScore,
    opponent: side ? match[opponentSide] : '',
    opponentCode: side ? match[`${opponentSide}Code`] : '',
    opponentLogo: side ? match[`${opponentSide}Logo`] : '',
  };
}

function buildTeams(tables, matches) {
  return tables.flatMap((group) => group.teams.map((team) => {
    const teamMatches = matches.filter((match) => teamSideInMatch(team, match));
    const nextMatch = teamMatches.find((match) => !isLocked(match)) || null;
    const lastResult = [...teamMatches].reverse().find(matchHasResult) || null;
    const qualifyingZone = team.position <= 2 ? 'direct' : (team.position === 3 ? 'third_watch' : 'outside');
    return {
      ...team,
      group: group.name,
      groupId: group.id,
      qualifyingZone,
      matchesPlayed: teamMatches.length,
      nextMatch: compactMatchForTeam(nextMatch, team),
      lastResult: compactMatchForTeam(lastResult, team),
    };
  })).sort((a, b) => (
    a.groupId.localeCompare(b.groupId)
    || a.position - b.position
    || a.name.localeCompare(b.name)
  ));
}

function saoPauloDateKey(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  const parts = new Intl.DateTimeFormat('pt-BR', {
    timeZone: 'America/Sao_Paulo',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date).reduce((acc, part) => {
    acc[part.type] = part.value;
    return acc;
  }, {});
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function buildFeatured(matches, teams) {
  const today = saoPauloDateKey(new Date());
  const liveMatches = matches.filter((match) => match.status === 'LIVE');
  const todayMatches = matches.filter((match) => saoPauloDateKey(match.kickoff) === today);
  const nextMatch = matches.find((match) => !isLocked(match)) || matches[0] || null;
  const lastResults = matches.filter(matchHasResult).slice(-8).reverse();
  const brazilTeam = teams.find((team) => normalize(team.name) === 'brasil' || normalize(team.code) === 'bra') || null;
  const brazilMatches = brazilTeam ? matches.filter((match) => teamSideInMatch(brazilTeam, match)) : [];
  const brazilMatch = brazilMatches.find((match) => !isLocked(match))
    || [...brazilMatches].reverse().find(matchHasResult)
    || null;

  return {
    liveMatches: liveMatches.slice(0, 8),
    todayMatches: todayMatches.slice(0, 12),
    nextMatch,
    lastResults,
    brazilTeam,
    brazilMatch,
    openMatches: matches.filter((match) => !isLocked(match)).length,
    completedMatches: matches.filter(matchHasResult).length,
    totalGroups: new Set(teams.map((team) => team.groupId)).size,
    totalTeams: teams.length,
  };
}

function buildCompetitionInfo(source) {
  const matches = source.matches || [];
  const teams = source.teams || [];
  const startedAt = matches[0]?.kickoff || '2026-06-11T00:00:00.000Z';
  const finalMatch = matches[matches.length - 1] || null;
  return {
    name: 'Copa do Mundo FIFA 2026',
    hostCountries: ['Canada', 'Estados Unidos', 'Mexico'],
    period: {
      start: startedAt,
      end: finalMatch?.kickoff || '2026-07-19T00:00:00.000Z',
    },
    format: {
      groups: source.featured?.totalGroups || new Set(teams.map((team) => team.groupId)).size,
      teams: teams.length,
      matches: matches.length,
      groupRule: 'Top 2 de cada grupo avancam; melhores terceiros entram na briga conforme formato oficial.',
    },
    dataCoverage: [
      'Jogos, horarios, sedes e status',
      'Placar ao vivo e resultados',
      'Classificacao por grupo',
      'Artilharia, assistencias e cartoes',
      'Selecoes, campanha, proximo jogo e ultimo resultado',
      'Elenco por selecao sob demanda',
      'Album visual com todos os jogadores em cards de figurinha',
      'Escalacao oficial quando a fonte publicar lineups',
      'Noticias em portugues via RSS BR',
      'Bolao, ranking e premios TenisCash',
    ],
    provider: {
      mode: source.dataMode,
      status: source.providerStatus,
      live: source.dataMode === 'sportmonks_live',
    },
  };
}

function buildAccessMap() {
  return [
    { id: 'today', label: 'Hoje', tab: 'today', description: 'Comeca pelo que esta acontecendo agora: ao vivo, Brasil e proximos jogos.' },
    { id: 'matches', label: 'Jogos', tab: 'matches', description: 'Abre calendario completo, filtros e palpites jogo a jogo.' },
    { id: 'tables', label: 'Tabelas', tab: 'tables', description: 'Mostra grupos, pontuacao e zona de classificacao.' },
    { id: 'stats', label: 'Stats', tab: 'stats', description: 'Acompanha artilharia, assistencias, amarelos, vermelhos e disciplina.' },
    { id: 'teams', label: 'Selecoes', tab: 'teams', description: 'Lista as 48 selecoes; cada card abre campanha, jogos, perfil e elenco.' },
    { id: 'album', label: 'Album', tab: 'album', description: 'Reune jogadores em cards de figurinha colecionavel, com busca por selecao e posicao.' },
    { id: 'brazil', label: 'Brasil', tab: 'brazil', description: 'Central da selecao brasileira, proximos jogos e escalacao provavel/oficial.' },
    { id: 'ranking', label: 'Ranking', tab: 'ranking', description: 'Acompanha usuarios, acertos, pontuacao, TenisCash e disputa por premios.' },
    { id: 'pool', label: 'Premios', tab: 'pool', description: 'Regras do bolao, premios definidos e area de gestao para admins.' },
  ];
}

function sortPlayerStatRows(rows) {
  return [...(rows || [])].sort((a, b) => (
    (b.total || 0) - (a.total || 0)
    || (a.position || 9999) - (b.position || 9999)
    || String(a.player || '').localeCompare(String(b.player || ''))
  )).slice(0, 25);
}

function buildDisciplineRows(yellowCards, redCards, cardRows) {
  const rowsByPlayer = new Map();

  function getRow(row) {
    const key = `${row.playerId || row.player}-${row.teamId || row.team}`;
    if (!rowsByPlayer.has(key)) {
      rowsByPlayer.set(key, {
        id: key,
        playerId: row.playerId || '',
        player: row.player || 'Jogador',
        playerPhoto: row.playerPhoto || '',
        teamId: row.teamId || '',
        team: row.team || '',
        teamCode: row.teamCode || '',
        teamLogo: row.teamLogo || '',
        yellowCards: 0,
        redCards: 0,
        cardPoints: 0,
        total: 0,
        position: row.position || 0,
      });
    }
    return rowsByPlayer.get(key);
  }

  (yellowCards || []).forEach((row) => {
    const target = getRow(row);
    target.yellowCards += row.total || 0;
  });
  (redCards || []).forEach((row) => {
    const target = getRow(row);
    target.redCards += row.total || 0;
  });
  (cardRows || []).forEach((row) => {
    const target = getRow(row);
    target.cardPoints = Math.max(target.cardPoints || 0, row.total || 0);
  });

  return [...rowsByPlayer.values()].map((row) => ({
    ...row,
    points: row.cardPoints || (row.yellowCards + (row.redCards * 2)),
    total: row.cardPoints || (row.yellowCards + (row.redCards * 2)),
  })).sort((a, b) => (
    (b.points || 0) - (a.points || 0)
    || (b.yellowCards || 0) - (a.yellowCards || 0)
    || (b.redCards || 0) - (a.redCards || 0)
    || String(a.player || '').localeCompare(String(b.player || ''))
  )).slice(0, 25);
}

function groupPlayerStats(rows) {
  const goals = sortPlayerStatRows(rows.filter((row) => row.metric === 'goals'));
  const assists = sortPlayerStatRows(rows.filter((row) => row.metric === 'assists'));
  const yellowCards = sortPlayerStatRows(rows.filter((row) => row.metric === 'yellowCards'));
  const redCards = sortPlayerStatRows(rows.filter((row) => row.metric === 'redCards'));
  const cardRows = sortPlayerStatRows(rows.filter((row) => row.metric === 'cards'));
  const discipline = buildDisciplineRows(yellowCards, redCards, cardRows);

  return {
    status: rows.length ? 'ok' : 'empty',
    source: 'sportmonks_topscorers',
    message: rows.length ? '' : 'Estatisticas de jogadores ainda nao publicadas pela fonte.',
    goals,
    assists,
    yellowCards,
    redCards,
    discipline,
    updatedAt: new Date().toISOString(),
  };
}

async function buildTournamentStats() {
  const emptyStats = {
    status: 'not_configured',
    source: 'none',
    message: 'Estatisticas oficiais de jogadores aguardando fonte conectada.',
    goals: [],
    assists: [],
    yellowCards: [],
    redCards: [],
    discipline: [],
    updatedAt: new Date().toISOString(),
  };

  if (!sportmonks.isConfigured()) return emptyStats;

  try {
    const rows = await sportmonks.getWorldCupTopscorers();
    return groupPlayerStats(rows || []);
  } catch (err) {
    console.warn('[copa] Estatisticas de jogadores Sportmonks indisponiveis:', err.message);
    return {
      ...emptyStats,
      status: 'unavailable',
      source: 'sportmonks_topscorers',
      message: 'Artilharia e cartoes aguardando atualizacao da fonte.',
    };
  }
}

function mergeLiveMatches(matches, liveMatches) {
  const liveById = new Map(
    (liveMatches || []).map((match) => [String(match.providerFixtureId || match.id), match])
  );
  if (!liveById.size) return { matches, liveCount: 0 };

  let liveCount = 0;
  const seen = new Set();
  const merged = matches.map((match) => {
    const id = String(match.providerFixtureId || match.id);
    const live = liveById.get(id) || liveById.get(String(match.id));
    if (!live) return match;
    liveCount += 1;
    seen.add(String(live.providerFixtureId || live.id));

    return {
      ...match,
      status: live.status || match.status,
      stateLabel: live.stateLabel || match.stateLabel,
      homeScore: Number.isFinite(live.homeScore) ? live.homeScore : match.homeScore,
      awayScore: Number.isFinite(live.awayScore) ? live.awayScore : match.awayScore,
      homeLogo: live.homeLogo || match.homeLogo,
      awayLogo: live.awayLogo || match.awayLogo,
      venue: live.venue || match.venue,
    };
  });

  const extraLiveMatches = (liveMatches || []).filter((match) => (
    !seen.has(String(match.providerFixtureId || match.id))
  ));
  return { matches: merged.concat(extraLiveMatches), liveCount: liveCount + extraLiveMatches.length };
}

async function getTournamentSource() {
  if (!sportmonks.isConfigured()) {
    const tables = buildFallbackTables(FALLBACK_MATCHES);
    const teams = buildTeams(tables, FALLBACK_MATCHES);
    return {
      dataMode: 'internal_mvp',
      providerStatus: 'not_configured',
      matches: FALLBACK_MATCHES,
      tables,
      teams,
      featured: buildFeatured(FALLBACK_MATCHES, teams),
    };
  }

  try {
    let matches = await sportmonks.getWorldCupMatches();
    let liveOverlayCount = 0;
    try {
      const liveMatches = await sportmonks.getWorldCupLiveMatches();
      const merged = mergeLiveMatches(matches, liveMatches);
      matches = merged.matches;
      liveOverlayCount = merged.liveCount;
    } catch (err) {
      console.warn('[copa] Livescore Sportmonks indisponivel:', err.message);
    }

    let tables = [];
    try {
      tables = await sportmonks.getWorldCupTables();
    } catch (err) {
      console.warn('[copa] Tabelas Sportmonks indisponiveis, derivando dos jogos:', err.message);
      tables = buildFallbackTables(matches);
    }

    if (matches.length) {
      const teams = buildTeams(tables, matches);
      return {
        dataMode: 'sportmonks_live',
        providerStatus: tables.length ? (liveOverlayCount ? 'ok_live' : 'ok') : 'partial',
        matches,
        tables,
        teams,
        featured: buildFeatured(matches, teams),
      };
    }
  } catch (err) {
    console.warn('[copa] Sportmonks indisponivel, usando fallback:', err.message);
  }

  const tables = buildFallbackTables(FALLBACK_MATCHES);
  const teams = buildTeams(tables, FALLBACK_MATCHES);
  return {
    dataMode: 'internal_mvp',
    providerStatus: 'fallback',
    matches: FALLBACK_MATCHES,
    tables,
    teams,
    featured: buildFeatured(FALLBACK_MATCHES, teams),
  };
}

function sanitizePrize(prize, index) {
  const id = String(prize.id || `premio-${index + 1}`).replace(/[^a-z0-9_-]/gi, '-').slice(0, 48);
  return {
    id,
    title: String(prize.title || 'Premio da Copa').slice(0, 90),
    criteria: String(prize.criteria || 'Criterio a definir').slice(0, 160),
    quantity: Math.max(1, Math.min(999, Number.parseInt(prize.quantity, 10) || 1)),
    status: String(prize.status || 'rascunho').slice(0, 40),
    sponsor: String(prize.sponsor || 'Sports & Tennis').slice(0, 80),
    notes: String(prize.notes || '').slice(0, 240),
  };
}

function sanitizeLineup(raw) {
  const source = raw && typeof raw === 'object' ? raw : {};
  const players = Array.isArray(source.players) ? source.players : DEFAULT_BRAZIL_LINEUP.players;
  return {
    formation: String(source.formation || DEFAULT_BRAZIL_LINEUP.formation).slice(0, 16),
    confidence: String(source.confidence || DEFAULT_BRAZIL_LINEUP.confidence).slice(0, 24),
    source: String(source.source || DEFAULT_BRAZIL_LINEUP.source).slice(0, 40),
    status: String(source.status || DEFAULT_BRAZIL_LINEUP.status).slice(0, 32),
    notes: String(source.notes || DEFAULT_BRAZIL_LINEUP.notes).slice(0, 300),
    updatedAt: source.updatedAt || null,
    players: players.slice(0, 26).map((player, index) => ({
      slot: String(player.slot || DEFAULT_BRAZIL_LINEUP.players[index]?.slot || '').slice(0, 12),
      name: String(player.name || '').slice(0, 80),
      role: String(player.role || DEFAULT_BRAZIL_LINEUP.players[index]?.role || '').slice(0, 40),
    })),
  };
}

function sanitizeUserBrazilLineup(raw) {
  const source = raw && typeof raw === 'object' ? raw : {};
  const players = Array.isArray(source.players) ? source.players : [];
  const mode = String(source.mode || 'wish').slice(0, 20);
  return {
    mode: mode === 'prediction' ? 'prediction' : 'wish',
    formation: String(source.formation || '4-3-3').slice(0, 16),
    notes: String(source.notes || '').slice(0, 220),
    updatedAt: source.updatedAt || new Date().toISOString(),
    players: players.slice(0, 11).map((player, index) => ({
      slot: String(player.slot || DEFAULT_BRAZIL_LINEUP.players[index]?.slot || '').slice(0, 12),
      playerId: String(player.playerId || '').slice(0, 40),
      name: String(player.name || '').trim().slice(0, 80),
      role: String(player.role || player.position || DEFAULT_BRAZIL_LINEUP.players[index]?.role || '').slice(0, 40),
      position: String(player.position || player.role || '').slice(0, 40),
      jerseyNumber: Number.isInteger(Number(player.jerseyNumber)) ? Number(player.jerseyNumber) : null,
      photo: String(player.photo || '').slice(0, 240),
    })),
  };
}

function brazilMatchesFrom(source) {
  const brazilTeam = source.featured?.brazilTeam
    || source.teams.find((team) => normalize(team.name) === 'brasil' || normalize(team.code) === 'bra')
    || null;
  if (!brazilTeam) return { brazilTeam: null, matches: [] };
  const matches = (source.matches || []).filter((match) => teamSideInMatch(brazilTeam, match));
  return { brazilTeam, matches };
}

async function buildBrazilCenter(source, poolState) {
  const { brazilTeam, matches } = brazilMatchesFrom(source);
  const nextMatches = matches.filter((match) => !isLocked(match)).slice(0, 4).map((match) => ({
    ...match,
    expectedLineup: sanitizeLineup(poolState.lineups?.[match.id]),
  }));
  const nextMatch = nextMatches[0] || [...matches].reverse().find(matchHasResult) || null;
  const savedLineup = nextMatch?.expectedLineup || sanitizeLineup();
  let officialLineup = null;

  if (nextMatch?.providerFixtureId && sportmonks.isConfigured()) {
    try {
      officialLineup = await sportmonks.getFixtureLineup(nextMatch.providerFixtureId);
    } catch (err) {
      officialLineup = { status: 'unavailable', error: err.message };
    }
  }

  const starterCount = officialLineup?.lineups?.filter((player) => player.isStarter).length || 0;
  return {
    team: brazilTeam,
    nextMatch,
    nextMatches,
    lastResults: matches.filter(matchHasResult).slice(-4).reverse(),
    officialLineup: {
      status: starterCount ? 'available' : 'pending',
      message: starterCount
        ? 'Escalacao oficial disponivel pela fonte.'
        : 'Escalacao oficial normalmente aparece perto do inicio do jogo.',
      formations: officialLineup?.formations || [],
      players: officialLineup?.lineups || [],
      sidelined: officialLineup?.sidelined || [],
    },
    expectedLineup: savedLineup,
  };
}

function buildTeamDetail(team, source) {
  const matches = (source.matches || []).filter((match) => teamSideInMatch(team, match));
  const group = (source.tables || []).find((table) => table.id === team.groupId) || null;
  return {
    team,
    group,
    matches,
    nextMatches: matches.filter((match) => !isLocked(match)).slice(0, 5),
    lastResults: matches.filter(matchHasResult).slice(-5).reverse(),
    stats: {
      position: team.position,
      points: team.points,
      played: team.played,
      won: team.won,
      drawn: team.drawn,
      lost: team.lost,
      goalsFor: team.goalsFor,
      goalsAgainst: team.goalsAgainst,
      goalDifference: team.goalDifference,
      qualifyingZone: team.qualifyingZone,
    },
  };
}

function eventMinuteLabel(event) {
  const minute = Number(event?.minute);
  if (!Number.isFinite(minute)) return '';
  const extra = Number(event?.extraMinute);
  return `${minute}${Number.isFinite(extra) && extra > 0 ? `+${extra}` : ''}'`;
}

function sortLineupPlayers(a, b) {
  const aFormation = Number(a.formationPosition);
  const bFormation = Number(b.formationPosition);
  const aOrder = Number.isFinite(aFormation) ? aFormation : 999;
  const bOrder = Number.isFinite(bFormation) ? bFormation : 999;
  return aOrder - bOrder
    || (a.jerseyNumber ?? 999) - (b.jerseyNumber ?? 999)
    || String(a.name || '').localeCompare(String(b.name || ''));
}

function applyLineupSubstitutions(lineup) {
  const players = (lineup?.lineups || []).map((player) => ({
    ...player,
    wasStarter: Boolean(player.isStarter),
    isOnField: Boolean(player.isStarter),
    enteredAt: '',
    subbedOutAt: '',
  }));
  const byPlayerId = new Map(players.map((player) => [String(player.playerId), player]));
  const substitutions = (lineup?.events || [])
    .filter((event) => event.isSubstitution)
    .sort((a, b) => (
      (a.minute ?? 0) - (b.minute ?? 0)
      || (a.extraMinute ?? 0) - (b.extraMinute ?? 0)
      || String(a.id).localeCompare(String(b.id))
    ));

  substitutions.forEach((event) => {
    const minute = eventMinuteLabel(event);
    const incoming = byPlayerId.get(String(event.playerId));
    const outgoing = byPlayerId.get(String(event.relatedPlayerId));
    if (incoming) {
      incoming.isOnField = true;
      incoming.enteredAt = minute;
    }
    if (outgoing) {
      outgoing.isOnField = false;
      outgoing.subbedOutAt = minute;
    }
  });

  return { players, substitutions };
}

function buildLineupSide(match, lineup, side, players) {
  const isHome = side === 'home';
  const team = {
    id: isHome ? match.homeTeamId : match.awayTeamId,
    name: isHome ? match.home : match.away,
    code: isHome ? match.homeCode : match.awayCode,
    logo: isHome ? match.homeLogo : match.awayLogo,
  };
  const teamPlayers = players.filter((player) => String(player.teamId) === String(team.id));
  const formation = (lineup.formations || []).find((item) => (
    String(item.teamId) === String(team.id)
    || String(item.location || '').toLowerCase() === side
  ));
  const activeMode = match.status === 'LIVE' || match.status === 'FINAL';

  return {
    ...team,
    formation: formation?.formation || '',
    starters: teamPlayers.filter((player) => player.wasStarter).sort(sortLineupPlayers),
    onField: teamPlayers.filter((player) => (activeMode ? player.isOnField : player.wasStarter)).sort(sortLineupPlayers),
    bench: teamPlayers.filter((player) => (activeMode ? !player.isOnField : !player.wasStarter)).sort(sortLineupPlayers),
    players: teamPlayers.sort(sortLineupPlayers),
  };
}

function buildMatchLineupPayload(source, match, lineup) {
  const { players, substitutions } = applyLineupSubstitutions(lineup);
  const home = buildLineupSide(match, lineup, 'home', players);
  const away = buildLineupSide(match, lineup, 'away', players);
  const starterCount = home.starters.length + away.starters.length;
  const playerCount = home.players.length + away.players.length;
  const status = playerCount ? 'available' : 'pending';

  return {
    dataMode: source.dataMode,
    providerStatus: source.providerStatus,
    generatedAt: new Date().toISOString(),
    status,
    message: status === 'available'
      ? 'Escalacao oficial publicada pela fonte.'
      : 'Escalacao oficial ainda nao publicada pela fonte.',
    match: {
      id: match.id,
      providerFixtureId: match.providerFixtureId,
      stage: match.stage,
      group: match.group,
      home: match.home,
      away: match.away,
      homeCode: match.homeCode,
      awayCode: match.awayCode,
      homeLogo: match.homeLogo,
      awayLogo: match.awayLogo,
      kickoff: match.kickoff,
      status: match.status,
      stateLabel: match.stateLabel,
      homeScore: match.homeScore,
      awayScore: match.awayScore,
      venue: match.venue,
    },
    home,
    away,
    starterCount,
    playerCount,
    substitutions,
    sidelined: lineup.sidelined || [],
  };
}

async function mapWithConcurrency(items, limit, mapper) {
  const results = new Array(items.length);
  let cursor = 0;
  const workerCount = Math.min(limit, items.length);

  async function worker() {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await mapper(items[index], index);
    }
  }

  await Promise.all(Array.from({ length: workerCount }, worker));
  return results;
}

function positionShort(position) {
  if (position === 'Goleiro') return 'GOL';
  if (position === 'Defensor') return 'DEF';
  if (position === 'Meio-campista') return 'MEI';
  if (position === 'Atacante') return 'ATA';
  return 'ELC';
}

function decorateAlbumPlayer(player, team, teamIndex, playerIndex) {
  const albumNumber = String((teamIndex * 40) + playerIndex + 1).padStart(4, '0');
  return {
    ...player,
    albumNumber: `ST-${albumNumber}`,
    teamId: String(team.id || ''),
    teamName: team.name,
    teamCode: team.code || '',
    teamLogo: team.logo || '',
    group: team.group || '',
    groupId: team.groupId || '',
    positionShort: positionShort(player.position),
  };
}

async function buildPlayersAlbum(source, teamId) {
  const allTeams = source.teams || [];
  const selectedTeams = teamId && teamId !== 'all'
    ? allTeams.filter((team) => String(team.id) === String(teamId))
    : allTeams;

  if (!sportmonks.isConfigured()) {
    return {
      status: 'not_configured',
      players: [],
      teams: selectedTeams.map((team) => ({ ...team, playerCount: 0 })),
      errors: [],
    };
  }

  const teamResults = await mapWithConcurrency(selectedTeams, 5, async (team, index) => {
    try {
      const squad = await sportmonks.getTeamSquad(team.id);
      const originalIndex = allTeams.findIndex((item) => String(item.id) === String(team.id));
      const teamIndex = originalIndex >= 0 ? originalIndex : index;
      return {
        team: { ...team, playerCount: squad.length },
        players: squad.map((player, playerIndex) => decorateAlbumPlayer(player, team, teamIndex, playerIndex)),
        error: null,
      };
    } catch (err) {
      return {
        team: { ...team, playerCount: 0 },
        players: [],
        error: { teamId: String(team.id), teamName: team.name, message: err.message },
      };
    }
  });

  const players = teamResults.flatMap((item) => item.players).sort((a, b) => (
    a.groupId.localeCompare(b.groupId)
    || a.teamName.localeCompare(b.teamName)
    || a.positionOrder - b.positionOrder
    || (a.jerseyNumber ?? 999) - (b.jerseyNumber ?? 999)
    || a.name.localeCompare(b.name)
  ));

  return {
    status: teamResults.some((item) => item.error) ? 'partial' : 'ok',
    players,
    teams: teamResults.map((item) => item.team),
    errors: teamResults.map((item) => item.error).filter(Boolean),
  };
}

function outcome(homeScore, awayScore) {
  if (homeScore === awayScore) return 'draw';
  return homeScore > awayScore ? 'home' : 'away';
}

function matchHasResult(match) {
  return match.status === 'FINAL' && Number.isFinite(match.homeScore) && Number.isFinite(match.awayScore);
}

function isLocked(match) {
  if (match.status !== 'SCHEDULED') return true;
  const kickoff = new Date(match.kickoff).getTime();
  return Number.isFinite(kickoff) && Date.now() >= kickoff;
}

function scorePrediction(match, prediction) {
  if (!prediction || !matchHasResult(match)) {
    return { points: 0, tenisCash: 0, exact: false, result: false, goalDifference: false };
  }

  const predictedHome = Number(prediction.homeScore);
  const predictedAway = Number(prediction.awayScore);
  if (!Number.isInteger(predictedHome) || !Number.isInteger(predictedAway)) {
    return { points: 0, tenisCash: 0, exact: false, result: false, goalDifference: false };
  }

  const exact = predictedHome === match.homeScore && predictedAway === match.awayScore;
  const result = outcome(predictedHome, predictedAway) === outcome(match.homeScore, match.awayScore);
  const goalDifference = (predictedHome - predictedAway) === (match.homeScore - match.awayScore);

  let points = 0;
  let tenisCash = 0;
  if (exact) {
    points += RULES.exactScore;
    tenisCash += RULES.tenisCashExact;
  } else if (result) {
    points += RULES.result;
    tenisCash += RULES.tenisCashResult;
  }
  if (!exact && goalDifference) points += RULES.goalDifference;

  return { points, tenisCash, exact, result, goalDifference };
}

function decorateMatches(predictions, matches) {
  return matches.map((match) => {
    const prediction = predictions[match.id] || null;
    const score = scorePrediction(match, prediction);
    return {
      ...match,
      locked: isLocked(match),
      prediction,
      score,
    };
  });
}

function summarizeUser(predictions, matches) {
  const decorated = decorateMatches(predictions, matches);
  const completed = decorated.filter(matchHasResult);
  const scored = decorated.reduce((acc, match) => {
    acc.points += match.score.points;
    acc.tenisCash += match.score.tenisCash;
    if (match.score.exact) acc.exactHits += 1;
    else if (match.score.result) acc.resultHits += 1;
    if (match.score.goalDifference) acc.goalDifferenceHits += 1;
    return acc;
  }, { points: 0, tenisCash: 0, exactHits: 0, resultHits: 0, goalDifferenceHits: 0 });

  const pending = decorated.filter((match) => !match.locked && !match.prediction).length;
  const predicted = decorated.filter((match) => !!match.prediction).length;
  const nextMatch = decorated.find((match) => !match.locked) || decorated[0] || null;
  const predictionsList = Object.values(predictions || {});
  const lastPredictionAt = predictionsList
    .map((prediction) => prediction.updatedAt)
    .filter(Boolean)
    .sort()
    .at(-1) || null;

  return {
    ...scored,
    pending,
    predicted,
    completed: completed.length,
    totalMatches: matches.length,
    completionRate: matches.length ? Math.round((predicted / matches.length) * 100) : 0,
    lastPredictionAt,
    nextMatch,
  };
}

async function buildLeaderboard(state, currentUserId, matches) {
  const userIds = Object.keys(state.predictions || {});
  const users = userIds.length
    ? await prisma.user.findMany({
      where: { id: { in: userIds } },
      select: { id: true, name: true },
    }).catch(() => [])
    : [];
  const names = new Map(users.map((user) => [user.id, user.name]));

  const rows = userIds.map((userId) => {
    const summary = summarizeUser(state.predictions[userId] || {}, matches);
    return {
      userId,
      name: names.get(userId) || 'Cliente TenisCash',
      points: summary.points,
      tenisCash: summary.tenisCash,
      predicted: summary.predicted,
      pending: summary.pending,
      completed: summary.completed,
      totalMatches: summary.totalMatches,
      completionRate: summary.completionRate,
      exactHits: summary.exactHits,
      resultHits: summary.resultHits,
      goalDifferenceHits: summary.goalDifferenceHits,
      lastPredictionAt: summary.lastPredictionAt,
      isMe: userId === currentUserId,
    };
  }).sort((a, b) => (
    b.points - a.points
    || b.exactHits - a.exactHits
    || b.predicted - a.predicted
    || a.name.localeCompare(b.name)
  ));

  return rows.map((row, index) => ({ ...row, rank: index + 1 }));
}

function rankingStats(leaderboard) {
  const rows = leaderboard || [];
  return {
    participants: rows.length,
    totalPredictions: rows.reduce((sum, row) => sum + (row.predicted || 0), 0),
    exactHits: rows.reduce((sum, row) => sum + (row.exactHits || 0), 0),
    topScore: rows[0]?.points || 0,
    tenisCashProjected: rows.reduce((sum, row) => sum + (row.tenisCash || 0), 0),
  };
}

function poolInfo(state) {
  const custom = state?.pool || {};
  return {
    ...DEFAULT_POOL,
    ...custom,
    rules: RULES,
    prizes: (state?.prizes || DEFAULT_PRIZES).map(sanitizePrize),
  };
}

async function buildPayload(userId) {
  const [state, user, source, news, playerStats] = await Promise.all([
    getPoolState(),
    prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, name: true, balance: true, role: true },
    }),
    getTournamentSource(),
    copaNews.getWorldCupNews(),
    buildTournamentStats(),
  ]);

  const predictions = (state.predictions && state.predictions[userId]) || {};
  const summary = summarizeUser(predictions, source.matches);
  const leaderboard = await buildLeaderboard(state, userId, source.matches);
  const brazil = await buildBrazilCenter(source, state);
  const me = leaderboard.find((row) => row.userId === userId) || {
    rank: leaderboard.length + 1,
    points: summary.points,
    tenisCash: summary.tenisCash,
    predicted: summary.predicted,
    exactHits: summary.exactHits,
    isMe: true,
    name: user?.name || 'Voce',
  };

  return {
    dataMode: source.dataMode,
    providerStatus: source.providerStatus,
    generatedAt: new Date().toISOString(),
    pool: poolInfo(state),
    user: {
      id: user?.id,
      name: user?.name || 'Cliente TenisCash',
      balance: user?.balance || 0,
      role: user?.role || 'user',
      canManageCopa: ['admin', 'superadmin', 'manager'].includes(user?.role || ''),
    },
    summary: {
      ...summary,
      rank: me.rank,
    },
    competition: buildCompetitionInfo(source),
    accessMap: buildAccessMap(),
    brazil,
    userBrazilLineup: sanitizeUserBrazilLineup(state.userBrazilLineups?.[userId]),
    featured: source.featured,
    matches: decorateMatches(predictions, source.matches),
    tables: source.tables,
    teams: source.teams,
    playerStats,
    leaderboard,
    rankingStats: rankingStats(leaderboard),
    news,
    prizes: (state.prizes || DEFAULT_PRIZES).map(sanitizePrize),
  };
}

router.get('/public', async (req, res) => {
  try {
    const [state, source, news, playerStats] = await Promise.all([
      getPoolState(),
      getTournamentSource(),
      copaNews.getWorldCupNews(),
      buildTournamentStats(),
    ]);
    const matches = decorateMatches({}, source.matches);
    const nextMatch = matches.find((match) => !match.locked) || matches[0] || null;
    const leaderboard = await buildLeaderboard(state, null, source.matches);
    const brazil = await buildBrazilCenter(source, state);

    res.json({
      dataMode: source.dataMode,
      providerStatus: source.providerStatus,
      isPublic: true,
      generatedAt: new Date().toISOString(),
      pool: poolInfo(state),
      summary: {
        points: 0,
        tenisCash: 0,
        exactHits: 0,
        resultHits: 0,
        pending: matches.filter((match) => !match.locked).length,
        predicted: 0,
        completed: matches.filter(matchHasResult).length,
        totalMatches: source.matches.length,
        nextMatch,
        rank: null,
      },
      competition: buildCompetitionInfo(source),
      accessMap: buildAccessMap(),
      brazil,
      featured: source.featured,
      matches,
      tables: source.tables,
      teams: source.teams,
      playerStats,
      leaderboard,
      rankingStats: rankingStats(leaderboard),
      news,
      prizes: (state.prizes || DEFAULT_PRIZES).map(sanitizePrize),
    });
  } catch (err) {
    console.error('Erro ao carregar previa publica do bolao da Copa:', err);
    res.status(500).json({ error: 'Erro ao carregar previa publica do bolao da Copa' });
  }
});

router.get('/news', async (req, res) => {
  try {
    res.json(await copaNews.getWorldCupNews());
  } catch (err) {
    console.error('Erro ao carregar noticias da Copa:', err);
    res.status(500).json({ error: 'Erro ao carregar noticias da Copa' });
  }
});

router.get('/players', async (req, res) => {
  try {
    const source = await getTournamentSource();
    const teamId = req.query.teamId ? String(req.query.teamId) : 'all';
    const album = await buildPlayersAlbum(source, teamId);

    return res.json({
      dataMode: source.dataMode,
      providerStatus: source.providerStatus,
      generatedAt: new Date().toISOString(),
      teamId,
      totalPlayers: album.players.length,
      totalTeams: album.teams.length,
      status: album.status,
      players: album.players,
      teams: album.teams,
      errors: album.errors,
    });
  } catch (err) {
    console.error('Erro ao carregar album de jogadores:', err);
    return res.status(500).json({ error: 'Erro ao carregar album de jogadores' });
  }
});

router.get('/teams/:teamId/profile', async (req, res) => {
  try {
    const source = await getTournamentSource();
    const team = source.teams.find((item) => String(item.id) === String(req.params.teamId));
    if (!team) return res.status(404).json({ error: 'Selecao nao encontrada' });

    const detail = buildTeamDetail(team, source);
    if (!sportmonks.isConfigured()) {
      return res.json({
        dataMode: source.dataMode,
        providerStatus: source.providerStatus,
        generatedAt: new Date().toISOString(),
        ...detail,
        profile: null,
        squad: [],
      });
    }

    const [profileResult, squadResult] = await Promise.allSettled([
      sportmonks.getTeamProfile(team.id),
      sportmonks.getTeamSquad(team.id),
    ]);

    return res.json({
      dataMode: source.dataMode,
      providerStatus: source.providerStatus,
      generatedAt: new Date().toISOString(),
      ...detail,
      profile: profileResult.status === 'fulfilled' ? profileResult.value : null,
      profileStatus: profileResult.status === 'fulfilled' ? 'ok' : profileResult.reason?.message || 'indisponivel',
      squad: squadResult.status === 'fulfilled' ? squadResult.value : [],
      squadStatus: squadResult.status === 'fulfilled' ? 'ok' : squadResult.reason?.message || 'indisponivel',
    });
  } catch (err) {
    console.error('Erro ao carregar perfil da selecao:', err);
    return res.status(500).json({ error: 'Erro ao carregar perfil da selecao' });
  }
});

router.get('/teams/:teamId/squad', async (req, res) => {
  try {
    const source = await getTournamentSource();
    const team = source.teams.find((item) => String(item.id) === String(req.params.teamId));
    if (!team) return res.status(404).json({ error: 'Selecao nao encontrada' });

    if (!sportmonks.isConfigured()) {
      return res.json({
        dataMode: source.dataMode,
        providerStatus: source.providerStatus,
        generatedAt: new Date().toISOString(),
        team,
        squad: [],
      });
    }

    const squad = await sportmonks.getTeamSquad(team.id);
    return res.json({
      dataMode: source.dataMode,
      providerStatus: source.providerStatus,
      generatedAt: new Date().toISOString(),
      team,
      squad,
    });
  } catch (err) {
    console.error('Erro ao carregar elenco da selecao:', err);
    return res.status(500).json({ error: 'Erro ao carregar elenco da selecao' });
  }
});

router.get('/matches/:matchId/lineup', async (req, res) => {
  try {
    const source = await getTournamentSource();
    const match = (source.matches || []).find((item) => (
      String(item.id) === String(req.params.matchId)
      || String(item.providerFixtureId || '') === String(req.params.matchId)
    ));
    if (!match) return res.status(404).json({ error: 'Jogo nao encontrado' });

    if (!sportmonks.isConfigured() || !match.providerFixtureId) {
      return res.json(buildMatchLineupPayload(source, match, {
        formations: [],
        lineups: [],
        events: [],
        sidelined: [],
      }));
    }

    try {
      const lineup = await sportmonks.getFixtureLineup(match.providerFixtureId);
      return res.json(buildMatchLineupPayload(source, match, lineup));
    } catch (err) {
      console.warn('[copa] Escalacao Sportmonks indisponivel:', err.message);
      return res.json({
        ...buildMatchLineupPayload(source, match, {
          formations: [],
          lineups: [],
          events: [],
          sidelined: [],
        }),
        status: 'unavailable',
        message: 'Escalacao oficial indisponivel neste momento.',
      });
    }
  } catch (err) {
    console.error('Erro ao carregar escalacao do jogo:', err);
    return res.status(500).json({ error: 'Erro ao carregar escalacao do jogo' });
  }
});

router.get('/summary', authMiddleware, async (req, res) => {
  try {
    res.json(await buildPayload(req.userId));
  } catch (err) {
    console.error('Erro ao carregar bolao da Copa:', err);
    res.status(500).json({ error: 'Erro ao carregar bolao da Copa' });
  }
});

router.put('/admin/config', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const state = await getPoolState();
    const body = req.body || {};

    if (body.pool && typeof body.pool === 'object') {
      state.pool = {
        ...state.pool,
        title: String(body.pool.title || state.pool.title || DEFAULT_POOL.title).slice(0, 90),
        subtitle: String(body.pool.subtitle || state.pool.subtitle || DEFAULT_POOL.subtitle).slice(0, 140),
        status: String(body.pool.status || state.pool.status || DEFAULT_POOL.status).slice(0, 40),
        prize: String(body.pool.prize || state.pool.prize || DEFAULT_POOL.prize).slice(0, 120),
      };
    }

    if (Array.isArray(body.prizes)) {
      state.prizes = body.prizes.slice(0, 12).map(sanitizePrize);
    }

    if (body.lineup && body.matchId) {
      state.lineups = state.lineups || {};
      state.lineups[String(body.matchId)] = {
        ...sanitizeLineup(body.lineup),
        updatedAt: new Date().toISOString(),
        updatedBy: req.userId,
      };
    }

    await savePoolState(state);
    return res.json(await buildPayload(req.userId));
  } catch (err) {
    console.error('Erro ao salvar configuracao da Copa:', err);
    return res.status(500).json({ error: 'Erro ao salvar configuracao da Copa' });
  }
});

router.post('/predictions', authMiddleware, async (req, res) => {
  try {
    const { matchId, homeScore, awayScore } = req.body || {};
    const source = await getTournamentSource();
    const match = source.matches.find((item) => item.id === String(matchId));
    if (!match) return res.status(404).json({ error: 'Jogo nao encontrado' });
    if (isLocked(match)) return res.status(409).json({ error: 'Palpite travado para este jogo' });

    const home = Number(homeScore);
    const away = Number(awayScore);
    if (!Number.isInteger(home) || !Number.isInteger(away) || home < 0 || away < 0 || home > 20 || away > 20) {
      return res.status(400).json({ error: 'Informe placares inteiros entre 0 e 20' });
    }

    const state = await getPoolState();
    const userPredictions = state.predictions[req.userId] || {};
    userPredictions[match.id] = {
      matchId: match.id,
      homeScore: home,
      awayScore: away,
      updatedAt: new Date().toISOString(),
    };
    state.predictions[req.userId] = userPredictions;
    await savePoolState(state);

    res.json(await buildPayload(req.userId));
  } catch (err) {
    console.error('Erro ao salvar palpite:', err);
    res.status(500).json({ error: 'Erro ao salvar palpite' });
  }
});

router.put('/brazil-lineup', authMiddleware, async (req, res) => {
  try {
    const state = await getPoolState();
    state.userBrazilLineups = state.userBrazilLineups || {};
    state.userBrazilLineups[req.userId] = sanitizeUserBrazilLineup({
      ...(req.body || {}),
      updatedAt: new Date().toISOString(),
    });
    await savePoolState(state);
    res.json(await buildPayload(req.userId));
  } catch (err) {
    console.error('Erro ao salvar escalacao do usuario:', err);
    res.status(500).json({ error: 'Erro ao salvar escalacao do Brasil' });
  }
});

// ============================================================
// FIGURINHAS PANINI — Copa do Mundo FIFA 2026
// (/api/copa/figurinhas/*)
// ============================================================

// GET /api/copa/figurinhas/stickers
router.get('/figurinhas/stickers', async (_req, res) => {
  try {
    const stickers = await prisma.sticker.findMany({
      orderBy: [{ section: 'asc' }, { number: 'asc' }],
    });
    res.json({ stickers });
  } catch (e) {
    console.error('[copa/figurinhas] stickers', e);
    res.status(500).json({ error: 'Erro ao buscar figurinhas' });
  }
});

// POST /api/copa/figurinhas/perfil — criar coleção
router.post('/figurinhas/perfil', async (req, res) => {
  try {
    const { name, whatsapp, city, neighborhood } = req.body || {};
    if (!name || !whatsapp) return res.status(400).json({ error: 'Nome e WhatsApp obrigatórios' });
    const col = await prisma.stickerCollection.create({
      data: {
        name: name.trim(),
        whatsapp: String(whatsapp).replace(/\D/g, ''),
        city: (city || '').trim(),
        neighborhood: (neighborhood || '').trim(),
      },
    });
    return res.json({ token: col.token, id: col.id, name: col.name });
  } catch (e) {
    console.error('[copa/figurinhas] POST /perfil', e);
    return res.status(500).json({ error: 'Erro ao criar perfil' });
  }
});

// GET /api/copa/figurinhas/perfil/:token
router.get('/figurinhas/perfil/:token', async (req, res) => {
  try {
    const col = await prisma.stickerCollection.findUnique({
      where: { token: req.params.token },
      include: { stickers: { select: { stickerId: true, quantity: true } } },
    });
    if (!col) return res.status(404).json({ error: 'Perfil não encontrado' });
    const stickerMap = {};
    for (const us of col.stickers) stickerMap[us.stickerId] = us.quantity;
    return res.json({
      id: col.id, token: col.token, name: col.name,
      whatsapp: col.whatsapp, city: col.city,
      neighborhood: col.neighborhood, createdAt: col.createdAt, stickerMap,
    });
  } catch (e) {
    console.error('[copa/figurinhas] GET /perfil/:token', e);
    return res.status(500).json({ error: 'Erro ao buscar perfil' });
  }
});

// PUT /api/copa/figurinhas/perfil/:token — salvar lote de figurinhas
// body: { updates: [{ stickerId, quantity }] }
router.put('/figurinhas/perfil/:token', async (req, res) => {
  try {
    const col = await prisma.stickerCollection.findUnique({ where: { token: req.params.token } });
    if (!col) return res.status(404).json({ error: 'Perfil não encontrado' });
    const { updates } = req.body || {};
    if (!Array.isArray(updates) || !updates.length) return res.json({ ok: true, saved: 0 });
    const ops = updates.map(u =>
      prisma.userSticker.upsert({
        where: { collectionId_stickerId: { collectionId: col.id, stickerId: u.stickerId } },
        create: { collectionId: col.id, stickerId: u.stickerId, quantity: Math.max(0, u.quantity | 0) },
        update: { quantity: Math.max(0, u.quantity | 0) },
      })
    );
    await prisma.$transaction(ops);
    await prisma.stickerCollection.update({ where: { id: col.id }, data: { updatedAt: new Date() } });
    return res.json({ ok: true, saved: ops.length });
  } catch (e) {
    console.error('[copa/figurinhas] PUT /perfil/:token', e);
    return res.status(500).json({ error: 'Erro ao salvar figurinhas' });
  }
});

// GET /api/copa/figurinhas/parceiros?city=X
router.get('/figurinhas/parceiros', async (req, res) => {
  try {
    const { city } = req.query;
    const where = city ? { city: { contains: city, mode: 'insensitive' } } : {};
    const list = await prisma.stickerCollection.findMany({
      where,
      select: {
        id: true, token: true, name: true, city: true,
        neighborhood: true, updatedAt: true,
        stickers: { select: { quantity: true } },
      },
      orderBy: { updatedAt: 'desc' },
      take: 60,
    });
    const result = list.map(p => {
      const have = p.stickers.filter(s => s.quantity >= 1).length;
      const dups = p.stickers.filter(s => s.quantity >= 2).reduce((a, s) => a + (s.quantity - 1), 0);
      return {
        id: p.id, token: p.token, name: p.name,
        city: p.city, neighborhood: p.neighborhood, updatedAt: p.updatedAt,
        have, duplicates: dups, missing: 980 - have, pct: Math.round(have / 9.8),
      };
    });
    return res.json({ parceiros: result });
  } catch (e) {
    console.error('[copa/figurinhas] GET /parceiros', e);
    return res.status(500).json({ error: 'Erro ao buscar parceiros' });
  }
});

// POST /api/copa/figurinhas/scan — identifica figurinhas por foto (Claude Vision)
// body: { token, image: base64, mimeType }
router.post('/figurinhas/scan', async (req, res) => {
  try {
    const { token, image, mimeType = 'image/jpeg' } = req.body || {};
    if (!token || !image) return res.status(400).json({ error: 'Token e imagem obrigatórios' });

    const col = await prisma.stickerCollection.findUnique({ where: { token } });
    if (!col) return res.status(404).json({ error: 'Perfil não encontrado' });

    const Anthropic = require('@anthropic-ai/sdk');
    const ai = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

    const prompt = `Você está analisando uma foto de figurinhas do álbum Panini Copa do Mundo FIFA 2026.

Identifique TODAS as figurinhas visíveis na imagem.

Para cada figurinha, determine:
- section: código de 2-3 letras da seleção/seção
- number: número de 1 a 20 (ou até 11 para Museu, até 8 para FWC)

Seções válidas:
CONCACAF: CAN, USA, MEX, PAN, CUR, HAI
CONMEBOL: ARG, BRA, COL, ECU, PAR, URU
UEFA: ALE, AUT, BEL, DIN, ESC, ESP, FRA, ING, ITA, NOR, HOL, POL, POR, RTC, SUE, SUI
CAF: EGI, ALG, ASA, CPV, GAN, MAR, SEN, TUN, CMA, RDC
AFC: AUS, CDS, IRA, IRQ, JPN, JOR, TAI, UZB, VIE
OFC: NZL
Especiais: INT (só nº 1), FWC (nºs 1-8), MUS (nºs 1-11)

Estrutura de cada seleção (20 figurinhas):
- Nº 1: Escudo/Badge (geralmente dourado ou metalizado)
- Nºs 2-19: Jogadores individuais
- Nº 20: Foto da seleção completa

Procure números impressos nas figurinhas, flags/bandeiras das seleções, nomes de jogadores, e posição no layout.

Retorne APENAS JSON válido sem texto adicional:
[{"section":"BRA","number":1},{"section":"ARG","number":7}]

Se não identificar nenhuma com confiança razoável, retorne: []`;

    const response = await ai.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 2048,
      messages: [{ role: 'user', content: [
        { type: 'image', source: { type: 'base64', media_type: mimeType, data: image } },
        { type: 'text', text: prompt }
      ]}]
    });

    const text = (response.content[0]?.text || '').trim();
    let found = [];
    try { const m = text.match(/\[[\s\S]*\]/); if (m) found = JSON.parse(m[0]); } catch (_) {}

    const VALID = new Set(['INT','FWC','MUS','CAN','USA','MEX','PAN','CUR','HAI','ARG','BRA','COL','ECU','PAR','URU',
      'ALE','AUT','BEL','DIN','ESC','ESP','FRA','ING','ITA','NOR','HOL','POL','POR','RTC','SUE','SUI',
      'EGI','ALG','ASA','CPV','GAN','MAR','SEN','TUN','CMA','RDC','AUS','CDS','IRA','IRQ','JPN','JOR','TAI','UZB','VIE','NZL']);

    const valid = found.filter(f =>
      f && typeof f.section === 'string' && VALID.has(f.section) &&
      Number.isInteger(f.number) && f.number >= 1 && f.number <= 20
    );

    const stickers = valid.length ? await prisma.sticker.findMany({
      where: { OR: valid.map(f => ({ section: f.section, number: f.number })) },
      select: { id: true, section: true, number: true, displayCode: true, sectionName: true, label: true }
    }) : [];

    return res.json({ stickers, count: stickers.length });
  } catch (e) {
    console.error('[copa/figurinhas] scan', e);
    return res.status(500).json({ error: 'Erro ao analisar imagem: ' + e.message });
  }
});

// GET /api/copa/figurinhas/cruzar/:myToken/:theirToken
router.get('/figurinhas/cruzar/:myToken/:theirToken', async (req, res) => {
  try {
    const [me, them] = await Promise.all([
      prisma.stickerCollection.findUnique({
        where: { token: req.params.myToken },
        include: { stickers: { select: { stickerId: true, quantity: true } } },
      }),
      prisma.stickerCollection.findUnique({
        where: { token: req.params.theirToken },
        include: { stickers: { select: { stickerId: true, quantity: true } } },
      }),
    ]);
    if (!me) return res.status(404).json({ error: 'Seu perfil não encontrado' });
    if (!them) return res.status(404).json({ error: 'Perfil do parceiro não encontrado' });

    const myMap = Object.fromEntries(me.stickers.map(s => [s.stickerId, s.quantity]));
    const theirMap = Object.fromEntries(them.stickers.map(s => [s.stickerId, s.quantity]));
    const all = await prisma.sticker.findMany({ orderBy: [{ section: 'asc' }, { number: 'asc' }] });

    const iCanGive = all
      .filter(s => (myMap[s.id] || 0) >= 2 && (theirMap[s.id] || 0) === 0)
      .map(s => ({ id: s.id, displayCode: s.displayCode, sectionName: s.sectionName, label: s.label, myQty: myMap[s.id] }));

    const theyCanGive = all
      .filter(s => (theirMap[s.id] || 0) >= 2 && (myMap[s.id] || 0) === 0)
      .map(s => ({ id: s.id, displayCode: s.displayCode, sectionName: s.sectionName, label: s.label, theirQty: theirMap[s.id] }));

    return res.json({
      me: { name: me.name, whatsapp: me.whatsapp, token: me.token },
      them: { name: them.name, whatsapp: them.whatsapp, token: them.token },
      iCanGive, theyCanGive,
      iCanGiveCount: iCanGive.length, theyCanGiveCount: theyCanGive.length,
    });
  } catch (e) {
    console.error('[copa/figurinhas] GET /cruzar', e);
    return res.status(500).json({ error: 'Erro ao cruzar coleções' });
  }
});

// POST /api/copa/figurinhas/buscar-parceiros/:token — dispara robô manualmente
router.post('/figurinhas/buscar-parceiros/:token', async (req, res) => {
  try {
    const col = await prisma.stickerCollection.findUnique({ where: { token: req.params.token } });
    if (!col) return res.status(404).json({ error: 'Perfil não encontrado' });

    const { runForCollection } = require('../services/copaMatchBot');
    const result = await runForCollection(col.id);
    return res.json(result);
  } catch (e) {
    console.error('[copa/figurinhas] buscar-parceiros', e);
    return res.status(500).json({ error: 'Erro ao buscar parceiros: ' + e.message });
  }
});

module.exports = router;
