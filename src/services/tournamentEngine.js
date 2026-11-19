// =====================================================================
// APEX COMPETIÇÃO — Tournament Engine
// =====================================================================
// Motor de torneios: gera chaveamento (pontos corridos + mata-mata),
// recalcula classificação, aplica resultado de partida (com avanço
// automático na chave) e atualiza o rating do atleta (escala 0-7).
//
// Reutiliza o mesmo Postgres/User do TenisCash. Nada de movimento REAL
// de saldo aqui — premiação/inscrição em TenisCash é fase 2 (gated).
// =====================================================================

const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
const F = require('./tournamentFormats');

// Fases "de tabela" (empate vale ponto; classificação recalculada).
// Todo o resto (mata-mata, dupla eliminação, final) não pode empatar.
const LEAGUE_STAGES = ['LEAGUE', 'GROUP', 'SWISS', 'AMERICANO'];
const isLeagueStage = (stage) => LEAGUE_STAGES.includes(stage);

// Config de formato por categoria (JSON livre): { rounds, reset, variant }
function catConfig(category) {
  let c = category && category.formatConfig;
  if (typeof c === 'string') {
    try {
      c = JSON.parse(c);
    } catch (_) {
      c = null;
    }
  }
  return c && typeof c === 'object' ? c : {};
}

// ---------------------------------------------------------------------
// Utils de chaveamento
// ---------------------------------------------------------------------

const avg = (arr) => (arr.length ? arr.reduce((s, x) => s + x, 0) / arr.length : 0);

function nextPow2(n) {
  let p = 1;
  while (p < n) p <<= 1;
  return p;
}

// Ordem padrão de cabeças de chave para um bracket de tamanho `size`
// (potência de 2). Ex.: size 8 → [1,8,4,5,2,7,3,6].
function seedSlots(size) {
  let seeds = [1, 2];
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

// Rótulo da fase do mata-mata pela qtd de partidas na rodada.
function stageLabel(matchesInRound) {
  return (
    { 1: 'FINAL', 2: 'SEMI', 4: 'QUARTER', 8: 'RO16', 16: 'RO32', 32: 'RO64', 64: 'RO128' }[
      matchesInRound
    ] || `R${matchesInRound * 2}`
  );
}

// Método do círculo (round-robin): retorna array de rodadas,
// cada rodada = array de pares [home, away]. `null` = bye (descartado).
function roundRobinRounds(entries) {
  const list = [...entries];
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
      if (home && away) pairs.push([home, away]);
    }
    rounds.push(pairs);
    rotating = [rotating[rotating.length - 1], ...rotating.slice(0, rotating.length - 1)];
  }
  return rounds;
}

// ---------------------------------------------------------------------
// Geração de fixtures
// ---------------------------------------------------------------------

/**
 * Gera as partidas de uma categoria a partir dos inscritos CONFIRMED.
 * Idempotente: apaga partidas/standings anteriores e recria.
 */
async function generateFixtures(categoryId, opts = {}) {
  const category = await prisma.tournamentCategory.findUnique({
    where: { id: categoryId },
    include: {
      tournament: true,
      entries: {
        where: { status: 'CONFIRMED' },
        orderBy: [{ seed: 'asc' }, { createdAt: 'asc' }],
      },
    },
  });
  if (!category) return { ok: false, error: 'categoria não encontrada' };

  const entries = category.entries;
  if (entries.length < 2) return { ok: false, error: 'mínimo 2 inscritos confirmados' };

  const format = category.format || category.tournament.format || 'KNOCKOUT';

  // limpa fixtures antigos (idempotente)
  await prisma.tournamentMatch.deleteMany({ where: { categoryId } });
  await prisma.tournamentStanding.deleteMany({ where: { categoryId } });

  if (format === 'ROUND_ROBIN') {
    return generateRoundRobin(category, entries, 'ROUND_ROBIN');
  }
  if (format === 'DOUBLE_ELIM') return generateDoubleElim(category, entries);
  if (format === 'SWISS') return generateSwissFirst(category, entries);
  if (format === 'AMERICANO') return generateAmericano(category, entries);
  if (format === 'GROUPS' || format === 'GROUPS_KNOCKOUT') {
    // Grupos já definidos manualmente? (todos os inscritos com groupName) →
    // RESPEITA o sorteio existente. Senão, distribui em serpentina por seed.
    // No GROUPS_KNOCKOUT o mata-mata vem depois, via generateKnockoutFromGroups().
    const allHaveGroups = entries.length > 0 && entries.every((e) => e.groupName);
    let groupCount;
    if (allHaveGroups && !opts.forceRedraw) {
      groupCount = new Set(entries.map((e) => e.groupName)).size;
    } else {
      groupCount = resolveGroupCount(entries, opts.groupCount);
      await assignGroups(entries, groupCount);
    }
    const r = await generateRoundRobin(category, entries, 'GROUPS');
    return { ...r, format, phase: 'GROUPS', groupCount };
  }
  return generateKnockout(category, entries);
}

