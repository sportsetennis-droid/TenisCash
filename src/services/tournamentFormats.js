'use strict';
// =====================================================================
// APEX — Motor de campeonato: funções PURAS (sem banco)
// ---------------------------------------------------------------------
// Tudo aqui é determinístico e testável sem Postgres:
//  • critérios de desempate configuráveis (inclui confronto direto com
//    mini-tabela entre os empatados, fair play e sorteio com semente)
//  • ida e volta (pontos corridos / grupos)
//  • dupla eliminação (chave dos vencedores + perdedores + grande final
//    com "reset" opcional) — com byes resolvidos na geração
//  • sistema suíço (pareamento por pontuação sem repetir confronto, bye)
//  • Americano / Super 8 / Super 12 (parceiros rotativos, ranking
//    individual por games)
//  • suspensão automática (amarelos acumulados / vermelho)
//  • campeão de uma categoria (histórico de séries)
// O tournamentEngine.js faz a parte de banco e chama estas funções.
// =====================================================================

const crypto = require('crypto');

// ---------------------------------------------------------------------
// Critérios de desempate
// ---------------------------------------------------------------------

const TIEBREAK_KEYS = [
  'POINTS', // pontos
  'WINS', // vitórias
  'GOAL_DIFF', // saldo (gols/sets/games)
  'GOALS_FOR', // gols/sets/games pró
  'HEAD_TO_HEAD', // confronto direto (mini-tabela entre os empatados)
  'GOALS_AGAINST', // menos gols sofridos
  'FAIR_PLAY', // menos pontos de cartão (amarelo=1, vermelho=3)
  'BUCHHOLZ', // soma dos pontos dos adversários (suíço)
  'DRAW', // sorteio (determinístico, semente registrada)
];

const TIEBREAK_LABELS = {
  POINTS: 'Pontos',
  WINS: 'Vitórias',
  GOAL_DIFF: 'Saldo',
  GOALS_FOR: 'Gols/sets pró',
  HEAD_TO_HEAD: 'Confronto direto',
  GOALS_AGAINST: 'Menos gols sofridos',
  FAIR_PLAY: 'Fair play (cartões)',
  BUCHHOLZ: 'Buchholz (força dos adversários)',
  DRAW: 'Sorteio',
};

// Padrão = comportamento histórico do motor (pontos → saldo → marcados).
// NÃO mudar: as classificações já publicadas dependem disso.
const DEFAULT_TIEBREAKERS = ['POINTS', 'GOAL_DIFF', 'GOALS_FOR'];
// Americano: POINTS = games pró (ranking individual por games).
const AMERICANO_TIEBREAKERS = ['POINTS', 'GOAL_DIFF', 'WINS', 'DRAW'];

const CARD_POINTS = { YELLOW: 1, RED: 3 };

function normalizeTiebreakers(list, fallback = DEFAULT_TIEBREAKERS) {
  let arr = list;
  if (typeof arr === 'string') {
    try {
      arr = JSON.parse(arr);
    } catch (_) {
      arr = arr.split(',');
    }
  }
  if (!Array.isArray(arr)) return fallback.slice();
  const out = [];
  for (const raw of arr) {
    const k = String(raw || '').trim().toUpperCase();
    if (TIEBREAK_KEYS.includes(k) && !out.includes(k)) out.push(k);
  }
  return out.length ? out : fallback.slice();
}

// Valor do sorteio: hash da semente + id. Mesma semente = mesma ordem
// (auditável: qualquer um refaz o cálculo com a semente publicada).
function drawValue(seed, entryId) {
  const h = crypto.createHash('sha256').update(String(seed || '') + ':' + String(entryId)).digest('hex');
  return parseInt(h.slice(0, 12), 16);
}

function newSeed() {
  return crypto.randomBytes(8).toString('hex');
}

function cmpTuple(a, b) {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    if (x !== y) return y - x; // desc
  }
  return 0;
}

// Agrupa linhas por valor (tupla), em ordem decrescente; estável dentro do grupo.
function bucketBy(rows, keyFn) {
  const keyed = rows.map((r) => ({ r, k: [].concat(keyFn(r)) }));
  const distinct = [];
  for (const x of keyed) if (!distinct.some((d) => cmpTuple(d, x.k) === 0)) distinct.push(x.k);
  distinct.sort(cmpTuple);
  return distinct.map((d) => keyed.filter((x) => cmpTuple(x.k, d) === 0).map((x) => x.r));
}

// Mini-tabela entre um subconjunto de times (confronto direto).
function miniTable(ids, matches, points) {
  const t = {};
  for (const id of ids) t[id] = { pts: 0, gd: 0, gf: 0 };
  for (const m of matches || []) {
    if (!ids.has(m.homeEntryId) || !ids.has(m.awayEntryId)) continue;
    const hs = Number(m.homeScore) || 0;
    const as = Number(m.awayScore) || 0;
    const h = t[m.homeEntryId];
    const a = t[m.awayEntryId];
    h.gf += hs;
    a.gf += as;
    h.gd += hs - as;
    a.gd += as - hs;
    if (m.winnerEntryId === m.homeEntryId) {
      h.pts += points.win;
      a.pts += points.loss;
    } else if (m.winnerEntryId === m.awayEntryId) {
      a.pts += points.win;
      h.pts += points.loss;
    } else {
      h.pts += points.draw;
      a.pts += points.draw;
    }
  }
  return t;
}

