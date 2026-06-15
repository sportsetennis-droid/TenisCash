const DEFAULT_BASE_URL = 'https://api.sportmonks.com/v3/football';
const DEFAULT_WORLD_CUP_LEAGUE_ID = '732';
const DEFAULT_WORLD_CUP_SEASON_ID = '26618';
const DEFAULT_WORLD_CUP_START_DATE = '2026-06-11';
const DEFAULT_WORLD_CUP_END_DATE = '2026-07-19';
const DEFAULT_TIMEOUT_MS = 12000;
const DEFAULT_CACHE_TTL_MS = 60 * 1000;
const SQUAD_CACHE_TTL_MS = 10 * 60 * 1000;
const PROFILE_CACHE_TTL_MS = 10 * 60 * 1000;
const LINEUP_CACHE_TTL_MS = 30 * 1000;
const LIVE_CACHE_TTL_MS = 8 * 1000;
const TOPSCORERS_CACHE_TTL_MS = 60 * 1000;

const cache = new Map();

const TEAM_NAME_PT = {
  Algeria: 'Argelia',
  Argentina: 'Argentina',
  Australia: 'Australia',
  Austria: 'Austria',
  Belgium: 'Belgica',
  Bolivia: 'Bolivia',
  Brazil: 'Brasil',
  Cameroon: 'Camaroes',
  Canada: 'Canada',
  'Cape Verde': 'Cabo Verde',
  'Cape Verde Islands': 'Cabo Verde',
  Chile: 'Chile',
  Colombia: 'Colombia',
  'Costa Rica': 'Costa Rica',
  Croatia: 'Croacia',
  Curacao: 'Curacao',
  'Curaçao': 'Curacao',
  'Czech Republic': 'Republica Tcheca',
  Denmark: 'Dinamarca',
  Ecuador: 'Equador',
  Egypt: 'Egito',
  England: 'Inglaterra',
  France: 'Franca',
  Germany: 'Alemanha',
  Ghana: 'Gana',
  Greece: 'Grecia',
  Haiti: 'Haiti',
  Honduras: 'Honduras',
  Iran: 'Ira',
  Iraq: 'Iraque',
  Ireland: 'Irlanda',
  Italy: 'Italia',
  'Ivory Coast': 'Costa do Marfim',
  Jamaica: 'Jamaica',
  Japan: 'Japao',
  Jordan: 'Jordania',
  'Korea Republic': 'Coreia do Sul',
  Mexico: 'Mexico',
  Morocco: 'Marrocos',
  Netherlands: 'Holanda',
  'New Zealand': 'Nova Zelandia',
  Nigeria: 'Nigeria',
  Norway: 'Noruega',
  Oman: 'Oma',
  Panama: 'Panama',
  Paraguay: 'Paraguai',
  Peru: 'Peru',
  Poland: 'Polonia',
  Portugal: 'Portugal',
  Qatar: 'Catar',
  Romania: 'Romenia',
  'Saudi Arabia': 'Arabia Saudita',
  Scotland: 'Escocia',
  Senegal: 'Senegal',
  Serbia: 'Servia',
  Slovakia: 'Eslovaquia',
  Slovenia: 'Eslovenia',
  'South Africa': 'Africa do Sul',
  Spain: 'Espanha',
  Sweden: 'Suecia',
  Switzerland: 'Suica',
  Tunisia: 'Tunisia',
  Turkey: 'Turquia',
  Ukraine: 'Ucrania',
  'United Arab Emirates': 'Emirados Arabes',
  'United States': 'Estados Unidos',
  Uruguay: 'Uruguai',
  USA: 'Estados Unidos',
  Uzbekistan: 'Uzbequistao',
  Wales: 'Pais de Gales',
};

const POSITION_PT = {
  Goalkeeper: 'Goleiro',
  Defender: 'Defensor',
  Midfielder: 'Meio-campista',
  Attacker: 'Atacante',
  Coach: 'Tecnico',
};

const POSITION_ORDER = {
  Goleiro: 1,
  Defensor: 2,
  'Meio-campista': 3,
  Atacante: 4,
  Tecnico: 5,
};

