// =====================================================================
// Liga Aberta F3 — REGRAS DO JOGO por categoria (TournamentCategory.gameRules)
// ---------------------------------------------------------------------
// Antes da F3 a súmula era fixa de futsal: eventos GOAL/ASSIST/YELLOW/RED/
// FOUL/TIMEOUT pra todo esporte, período 1 ou 2 e alerta na 6ª falta (fixo
// no front). Agora isso vem da regra da categoria.
//
// ⚠️ PROTEÇÃO DO QUE JÁ EXISTE: categoria SEM regra salva (gameRules nulo —
// todas as categorias criadas antes da F3, inclusive o II Futsal Master Cup)
// usa LEGACY_RULES = exatamente o comportamento antigo (mesmos eventos, mesmo
// alerta da 6ª falta, mesmo texto). Categoria nova recebe a regra padrão do
// esporte gravada (o organizador edita depois).
//
// Placar: soma do valor de cada evento que marca ponto (GOAL=1; basquete
// PT1/PT2/PT3 = 1/2/3; vôlei/raquete SET=1 → placar em sets).
// =====================================================================

// Catálogo de tipos de evento da súmula.
//  player: precisa de jogador (entra na estatística individual)
//  score:  quantos pontos soma no placar do time
const EVENT_CATALOG = Object.freeze({
  GOAL: { label: 'Gol', short: 'Gol', player: true, score: 1 },
  ASSIST: { label: 'Assistência', short: 'Assist.', player: true },
  YELLOW: { label: 'Cartão amarelo', short: 'Amarelo', player: true },
  RED: { label: 'Cartão vermelho', short: 'Vermelho', player: true },
  FOUL: { label: 'Falta', short: 'Falta', player: false },
  TIMEOUT: { label: 'Pedido de tempo', short: 'Tempo', player: false },
  POINT: { label: 'Ponto', short: 'Ponto', player: false },
  SET: { label: 'Set vencido', short: 'Set', player: false, score: 1 },
  PT1: { label: 'Lance livre (1 ponto)', short: '+1', player: true, score: 1 },
  PT2: { label: 'Cesta de 2 pontos', short: '+2', player: true, score: 2 },
  PT3: { label: 'Cesta de 3 pontos', short: '+3', player: true, score: 3 },
});
const EVENT_TYPES = Object.freeze(Object.keys(EVENT_CATALOG));

const FUTSAL_EVENTS = ['GOAL', 'ASSIST', 'YELLOW', 'RED', 'FOUL', 'TIMEOUT'];

// Comportamento antigo (antes da F3) — NÃO MUDAR: categorias sem regra salva dependem disto.
const LEGACY_RULES = Object.freeze({
  periods: 2,
  minutesPerPeriod: null,
  playersOnField: null,
  maxRoster: null,
  foulLimit: 6,
  foulText: 'tiro livre direto sem barreira',
  foulWarnText: 'a próxima é tiro livre direto',
  events: FUTSAL_EVENTS,
});

// Padrão de cada esporte para categoria NOVA (regra oficial de cada modalidade).
// Duração/jogadores ficam nulos quando a modalidade não tem um padrão único.
const SPORT_DEFAULTS = Object.freeze({
  FUTSAL: { periods: 2, minutesPerPeriod: 20, playersOnField: 5, foulLimit: 6, foulText: 'tiro livre direto sem barreira', foulWarnText: 'a próxima é tiro livre direto', events: FUTSAL_EVENTS },
  SOCCER: { periods: 2, minutesPerPeriod: null, playersOnField: null, foulLimit: null, events: FUTSAL_EVENTS },
  HANDBALL: { periods: 2, minutesPerPeriod: 30, playersOnField: 7, foulLimit: null, events: ['GOAL', 'ASSIST', 'YELLOW', 'RED', 'TIMEOUT'] },
  BASKETBALL: { periods: 4, minutesPerPeriod: 10, playersOnField: 5, foulLimit: 5, foulText: 'lances livres a cada nova falta no período (bônus)', foulWarnText: 'a próxima já dá lance livre', events: ['PT1', 'PT2', 'PT3', 'ASSIST', 'FOUL', 'TIMEOUT'] },
  VOLLEY: { periods: null, minutesPerPeriod: null, playersOnField: 6, foulLimit: null, events: ['POINT', 'SET', 'YELLOW', 'RED', 'TIMEOUT'] },
  BEACH_TENNIS: { periods: null, minutesPerPeriod: null, playersOnField: 2, foulLimit: null, events: ['POINT', 'SET'] },
  TENNIS: { periods: null, minutesPerPeriod: null, playersOnField: null, foulLimit: null, events: ['POINT', 'SET'] },
  PADEL: { periods: null, minutesPerPeriod: null, playersOnField: 2, foulLimit: null, events: ['POINT', 'SET'] },
  TABLE_TENNIS: { periods: null, minutesPerPeriod: null, playersOnField: null, foulLimit: null, events: ['POINT', 'SET'] },
  OTHER: { periods: 2, minutesPerPeriod: null, playersOnField: null, foulLimit: null, events: FUTSAL_EVENTS },
});

class RulesError extends Error { constructor(msg) { super(msg); this.status = 400; } }

function intOrNull(v, min, max, label) {
  if (v === undefined) return undefined;
  if (v === null || v === '') return null;
  const n = Number(v);
  if (!Number.isFinite(n) || Math.round(n) !== n || n < min || n > max) throw new RulesError(`${label} inválido (${min} a ${max})`);
  return n;
}
function textOrNull(v, label) {
  if (v === undefined) return undefined;
  if (v === null || v === '') return null;
  if (typeof v !== 'string') throw new RulesError(label + ' inválido');
  return v.trim().slice(0, 120) || null;
}