function criterionValue(c, r, ctx) {
  switch (c) {
    case 'POINTS':
      return r.points || 0;
    case 'WINS':
      return r.won || 0;
    case 'GOAL_DIFF':
      return (r.scoreFor || 0) - (r.scoreAgainst || 0);
    case 'GOALS_FOR':
      return r.scoreFor || 0;
    case 'GOALS_AGAINST':
      return -(r.scoreAgainst || 0);
    case 'FAIR_PLAY':
      return -(r.fairPlay || 0);
    case 'BUCHHOLZ':
      return r.buchholz || 0;
    case 'DRAW':
      return drawValue(ctx.seed, r.entryId);
    default:
      return 0;
  }
}

function rankGroup(rows, criteria, ctx) {
  if (rows.length <= 1 || !criteria.length) return rows;
  const [c, ...rest] = criteria;
  let buckets;
  if (c === 'HEAD_TO_HEAD') {
    const ids = new Set(rows.map((r) => r.entryId));
    const mini = miniTable(ids, ctx.matches, ctx.points);
    buckets = bucketBy(rows, (r) => [mini[r.entryId].pts, mini[r.entryId].gd, mini[r.entryId].gf]);
    if (buckets.length === 1) return rankGroup(rows, rest, ctx);
    const out = [];
    for (const b of buckets) {
      if (b.length === 1) {
        b[0].decidedBy = b[0].decidedBy || c;
        out.push(b[0]);
      } else {
        // subconjunto menor: o confronto direto é recalculado só entre eles
        out.push(...rankGroup(b, criteria, ctx));
      }
    }
    return out;
  }
  buckets = bucketBy(rows, (r) => criterionValue(c, r, ctx));
  if (buckets.length === 1) return rankGroup(rows, rest, ctx);
  const out = [];
  for (const b of buckets) {
    if (b.length === 1) {
      b[0].decidedBy = b[0].decidedBy || c;
      out.push(b[0]);
    } else out.push(...rankGroup(b, rest, ctx));
  }
  return out;
}

/**
 * Ordena uma tabela (um grupo) pelos critérios.
 * rows: [{ entryId, points, won, scoreFor, scoreAgainst, fairPlay?, buchholz? }]
 * opts: { criteria, matches (encerrados, p/ confronto direto), points:{win,draw,loss}, seed }
 * Retorna NOVAS linhas ordenadas com rank (1..n) e decidedBy (critério que
 * separou a linha; null = empate total, mantém a ordem de entrada).
 */
function rankTable(rows, opts = {}) {
  const criteria = normalizeTiebreakers(opts.criteria);
  const ctx = {
    matches: opts.matches || [],
    points: opts.points || { win: 3, draw: 1, loss: 0 },
    seed: opts.seed || '',
  };
  const copy = rows.map((r) => ({ ...r, decidedBy: null }));
  const ranked = rankGroup(copy, criteria, ctx);
  ranked.forEach((r, i) => {
    r.rank = i + 1;
  });
  return ranked;
}

// Contabiliza a tabela de liga/grupo/suíço a partir das partidas encerradas.
// Bye do suíço (um lado vazio + vencedor) = vitória sem gols.
function tallyTable(entries, matches, points, opts = {}) {
  const table = {};
  for (const e of entries) {
    table[e.id] = {
      entryId: e.id,
      groupName: e.groupName || null,
      played: 0,
      won: 0,
      drawn: 0,
      lost: 0,
      scoreFor: 0,
      scoreAgainst: 0,
      points: 0,
      fairPlay: (opts.fairPlay && opts.fairPlay[e.id]) || 0,
      buchholz: 0,
    };
  }
  const opponents = {};
  for (const m of matches) {
    // bye (suíço): só um lado e vencedor definido
    if ((!m.homeEntryId || !m.awayEntryId) && m.winnerEntryId && table[m.winnerEntryId]) {
      const w = table[m.winnerEntryId];
      w.played++;
      w.won++;
      w.points += points.win;
      continue;
    }
    const h = table[m.homeEntryId];
    const a = table[m.awayEntryId];
    if (!h || !a) continue;
    const hs = m.homeScore ?? 0;
    const as = m.awayScore ?? 0;
    h.played++;
    a.played++;
    h.scoreFor += hs;
    h.scoreAgainst += as;
    a.scoreFor += as;
    a.scoreAgainst += hs;
    (opponents[h.entryId] ||= []).push(a.entryId);
    (opponents[a.entryId] ||= []).push(h.entryId);
    if (m.winnerEntryId === m.homeEntryId) {
      h.won++;
      a.lost++;
      h.points += points.win;
      a.points += points.loss;
    } else if (m.winnerEntryId === m.awayEntryId) {
      a.won++;
      h.lost++;
      a.points += points.win;
      h.points += points.loss;
    } else {
      h.drawn++;
      a.drawn++;
      h.points += points.draw;
      a.points += points.draw;
    }
  }
  for (const r of Object.values(table)) {
    r.buchholz = (opponents[r.entryId] || []).reduce((s, id) => s + (table[id] ? table[id].points : 0), 0);
  }
  return table;
}

