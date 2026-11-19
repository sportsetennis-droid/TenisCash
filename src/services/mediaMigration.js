// =====================================================================
// Liga Aberta F5 — migração dos data URI antigos para o mediaStore
// ---------------------------------------------------------------------
// Campos (SÓ torneio/clube/atleta/patrocinador/aviso — nada de produto/Nuvemshop):
//   Tournament.bannerUrl · TournamentEntry.logoUrl · TournamentSponsor.logoUrl ·
//   TournamentPost.imageUrl · Club.crestUrl · AthleteProfile.avatarUrl
// Regras:
//   - LISTA DE EXCLUSÃO (clubIdentity.EXCLUDED_SLUGS — Futsal Master Cup): nada do
//     torneio é tocado; clube ligado a ele (origem, inscrição ou vínculo) e atleta que
//     joga nele também ficam como estão (continuam lendo o data URI antigo).
//   - Idempotente: só pega valor que ainda começa com "data:"; grava com
//     compare-and-set (só troca se o campo ainda é o mesmo data URI).
//   - Em lotes (cursor por id), sem carregar a tabela inteira.
//   - Backup: cada troca é escrita no arquivo (JSON por linha) ANTES do UPDATE:
//     { model, id, field, old, new }. Reverter = volta "old" onde o campo ainda é "new".
//   - SVG/ilegível não migra (fica como está e é listado).
//   - Nunca apaga MediaObject nem dado.
// =====================================================================

const fs = require('fs');
const mediaStore = require('./mediaStore');
const clubIdentity = require('./clubIdentity');
const { parseDataUri, sniffImageType } = require('./imageGuard');

const TARGETS = [
  { model: 'Tournament', delegate: 'tournament', id: 'id', field: 'bannerUrl', scope: 'tournament', tKey: 'id', ownerKey: 'ownerId' },
  { model: 'TournamentEntry', delegate: 'tournamentEntry', id: 'id', field: 'logoUrl', scope: 'tournament', tKey: 'tournamentId' },
  { model: 'TournamentSponsor', delegate: 'tournamentSponsor', id: 'id', field: 'logoUrl', scope: 'tournament', tKey: 'tournamentId' },
  { model: 'TournamentPost', delegate: 'tournamentPost', id: 'id', field: 'imageUrl', scope: 'tournament', tKey: 'tournamentId' },
  { model: 'Club', delegate: 'club', id: 'id', field: 'crestUrl', scope: 'club', ownerKey: 'ownerId' },
  { model: 'AthleteProfile', delegate: 'athleteProfile', id: 'userId', field: 'avatarUrl', scope: 'athlete', ownerKey: 'userId' },
];

async function exclusionSets(db, { includeExcluded = false } = {}) {
  const slugs = includeExcluded ? [] : [...clubIdentity.excludedSlugs()];
  const ts = slugs.length ? await db.tournament.findMany({ where: { slug: { in: slugs } }, select: { id: true } }) : [];
  const tids = ts.map((t) => t.id);
  const clubIds = new Set();
  const userIds = new Set();
  if (tids.length) {
    const [origin, entries, links, members, roster] = await Promise.all([
      db.club.findMany({ where: { originTournamentId: { in: tids } }, select: { id: true } }),
      db.tournamentEntry.findMany({ where: { tournamentId: { in: tids }, clubId: { not: null } }, select: { clubId: true } }),
      db.clubTournamentLink.findMany({ where: { tournamentId: { in: tids } }, select: { clubId: true } }).catch(() => []),
      db.entryMember.findMany({ where: { entry: { tournamentId: { in: tids } } }, select: { userId: true } }),
      db.rosterPlayer.findMany({ where: { userId: { not: null }, entryId: { in: (await db.tournamentEntry.findMany({ where: { tournamentId: { in: tids } }, select: { id: true } })).map((e) => e.id) } }, select: { userId: true } }),
    ]);
    origin.forEach((c) => clubIds.add(c.id));
    entries.forEach((e) => clubIds.add(e.clubId));
    links.forEach((l) => clubIds.add(l.clubId));
    members.forEach((m) => userIds.add(m.userId));
    roster.forEach((r) => userIds.add(r.userId));
  }
  return { tids: new Set(tids), clubIds, userIds, slugs };
}

function classify(value) {
  const p = parseDataUri(value);
  if (!p) return { ok: false, reason: 'data URI ilegível' };
  if (/svg/.test(p.mime)) return { ok: false, reason: 'SVG (não migra; continua fora das rotas públicas)' };
  const type = sniffImageType(p.buf);
  if (!type) return { ok: false, reason: 'não é PNG/JPEG/WEBP/GIF de verdade' };
  return { ok: true, buf: p.buf, type };
}

/**
 * Percorre os campos e (se apply) grava. Retorna o relatório.
 * opts: { apply, backupFile, onlySlugs, includeExcluded, batch, log }
 */