// Nº de grupos: usa o pedido (clamp) ou ~4 por grupo. Cada grupo precisa de >=2.
function resolveGroupCount(entries, requested) {
  const n = entries.length;
  let g = Number(requested) || Math.max(1, Math.round(n / 4));
  g = Math.max(1, Math.min(g, Math.floor(n / 2) || 1));
  return g;
}

// Distribui entries em `groupCount` grupos em serpentina (seed-balanced) e
// persiste o groupName (sobrescreve p/ garantir consistência da geração).
async function assignGroups(entries, groupCount) {
  const names = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'];
  const cyc = 2 * groupCount;
  for (let i = 0; i < entries.length; i++) {
    const c = i % cyc;
    const gi = c < groupCount ? c : cyc - 1 - c;
    const gname = names[gi] || String.fromCharCode(65 + gi);
    entries[i].groupName = gname;
    await prisma.tournamentEntry.update({ where: { id: entries[i].id }, data: { groupName: gname } });
  }
}

async function generateRoundRobin(category, entries, format) {
  // GROUPS: agrupa por groupName (default "A"); senão grupo único
  const groups = {};
  if (format === 'GROUPS') {
    for (const e of entries) (groups[e.groupName || 'A'] ||= []).push(e);
  } else {
    groups['_'] = entries;
  }

  const matchesData = [];
  for (const [gName, gEntries] of Object.entries(groups)) {
    if (gEntries.length < 2) continue;
    // Ida e volta (por categoria): o returno inverte o mando.
    const rounds = category.doubleRound ? F.withReturnLeg(roundRobinRounds(gEntries)) : roundRobinRounds(gEntries);
    rounds.forEach((pairs, ri) => {
      pairs.forEach(([home, away], oi) => {
        matchesData.push({
          tournamentId: category.tournamentId,
          categoryId: category.id,
          stage: format === 'GROUPS' ? 'GROUP' : 'LEAGUE',
          round: ri + 1,
          groupName: format === 'GROUPS' ? gName : null,
          ordering: oi,
          homeEntryId: home.id,
          awayEntryId: away.id,
          status: 'SCHEDULED',
        });
      });
    });
  }

  await prisma.tournamentMatch.createMany({ data: matchesData });
  await seedStandings(category, entries);

  return { ok: true, format, matchesCreated: matchesData.length, doubleRound: !!category.doubleRound };
}

async function seedStandings(category, entries) {
  await prisma.tournamentStanding.createMany({
    data: entries.map((e) => ({
      tournamentId: category.tournamentId,
      categoryId: category.id,
      entryId: e.id,
      groupName: e.groupName || null,
    })),
    skipDuplicates: true,
  });
}

async function generateKnockout(category, entries) {
  return buildBracketFromSeeded(category, entries.map((e) => ({ id: e.id })), {});
}

/**
 * Monta um mata-mata a partir de uma lista JÁ ordenada por seed
 * (index 0 = seed 1). Cada item: { id, group? }.
 * opts.fromGroups: tenta evitar confronto do mesmo grupo na 1a rodada.
 */