// Pontos de cartão por time a partir dos eventos (amarelo=1, vermelho=3).
function fairPlayByEntry(events) {
  const out = {};
  for (const e of events || []) {
    const p = CARD_POINTS[e.type];
    if (!p || !e.entryId) continue;
    out[e.entryId] = (out[e.entryId] || 0) + p;
  }
  return out;
}

// ---------------------------------------------------------------------
// Pontos corridos: método do círculo + ida e volta
// ---------------------------------------------------------------------

// Igual ao roundRobinRounds do engine, mas trabalha com ids (string).
function circleRounds(ids) {
  const list = [...ids];
  if (list.length % 2 === 1) list.push(null);
  const n = list.length;
  const rounds = [];
  const fixed = list[0];
  let rotating = list.slice(1);
  for (let r = 0; r < n - 1; r++) {
    const arr = [fixed, ...rotating];
    const pairs = [];
    for (let i = 0; i < n / 2; i++) {
      const home = arr[i];
      const away = arr[n - 1 - i];
      if (home != null && away != null) pairs.push([home, away]);
    }
    rounds.push(pairs);
    rotating = [rotating[rotating.length - 1], ...rotating.slice(0, rotating.length - 1)];
  }
  return rounds;
}

// Ida e volta: o returno repete as rodadas com mando invertido.
function withReturnLeg(rounds) {
  return rounds.concat(rounds.map((pairs) => pairs.map(([h, a]) => [a, h])));
}

// ---------------------------------------------------------------------
// Dupla eliminação
// ---------------------------------------------------------------------

function nextPow2(n) {
  let p = 1;
  while (p < n) p <<= 1;
  return p;
}

function seedSlots(size) {
  let seeds = [1, 2];
  if (size < 2) return [1];
  while (seeds.length < size) {
    const n = seeds.length * 2;
    const next = [];
    for (const s of seeds) {
      next.push(s);
      next.push(n + 1 - s);
    }
    seeds = next;
  }
  return seeds;
}

/**
 * Plano da dupla eliminação para n inscritos (seed 1..n).
 * Retorna { matches:[{ key, bracket:'W'|'L'|'GF'|'GF2', round, ordering,
 *   home:{type:'seed',seed}|{type:'W'|'L',key}, away:..., winnerTo:{key,slot}|null,
 *   loserTo:{key,slot}|null }], wbRounds, lbRounds }
 * Byes são resolvidos na geração (partida com um lado impossível some e o
 * classificado vai direto pro próximo jogo) — nada de jogo "fantasma".
 */