// Valida/normaliza o que veio do organizador. Só copia campos presentes.
// Retorna { data } ou { error }.
function normalizeGameRules(input) {
  if (input === null) return { data: null };
  if (!input || typeof input !== 'object' || Array.isArray(input)) return { error: 'regras do jogo inválidas' };
  try {
    const out = {};
    const set = (k, v) => { if (v !== undefined) out[k] = v; };
    set('periods', intOrNull(input.periods, 1, 8, 'número de períodos'));
    set('minutesPerPeriod', intOrNull(input.minutesPerPeriod, 1, 120, 'minutos por período'));
    set('playersOnField', intOrNull(input.playersOnField, 1, 30, 'jogadores em campo'));
    set('maxRoster', intOrNull(input.maxRoster, 1, 60, 'limite do elenco'));
    set('foulLimit', intOrNull(input.foulLimit, 1, 20, 'limite de faltas'));
    set('foulText', textOrNull(input.foulText, 'texto da falta'));
    set('foulWarnText', textOrNull(input.foulWarnText, 'texto do aviso de falta'));
    if (input.events !== undefined) {
      if (!Array.isArray(input.events) || !input.events.length) throw new RulesError('escolha ao menos um tipo de evento da súmula');
      const ev = [];
      for (const raw of input.events) {
        const k = String(raw || '').toUpperCase();
        if (!EVENT_CATALOG[k]) throw new RulesError('tipo de evento inválido: ' + String(raw).slice(0, 20));
        if (!ev.includes(k)) ev.push(k);
      }
      if (!ev.some((k) => EVENT_CATALOG[k].score)) throw new RulesError('inclua ao menos um tipo de evento que marque ponto (gol, cesta ou set)');
      out.events = ev;
    }
    return { data: out };
  } catch (e) {
    if (e instanceof RulesError) return { error: e.message };
    throw e;
  }
}

function sportDefaults(sport) {
  return SPORT_DEFAULTS[String(sport || '').toUpperCase()] || SPORT_DEFAULTS.OTHER;
}

// Regra completa a GRAVAR numa categoria nova: padrão do esporte + o que veio.
function defaultsFor(sport, overrides = {}) {
  const d = sportDefaults(sport);
  const base = {
    periods: d.periods ?? null,
    minutesPerPeriod: d.minutesPerPeriod ?? null,
    playersOnField: d.playersOnField ?? null,
    maxRoster: null,
    foulLimit: d.foulLimit ?? null,
    foulText: d.foulText || null,
    foulWarnText: d.foulWarnText || null,
    events: d.events.slice(),
  };
  return { ...base, ...(overrides || {}) };
}

function parseStored(v) {
  let x = v;
  if (typeof x === 'string') { try { x = JSON.parse(x); } catch (_) { x = null; } }
  return x && typeof x === 'object' && !Array.isArray(x) ? x : null;
}

// Regra EFETIVA de uma categoria (o que a súmula e a tela usam).
// category: { gameRules } (pode ser null); sport: esporte do torneio.
function resolveRules(category, sport) {
  const saved = parseStored(category && category.gameRules);
  const base = saved ? defaultsFor(sport) : { ...LEGACY_RULES, events: LEGACY_RULES.events.slice() };
  const r = saved ? { ...base, ...saved } : base;
  const events = (Array.isArray(r.events) && r.events.length ? r.events : base.events).filter((k) => EVENT_CATALOG[k]);
  const scoring = {};
  const labels = {};
  events.forEach((k) => { labels[k] = EVENT_CATALOG[k].label; if (EVENT_CATALOG[k].score) scoring[k] = EVENT_CATALOG[k].score; });
  return {
    source: saved ? 'category' : 'legacy',
    periods: r.periods ?? null,
    minutesPerPeriod: r.minutesPerPeriod ?? null,
    playersOnField: r.playersOnField ?? null,
    maxRoster: r.maxRoster ?? null,
    foulLimit: r.foulLimit ?? null,
    foulText: r.foulText || null,
    foulWarnText: r.foulWarnText || null,
    events,
    playerEvents: events.filter((k) => EVENT_CATALOG[k].player),
    teamEvents: events.filter((k) => !EVENT_CATALOG[k].player),
    scoring,
    labels,
  };
}

// Placar a partir dos eventos (lista com entryId/type).
function scoreFromEvents(events, rules, homeEntryId, awayEntryId) {
  const sc = (rules && rules.scoring) || { GOAL: 1 };
  let home = 0;
  let away = 0;
  for (const e of events || []) {
    const v = sc[e.type];
    if (!v) continue;
    if (e.entryId === homeEntryId) home += v;
    else if (e.entryId === awayEntryId) away += v;
  }
  return { home, away };
}

// Regra do jogo (categoria + esporte do torneio) a partir do id do jogo.
async function rulesForMatch(db, matchId) {
  // uma consulta só (categoria + esporte do torneio)
  const m = await db.tournamentMatch.findUnique({
    where: { id: String(matchId) },
    select: { category: { select: { gameRules: true } }, tournament: { select: { sport: true } } },
  });
  if (!m) return resolveRules(null, null);
  return resolveRules(m.category, m.tournament && m.tournament.sport);
}

// Todos os tipos que marcam ponto em algum esporte (pra placar ao vivo genérico).
const SCORE_VALUES = Object.freeze(Object.fromEntries(EVENT_TYPES.filter((k) => EVENT_CATALOG[k].score).map((k) => [k, EVENT_CATALOG[k].score])));

module.exports = {
  EVENT_CATALOG, EVENT_TYPES, FUTSAL_EVENTS, LEGACY_RULES, SPORT_DEFAULTS, SCORE_VALUES,
  normalizeGameRules, defaultsFor, sportDefaults, resolveRules, scoreFromEvents, rulesForMatch,
};
