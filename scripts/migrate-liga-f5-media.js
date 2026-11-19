#!/usr/bin/env node
'use strict';
// =====================================================================
// Liga Aberta F5 — tira as imagens antigas (data URI) dos campos do torneio/
// clube/atleta/patrocinador/aviso e guarda no mediaStore ("/media/<sha>.<ext>").
//
// Dry-run (padrão, não grava nada):
//   node scripts/migrate-liga-f5-media.js
// Aplicar (backup JSON por linha ANTES de cada troca):
//   node scripts/migrate-liga-f5-media.js --apply
// Reverter um apply (volta o data URI onde o campo ainda é a URL nova):
//   node scripts/migrate-liga-f5-media.js --revert=scripts/backups/liga-f5-media-<data>.jsonl
// Só alguns torneios (só campos do torneio):   --only=slug1,slug2
// Lote (padrão 25 linhas por consulta):       --batch=25
// Torneio da lista de exclusão (Futsal Master Cup), DEPOIS do evento:
//   node scripts/migrate-liga-f5-media.js --only=futsal-master-cup-2026 --include-excluded           (dry-run)
//   node scripts/migrate-liga-f5-media.js --only=futsal-master-cup-2026 --include-excluded --apply   (aplica)
//
// Regras: idempotente (só pega o que ainda é "data:"; troca com compare-and-set),
// pula a lista de exclusão (src/services/clubIdentity.js EXCLUDED_SLUGS) e o que é
// ligado a ela (clube e atleta do Master Cup), não mexe em produto/Nuvemshop,
// SVG/ilegível fica como está (listado), nunca apaga nada. NÃO roda no boot.
// O backup traz as imagens antigas: fica em scripts/backups/ (fora do git).
// =====================================================================

const fs = require('fs');
const path = require('path');

function arg(name) {
  const hit = process.argv.find((a) => a === '--' + name || a.startsWith('--' + name + '='));
  if (!hit) return null;
  return hit.includes('=') ? hit.slice(hit.indexOf('=') + 1) : true;
}

async function main() {
  if (!process.env.JWT_SECRET) process.env.JWT_SECRET = 'migracao-liga-f5-sem-jwt';
  const { prisma } = require('../src/middleware');
  const { ensureApexSchema } = require('../src/services/ensureApexSchema');
  const mig = require('../src/services/mediaMigration');
  const mediaStore = require('../src/services/mediaStore');
  await ensureApexSchema(prisma);

  const revert = arg('revert');
  if (revert && revert !== true) {
    const r = await mig.revert(prisma, path.resolve(String(revert)));
    console.log(`[liga-f5] revertido: ${r.restored} campo(s) voltaram ao data URI; ${r.skipped} já estavam diferentes (de ${r.lines} linhas). Objetos de mídia ficam (nunca apagar).`);
    await prisma.$disconnect();
    return;
  }

  const only = arg('only');
  const onlySlugs = only && only !== true ? String(only).split(',').map((s) => s.trim()).filter(Boolean) : null;
  const includeExcluded = !!arg('include-excluded');
  if (includeExcluded && !onlySlugs) {
    console.error('[liga-f5] --include-excluded só junto com --only=<slug> (nunca migra a lista de exclusão inteira sem querer).');
    process.exit(2);
  }
  const apply = !!arg('apply');
  const batch = Number(arg('batch')) || 25;
  let backupFile = null;
  if (apply) {
    const dir = path.join(__dirname, 'backups');
    fs.mkdirSync(dir, { recursive: true });
    backupFile = path.join(dir, `liga-f5-media-${new Date().toISOString().replace(/[:.]/g, '-')}.jsonl`);
    fs.writeFileSync(backupFile, '');
  }
  console.log(`[liga-f5] ${apply ? 'APLICANDO' : 'DRY-RUN'} — armazenamento: ${mediaStore.adapterName()} — exclusão: ${includeExcluded ? '(IGNORADA por --include-excluded)' : [...require('../src/services/clubIdentity').excludedSlugs()].join(', ')}`);
  const rep = await mig.run(prisma, { apply, backupFile, onlySlugs, includeExcluded, batch, log: (m) => console.log(m) });
  for (const [k, f] of Object.entries(rep.fields)) console.log(`  ${k}: ${f.found} com data URI · ${apply ? 'migrados' : 'a migrar'} ${f.migrated} · exclusão ${f.excluded} · inválidos ${f.invalid}`);
  for (const s of rep.skipped.slice(0, 50)) console.log(`  ⚠️  ${s.model} ${s.id} ${s.field}: ${s.reason}`);
  console.log(`[liga-f5] total ${apply ? 'migrado' : 'a migrar'}: ${rep.migrated} campo(s), ${(rep.bytes / 1024 / 1024).toFixed(1)} MB de imagem; objetos novos: ${rep.objectsCreated}; mantidos (Master Cup): ${rep.keptExcluded}.`);
  if (apply) console.log(`[liga-f5] backup: ${backupFile}`);
  else console.log('[liga-f5] nada gravado (rode com --apply para aplicar).');
  await prisma.$disconnect();
}

main().catch((e) => { console.error('[liga-f5] ERRO', e); process.exit(1); });