function doubleElimPlan(n, opts = {}) {
  if (n < 2) throw new Error('mínimo 2 inscritos');
  const P = nextPow2(n);
  const k = Math.log2(P);
  const slots = seedSlots(P);
  const raw = []; // matches com fontes cruas
  const add = (m) => {
    raw.push(m);
    return m;
  };

  // Chave dos vencedores (WB)
  const wb = {};
  for (let r = 1; r <= k; r++) {
    wb[r] = [];
    const cnt = P / 2 ** r;
    for (let m = 0; m < cnt; m++) {
      const home = r === 1 ? { type: 'seed', seed: slots[2 * m] } : { type: 'W', key: wb[r - 1][2 * m].key };
      const away = r === 1 ? { type: 'seed', seed: slots[2 * m + 1] } : { type: 'W', key: wb[r - 1][2 * m + 1].key };
      wb[r].push(add({ key: `W${r}-${m}`, bracket: 'W', round: r, ordering: m, home, away }));
    }
  }

  // Chave dos perdedores (LB): 2(k-1) rodadas
  const lb = {};
  const lbRounds = Math.max(0, 2 * (k - 1));
  for (let lr = 1; lr <= lbRounds; lr++) {
    lb[lr] = [];
    if (lr === 1) {
      const cnt = P / 4;
      for (let m = 0; m < cnt; m++) {
        lb[lr].push(
          add({
            key: `L1-${m}`,
            bracket: 'L',
            round: 1,
            ordering: m,
            home: { type: 'L', key: wb[1][2 * m].key },
            away: { type: 'L', key: wb[1][2 * m + 1].key },
          })
        );
      }
    } else if (lr % 2 === 0) {
      // perdedores da WB rodada (lr/2 + 1) entram contra os vencedores da LB anterior
      const j = lr / 2;
      const wbr = wb[j + 1];
      const prev = lb[lr - 1];
      const cnt = prev.length;
      for (let m = 0; m < cnt; m++) {
        // inverte a ordem em rodadas alternadas pra evitar revanche imediata
        const src = j % 2 === 1 ? wbr[cnt - 1 - m] : wbr[m];
        lb[lr].push(
          add({
            key: `L${lr}-${m}`,
            bracket: 'L',
            round: lr,
            ordering: m,
            home: { type: 'W', key: prev[m].key },
            away: { type: 'L', key: src.key },
          })
        );
      }
    } else {
      const prev = lb[lr - 1];
      const cnt = prev.length / 2;
      for (let m = 0; m < cnt; m++) {
        lb[lr].push(
          add({
            key: `L${lr}-${m}`,
            bracket: 'L',
            round: lr,
            ordering: m,
            home: { type: 'W', key: prev[2 * m].key },
            away: { type: 'W', key: prev[2 * m + 1].key },
          })
        );
      }
    }
  }

  const wbFinal = wb[k][0];
  const lbChampSrc = lbRounds ? { type: 'W', key: lb[lbRounds][0].key } : { type: 'L', key: wbFinal.key };
  const gf = add({
    key: 'GF',
    bracket: 'GF',
    round: 1,
    ordering: 0,
    home: { type: 'W', key: wbFinal.key },
    away: lbChampSrc,
  });

  // --- byes: fontes mortas e partidas que somem ---
  const byKey = Object.fromEntries(raw.map((m) => [m.key, m]));
  const state = {}; // key -> 'real' | 'bye' | 'void'
  const dead = (src) => {
    if (src.type === 'seed') return src.seed > n;
    const st = state[src.key];
    if (src.type === 'W') return st === 'void';
    return st === 'bye' || st === 'void'; // 'L': bye/void não tem perdedor
  };
  for (const m of raw) {
    const dh = dead(m.home);
    const da = dead(m.away);
    state[m.key] = dh && da ? 'void' : dh || da ? 'bye' : 'real';
  }
  const resolve = (src) => {
    if (src.type === 'W' && state[src.key] === 'bye') {
      const m = byKey[src.key];
      return resolve(dead(m.home) ? m.away : m.home);
    }
    return src;
  };

  const real = raw.filter((m) => state[m.key] === 'real').map((m) => ({
    key: m.key,
    bracket: m.bracket,
    round: m.round,
    ordering: m.ordering,
    home: resolve(m.home),
    away: resolve(m.away),
    winnerTo: null,
    loserTo: null,
  }));
  const realByKey = Object.fromEntries(real.map((m) => [m.key, m]));
  for (const m of real) {
    for (const slot of ['home', 'away']) {
      const src = m[slot];
      if (src.type === 'W' && realByKey[src.key]) realByKey[src.key].winnerTo = { key: m.key, slot };
      if (src.type === 'L' && realByKey[src.key]) realByKey[src.key].loserTo = { key: m.key, slot };
    }
  }
  // Renumera ordering dentro de cada (bracket, round) depois de remover os byes
  const groups = {};
  for (const m of real) (groups[m.bracket + m.round] ||= []).push(m);
  for (const arr of Object.values(groups)) arr.sort((a, b) => a.ordering - b.ordering).forEach((m, i) => (m.ordering = i));

  if (opts.reset !== false) {
    real.push({
      key: 'GF2',
      bracket: 'GF2',
      round: 1,
      ordering: 0,
      home: { type: 'GF', slot: 'home' },
      away: { type: 'GF', slot: 'away' },
      winnerTo: null,
      loserTo: null,
    });
  }
  void gf;
  return { matches: real, wbRounds: k, lbRounds, bracketSize: P };
}

// ---------------------------------------------------------------------
// Sistema suíço
// ---------------------------------------------------------------------

const pairKey = (a, b) => (a < b ? `${a}|${b}` : `${b}|${a}`);

function suggestedSwissRounds(n) {
  return Math.max(1, Math.ceil(Math.log2(Math.max(2, n))));
}

// 1ª rodada: metade de cima × metade de baixo (1×(n/2+1), 2×(n/2+2)...).
function swissFirstRound(ids) {
  const list = [...ids];
  let bye = null;
  if (list.length % 2 === 1) bye = list.pop();
  const half = list.length / 2;
  const pairs = [];
  for (let i = 0; i < half; i++) pairs.push([list[i], list[i + half]]);
  return { pairs, bye };
}

/**
 * Pareamento suíço de uma rodada.
 * ranked: ids em ordem de classificação (melhor primeiro).
 * played: Set de pairKey já jogados. byes: Set de ids que já tiveram bye.
 * Retorna { pairs:[[a,b]], bye, repeats } — repeats>0 só se for impossível evitar.
 */
