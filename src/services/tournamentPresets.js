// =====================================================================
// Liga Aberta F3 — MODELOS PRONTOS (presets) da criação em 2 minutos
// ---------------------------------------------------------------------
// Cada modelo preenche: formato, pontos (V/E/D), ordem de desempate, ida e
// volta, duração (períodos × minutos) e nº de jogadores. Tudo continua
// editável depois na categoria. Exposto em GET /api/tournaments/presets.
//
// Duração/jogadores: o modelo pode fixar (racha = 1 tempo de 10 min) ou deixar
// o padrão oficial do esporte (tournamentRules.SPORT_DEFAULTS).
// =====================================================================

const rules = require('./tournamentRules');

const TEAM_SPORTS = ['FUTSAL', 'SOCCER', 'VOLLEY', 'BASKETBALL', 'HANDBALL', 'OTHER'];
const RACKET_SPORTS = ['BEACH_TENNIS', 'TENNIS', 'PADEL', 'TABLE_TENNIS'];

const SPORT_LABEL = Object.freeze({
  FUTSAL: 'Futsal', SOCCER: 'Society', VOLLEY: 'Vôlei', BASKETBALL: 'Basquete', HANDBALL: 'Handebol',
  BEACH_TENNIS: 'Beach Tennis', TENNIS: 'Tênis', PADEL: 'Padel', TABLE_TENNIS: 'Tênis de Mesa', OTHER: 'Outro',
});

const FORMAT_LABEL = Object.freeze({
  KNOCKOUT: 'Mata-mata', ROUND_ROBIN: 'Pontos corridos', GROUPS: 'Fase de grupos', GROUPS_KNOCKOUT: 'Grupos + mata-mata',
  DOUBLE_ELIM: 'Dupla eliminação', SWISS: 'Sistema suíço', PICKUP: 'Racha',
});
// Formatos que o assistente aceita (Americano precisa de atletas individuais, não de times).
const QUICK_FORMATS = Object.freeze(['ROUND_ROBIN', 'GROUPS_KNOCKOUT', 'GROUPS', 'KNOCKOUT', 'DOUBLE_ELIM', 'SWISS', 'PICKUP']);

const PRESETS = Object.freeze([
  {
    id: 'racha-semanal',
    label: 'Racha semanal',
    description: 'Lista de presença do dia, sorteio de times equilibrado por nível, placar rápido e artilharia da temporada.',
    sports: TEAM_SPORTS,
    format: 'PICKUP',
    unit: 'players', // no passo 3 o organizador lista JOGADORES (não times)
    pointsWin: 3, pointsDraw: 1, pointsLoss: 0,
    tiebreakers: ['POINTS', 'GOAL_DIFF', 'GOALS_FOR'],
    doubleRound: false,
    duration: { periods: 1, minutesPerPeriod: 10 },
  },
  {
    id: 'liga-pontos-corridos',
    label: 'Liga de pontos corridos',
    description: 'Todos contra todos; campeão é quem soma mais pontos. Ida e volta pode ligar depois.',
    sports: TEAM_SPORTS,
    format: 'ROUND_ROBIN',
    unit: 'teams',
    pointsWin: 3, pointsDraw: 1, pointsLoss: 0,
    tiebreakers: ['POINTS', 'WINS', 'GOAL_DIFF', 'GOALS_FOR', 'HEAD_TO_HEAD', 'FAIR_PLAY', 'DRAW'],
    doubleRound: false,
    duration: null, // padrão oficial do esporte
  },
  {
    id: 'copa-grupos-mata-mata',
    label: 'Copa com grupos e mata-mata',
    description: 'Grupos de ~4 times; os 2 melhores de cada grupo vão para o mata-mata.',
    sports: TEAM_SPORTS,
    format: 'GROUPS_KNOCKOUT',
    unit: 'teams',
    pointsWin: 3, pointsDraw: 1, pointsLoss: 0,
    tiebreakers: ['POINTS', 'GOAL_DIFF', 'GOALS_FOR', 'HEAD_TO_HEAD', 'FAIR_PLAY', 'DRAW'],
    doubleRound: false,
    duration: null,
  },
  {
    id: 'torneio-um-dia',
    label: 'Torneio de um dia',
    description: 'Mata-mata direto com jogos curtos — começa e termina no mesmo dia.',
    sports: TEAM_SPORTS.concat(RACKET_SPORTS),
    format: 'KNOCKOUT',
    unit: 'teams',
    pointsWin: 3, pointsDraw: 1, pointsLoss: 0,
    tiebreakers: ['POINTS', 'GOAL_DIFF', 'GOALS_FOR'],
    doubleRound: false,
    duration: { periods: 1, minutesPerPeriod: 15 },
    durationSports: TEAM_SPORTS, // esporte de raquete não tem tempo de jogo
  },
  {
    id: 'ranking-duplas',
    label: 'Ranking de duplas (beach tennis/tênis)',
    description: 'Duplas fixas jogam todos contra todos; ranking por vitórias, confronto direto e games.',
    sports: RACKET_SPORTS,
    format: 'ROUND_ROBIN',
    unit: 'pairs',
    isDoubles: true,
    pointsWin: 3, pointsDraw: 0, pointsLoss: 0,
    tiebreakers: ['POINTS', 'WINS', 'HEAD_TO_HEAD', 'GOAL_DIFF', 'GOALS_FOR', 'DRAW'],
    doubleRound: false,
    duration: null,
    playersOnField: 2,
  },
]);