async function buildBracketFromSeeded(category, seedEntries, opts = {}) {
  const n = seedEntries.length;
  const size = nextPow2(n);
  const slots = seedSlots(size); // seed numbers em ordem de slot
  const roundsCount = Math.log2(size);

  // seed 1..n na ordem recebida
  const bySeed = {};
  seedEntries.forEach((e, i) => {
    bySeed[i + 1] = e;
  });

  // Pares da 1a rodada em memória (com possível swap anti-mesmo-grupo)
  const r1count = size / 2;
  const pairs = [];
  for (let m = 0; m < r1count; m++) {
    pairs.push({ home: bySeed[slots[2 * m]] || null, away: bySeed[slots[2 * m + 1]] || null });
  }
  if (opts.fromGroups) {
    const clash = (p) => p.home && p.away && p.home.group && p.home.group === p.away.group;
    for (let i = 0; i < pairs.length; i++) {
      if (!clash(pairs[i])) continue;
      for (let j = 0; j < pairs.length; j++) {
        if (j === i) continue;
        const cand = { home: pairs[i].home, away: pairs[j].away };
        const cand2 = { home: pairs[j].home, away: pairs[i].away };
        if (!clash(cand) && !clash(cand2)) {
          const tmp = pairs[i].away;
          pairs[i].away = pairs[j].away;
          pairs[j].away = tmp;
          break;
        }
      }
    }
  }

  // Cria as rodadas da FINAL pra trás, guardando a rodada posterior
  // pra linkar nextMatchId/nextSlot das partidas anteriores.
  let laterRound = null;
  const allRounds = {}; // round number -> [matches]

  for (let r = roundsCount; r >= 1; r--) {
    const matchesInRound = size / Math.pow(2, r); // final r=roundsCount → 1
    const thisRound = [];
    for (let m = 0; m < matchesInRound; m++) {
      const isFinal = r === roundsCount;
      const next = isFinal ? null : laterRound[Math.floor(m / 2)];
      const created = await prisma.tournamentMatch.create({
        data: {
          tournamentId: category.tournamentId,
          categoryId: category.id,
          stage: stageLabel(matchesInRound),
          round: r,
          ordering: m,
          status: 'SCHEDULED',
          nextMatchId: next ? next.id : null,
          nextSlot: isFinal ? null : m % 2 === 0 ? 'home' : 'away',
        },
      });
      thisRound.push(created);
    }
    allRounds[r] = thisRound;
    laterRound = thisRound;
  }

  // Preenche a rodada 1 com os pares calculados
  const round1 = allRounds[1];
  for (let m = 0; m < round1.length; m++) {
    const home = pairs[m].home;
    const away = pairs[m].away;
    const match = await prisma.tournamentMatch.update({
      where: { id: round1[m].id },
      data: { homeEntryId: home ? home.id : null, awayEntryId: away ? away.id : null },
    });
    round1[m] = match;
  }

  // Resolve byes da rodada 1 (um lado vazio → o outro avança)
  for (const m of round1) {
    const hasHome = !!m.homeEntryId;
    const hasAway = !!m.awayEntryId;
    if (hasHome !== hasAway) {
      const winnerId = m.homeEntryId || m.awayEntryId;
      await prisma.tournamentMatch.update({
        where: { id: m.id },
        data: { winnerEntryId: winnerId, status: 'WALKOVER' },
      });
      if (m.nextMatchId) {
        await prisma.tournamentMatch.update({
          where: { id: m.nextMatchId },
          data: m.nextSlot === 'away' ? { awayEntryId: winnerId } : { homeEntryId: winnerId },
        });
      }
    }
  }

  // Disputa de 3º lugar — só quando há semifinal (bracket >= 4).
  // Os perdedores das 2 semis são encaminhados pra cá em applyMatchResult.
  let thirdCreated = 0;
  if (roundsCount >= 2) {
    await prisma.tournamentMatch.create({
      data: {
        tournamentId: category.tournamentId,
        categoryId: category.id,
        stage: 'THIRD',
        round: roundsCount + 1,
        ordering: 0,
        status: 'SCHEDULED',
      },
    });
    thirdCreated = 1;
  }

  const totalMatches = Object.values(allRounds).reduce((s, arr) => s + arr.length, 0) + thirdCreated;
  return {
    ok: true,
    format: 'KNOCKOUT',
    phase: opts.fromGroups ? 'KNOCKOUT' : undefined,
    bracketSize: size,
    rounds: roundsCount,
    matchesCreated: totalMatches,
  };
}

/**
 * GROUPS_KNOCKOUT — fase final: pega os classificados (top N de cada grupo)
 * e monta o mata-mata, semeado pela campanha (1os colocados como cabeças).
 * Exige a fase de grupos concluída. Idempotente: recria só o mata-mata,
 * preservando as partidas/standings da fase de grupos.
 */
async function generateKnockoutFromGroups(categoryId, qualifiersPerGroup = 2) {
  const category = await prisma.tournamentCategory.findUnique({
    where: { id: categoryId },
    include: { tournament: true },
  });
  if (!category) return { ok: false, error: 'categoria não encontrada' };

  const groupMatches = await prisma.tournamentMatch.findMany({ where: { categoryId, stage: 'GROUP' } });
  if (!groupMatches.length) return { ok: false, error: 'gere a fase de grupos primeiro' };
  const pending = groupMatches.filter((m) => m.status !== 'FINISHED' && m.status !== 'WALKOVER');
  if (pending.length) return { ok: false, error: `faltam ${pending.length} jogo(s) da fase de grupos` };

  await recomputeStandings(categoryId);
  const standings = await prisma.tournamentStanding.findMany({
    where: { categoryId },
    orderBy: [{ groupName: 'asc' }, { rank: 'asc' }],
  });

  const byGroup = {};
  for (const s of standings) {
    if (!s.groupName) continue; // ignora entries sem grupo (defensivo)
    (byGroup[s.groupName] ||= []).push(s);
  }

  const q = Math.max(1, Number(qualifiersPerGroup) || 2);
  const qualifiers = [];
  for (const rows of Object.values(byGroup)) {
    rows.slice(0, q).forEach((s, i) => {
      qualifiers.push({ id: s.entryId, group: s.groupName, place: i + 1, points: s.points });
    });
  }
  if (qualifiers.length < 2) return { ok: false, error: 'classificados insuficientes p/ o mata-mata' };

  // remove mata-mata anterior, preserva a fase de grupos
  await prisma.tournamentMatch.deleteMany({ where: { categoryId, stage: { notIn: ['GROUP'] } } });

  // seeds: todos os 1os (melhor campanha primeiro), depois os 2os, etc.
  qualifiers.sort((a, b) => a.place - b.place || b.points - a.points);

  const r = await buildBracketFromSeeded(
    category,
    qualifiers.map((x) => ({ id: x.id, group: x.group })),
    { fromGroups: true }
  );
  return { ...r, qualifiers: qualifiers.length, qualifiersPerGroup: q };
}