function swissPair(ranked, played = new Set(), byes = new Set()) {
  let steps = 0;
  const LIMIT = 200000;
  const bt = (arr) => {
    if (!arr.length) return [];
    if (++steps > LIMIT) return null;
    const a = arr[0];
    for (let j = 1; j < arr.length; j++) {
      const b = arr[j];
      if (played.has(pairKey(a, b))) continue;
      const rest = arr.slice(1, j).concat(arr.slice(j + 1));
      const sub = bt(rest);
      if (sub) return [[a, b], ...sub];
    }
    return null;
  };
  const list = [...ranked];
  if (list.length % 2 === 0) {
    const pairs = bt(list);
    if (pairs) return { pairs, bye: null, repeats: 0 };
    return fallbackPairs(list, null, played);
  }
  // Ímpar: candidatos a folga = de baixo pra cima, primeiro quem nunca folgou.
  // Escolhe o 1º candidato que permite parear o resto SEM repetir confronto.
  const order = [...list].reverse();
  const candidates = order.filter((x) => !byes.has(x)).concat(order.filter((x) => byes.has(x)));
  for (const bye of candidates) {
    const rest = list.filter((x) => x !== bye);
    const pairs = bt(rest);
    if (pairs) return { pairs, bye, repeats: 0 };
  }
  const bye = candidates[0];
  return fallbackPairs(list.filter((x) => x !== bye), bye, played);
}

function fallbackPairs(list, bye, played) {
  const pairs = [];
  let repeats = 0;
  for (let i = 0; i < list.length; i += 2) {
    pairs.push([list[i], list[i + 1]]);
    if (played.has(pairKey(list[i], list[i + 1]))) repeats++;
  }
  return { pairs, bye, repeats };
}

// ---------------------------------------------------------------------
// Americano / Super 8 / Super 12 (parceiros rotativos)
// ---------------------------------------------------------------------

// Todas as formas de casar `items` (qtd par) em duplas.
function perfectMatchings(items) {
  if (!items.length) return [[]];
  const [a, ...rest] = items;
  const out = [];
  for (let i = 0; i < rest.length; i++) {
    const b = rest[i];
    const remaining = rest.slice(0, i).concat(rest.slice(i + 1));
    for (const sub of perfectMatchings(remaining)) out.push([[a, b], ...sub]);
  }
  return out;
}

/**
 * Torneio "whist" cíclico (Z_{n-1} ∪ {∞}): acha UMA rodada-base e gira ela
 * n-1 vezes. Garante: cada atleta joga com cada outro EXATAMENTE 1 vez como
 * parceiro e o enfrenta EXATAMENTE 2 vezes. Retorna as mesas da base em índices
 * (-1 = ∞, 0..n-2) ou null se não achar dentro do limite.
 */
const WHIST_CACHE = {};
function whistBase(n, LIMIT = 400000) {
  if (n in WHIST_CACHE) return WHIST_CACHE[n];
  const q = n - 1;
  const INF = -1;
  const half = (q - 1) / 2;
  const diff = (x, y) => {
    const d = (((x - y) % q) + q) % q;
    return Math.min(d, q - d);
  };
  const pc = new Array(half + 1).fill(0);
  const oc = new Array(half + 1).fill(0);
  let infPartner = 0;
  let infOpp = 0;
  let steps = 0;
  const used = new Set();
  const tables = [];
  const pts = [INF];
  for (let i = 0; i < q; i++) pts.push(i);
  // dir=+1 tenta ocupar (falha se estourar), dir=-1 devolve
  const partner = (x, y, dir) => {
    if (x === INF || y === INF) {
      if (dir > 0 && infPartner >= 1) return false;
      infPartner += dir;
      return true;
    }
    const d = diff(x, y);
    if (dir > 0 && pc[d] >= 1) return false;
    pc[d] += dir;
    return true;
  };
  const opp = (x, y, dir) => {
    if (x === INF || y === INF) {
      if (dir > 0 && infOpp >= 2) return false;
      infOpp += dir;
      return true;
    }
    const d = diff(x, y);
    if (dir > 0 && oc[d] >= 2) return false;
    oc[d] += dir;
    return true;
  };
  const dfs = () => {
    if (++steps > LIMIT) return false;
    const free = pts.filter((p) => !used.has(p));
    if (!free.length) return true;
    const a = free[0];
    for (let i = 1; i < free.length; i++) {
      const b = free[i];
      if (!partner(a, b, 1)) continue;
      for (let j = 1; j < free.length; j++) {
        if (j === i) continue;
        const c = free[j];
        for (let k = j + 1; k < free.length; k++) {
          if (k === i) continue;
          const d = free[k];
          if (!partner(c, d, 1)) continue;
          const done = [];
          let good = true;
          for (const [x, y] of [[a, c], [a, d], [b, c], [b, d]]) {
            if (opp(x, y, 1)) done.push([x, y]);
            else {
              good = false;
              break;
            }
          }
          if (good) {
            [a, b, c, d].forEach((x) => used.add(x));
            tables.push([[a, b], [c, d]]);
            if (dfs()) return true;
            tables.pop();
            [a, b, c, d].forEach((x) => used.delete(x));
          }
          for (const [x, y] of done) opp(x, y, -1);
          partner(c, d, -1);
        }
      }
      partner(a, b, -1);
    }
    return false;
  };
  WHIST_CACHE[n] = dfs() ? tables.map((t) => t.map((p) => p.slice())) : null;
  return WHIST_CACHE[n];
}

