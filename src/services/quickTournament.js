// =====================================================================
// Liga Aberta F3 — CRIAÇÃO EM 2 MINUTOS (POST /api/tournaments/quick)
// ---------------------------------------------------------------------
// Assistente de 4 passos: esporte → formato (ou modelo pronto) → times →
// publicar. Numa TRANSAÇÃO só: torneio + categoria "Geral" (com as regras do
// modelo) + uma inscrição por time (cada time com o seu Club, via
// clubIdentity — F2) + tabela/chave gerada pelo motor. Falha no meio = nada
// fica gravado. Racha (PICKUP): em vez de times, os JOGADORES do racha.
// Datas, locais e regras ficam para depois (tudo editável).
// Não mexe em dinheiro: torneio nasce sem TenisCash (cashEnabled=false).
// =====================================================================

const { prisma } = require('../middleware');
const engine = require('./tournamentEngine');
const clubIdentity = require('./clubIdentity');
const presets = require('./tournamentPresets');
const access = require('./tournamentAccess');
const audit = require('./tournamentAudit');
const { publicBaseUrl } = require('../config/publicUrl');

const SPORTS = new Set(['TENNIS', 'BEACH_TENNIS', 'PADEL', 'FUTSAL', 'SOCCER', 'VOLLEY', 'BASKETBALL', 'HANDBALL', 'TABLE_TENNIS', 'OTHER']);
const MAX_TEAMS = 64;

class QuickError extends Error { constructor(status, msg, extra) { super(msg); this.status = status; this.extra = extra || null; } }

function slugify(s) {
  return String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 50) || 'torneio';
}
async function uniqueSlug(db, base) {
  const b = slugify(base);
  let slug = b;
  for (let n = 2; await db.tournament.findUnique({ where: { slug }, select: { id: true } }); n++) slug = `${b}-${n}`;
  return slug;
}

// "Time A\nTime B" ou ["Time A","Time B"] → nomes limpos (sem vazios), na ordem digitada.
function parseNames(input) {
  let arr = input;
  if (typeof arr === 'string') arr = arr.split(/\r?\n/);
  if (!Array.isArray(arr)) return [];
  return arr
    .map((x) => String(x == null ? '' : x).replace(/^\s*(\d+[.)-]|[-*•])\s*/, '').replace(/\s+/g, ' ').trim().slice(0, 80))
    .filter(Boolean);
}

function validate(body) {
  const b = body || {};
  const sport = String(b.sport || '').toUpperCase();
  if (!SPORTS.has(sport)) throw new QuickError(400, 'escolha o esporte');
  const preset = b.preset ? presets.presetById(b.preset) : null;
  if (b.preset && !preset) throw new QuickError(400, 'modelo pronto inválido');
  if (preset && !preset.sports.includes(sport)) throw new QuickError(400, `o modelo "${preset.label}" não serve para este esporte`);
  let cfg;
  if (preset) cfg = presets.applyPreset(preset, sport);
  else {
    const format = String(b.format || '').toUpperCase();
    if (!presets.QUICK_FORMATS.includes(format)) throw new QuickError(400, 'escolha o formato (ou um modelo pronto)');
    cfg = presets.plainConfig(format, sport);
  }
  const names = parseNames(b.teams !== undefined ? b.teams : b.teamsText);
  if (names.length > MAX_TEAMS) throw new QuickError(400, `máximo de ${MAX_TEAMS} ${cfg.unit === 'players' ? 'jogadores' : 'times'} (veio ${names.length})`);
  if (cfg.format !== 'PICKUP' && names.length < 2) throw new QuickError(400, 'informe pelo menos 2 times');
  const seen = new Map();
  const dups = [];
  names.forEach((n) => { const k = clubIdentity.normName(n); if (seen.has(k)) dups.push(n); else seen.set(k, n); });
  if (dups.length) throw new QuickError(400, 'nomes repetidos: ' + [...new Set(dups)].slice(0, 5).join(', '), { duplicates: dups });
  const name = String(b.name || '').trim().slice(0, 120) || presets.suggestName(sport, preset || cfg.format);
  return { sport, preset, cfg, names, name, visibility: access.normalizeVisibility(b.visibility) };
}

