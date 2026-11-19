#!/usr/bin/env node
'use strict';
// =====================================================================
// Liga Aberta F2 — liga cada inscrição de TIME a um Club (TournamentEntry.clubId).
//
// Dry-run (padrão, não escreve nada):
//   node scripts/migrate-liga-f2-clubs.js
// Aplicar (grava backup JSON antes):
//   node scripts/migrate-liga-f2-clubs.js --apply
// Só alguns torneios:          --only=slug1,slug2
// Torneio da lista de exclusão (ex.: Futsal Master Cup, DEPOIS do evento 20–22/11/2026):
//   node scripts/migrate-liga-f2-clubs.js --only=futsal-master-cup-2026 --include-excluded          (dry-run)
//   node scripts/migrate-liga-f2-clubs.js --only=futsal-master-cup-2026 --include-excluded --apply  (aplica)
// Reverter um apply:           --revert=scripts/backups/liga-f2-clubs-<data>.json
//
// Regras: agrupa por nome normalizado DENTRO do mesmo torneio (nunca junta torneios
// diferentes), reaproveita Club de vínculo explícito (ClubTournamentLink), pula a lista
// de exclusão (src/services/clubIdentity.js EXCLUDED_SLUGS) e é idempotente.
// =====================================================================

const fs = require('fs');
const path = require('path');

function arg(name) {
  const hit = process.argv.find((a) => a === '--' + name || a.startsWith('--' + name + '='));
  if (!hit) return null;
  return hit.includes('=') ? hit.slice(hit.indexOf('=') + 1) : true;
}

async function main() {
  if (!process.env.JWT_SECRET) process.env.JWT_SECRET = 'migracao-liga-f2-sem-jwt';
  const { prisma } = require('../src/middleware');
  const { ensureApexSchema } = require('../src/services/ensureApexSchema');
  const ci = require('../src/services/clubIdentity');
  await ensureApexSchema(prisma);

  const revert = arg('revert');
  if (revert && revert !== true) {
    const backup = JSON.parse(fs.readFileSync(path.resolve(String(revert)), 'utf8'));
    const r = await ci.revertMigration(prisma, backup.applied || backup);
    console.log(`[liga-f2] revertido: ${r.entries} inscrição(ões) voltaram a clubId=null; ${r.clubsKept} clube(s) criados ficam (sem apagar).`);
    await prisma.$disconnect();
    return;
  }

  const only = arg('only');
  const onlySlugs = only && only !== true ? String(only).split(',').map((s) => s.trim()).filter(Boolean) : null;
  const includeExcluded = !!arg('include-excluded');
  const apply = !!arg('apply');

  const plan = await ci.planMigration(prisma, { onlySlugs, includeExcluded });
  console.log(`[liga-f2] ${apply ? 'APLICANDO' : 'DRY-RUN'} — exclusão: ${[...ci.excludedSlugs()].join(', ')}${includeExcluded ? ' (IGNORADA por --include-excluded)' : ''}`);
  for (const s of plan.skipped) console.log(`  ⏭️  ${s.slug} — ${s.reason}`);
  for (const tp of plan.tournaments) {
    console.log(`  🏆 ${tp.slug} (${tp.name})`);
    for (const g of tp.groups) {
      console.log(`     - "${g.names.join('" / "')}" → ${g.create ? 'clube NOVO "' + g.create.name + '"' : 'clube existente ' + g.clubId + ' (' + g.source + ')'} · ${g.entryIds.length} inscrição(ões)`);
    }
  }
  for (const c of plan.conflicts) console.log(`  ⚠️  CONFLITO ${c.slug} "${c.key}": ${c.reason} (${c.clubIds.join(', ')}) — não mexi`);
  console.log(`[liga-f2] grupos=${plan.totals.groups} inscrições a ligar=${plan.totals.entriesToLink} clubes novos=${plan.totals.clubsToCreate} reaproveitados=${plan.totals.clubsReused} já ligadas=${plan.totals.alreadyLinked} conflitos=${plan.conflicts.length}`);

  if (!apply) {
    console.log('[liga-f2] nada gravado (rode com --apply para aplicar).');
    await prisma.$disconnect();
    return;
  }
  const dir = path.join(__dirname, 'backups');
  fs.mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const file = path.join(dir, `liga-f2-clubs-${stamp}.json`);
  fs.writeFileSync(file, JSON.stringify({ at: new Date().toISOString(), plan }, null, 2));
  const applied = await ci.applyMigration(prisma, plan, {
    onTournamentDone: (sofar) => fs.writeFileSync(file, JSON.stringify({ at: new Date().toISOString(), plan, applied: sofar, partial: true }, null, 2)),
  });
  fs.writeFileSync(file, JSON.stringify({ at: new Date().toISOString(), plan, applied }, null, 2));
  console.log(`[liga-f2] aplicado: ${applied.linked.reduce((s, l) => s + l.updated, 0)} inscrição(ões) ligadas, ${applied.clubsCreated.length} clube(s) criados. Backup: ${file}`);
  await prisma.$disconnect();
}

main().catch((e) => { console.error('[liga-f2] falhou:', e); process.exit(1); });