/**
 * Tabela do Americano: n atletas (múltiplo de 4). n-1 rodadas; em cada uma
 * todos jogam, com parceiro novo (cada atleta joga UMA vez com cada outro).
 * Preferência: torneio "whist" (cada adversário exatamente 2x). Se não achar
 * (n muito grande), cai no método do círculo com confrontos equilibrados.
 * Retorna [{ round, matches:[{ home:[a,b], away:[c,d] }] }].
 */
function americanoSchedule(ids) {
  const n = ids.length;
  if (n < 4 || n % 4 !== 0) throw new Error('Americano precisa de nº de atletas múltiplo de 4 (4, 8, 12, 16...)');
  const base = n <= 32 ? whistBase(n) : null;
  if (base) {
    const q = n - 1;
    const map = (x, r) => (x === -1 ? ids[0] : ids[1 + ((x + r) % q)]);
    const rounds = [];
    for (let r = 0; r < q; r++) {
      rounds.push({
        round: r + 1,
        matches: base.map(([p, w]) => ({ home: [map(p[0], r), map(p[1], r)], away: [map(w[0], r), map(w[1], r)] })),
      });
    }
    return rounds;
  }
  const partnerRounds = circleRounds(ids);
  // Opções de confronto de cada rodada (casar as duplas da rodada em jogos).
  const options = partnerRounds.map((pairs) => {
    if (pairs.length > 12) {
      const seq = [];
      for (let i = 0; i < pairs.length; i += 2) seq.push([pairs[i], pairs[i + 1]]);
      return [seq];
    }
    return perfectMatchings(pairs.map((_, i) => i)).map((mt) => mt.map(([i, j]) => [pairs[i], pairs[j]]));
  });
  const opp = {};
  const get = (x, y) => (opp[x] && opp[x][y]) || 0;
  const add = (x, y, d) => {
    (opp[x] ||= {})[y] = get(x, y) + d;
    (opp[y] ||= {})[x] = get(y, x) + d;
  };
  const apply = (matching, d) => {
    for (const [p, q] of matching) for (const x of p) for (const y of q) add(x, y, d);
  };
  const fits = (matching, cap) => matching.every(([p, q]) => p.every((x) => q.every((y) => get(x, y) < cap)));

  // 1) Busca exata: ninguém enfrenta o mesmo adversário mais de 2x (torneio "whist").
  //    Com 2(n-1) adversários por atleta e n-1 rivais, cap 2 = equilíbrio perfeito.
  const chosen = [];
  let steps = 0;
  const LIMIT = 300000;
  const dfs = (r) => {
    if (r === options.length) return true;
    if (++steps > LIMIT) return false;
    for (const mt of options[r]) {
      if (!fits(mt, 2)) continue;
      apply(mt, 1);
      chosen.push(mt);
      if (dfs(r + 1)) return true;
      chosen.pop();
      apply(mt, -1);
    }
    return false;
  };
  let picked;
  if (dfs(0)) picked = chosen.slice();
  else {
    // 2) Sem solução exata no limite: guloso (menor soma de repetições a cada rodada).
    for (const k of Object.keys(opp)) delete opp[k];
    picked = options.map((opts) => {
      let best = opts[0];
      let bestCost = Infinity;
      for (const mt of opts) {
        let c = 0;
        for (const [p, q] of mt) for (const x of p) for (const y of q) c += (get(x, y) + 1) ** 2;
        if (c < bestCost) {
          bestCost = c;
          best = mt;
        }
      }
      apply(best, 1);
      return best;
    });
  }
  return picked.map((mt, ri) => ({ round: ri + 1, matches: mt.map(([p, q]) => ({ home: p, away: q })) }));
}

// Ranking individual do Americano: cada atleta soma os games da sua dupla.
// points = games pró (é o critério principal); vitórias/saldo desempatam.
function tallyAmericano(entries, matches) {
  const t = {};
  for (const e of entries) {
    t[e.id] = { entryId: e.id, groupName: null, played: 0, won: 0, drawn: 0, lost: 0, scoreFor: 0, scoreAgainst: 0, points: 0, fairPlay: 0, buchholz: 0 };
  }
  for (const m of matches) {
    const home = [m.homeEntryId, m.homeEntry2Id].filter(Boolean);
    const away = [m.awayEntryId, m.awayEntry2Id].filter(Boolean);
    const hs = Number(m.homeScore) || 0;
    const as = Number(m.awayScore) || 0;
    const apply = (ids, gf, ga) => {
      for (const id of ids) {
        const r = t[id];
        if (!r) continue;
        r.played++;
        r.scoreFor += gf;
        r.scoreAgainst += ga;
        r.points += gf;
        if (gf > ga) r.won++;
        else if (gf < ga) r.lost++;
        else r.drawn++;
      }
    };
    apply(home, hs, as);
    apply(away, as, hs);
  }
  return t;
}

