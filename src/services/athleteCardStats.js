// =====================================================================
// Liga Aberta F5 (pendência da F4) — números do CARD do atleta pelo ESPORTE
// ---------------------------------------------------------------------
// O card mostrava "GOLS" e "ASSIST." até para quem só joga beach tennis.
// Agora os rótulos seguem o esporte principal do atleta (o que ele mais jogou no
// histórico; sem jogo ainda, o esporte do rating):
//   raquete (tênis, beach tennis, padel, tênis de mesa) e vôlei:
//     Jogos · Vitórias · Aproveit. · Títulos · Torneios
//   futsal / futebol / handebol: Jogos · Vitórias · Gols · Assist. · Títulos · Torneios
//   basquete: Jogos · Vitórias · Pontos · Assist. · Títulos · Torneios
// Gols/pontos/assistências vêm da linha do ESPORTE principal (history.bySport) — no
// basquete o "gols" do histórico já é a soma dos pontos (PT1/PT2/PT3).
// Sem histórico nem rating: genérico (sem gols).
// =====================================================================

const RACKET = new Set(['TENNIS', 'BEACH_TENNIS', 'PADEL', 'TABLE_TENNIS', 'SQUASH', 'BADMINTON', 'PICKLEBALL']);
const GOAL_SPORTS = new Set(['FUTSAL', 'SOCCER', 'HANDBALL', 'SOCIETY']);

function familyOf(sport) {
  const s = String(sport || '').toUpperCase();
  if (!s) return 'generic';
  if (RACKET.has(s)) return 'racket';
  if (s === 'VOLLEY' || s === 'BEACH_VOLLEY') return 'racket'; // placar em sets, sem gol
  if (s === 'BASKETBALL') return 'basket';
  if (GOAL_SPORTS.has(s)) return 'goals';
  return 'generic';
}

/** Esporte principal: o mais jogado no histórico; senão o do rating. */
function mainSport(card) {
  const bs = card && card.history && Array.isArray(card.history.bySport) ? card.history.bySport.filter((r) => r && r.games > 0) : [];
  if (bs.length) return [...bs].sort((a, b) => b.games - a.games || String(a.sport).localeCompare(String(b.sport)))[0].sport;
  const r = card && Array.isArray(card.ratings) ? card.ratings[0] : null;
  return r ? r.sport : null;
}

/**
 * Células do card: [{ key, value, label }] na ordem de exibição.
 * card = engine.buildAthleteCard(...) (precisa de stats, history e ratings).
 */
function statCells(card) {
  const s = (card && card.stats) || {};
  const sport = mainSport(card);
  const fam = module.exports.familyOf(sport); // via exports (prova de sabotagem do teste)
  const row = (card && card.history && Array.isArray(card.history.bySport) ? card.history.bySport.find((r) => r.sport === sport) : null) || {};
  const games = s.matchesPlayed || 0;
  const wins = s.wins || 0;
  const base = [
    { key: 'games', value: games, label: 'Jogos' },
    { key: 'wins', value: wins, label: 'Vitórias' },
  ];
  const tail = [
    { key: 'titles', value: s.titles || 0, label: 'Títulos' },
    { key: 'tournaments', value: s.tournaments || 0, label: 'Torneios' },
  ];
  if (fam === 'goals') {
    return { sport, family: fam, cells: [...base, { key: 'goals', value: row.goals || 0, label: 'Gols' }, { key: 'assists', value: row.assists || 0, label: 'Assist.' }, ...tail] };
  }
  if (fam === 'basket') {
    return { sport, family: fam, cells: [...base, { key: 'points', value: row.goals || 0, label: 'Pontos' }, { key: 'assists', value: row.assists || 0, label: 'Assist.' }, ...tail] };
  }
  const rate = games ? Math.round((wins / games) * 100) : 0;
  return { sport, family: fam, cells: [...base, { key: 'winRate', value: `${rate}%`, label: 'Aproveit.' }, ...tail] };
}

module.exports = { familyOf, mainSport, statCells, RACKET };