async function run(db, opts = {}) {
  const apply = !!opts.apply;
  const batch = Math.max(1, Math.min(Number(opts.batch) || 25, 200));
  const log = opts.log || (() => {});
  if (apply && !opts.backupFile) throw new Error('backupFile obrigatório para aplicar');
  const ex = await exclusionSets(db, { includeExcluded: !!opts.includeExcluded });
  let onlyTids = null;
  if (opts.onlySlugs && opts.onlySlugs.length) {
    onlyTids = new Set((await db.tournament.findMany({ where: { slug: { in: opts.onlySlugs } }, select: { id: true } })).map((t) => t.id));
  }
  const ownerOfT = new Map();
  const tOwner = async (tid) => {
    if (!ownerOfT.has(tid)) ownerOfT.set(tid, ((await db.tournament.findUnique({ where: { id: tid }, select: { ownerId: true } })) || {}).ownerId || null);
    return ownerOfT.get(tid);
  };
  const report = { apply, excludedSlugs: ex.slugs, fields: {}, skipped: [], migrated: 0, bytes: 0, objectsCreated: 0, keptExcluded: 0 };
  for (const tg of TARGETS) {
    if (onlyTids && tg.scope !== 'tournament') continue; // --only: só campos do torneio
    const key = `${tg.model}.${tg.field}`;
    const fr = (report.fields[key] = { found: 0, migrated: 0, excluded: 0, invalid: 0 });
    let after = null;
    for (;;) {
      const where = { [tg.field]: { startsWith: 'data:' }, ...(after ? { [tg.id]: { gt: after } } : {}) };
      const select = { [tg.id]: true, [tg.field]: true };
      if (tg.tKey && tg.tKey !== tg.id) select[tg.tKey] = true;
      if (tg.ownerKey && tg.ownerKey !== tg.id) select[tg.ownerKey] = true;
      const rows = await db[tg.delegate].findMany({ where, select, orderBy: { [tg.id]: 'asc' }, take: batch });
      if (!rows.length) break;
      after = rows[rows.length - 1][tg.id];
      for (const row of rows) {
        const id = row[tg.id];
        const old = row[tg.field];
        fr.found++;
        const tid = tg.scope === 'tournament' ? row[tg.tKey] : null;
        if (tg.scope === 'tournament' && (ex.tids.has(tid) || (onlyTids && !onlyTids.has(tid)))) { if (ex.tids.has(tid)) { fr.excluded++; report.keptExcluded++; } continue; }
        if (tg.scope === 'club' && ex.clubIds.has(id)) { fr.excluded++; report.keptExcluded++; continue; }
        if (tg.scope === 'athlete' && ex.userIds.has(id)) { fr.excluded++; report.keptExcluded++; continue; }
        const c = classify(old);
        if (!c.ok) { fr.invalid++; report.skipped.push({ model: tg.model, id, field: tg.field, reason: c.reason }); continue; }
        if (!apply) { fr.migrated++; report.migrated++; report.bytes += c.buf.length; continue; }
        const owner = tg.scope === 'tournament' ? (tg.ownerKey ? row[tg.ownerKey] : await tOwner(tid)) : row[tg.ownerKey] || null;
        const put = await mediaStore.putBuffer(c.buf, { source: 'migration', ownerUserId: owner, db });
        if (put.created) report.objectsCreated++;
        // backup ANTES do update (queda no meio = o arquivo já tem o valor antigo)
        fs.appendFileSync(opts.backupFile, JSON.stringify({ model: tg.model, delegate: tg.delegate, idField: tg.id, id, field: tg.field, old, new: put.url }) + '\n');
        const r = await db[tg.delegate].updateMany({ where: { [tg.id]: id, [tg.field]: old }, data: { [tg.field]: put.url } });
        if (r.count) { fr.migrated++; report.migrated++; report.bytes += c.buf.length; }
      }
      log(`  ${key}: ${fr.found} lidos…`);
    }
  }
  return report;
}

/** Reverte a partir do arquivo de backup (JSON por linha). Idempotente. */
async function revert(db, backupFile) {
  const lines = fs.readFileSync(backupFile, 'utf8').split(/\r?\n/).filter(Boolean);
  const allowed = new Map(TARGETS.map((t) => [t.delegate, t]));
  let restored = 0;
  let skipped = 0;
  for (const line of lines) {
    let b;
    try { b = JSON.parse(line); } catch (_) { skipped++; continue; }
    const tg = allowed.get(b.delegate);
    if (!tg || tg.field !== b.field || tg.id !== b.idField || typeof b.old !== 'string' || !/^data:/.test(b.old)) { skipped++; continue; }
    const r = await db[tg.delegate].updateMany({ where: { [tg.id]: b.id, [tg.field]: b.new }, data: { [tg.field]: b.old } });
    if (r.count) restored++; else skipped++;
  }
  return { restored, skipped, lines: lines.length };
}

module.exports = { TARGETS, run, revert, exclusionSets };