// ---------------------------------------------------------------------
// Suspensão automática
// ---------------------------------------------------------------------

const DEFAULT_SUSPENSION_RULE = {
  enabled: true,
  yellowLimit: 3, // amarelos acumulados que geram suspensão
  yellowBan: 1, // jogos de suspensão por acúmulo
  redBan: 1, // jogos de suspensão por vermelho
  doubleYellowIsRed: true, // 2 amarelos no mesmo jogo = expulsão (não somam no acúmulo)
};

function normalizeSuspensionRule(rule) {
  let r = rule;
  if (typeof r === 'string') {
    try {
      r = JSON.parse(r);
    } catch (_) {
      r = null;
    }
  }
  const out = { ...DEFAULT_SUSPENSION_RULE };
  // Categoria SEM regra salva (ex.: torneios que já estavam rodando) = suspensão DESLIGADA.
  // Só vale quando o organizador ligar nas regras da categoria — nunca bloqueia súmula de surpresa.
  if (!r || typeof r !== "object") out.enabled = false;
  if (r && typeof r === 'object') {
    if (r.enabled !== undefined) out.enabled = !!r.enabled;
    const int = (v, min, max, def) => {
      const x = Number(v);
      return Number.isFinite(x) ? Math.max(min, Math.min(max, Math.round(x))) : def;
    };
    out.yellowLimit = int(r.yellowLimit, 1, 20, out.yellowLimit);
    out.yellowBan = int(r.yellowBan, 0, 20, out.yellowBan);
    out.redBan = int(r.redBan, 0, 20, out.redBan);
    if (r.doubleYellowIsRed !== undefined) out.doubleYellowIsRed = !!r.doubleYellowIsRed;
  }
  return out;
}

const PLAYED = (m) => (m.status === 'FINISHED' || m.status === 'WALKOVER') && m.homeEntryId && m.awayEntryId;
const ts = (d) => (d ? new Date(d).getTime() : null);

// Ordem cronológica dos jogos de um time: encerrados primeiro (pela data),
// depois os pendentes (agendados por data; sem data por rodada/ordem).
function entrySchedule(matches, entryId) {
  const mine = matches.filter(
    (m) => m.status !== 'CANCELED' && (m.homeEntryId === entryId || m.awayEntryId === entryId)
  );
  const done = mine.filter(PLAYED);
  const todo = mine.filter((m) => !PLAYED(m) && m.homeEntryId && m.awayEntryId);
  const byTime = (a, b) => {
    const ta = ts(a.scheduledAt) ?? ts(a.updatedAt) ?? Infinity;
    const tb = ts(b.scheduledAt) ?? ts(b.updatedAt) ?? Infinity;
    return ta - tb || (a.round || 0) - (b.round || 0) || (a.ordering || 0) - (b.ordering || 0);
  };
  const byPlan = (a, b) => {
    const ta = ts(a.scheduledAt) ?? Infinity;
    const tb = ts(b.scheduledAt) ?? Infinity;
    return ta - tb || (a.round || 0) - (b.round || 0) || (a.ordering || 0) - (b.ordering || 0);
  };
  done.sort(byTime);
  todo.sort(byPlan);
  return { done, todo };
}

/**
 * Calcula suspensões a partir dos eventos de jogos ENCERRADOS.
 * matches: partidas (todas) da categoria · events: cartões {matchId, playerId, entryId, type}
 * players: elenco {id, name, number, entryId} · rule: regra (normalizada aqui)
 * Retorna { rule, suspended:[...], hanging:[...] } — suspended traz matchIds
 * (próximos jogos em que o atleta NÃO pode atuar).
 */