function presetById(id) {
  return PRESETS.find((p) => p.id === String(id || '')) || null;
}

// Configuração que o modelo aplica para um esporte: o que vai no torneio e na categoria.
function applyPreset(preset, sport) {
  const sp = String(sport || '').toUpperCase();
  const overrides = {};
  const durOk = preset.duration && (!preset.durationSports || preset.durationSports.includes(sp));
  if (durOk) Object.assign(overrides, preset.duration);
  if (preset.playersOnField) overrides.playersOnField = preset.playersOnField;
  return {
    format: preset.format,
    isDoubles: !!preset.isDoubles,
    unit: preset.unit,
    category: {
      pointsWin: preset.pointsWin,
      pointsDraw: preset.pointsDraw,
      pointsLoss: preset.pointsLoss,
      tiebreakers: preset.tiebreakers.slice(),
      doubleRound: !!preset.doubleRound,
      gameRules: rules.defaultsFor(sp, overrides),
    },
  };
}

// Sem modelo: só o formato escolhido + o padrão do motor e do esporte.
function plainConfig(format, sport) {
  return {
    format,
    isDoubles: false,
    unit: format === 'PICKUP' ? 'players' : 'teams',
    category: {
      pointsWin: 3, pointsDraw: 1, pointsLoss: 0,
      tiebreakers: null, // padrão do motor (pontos → saldo → marcados)
      doubleRound: false,
      gameRules: rules.defaultsFor(sport),
    },
  };
}

// Nome sugerido: "Liga de Futsal · Nov/2026" (mês em America/Fortaleza).
const MONTHS = ['Jan', 'Fev', 'Mar', 'Abr', 'Mai', 'Jun', 'Jul', 'Ago', 'Set', 'Out', 'Nov', 'Dez'];
function suggestName(sport, presetOrFormat, now = new Date()) {
  const l = new Date(now.getTime() - 3 * 3600 * 1000); // UTC-3 fixo
  const when = MONTHS[l.getUTCMonth()] + '/' + l.getUTCFullYear();
  const sp = SPORT_LABEL[String(sport || '').toUpperCase()] || 'Esporte';
  const p = typeof presetOrFormat === 'object' && presetOrFormat ? presetOrFormat : presetById(presetOrFormat);
  let kind;
  if (p && p.id === 'racha-semanal') kind = 'Racha';
  else if (p && p.id === 'copa-grupos-mata-mata') kind = 'Copa';
  else if (p && p.id === 'torneio-um-dia') kind = 'Torneio';
  else if (p && p.id === 'ranking-duplas') kind = 'Ranking de duplas';
  else {
    const f = p ? p.format : String(presetOrFormat || '');
    kind = f === 'PICKUP' ? 'Racha' : f === 'KNOCKOUT' || f === 'DOUBLE_ELIM' ? 'Torneio' : f === 'GROUPS_KNOCKOUT' || f === 'GROUPS' ? 'Copa' : 'Liga';
  }
  return `${kind} de ${sp} · ${when}`;
}

function publicList() {
  return PRESETS.map((p) => ({
    id: p.id, label: p.label, description: p.description, sports: p.sports, format: p.format,
    formatLabel: FORMAT_LABEL[p.format], unit: p.unit, isDoubles: !!p.isDoubles,
    pointsWin: p.pointsWin, pointsDraw: p.pointsDraw, pointsLoss: p.pointsLoss,
    tiebreakers: p.tiebreakers, doubleRound: !!p.doubleRound,
    duration: p.duration, playersOnField: p.playersOnField || null,
  }));
}

module.exports = {
  PRESETS, QUICK_FORMATS, SPORT_LABEL, FORMAT_LABEL, TEAM_SPORTS, RACKET_SPORTS,
  presetById, applyPreset, plainConfig, suggestName, publicList,
};