// ---------------------------------------------------------------------
// DUPLA ELIMINAÇÃO — chave dos vencedores (WB) + perdedores (LB) +
// grande final (FINAL) com "reset" opcional (FINAL_RESET).
// ---------------------------------------------------------------------
async function generateDoubleElim(category, entries) {
  const cfg = catConfig(category);
  const plan = F.doubleElimPlan(entries.length, { reset: cfg.reset !== false });
  const k = plan.wbRounds;
  const L = plan.lbRounds;
  const stageOf = (b) => ({ W: 'WB', L: 'LB', GF: 'FINAL', GF2: 'FINAL_RESET' }[b]);
  const roundOf = (m) =>
    m.bracket === 'W' ? m.round : m.bracket === 'L' ? k + m.round : m.bracket === 'GF' ? k + L + 1 : k + L + 2;
  const human = (key) => {
    if (key === 'GF') return 'Final';
    const b = key[0];
    const [r, o] = key.slice(1).split('-').map(Number);
    return (b === 'W' ? 'Vencedores' : 'Perdedores') + ' R' + r + ' J' + (o + 1);
  };
  const label = (src) => {
    if (!src || src.type === 'seed') return null;
    if (src.type === 'GF') return src.slot === 'home' ? 'Campeão da chave dos vencedores' : 'Campeão da chave dos perdedores';
    return (src.type === 'W' ? 'Vencedor ' : 'Perdedor ') + human(src.key);
  };
  const seedEntry = (src) => (src && src.type === 'seed' ? entries[src.seed - 1] : null);

  const ids = {};
  for (const m of plan.matches) {
    const h = seedEntry(m.home);
    const a = seedEntry(m.away);
    const created = await prisma.tournamentMatch.create({
      data: {
        tournamentId: category.tournamentId,
        categoryId: category.id,
        stage: stageOf(m.bracket),
        bracket: m.bracket,
        round: roundOf(m),
        ordering: m.ordering,
        status: 'SCHEDULED',
        homeEntryId: h ? h.id : null,
        awayEntryId: a ? a.id : null,
        homeSourceLabel: label(m.home),
        awaySourceLabel: label(m.away),
      },
    });
    ids[m.key] = created.id;
  }
  for (const m of plan.matches) {
    const data = {};
    if (m.winnerTo) {
      data.nextMatchId = ids[m.winnerTo.key];
      data.nextSlot = m.winnerTo.slot;
    }
    if (m.loserTo) {
      data.loserNextMatchId = ids[m.loserTo.key];
      data.loserNextSlot = m.loserTo.slot;
    }
    if (Object.keys(data).length) await prisma.tournamentMatch.update({ where: { id: ids[m.key] }, data });
  }
  return {
    ok: true,
    format: 'DOUBLE_ELIM',
    bracketSize: plan.bracketSize,
    winnersRounds: k,
    losersRounds: L,
    reset: cfg.reset !== false,
    matchesCreated: plan.matches.length,
  };
}

// ---------------------------------------------------------------------
// SISTEMA SUÍÇO — N rodadas, pareamento por pontuação sem repetir
// confronto; nº ímpar → bye (vitória) pro pior colocado que ainda não teve.
// ---------------------------------------------------------------------
function swissRoundsFor(category, n) {
  const cfg = catConfig(category);
  const r = Number(cfg.rounds);
  return Number.isFinite(r) && r >= 1 ? Math.min(Math.round(r), Math.max(1, n - 1)) : F.suggestedSwissRounds(n);
}

async function createSwissRound(category, round, pairs, bye) {
  const data = pairs.map(([h, a], i) => ({
    tournamentId: category.tournamentId,
    categoryId: category.id,
    stage: 'SWISS',
    round,
    ordering: i,
    homeEntryId: h,
    awayEntryId: a,
    status: 'SCHEDULED',
  }));
  if (bye) {
    data.push({
      tournamentId: category.tournamentId,
      categoryId: category.id,
      stage: 'SWISS',
      round,
      ordering: pairs.length,
      homeEntryId: bye,
      awayEntryId: null,
      winnerEntryId: bye,
      status: 'WALKOVER',
      awaySourceLabel: 'Folga (bye)',
    });
  }
  await prisma.tournamentMatch.createMany({ data });
  return data.length;
}

async function generateSwissFirst(category, entries) {
  const totalRounds = swissRoundsFor(category, entries.length);
  const { pairs, bye } = F.swissFirstRound(entries.map((e) => e.id));
  const created = await createSwissRound(category, 1, pairs, bye);
  await seedStandings(category, entries);
  await recomputeStandings(category.id);
  return { ok: true, format: 'SWISS', round: 1, totalRounds, matchesCreated: created, bye: bye || null };
}