function computeSuspensions({ matches = [], events = [], players = [], rule } = {}) {
  const R = normalizeSuspensionRule(rule);
  const out = { rule: R, suspended: [], hanging: [] };
  if (!R.enabled) return out;
  const playedIds = new Set(matches.filter(PLAYED).map((m) => m.id));
  const evByPlayerMatch = {};
  for (const e of events) {
    if (!e.playerId || !playedIds.has(e.matchId)) continue;
    if (e.type !== 'YELLOW' && e.type !== 'RED') continue;
    const k = e.playerId + '|' + e.matchId;
    (evByPlayerMatch[k] ||= { y: 0, r: 0 });
    if (e.type === 'YELLOW') evByPlayerMatch[k].y++;
    else evByPlayerMatch[k].r++;
  }
  const schedCache = {};
  for (const p of players) {
    const sch = (schedCache[p.entryId] ||= entrySchedule(matches, p.entryId));
    let pending = 0;
    let yellows = 0;
    const reasons = [];
    for (const m of sch.done) {
      if (pending > 0) pending--; // cumpriu um jogo de suspensão
      if (pending === 0) reasons.length = 0;
      const ev = evByPlayerMatch[p.id + '|' + m.id];
      if (!ev) continue;
      let y = ev.y;
      let r = ev.r;
      if (R.doubleYellowIsRed && y >= 2) {
        r = Math.max(r, 1);
        y -= 2;
      }
      if (r > 0 && R.redBan > 0) {
        pending += R.redBan;
        reasons.push({ type: 'RED', matchId: m.id, games: R.redBan });
      }
      yellows += y;
      while (yellows >= R.yellowLimit) {
        yellows -= R.yellowLimit; // zera o acúmulo ao gerar a suspensão
        if (R.yellowBan > 0) {
          pending += R.yellowBan;
          reasons.push({ type: 'YELLOWS', matchId: m.id, games: R.yellowBan, count: R.yellowLimit });
        }
      }
    }
    const base = { playerId: p.id, name: p.name, number: p.number ?? null, entryId: p.entryId, yellowCount: yellows };
    if (pending > 0) {
      const matchIds = sch.todo.slice(0, pending).map((m) => m.id);
      out.suspended.push({ ...base, gamesRemaining: pending, matchIds, nextMatchId: matchIds[0] || null, reasons: reasons.slice() });
    } else if (R.yellowLimit > 1 && yellows === R.yellowLimit - 1) {
      out.hanging.push(base); // "pendurado": o próximo amarelo suspende
    }
  }
  return out;
}

function suspensionFor(result, playerId, matchId) {
  return (result.suspended || []).find((s) => s.playerId === playerId && s.matchIds.includes(matchId)) || null;
}

function suspensionReasonText(s) {
  if (!s || !s.reasons || !s.reasons.length) return 'suspenso';
  return s.reasons
    .map((r) => (r.type === 'RED' ? 'cartão vermelho' : `${r.count} amarelos acumulados`))
    .join(' + ');
}

// ---------------------------------------------------------------------
// Campeão de uma categoria (histórico de séries/temporadas)
// ---------------------------------------------------------------------

const DONE = (m) => m && (m.status === 'FINISHED' || m.status === 'WALKOVER') && m.winnerEntryId;
const other = (m, id) => (m.homeEntryId === id ? m.awayEntryId : m.homeEntryId);

/**
 * matches: partidas da categoria · standings: [{entryId, rank}] · opts.swissRounds
 * Retorna { championId, runnerUpId, source } ou null se não há campeão definido.
 */
function categoryChampion(matches = [], standings = [], opts = {}) {
  const reset = matches.find((m) => m.stage === 'FINAL_RESET');
  if (DONE(reset)) return { championId: reset.winnerEntryId, runnerUpId: other(reset, reset.winnerEntryId), source: 'FINAL_RESET' };
  const final = matches.find((m) => m.stage === 'FINAL');
  if (final) {
    if (!DONE(final)) return null;
    // dupla eliminação: se o campeão da chave dos perdedores venceu a final e há reset pendente, ainda não acabou
    if (reset && reset.status !== 'CANCELED' && final.winnerEntryId === final.awayEntryId) return null;
    return { championId: final.winnerEntryId, runnerUpId: other(final, final.winnerEntryId), source: 'FINAL' };
  }
  const league = matches.filter((m) => ['LEAGUE', 'AMERICANO', 'SWISS'].includes(m.stage));
  if (!league.length || league.length !== matches.length) return null;
  if (!league.every((m) => m.status === 'FINISHED' || m.status === 'WALKOVER')) return null;
  if (league[0].stage === 'SWISS') {
    const rounds = new Set(league.map((m) => m.round)).size;
    if (opts.swissRounds && rounds < opts.swissRounds) return null;
  }
  const sorted = [...standings].filter((s) => s.rank).sort((a, b) => a.rank - b.rank);
  if (!sorted.length) return null;
  return { championId: sorted[0].entryId, runnerUpId: sorted[1] ? sorted[1].entryId : null, source: league[0].stage };
}

module.exports = {
  TIEBREAK_KEYS,
  TIEBREAK_LABELS,
  DEFAULT_TIEBREAKERS,
  AMERICANO_TIEBREAKERS,
  CARD_POINTS,
  normalizeTiebreakers,
  drawValue,
  newSeed,
  rankTable,
  miniTable,
  tallyTable,
  fairPlayByEntry,
  circleRounds,
  withReturnLeg,
  nextPow2,
  seedSlots,
  doubleElimPlan,
  pairKey,
  suggestedSwissRounds,
  swissFirstRound,
  swissPair,
  americanoSchedule,
  tallyAmericano,
  perfectMatchings,
  whistBase,
  DEFAULT_SUSPENSION_RULE,
  normalizeSuspensionRule,
  entrySchedule,
  computeSuspensions,
  suspensionFor,
  suspensionReasonText,
  categoryChampion,
};