async function createQuick({ userId, userRole, body }) {
  if (!userId) throw new QuickError(401, 'entre na sua conta para publicar');
  const v = validate(body);
  const { sport, preset, cfg, names, name } = v;
  const isTeamSport = !presets.RACKET_SPORTS.includes(sport) && !cfg.isDoubles;

  const out = await prisma.$transaction(async (tx) => {
    const t = await tx.tournament.create({
      data: {
        slug: await uniqueSlug(tx, name),
        name,
        sport,
        format: cfg.format,
        isDoubles: !!cfg.isDoubles,
        ownerId: userId,
        status: 'OPEN',
        visibility: v.visibility,
        cashEnabled: false, entryFeeCash: 0, prizeCash: 0, // criação rápida nunca liga dinheiro
      },
    });
    const cat = await tx.tournamentCategory.create({
      data: {
        tournamentId: t.id,
        name: 'Geral',
        gender: 'OPEN',
        format: null, // herda o do torneio
        pointsWin: cfg.category.pointsWin,
        pointsDraw: cfg.category.pointsDraw,
        pointsLoss: cfg.category.pointsLoss,
        tiebreakers: cfg.category.tiebreakers || undefined,
        doubleRound: cfg.category.doubleRound,
        gameRules: cfg.category.gameRules,
      },
    });
    let entries = 0;
    let clubs = 0;
    let matches = 0;
    let players = 0;
    if (cfg.format === 'PICKUP') {
      for (const n of names) {
        await tx.pickupPlayer.create({ data: { tournamentId: t.id, name: n } });
        players++;
      }
    } else {
      let i = 0;
      for (const teamName of names) {
        i++;
        // Time = clube (F2). Dupla de raquete não vira clube (igual à migração da F2).
        const pick = isTeamSport
          ? await clubIdentity.clubForNewTeam(tx, t, { teamName, userId, userRole, manager: true, ownerMembership: false })
          : { clubId: null };
        await tx.tournamentEntry.create({
          data: { tournamentId: t.id, categoryId: cat.id, name: teamName, seed: i, status: 'CONFIRMED', clubId: pick.clubId || null },
        });
        entries++;
        if (pick.created) clubs++;
      }
      // Tabela/chave pelo motor, DENTRO da transação.
      const r = await engine.withDb(tx, () => engine.generateFixtures(cat.id, { groupCount: body && body.groupCount }));
      if (!r.ok) throw new QuickError(400, r.error || 'não foi possível gerar a tabela');
      matches = r.matchesCreated != null ? r.matchesCreated : await tx.tournamentMatch.count({ where: { categoryId: cat.id } });
    }
    await tx.tournament.update({ where: { id: t.id }, data: { status: 'ONGOING' } });
    return { t: { ...t, status: 'ONGOING' }, cat, entries, clubs, matches, players };
  }, { timeout: 60000, maxWait: 10000 });

  await audit.record({
    tournamentId: out.t.id, userId, action: 'tournament.create', entity: 'Tournament', entityId: out.t.id,
    after: { quick: true, preset: preset ? preset.id : null, format: cfg.format, sport, teams: out.entries, players: out.players, matches: out.matches, clubsCreated: out.clubs },
  });
  const base = publicBaseUrl();
  const path = cfg.format === 'PICKUP' ? '/racha/' + out.t.slug : '/t/' + out.t.slug;
  const url = base + path;
  const shareText = cfg.format === 'PICKUP'
    ? `Racha "${out.t.name}": confirme sua presença e veja os times sorteados: ${url}`
    : `Tabela de "${out.t.name}" no ar! Jogos, classificação e artilharia: ${url}`;
  return {
    ok: true,
    tournament: { id: out.t.id, slug: out.t.slug, name: out.t.name, sport, format: cfg.format, visibility: out.t.visibility, status: out.t.status },
    categoryId: out.cat.id,
    preset: preset ? preset.id : null,
    entries: out.entries, clubsCreated: out.clubs, matchesCreated: out.matches, players: out.players,
    path, url, shareText, whatsappUrl: 'https://wa.me/?text=' + encodeURIComponent(shareText),
    manageUrl: '/torneios.html#/t/' + out.t.id,
  };
}

module.exports = { QuickError, createQuick, parseNames, validate, MAX_TEAMS, slugify, uniqueSlug };