/** Próxima rodada do suíço (exige a rodada atual encerrada). */
async function generateSwissNextRound(categoryId) {
  const category = await prisma.tournamentCategory.findUnique({ where: { id: categoryId } });
  if (!category) return { ok: false, error: 'categoria não encontrada' };
  const matches = await prisma.tournamentMatch.findMany({ where: { categoryId, stage: 'SWISS' } });
  if (!matches.length) return { ok: false, error: 'gere a 1ª rodada primeiro' };
  const pending = matches.filter((m) => m.status !== 'FINISHED' && m.status !== 'WALKOVER');
  if (pending.length) return { ok: false, error: `faltam ${pending.length} jogo(s) da rodada atual` };
  const entries = await prisma.tournamentEntry.findMany({
    where: { categoryId, status: 'CONFIRMED' },
    orderBy: [{ seed: 'asc' }, { createdAt: 'asc' }],
  });
  const totalRounds = swissRoundsFor(category, entries.length);
  const current = Math.max(...matches.map((m) => m.round));
  if (current >= totalRounds) return { ok: false, error: `as ${totalRounds} rodadas já foram geradas` };

  await recomputeStandings(categoryId);
  const standings = await prisma.tournamentStanding.findMany({ where: { categoryId }, orderBy: { rank: 'asc' } });
  const valid = new Set(entries.map((e) => e.id));
  const ranked = standings.map((s) => s.entryId).filter((id) => valid.has(id));
  for (const e of entries) if (!ranked.includes(e.id)) ranked.push(e.id);

  const played = new Set();
  const byes = new Set();
  for (const m of matches) {
    if (m.homeEntryId && m.awayEntryId) played.add(F.pairKey(m.homeEntryId, m.awayEntryId));
    else if (m.winnerEntryId) byes.add(m.winnerEntryId);
  }
  const { pairs, bye, repeats } = F.swissPair(ranked, played, byes);
  const created = await createSwissRound(category, current + 1, pairs, bye);
  await recomputeStandings(categoryId);
  return { ok: true, format: 'SWISS', round: current + 1, totalRounds, matchesCreated: created, bye: bye || null, repeats };
}

// ---------------------------------------------------------------------
// AMERICANO / SUPER 8 / SUPER 12 — individual, parceiros rotativos,
// ranking por games. Cada partida: (A & B) × (C & D).
// ---------------------------------------------------------------------
async function generateAmericano(category, entries) {
  if (entries.length < 4 || entries.length % 4 !== 0) {
    return { ok: false, error: 'Americano precisa de nº de atletas múltiplo de 4 (Super 8 = 8, Super 12 = 12)' };
  }
  const sched = F.americanoSchedule(entries.map((e) => e.id));
  const data = [];
  for (const r of sched) {
    r.matches.forEach((m, i) => {
      data.push({
        tournamentId: category.tournamentId,
        categoryId: category.id,
        stage: 'AMERICANO',
        round: r.round,
        ordering: i,
        homeEntryId: m.home[0],
        homeEntry2Id: m.home[1],
        awayEntryId: m.away[0],
        awayEntry2Id: m.away[1],
        status: 'SCHEDULED',
      });
    });
  }
  await prisma.tournamentMatch.createMany({ data });
  await seedStandings(category, entries);
  const variant = entries.length === 8 ? 'SUPER8' : entries.length === 12 ? 'SUPER12' : 'AMERICANO';
  return { ok: true, format: 'AMERICANO', variant, rounds: sched.length, matchesCreated: data.length };
}

// ---------------------------------------------------------------------
// Resultado de partida + avanço de chave
// ---------------------------------------------------------------------

/**
 * Aplica o resultado de uma partida.
 * result = {
 *   games?: [{ setNumber, homeGames, awayGames, homeTiebreak?, awayTiebreak? }],
 *   homeScore?, awayScore?,   // usado se não vierem games
 *   winnerEntryId?            // força o vencedor (W.O., desempate manual)
 * }
 */