function config() {
  return {
    token: process.env.SPORTMONKS_API_TOKEN,
    baseUrl: process.env.SPORTMONKS_BASE_URL || DEFAULT_BASE_URL,
    leagueId: String(process.env.SPORTMONKS_WORLD_CUP_LEAGUE_ID || DEFAULT_WORLD_CUP_LEAGUE_ID),
    seasonId: String(process.env.SPORTMONKS_WORLD_CUP_SEASON_ID || DEFAULT_WORLD_CUP_SEASON_ID),
    startDate: process.env.SPORTMONKS_WORLD_CUP_START_DATE || DEFAULT_WORLD_CUP_START_DATE,
    endDate: process.env.SPORTMONKS_WORLD_CUP_END_DATE || DEFAULT_WORLD_CUP_END_DATE,
  };
}

function isConfigured() {
  return Boolean(config().token);
}

function cacheGet(key) {
  const hit = cache.get(key);
  if (!hit || hit.expiresAt <= Date.now()) {
    cache.delete(key);
    return null;
  }
  return hit.value;
}

function cacheSet(key, value, ttlMs) {
  cache.set(key, { value, expiresAt: Date.now() + ttlMs });
  return value;
}

function buildUrl(path, params = {}) {
  const cfg = config();
  if (!cfg.token) {
    throw new Error('SPORTMONKS_API_TOKEN nao configurado');
  }

  const normalizedBase = cfg.baseUrl.replace(/\/+$/, '');
  const normalizedPath = String(path || '').replace(/^\/+/, '');
  const url = new URL(`${normalizedBase}/${normalizedPath}`);
  url.searchParams.set('api_token', cfg.token);

  Object.entries(params).forEach(([key, value]) => {
    if (value === undefined || value === null || value === '') return;
    url.searchParams.set(key, String(value));
  });

  return url;
}

async function request(path, params = {}, options = {}) {
  const ttlMs = options.ttlMs ?? DEFAULT_CACHE_TTL_MS;
  const url = buildUrl(path, params);
  const cacheKey = url.toString();
  const cached = cacheGet(cacheKey);
  if (cached) return cached;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs || DEFAULT_TIMEOUT_MS);

  try {
    const response = await fetch(url, {
      headers: { Accept: 'application/json' },
      signal: controller.signal,
    });
    const text = await response.text();
    const body = text ? JSON.parse(text) : {};

    if (!response.ok) {
      const message = body.message || body.error || `Sportmonks HTTP ${response.status}`;
      throw new Error(message);
    }

    return cacheSet(cacheKey, body, ttlMs);
  } catch (err) {
    if (err.name === 'AbortError') {
      throw new Error('Sportmonks timeout');
    }
    throw err;
  } finally {
    clearTimeout(timeout);
  }
}

function array(value) {
  return Array.isArray(value) ? value : [];
}