async function applyMatchResult(matchId, result = {}) {
  const match = await prisma.tournamentMatch.findUnique({
    where: { id: matchId },
    include: {
      tournament: true,
      category: true,
      homeEntry: { include: { members: true } },
      awayEntry: { include: { members: true } },
    },
  });
  if (!match) return { ok: false, error: 'partida não encontrada' };
  if (!match.homeEntryId || !match.awayEntryId) {
    return { ok: false, error: 'partida ainda sem os dois inscritos definidos' };
  }

  // Validação de sanidade do placar (multi-esporte: NÃO força regra de tênis,
  // só rejeita número inválido/negativo pra não corromper a classificação).
  const okNum = (v) =>
    v === undefined || v === null || v === '' || (Number.isFinite(Number(v)) && Number(v) >= 0 && Number(v) <= 999);
  if (Array.isArray(result.games)) {
    for (const g of result.games) {
      if (!okNum(g.homeGames) || !okNum(g.awayGames) || !okNum(g.homeTiebreak) || !okNum(g.awayTiebreak)) {
        return { ok: false, error: 'placar inválido (use números de 0 a 999)' };
      }
    }
  }
  if (!okNum(result.homeScore) || !okNum(result.awayScore)) {
    return { ok: false, error: 'placar inválido' };
  }

  // Grava sets (se vierem) e conta sets vencidos
  let hs = 0;
  let as = 0;
  if (Array.isArray(result.games) && result.games.length) {
    await prisma.matchGame.deleteMany({ where: { matchId } });
    for (const g of result.games) {
      const homeGames = Number(g.homeGames) || 0;
      const awayGames = Number(g.awayGames) || 0;
      await prisma.matchGame.create({
        data: {
          matchId,
          setNumber: Number(g.setNumber),
          homeGames,
          awayGames,
          homeTiebreak: g.homeTiebreak ?? null,
          awayTiebreak: g.awayTiebreak ?? null,
        },
      });
      if (homeGames > awayGames) hs++;
      else if (awayGames > homeGames) as++;
    }
  } else {
    hs = Number(result.homeScore) || 0;
    as = Number(result.awayScore) || 0;
  }

  let winnerEntryId = result.winnerEntryId || null;
  if (!winnerEntryId) {
    if (hs > as) winnerEntryId = match.homeEntryId;
    else if (as > hs) winnerEntryId = match.awayEntryId;
    // empate (liga) → winnerEntryId fica null
  }

  // No mata-mata não pode haver empate: a chave trava sem vencedor definido.
  const isKnockout = !isLeagueStage(match.stage);
  if (isKnockout && !winnerEntryId) {
    return { ok: false, error: 'mata-mata não pode terminar empatado — defina o vencedor (ou use W.O.)' };
  }

  await prisma.tournamentMatch.update({
    where: { id: matchId },
    data: { homeScore: hs, awayScore: as, winnerEntryId, status: 'FINISHED', liveState: null },
  });

  // Avanço automático na chave
  if (match.nextMatchId && winnerEntryId) {
    await prisma.tournamentMatch.update({
      where: { id: match.nextMatchId },
      data: match.nextSlot === 'away' ? { awayEntryId: winnerEntryId } : { homeEntryId: winnerEntryId },
    });
  }

  const loserId = winnerEntryId
    ? winnerEntryId === match.homeEntryId
      ? match.awayEntryId
      : match.homeEntryId
    : null;

  // Dupla eliminação: o PERDEDOR da chave dos vencedores cai na chave dos perdedores.
  if (match.loserNextMatchId && loserId) {
    await prisma.tournamentMatch.update({
      where: { id: match.loserNextMatchId },
      data: match.loserNextSlot === 'away' ? { awayEntryId: loserId } : { homeEntryId: loserId },
    });
  }

  // Grande final da dupla eliminação: se o campeão da chave dos PERDEDORES
  // (visitante) vence, joga-se o "reset". Se o dos vencedores vence, acabou.
  if (match.stage === 'FINAL' && match.bracket === 'GF' && winnerEntryId) {
    const reset = await prisma.tournamentMatch.findFirst({
      where: { categoryId: match.categoryId, stage: 'FINAL_RESET' },
    });
    if (reset && reset.status !== 'FINISHED') {
      if (winnerEntryId === match.awayEntryId) {
        await prisma.tournamentMatch.update({
          where: { id: reset.id },
          data: { homeEntryId: match.homeEntryId, awayEntryId: match.awayEntryId, status: 'SCHEDULED' },
        });
      } else {
        await prisma.tournamentMatch.update({
          where: { id: reset.id },
          data: { homeEntryId: null, awayEntryId: null, winnerEntryId: null, status: 'CANCELED' },
        });
      }
    }
  }

  // Disputa de 3º lugar: o PERDEDOR da semifinal cai na partida THIRD.
  // Semi ordering 0 → slot "casa" da THIRD; ordering 1 → slot "visitante".
  if (match.stage === 'SEMI' && winnerEntryId) {
    const third = await prisma.tournamentMatch.findFirst({
      where: { categoryId: match.categoryId, stage: 'THIRD' },
    });
    if (third && loserId) {
      await prisma.tournamentMatch.update({
        where: { id: third.id },
        data: match.ordering === 0 ? { homeEntryId: loserId } : { awayEntryId: loserId },
      });
    }
  }

  // Classificação (liga/grupos/suíço/americano)
  if (isLeagueStage(match.stage)) {
    await recomputeStandings(match.categoryId);
  }

  // Rating do atleta (escala 0-7) — no Americano as duplas mudam a cada jogo: não entra no rating.
  if (winnerEntryId && match.stage !== 'AMERICANO') {
    await updateRatingsForMatch(match, winnerEntryId);
  }
  // Rating Glicko-2 (nível 0-7 + confiabilidade) — recalcula do histórico; o Elo acima segue como legado.
  await require('./clubRating').onResult(match.tournament.sport);

  return { ok: true, matchId, winnerEntryId, homeScore: hs, awayScore: as };
}

// ---------------------------------------------------------------------
// Classificação (pontos corridos / grupos / suíço / americano)
// ---------------------------------------------------------------------

// Critérios efetivos de uma categoria (padrão = pontos → saldo → marcados).
function categoryTiebreakers(category, isAmericano) {
  return F.normalizeTiebreakers(
    category && category.tiebreakers,
    isAmericano ? F.AMERICANO_TIEBREAKERS : F.DEFAULT_TIEBREAKERS
  );
}

async function recomputeStandings(categoryId) {
  const category = await prisma.tournamentCategory.findUnique({
    where: { id: categoryId },
    include: { tournament: { select: { format: true } } },
  });
  if (!category) return [];

  const entries = await prisma.tournamentEntry.findMany({ where: { categoryId, status: 'CONFIRMED' } });
  const matches = await prisma.tournamentMatch.findMany({
    where: {
      categoryId,
      OR: [
        { status: 'FINISHED', stage: { in: LEAGUE_STAGES } },
        { status: 'WALKOVER', stage: 'SWISS' }, // bye do suíço = vitória
      ],
    },
  });

  const fmt = category.format || (category.tournament && category.tournament.format);
  const isAmericano = fmt === 'AMERICANO' || matches.some((m) => m.stage === 'AMERICANO');
  const criteria = categoryTiebreakers(category, isAmericano);
  const points = { win: category.pointsWin, draw: category.pointsDraw, loss: category.pointsLoss };

  // Fair play: só busca cartões quando o critério está na lista (não pesa no fluxo padrão).
  let fairPlay = {};
  if (criteria.includes('FAIR_PLAY') && matches.length) {
    const cards = await prisma.matchEvent.findMany({
      where: { matchId: { in: matches.map((m) => m.id) }, type: { in: ['YELLOW', 'RED'] } },
      select: { entryId: true, type: true },
    });
    fairPlay = F.fairPlayByEntry(cards);
  }

  // Sorteio: a semente é gerada UMA vez e gravada (auditável e reproduzível).
  let seed = category.tiebreakSeed || null;
  if (criteria.includes('DRAW') && !seed) {
    seed = F.newSeed();
    await prisma.tournamentCategory.update({ where: { id: categoryId }, data: { tiebreakSeed: seed } });
  }

  const table = isAmericano ? F.tallyAmericano(entries, matches) : F.tallyTable(entries, matches, points, { fairPlay });
  const rows = Object.values(table);
  const byGroup = {};
  for (const r of rows) (byGroup[isAmericano ? '_' : r.groupName || '_'] ||= []).push(r);
  const ranked = [];
  for (const g of Object.values(byGroup)) {
    ranked.push(...F.rankTable(g, { criteria, matches, points, seed }));
  }

  for (const r of ranked) {
    const data = {
      groupName: r.groupName,
      played: r.played,
      won: r.won,
      drawn: r.drawn,
      lost: r.lost,
      scoreFor: r.scoreFor,
      scoreAgainst: r.scoreAgainst,
      points: r.points,
      rank: r.rank,
      fairPlay: r.fairPlay || 0,
      tiebreak: r.decidedBy || null,
    };
    await prisma.tournamentStanding.upsert({
      where: { entryId: r.entryId },
      create: { tournamentId: category.tournamentId, categoryId, entryId: r.entryId, ...data },
      update: data,
    });
  }

  return ranked;
}

// ---------------------------------------------------------------------
// Rating do atleta — Elo adaptado à escala 0-7
// ---------------------------------------------------------------------

async function getOrCreateRatings(userIds, sport) {
  const out = [];
  for (const userId of userIds) {
    let r = await prisma.athleteRating.findUnique({
      where: { userId_sport: { userId, sport } },
    });
    if (!r) r = await prisma.athleteRating.create({ data: { userId, sport } });
    out.push(r);
  }
  return out;
}

async function applyRatingDelta(ratings, delta, won) {
  for (const r of ratings) {
    const nr = Math.max(0, Math.min(7, r.rating + delta));
    await prisma.athleteRating.update({
      where: { id: r.id },
      data: {
        rating: nr,
        matchesCount: { increment: 1 },
        wins: won ? { increment: 1 } : undefined,
        losses: won ? undefined : { increment: 1 },
        lastMatchAt: new Date(),
      },
    });
  }
}

async function updateRatingsForMatch(match, winnerEntryId) {
  const sport = match.tournament.sport;
  const home = match.homeEntry;
  const away = match.awayEntry;
  if (!home || !away) return;

  const homeUsers = home.members.map((m) => m.userId);
  const awayUsers = away.members.map((m) => m.userId);
  if (!homeUsers.length || !awayUsers.length) return;

  const homeRatings = await getOrCreateRatings(homeUsers, sport);
  const awayRatings = await getOrCreateRatings(awayUsers, sport);
  const ra = avg(homeRatings.map((r) => r.rating));
  const rb = avg(awayRatings.map((r) => r.rating));

  const homeWon = winnerEntryId === home.id;
  const scoreA = homeWon ? 1 : 0;
  // escala comprimida: divisor 2 (não 400) porque o range é 0-7
  const expectedA = 1 / (1 + Math.pow(10, (rb - ra) / 2));
  const K = 0.15;
  const deltaA = K * (scoreA - expectedA);

  await applyRatingDelta(homeRatings, deltaA, homeWon);
  await applyRatingDelta(awayRatings, -deltaA, !homeWon);
}

/**
 * Rating de um amistoso 1v1 (PlayChallenge). winnerUserId vs loserUserId.
 */
async function rateHeadToHead(winnerUserId, loserUserId, sport) {
  if (!winnerUserId || !loserUserId || winnerUserId === loserUserId) return;
  const [wr] = await getOrCreateRatings([winnerUserId], sport);
  const [lr] = await getOrCreateRatings([loserUserId], sport);
  const expectedW = 1 / (1 + Math.pow(10, (lr.rating - wr.rating) / 2));
  const K = 0.15;
  const delta = K * (1 - expectedW);
  await applyRatingDelta([wr], delta, true);
  await applyRatingDelta([lr], -delta, false);
  await require('./clubRating').onResult(sport); // Glicko-2 (SINGLES)
}