function numberOrNull(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function translateTeamName(name) {
  return TEAM_NAME_PT[name] || name || 'A definir';
}

function translatePosition(name) {
  return POSITION_PT[name] || name || 'Elenco';
}

function groupIdFromName(name) {
  const match = String(name || '').match(/(?:Group|Grupo)\s+([A-L])/i);
  return match ? match[1].toUpperCase() : '';
}

function translateGroupName(name) {
  const groupId = groupIdFromName(name);
  return groupId ? `Grupo ${groupId}` : (name || '');
}

function translateStageName(fixture) {
  const groupName = translateGroupName(fixture.group?.name);
  if (groupName) {
    const roundName = fixture.round?.name ? ` - Rodada ${fixture.round.name}` : '';
    return `${groupName}${roundName}`;
  }

  const stage = fixture.stage?.name || '';
  if (/group stage/i.test(stage)) return 'Fase de grupos';
  if (/round of 32/i.test(stage)) return '32 avos de final';
  if (/round of 16/i.test(stage)) return 'Oitavas de final';
  if (/quarter/i.test(stage)) return 'Quartas de final';
  if (/semi/i.test(stage)) return 'Semifinal';
  if (/final/i.test(stage)) return 'Final';
  return stage || 'Copa do Mundo';
}

function participantByLocation(fixture, location) {
  return array(fixture.participants).find((participant) => participant.meta?.location === location) || null;
}

function scoreForLocation(fixture, location) {
  const scores = array(fixture.scores);
  const current = scores.find((item) => (
    String(item.description || '').toUpperCase() === 'CURRENT'
    && item.score?.participant === location
  ));
  const fallback = scores.find((item) => item.score?.participant === location);
  const goals = Number((current || fallback)?.score?.goals);
  return Number.isFinite(goals) ? goals : null;
}

function mapStatus(fixture) {
  const code = String(
    fixture.state?.developer_name
    || fixture.state?.state
    || fixture.state?.short_name
    || ''
  ).toUpperCase();

  if (['FT', 'AET', 'FT_PEN', 'AFTER_PENALTIES'].includes(code)) return 'FINAL';
  if (['NS', 'TBA', 'TBD', 'POSTPONED', 'CANCELLED', 'ABANDONED'].includes(code)) return 'SCHEDULED';
  if (code.includes('HALF') || ['LIVE', 'INPLAY', 'HT', 'ET', 'PEN', 'BREAK'].includes(code)) return 'LIVE';

  const kickoff = new Date(String(fixture.starting_at || '').replace(' ', 'T') + 'Z').getTime();
  if (Number.isFinite(kickoff) && Date.now() >= kickoff) return 'LIVE';
  return 'SCHEDULED';
}

function kickoffIso(startingAt) {
  if (!startingAt) return null;
  const normalized = String(startingAt).includes('T')
    ? String(startingAt)
    : `${startingAt}Z`.replace(' ', 'T');
  const date = new Date(normalized);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function venueName(venue) {
  if (!venue) return '';
  return [venue.name, venue.city_name].filter(Boolean).join(' - ');
}

function mapFixture(fixture) {
  const home = participantByLocation(fixture, 'home') || array(fixture.participants)[0] || {};
  const away = participantByLocation(fixture, 'away') || array(fixture.participants)[1] || {};
  const status = mapStatus(fixture);
  const homeScore = scoreForLocation(fixture, 'home');
  const awayScore = scoreForLocation(fixture, 'away');
  const group = translateGroupName(fixture.group?.name);

  return {
    id: String(fixture.id),
    provider: 'sportmonks',
    providerFixtureId: fixture.id,
    stage: translateStageName(fixture),
    group,
    groupId: groupIdFromName(group),
    round: fixture.round?.name || '',
    homeTeamId: home.id ? String(home.id) : '',
    awayTeamId: away.id ? String(away.id) : '',
    home: translateTeamName(home.name),
    away: translateTeamName(away.name),
    homeCode: home.short_code || '',
    awayCode: away.short_code || '',
    homeLogo: home.image_path || '',
    awayLogo: away.image_path || '',
    kickoff: kickoffIso(fixture.starting_at),
    status,
    homeScore,
    awayScore,
    venue: venueName(fixture.venue),
    stateLabel: fixture.state?.name || '',
  };
}

function detailValue(row, predicate) {
  const detail = array(row.details).find((item) => {
    const name = String(item.type?.name || '').toLowerCase();
    return predicate(name);
  });
  return numberOrNull(detail?.value) || 0;
}

function mapStandingRow(row) {
  const participant = row.participant || {};
  const played = detailValue(row, (name) => name.includes('overall') && name.includes('played'));
  const won = detailValue(row, (name) => name.includes('overall') && name.includes('won'));
  const drawn = detailValue(row, (name) => name.includes('overall') && name.includes('draw'));
  const lost = detailValue(row, (name) => name.includes('overall') && name.includes('lost'));
  const goalsFor = detailValue(row, (name) => name.includes('goal') && name.includes('scored') && (name.includes('overall') || name.includes('overal')));
  const goalsAgainst = detailValue(row, (name) => name.includes('goal') && name.includes('conceded') && (name.includes('overall') || name.includes('overal')));
  const points = numberOrNull(row.points) || 0;
  const goalDifference = goalsFor - goalsAgainst;
  const groupId = groupIdFromName(row.group?.name);

  return {
    id: participant.id ? String(participant.id) : String(row.participant_id || row.id),
    standingId: String(row.id),
    name: translateTeamName(participant.name),
    originalName: participant.name || '',
    code: participant.short_code || '',
    logo: participant.image_path || '',
    groupId,
    group: translateGroupName(row.group?.name),
    position: numberOrNull(row.position) || 0,
    points,
    played,
    won,
    drawn,
    lost,
    goalsFor,
    goalsAgainst,
    goalDifference,
    form: array(row.form),
  };
}

function sortStanding(a, b) {
  return a.position - b.position
    || b.points - a.points
    || b.goalDifference - a.goalDifference
    || b.goalsFor - a.goalsFor
    || a.name.localeCompare(b.name);
}

function mapStandingsToTables(rows) {
  const groups = new Map();
  array(rows).map(mapStandingRow).forEach((team) => {
    const id = team.groupId || 'OUTROS';
    if (!groups.has(id)) {
      groups.set(id, {
        id,
        name: team.group || (id === 'OUTROS' ? 'Outros' : `Grupo ${id}`),
        teams: [],
      });
    }
    groups.get(id).teams.push(team);
  });

  return [...groups.values()]
    .map((group) => ({ ...group, teams: group.teams.sort(sortStanding) }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

function mapSquadRow(row) {
  const player = row.player || {};
  const position = translatePosition(row.position?.name);
  const playerName = String(player.display_name || player.name || 'Jogador').trim();
  const fullName = String(player.name || player.display_name || 'Jogador').trim();
  return {
    id: String(player.id || row.player_id || row.id),
    squadId: String(row.id),
    playerId: player.id ? String(player.id) : String(row.player_id || ''),
    name: playerName || 'Jogador',
    fullName: fullName || playerName || 'Jogador',
    photo: player.image_path || '',
    jerseyNumber: numberOrNull(row.jersey_number),
    position,
    positionOrder: POSITION_ORDER[position] || 9,
  };
}

function compactEntity(value) {
  if (!value || typeof value !== 'object') return null;
  return {
    id: value.id ? String(value.id) : '',
    name: value.name || value.display_name || value.common_name || '',
    code: value.short_code || value.code || '',
    image: value.image_path || '',
  };
}

function mapTeamProfile(row) {
  if (!row || typeof row !== 'object') return null;
  const venue = row.venue || {};
  const coaches = array(row.coaches).map(compactEntity).filter(Boolean).slice(0, 5);
  const socials = array(row.socials).map((item) => ({
    id: item.id ? String(item.id) : '',
    type: item.type?.name || item.type || item.name || '',
    value: item.value || item.url || '',
  })).filter((item) => item.value).slice(0, 8);
  const rankings = array(row.rankings).map((item) => ({
    id: item.id ? String(item.id) : '',
    type: item.type?.name || item.type || '',
    position: numberOrNull(item.position),
    points: numberOrNull(item.points),
    publishedAt: item.published_at || item.updated_at || '',
  })).slice(0, 8);
  const trophies = array(row.trophies).map((item) => ({
    id: item.id ? String(item.id) : '',
    league: item.league?.name || item.name || '',
    season: item.season?.name || item.season_id || '',
    place: item.place || item.type || '',
  })).slice(0, 12);

  return {
    id: row.id ? String(row.id) : '',
    name: translateTeamName(row.name),
    originalName: row.name || '',
    code: row.short_code || '',
    logo: row.image_path || '',
    country: row.country?.name || '',
    countryCode: row.country?.iso2 || row.country?.iso3 || '',
    gender: row.gender || '',
    type: row.type || '',
    founded: row.founded || null,
    venue: venue.name ? {
      id: venue.id ? String(venue.id) : '',
      name: venue.name || '',
      city: venue.city_name || '',
      capacity: numberOrNull(venue.capacity),
      surface: venue.surface || '',
    } : null,
    coaches,
    socials,
    rankings,
    trophies,
  };
}

function mapLineupRow(row) {
  const player = row.player || {};
  const typeName = row.type?.name || row.type?.developer_name || row.type || '';
  const position = translatePosition(row.position?.name || row.position_name);
  const isStarter = Boolean(row.formation_position || /start|lineup|xi/i.test(String(typeName)));
  return {
    id: String(row.id || row.player_id || player.id || ''),
    teamId: row.team_id ? String(row.team_id) : '',
    playerId: player.id ? String(player.id) : String(row.player_id || ''),
    name: String(player.display_name || player.name || row.player_name || 'Jogador').trim(),
    photo: player.image_path || '',
    jerseyNumber: numberOrNull(row.jersey_number),
    position,
    formationPosition: row.formation_position || row.formation_field || '',
    type: typeName,
    isStarter,
    isBench: !isStarter,
  };
}

function mapFormation(row) {
  return {
    teamId: row.team_id ? String(row.team_id) : String(row.participant_id || ''),
    formation: row.formation || row.value || '',
    location: row.location || row.participant || '',
  };
}

function mapFixtureEvent(row) {
  const typeName = row.type?.name || row.type?.developer_name || row.type || '';
  const typeId = numberOrNull(row.type_id || row.type?.id);
  const minute = numberOrNull(row.minute);
  const extraMinute = numberOrNull(row.extra_minute);
  return {
    id: row.id ? String(row.id) : '',
    teamId: row.participant_id ? String(row.participant_id) : String(row.team_id || ''),
    typeId,
    type: typeName,
    minute,
    extraMinute,
    playerId: row.player_id ? String(row.player_id) : '',
    relatedPlayerId: row.related_player_id ? String(row.related_player_id) : '',
    player: String(row.player?.display_name || row.player?.name || row.player_name || '').trim(),
    relatedPlayer: String(row.relatedPlayer?.display_name || row.relatedPlayer?.name || row.related_player_name || '').trim(),
    isSubstitution: /substitution/i.test(String(typeName)) || /sub/i.test(String(row.addition || '')),
  };
}

function mapFixtureLineup(row) {
  return {
    id: row.id ? String(row.id) : '',
    status: mapStatus(row),
    stateLabel: row.state?.name || '',
    kickoff: kickoffIso(row.starting_at),
    venue: venueName(row.venue),
    formations: array(row.formations).map(mapFormation).filter((item) => item.formation),
    lineups: array(row.lineups)
      .map(mapLineupRow)
      .filter((item) => item.playerId || item.name),
    events: array(row.events)
      .map(mapFixtureEvent)
      .filter((item) => item.id || item.playerId || item.relatedPlayerId),
    sidelined: array(row.sidelined).map((item) => ({
      id: item.id ? String(item.id) : '',
      teamId: item.team_id ? String(item.team_id) : '',
      player: compactEntity(item.player),
      reason: item.sideline?.name || item.reason || '',
    })).slice(0, 20),
  };
}

function normalizeTopscorerMetric(typeId, typeName) {
  const id = Number(typeId);
  const name = String(typeName || '').toLowerCase();
  if ([52, 208].includes(id) || (name.includes('goal') && !name.includes('conceded'))) return 'goals';
  if ([79, 209].includes(id) || name.includes('assist')) return 'assists';
  if (id === 84 || name.includes('yellow')) return 'yellowCards';
  if (id === 83 || (name.includes('red') && !name.includes('yellow'))) return 'redCards';
  if (id === 210 || name.includes('card')) return 'cards';
  return 'other';
}

function mapTopscorerRow(row) {
  const player = row.player || {};
  const participant = row.participant || {};
  const type = row.type || {};
  const typeName = type.name || type.developer_name || '';
  const typeId = numberOrNull(row.type_id || type.id) || 0;
  const playerName = String(player.display_name || player.name || row.player_name || 'Jogador').trim();
  const teamName = String(translateTeamName(participant.name || row.participant_name || '')).trim();

  return {
    id: String(row.id || `${row.player_id || player.id || 'player'}-${typeId}`),
    playerId: player.id ? String(player.id) : String(row.player_id || ''),
    player: playerName || 'Jogador',
    playerPhoto: player.image_path || '',
    teamId: participant.id ? String(participant.id) : String(row.participant_id || ''),
    team: teamName || 'Selecao',
    teamCode: participant.short_code || participant.code || '',
    teamLogo: participant.image_path || '',
    typeId,
    type: typeName,
    metric: normalizeTopscorerMetric(typeId, typeName),
    total: numberOrNull(row.total) || 0,
    position: numberOrNull(row.position) || 0,
  };
}

async function getWorldCupMatches() {
  const cfg = config();
  const path = `fixtures/between/${cfg.startDate}/${cfg.endDate}`;
  const include = 'participants;scores;venue;state;league;round;stage;group';
  const filters = `fixtureLeagues:${cfg.leagueId}`;
  const matches = [];

  for (let page = 1; page <= 8; page += 1) {
    const response = await request(path, {
      include,
      filters,
      page,
    }, { ttlMs: DEFAULT_CACHE_TTL_MS });

    matches.push(...array(response.data).map(mapFixture));
    if (!response.pagination?.has_more) break;
  }

  return matches.sort((a, b) => {
    const aTime = new Date(a.kickoff || 0).getTime();
    const bTime = new Date(b.kickoff || 0).getTime();
    return aTime - bTime || String(a.id).localeCompare(String(b.id));
  });
}

async function getWorldCupStandings() {
  const cfg = config();
  const response = await request(`standings/seasons/${cfg.seasonId}`, {
    include: 'participant;group;details.type',
  }, { ttlMs: DEFAULT_CACHE_TTL_MS });
  return array(response.data);
}

async function getWorldCupTables() {
  const rows = await getWorldCupStandings();
  return mapStandingsToTables(rows);
}

async function getTeamSquad(teamId) {
  const cfg = config();
  const response = await request(`squads/seasons/${cfg.seasonId}/teams/${teamId}`, {
    include: 'player;position',
  }, { ttlMs: SQUAD_CACHE_TTL_MS });

  return array(response.data)
    .map(mapSquadRow)
    .sort((a, b) => (
      a.positionOrder - b.positionOrder
      || (a.jerseyNumber ?? 999) - (b.jerseyNumber ?? 999)
      || a.name.localeCompare(b.name)
    ));
}

async function getTeamProfile(teamId) {
  const includeAttempts = [
    'country;venue;coaches;socials;trophies',
    'country;venue;coaches;socials',
    'country;venue;coaches',
    'country;venue',
    '',
  ];
  let lastError = null;

  for (const include of includeAttempts) {
    try {
      const response = await request(`teams/${teamId}`, { include }, { ttlMs: PROFILE_CACHE_TTL_MS });
      return mapTeamProfile(response.data);
    } catch (err) {
      lastError = err;
      const message = String(err.message || '').toLowerCase();
      if (!message.includes('include') && !message.includes('access')) {
        throw err;
      }
    }
  }

  throw lastError;
}

async function getFixtureLineup(fixtureId) {
  const response = await request(`fixtures/${fixtureId}`, {
    include: 'participants;state;venue;formations;lineups.player;lineups.position;events.player;events.type;sidelined.sideline;sidelined.player',
  }, { ttlMs: LINEUP_CACHE_TTL_MS, timeoutMs: 4500 });
  return mapFixtureLineup(response.data || {});
}

async function getLiveScores() {
  const response = await request('livescores/inplay', {
    include: 'participants;scores;state;league',
  }, { ttlMs: LIVE_CACHE_TTL_MS });
  return array(response.data).filter((fixture) => String(fixture.league_id) === config().leagueId);
}

async function getWorldCupLiveMatches() {
  const fixtures = await getLiveScores();
  return fixtures
    .map(mapFixture)
    .sort((a, b) => {
      const aTime = new Date(a.kickoff || 0).getTime();
      const bTime = new Date(b.kickoff || 0).getTime();
      return aTime - bTime || String(a.id).localeCompare(String(b.id));
    });
}

async function getWorldCupTopscorers() {
  const cfg = config();
  const filters = ['208', '209', '84', '83'];
  const rows = [];

  for (const filter of filters) {
    for (let page = 1; page <= 4; page += 1) {
      const response = await request(`topscorers/seasons/${cfg.seasonId}`, {
        include: 'type;player;participant',
        filters: `seasonTopscorerTypes:${filter}`,
        per_page: 50,
        page,
      }, { ttlMs: TOPSCORERS_CACHE_TTL_MS });

      rows.push(...array(response.data));
      if (!response.pagination?.has_more) break;
    }
  }

  const unique = new Map();
  rows.map(mapTopscorerRow)
    .filter((row) => row.playerId || row.player)
    .forEach((row) => {
      unique.set(`${row.playerId || row.player}-${row.teamId || row.team}-${row.typeId}`, row);
    });

  return [...unique.values()];
}

module.exports = {
  getFixtureLineup,
  getLiveScores,
  getTeamProfile,
  getTeamSquad,
  getWorldCupLiveMatches,
  getWorldCupMatches,
  getWorldCupStandings,
  getWorldCupTables,
  getWorldCupTopscorers,
  isConfigured,
  mapStandingsToTables,
  translateTeamName,
};