// ---------------------------------------------------------------------
// Identidade + Card do atleta (estilo FIFA) — reusado pelas rotas e páginas
// ---------------------------------------------------------------------

function yearStart() {
  const now = new Date();
  const year = Number(
    new Intl.DateTimeFormat('en-US', { timeZone: 'America/Fortaleza', year: 'numeric' }).format(now)
  );
  return new Date(Date.UTC(year, 0, 1, 3, 0, 0)); // 01/jan 00:00 Fortaleza
}

// Resolve um userId a partir de id, User.username ou AthleteProfile.username
async function resolveUserId(idOrHandle) {
  if (!idOrHandle) return null;
  const handle = String(idOrHandle).replace(/^@/, '');
  const byId = await prisma.user.findUnique({ where: { id: handle }, select: { id: true } });
  if (byId) return byId.id;
  const byUser = await prisma.user.findUnique({ where: { username: handle }, select: { id: true } });
  if (byUser) return byUser.id;
  const byAthlete = await prisma.athleteProfile.findUnique({
    where: { username: handle },
    select: { userId: true },
  });
  return byAthlete ? byAthlete.userId : null;
}

async function buildAthleteCard(userId, opts = {}) {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { id: true, name: true, username: true, city: true, state: true },
  });
  if (!user) return null;

  const profile = await prisma.athleteProfile.findUnique({ where: { userId } });
  const ratings = await prisma.athleteRating.findMany({ where: { userId }, orderBy: { rating: 'desc' } });
  const since = yearStart();

  const [trainingsTotal, trainingsYear] = await Promise.all([
    prisma.activity.count({ where: { userId } }),
    prisma.activity.count({ where: { userId, startedAt: { gte: since } } }),
  ]);

  // Liga F2: histórico ÚNICO entre ligas (EntryMember + elenco reivindicado), só jogos
  // encerrados e só torneios que quem olha pode ver (sem viewer = só públicos).
  const history = await require('./athleteHistory').history(userId, { viewer: opts.viewer || null });
  const ht = history.totals;
  const tournamentsCount = ht.tournaments || 0;
  const played = ht.games;
  const wins = ht.wins;
  const setsFor = ht.scoreFor;
  const setsAgainst = ht.scoreAgainst;
  const curSeason = require('./athleteHistory').seasonOf(new Date());
  const playedYear = (history.bySeason.find((x) => x.season === curSeason) || {}).games || 0;

  const challenges = await prisma.playChallenge.findMany({
    where: { status: 'PLAYED', OR: [{ challengerId: userId }, { challengedId: userId }] },
    select: { winnerId: true },
  });
  const challengeWins = challenges.filter((c) => c.winnerId === userId).length;

  const badges = await prisma.badgeEarned.findMany({
    where: { userId },
    orderBy: { earnedAt: 'desc' },
    take: 12,
  });
  const xpAgg = await prisma.badgeEarned.aggregate({ where: { userId }, _sum: { xpAwarded: true } });

  const totalMatches = played + challenges.length;
  const totalWins = wins + challengeWins;

  return {
    user: {
      id: user.id,
      name: user.name,
      username: user.username || profile?.username || null,
      city: user.city,
      state: user.state,
      avatarUrl: profile?.avatarUrl || null,
      bio: profile?.bio || null,
      experienceLevel: profile?.experienceLevel || null,
    },
    ratings: ratings.map((r) => ({
      sport: r.sport,
      rating: Number(r.rating.toFixed(2)),
      matches: r.matchesCount,
      wins: r.wins,
      losses: r.losses,
    })),
    stats: {
      xp: xpAgg._sum.xpAwarded || 0,
      trainings: trainingsTotal,
      trainingsYear,
      tournaments: tournamentsCount,
      matchesPlayed: totalMatches,
      matchesPlayedYear: playedYear,
      wins: totalWins,
      losses: totalMatches - totalWins - ht.draws,
      winRate: totalMatches ? Math.round((totalWins / totalMatches) * 100) : 0,
      setsFor,
      setsAgainst,
      draws: ht.draws,
      goals: ht.goals,
      assists: ht.assists,
      yellow: ht.yellow,
      red: ht.red,
      titles: ht.titles,
      badgeCount: badges.length,
    },
    history,
    badges: badges.map((b) => ({ key: b.badgeKey, at: b.earnedAt })),
  };
}

module.exports = {
  generateFixtures,
  generateKnockoutFromGroups,
  generateSwissNextRound,
  categoryTiebreakers,
  isLeagueStage,
  LEAGUE_STAGES,
  catConfig,
  applyMatchResult,
  recomputeStandings,
  updateRatingsForMatch,
  rateHeadToHead,
  resolveUserId,
  buildAthleteCard,
  yearStart,
  // utils expostos p/ teste
  seedSlots,
  roundRobinRounds,
  nextPow2,
};
