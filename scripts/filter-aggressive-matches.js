// =====================================================================
// filter-aggressive-matches.js
// Pega entries do progress.json com matchedBy in (model_only,
// code_loose_6) e valida — se a marca extraída pelo Vision não-OUTRO
// diverge da marca do produto, reverte pra NOT FOUND.
//
// Mantém brand_alias_* (alta confiança) e code_loose_7/8 (substring
// suficientemente única). model_only com marca compatível também
// permanece.
//
// Uso:
//   node scripts/filter-aggressive-matches.js \
//        --progress <file.json> --dry
//   (sem --dry, sobrescreve o progress.json)
// =====================================================================

try {
  const env = require('fs').readFileSync('.env', 'utf8');
  env.split('\n').forEach(l => {
    const m = l.match(/^([^=#]+)=(.*)$/);
    if (m) process.env[m[1].trim()] = m[2].trim().replace(/^["']|["']$/g, '');
  });
} catch {}

const fs = require('fs');
const { PrismaClient } = require('@prisma/client');

const args = Object.fromEntries(process.argv.slice(2).reduce((acc, v, i, a) => {
  if (v.startsWith('--')) acc.push([v.slice(2), a[i + 1] && !a[i + 1].startsWith('--') ? a[i + 1] : true]);
  return acc;
}, []));

const PROGRESS = args.progress;
const DRY = !!args.dry;
if (!PROGRESS) { console.error('Uso: --progress <file.json> [--dry]'); process.exit(1); }

const prisma = new PrismaClient();

// Normaliza nome de marca pra comparação
function normBrand(b) {
  if (!b) return '';
  return String(b).toUpperCase()
    .replace(/UNDER ARMOUR|UA/g, 'UA')
    .replace(/CAJU BRASIL|CAJUBRASIL/g, 'CAJU')
    .replace(/NEW BALANCE|NB/g, 'NB')
    .replace(/[^A-Z]/g, '');
}

function brandsCompatible(extBrand, prodBrand) {
  if (!extBrand || extBrand === 'OUTRO') return true; // OUTRO casa com qualquer
  const a = normBrand(extBrand);
  const b = normBrand(prodBrand);
  if (!a || !b) return true;
  return a === b || a.includes(b) || b.includes(a);
}

(async () => {
  const progress = JSON.parse(fs.readFileSync(PROGRESS, 'utf8'));
  let kept = 0, reverted = 0, untouched = 0;
  const stats = {};
  const reasons = { brand_mismatch: 0, kept_safe: 0, kept_brand_match: 0 };

  for (const [photo, entry] of Object.entries(progress)) {
    if (!entry || !entry.matchedBy || !entry.productId) { untouched++; continue; }

    // Estratégias seguras — manter sempre
    const STRATEGIES_SAFE = ['ean', 'supplierRef', 'sku', 'name', 'name_prefix', 'supplierRef_prefix', 'supplierRef_startsWith', 'name_fuzzy'];
    if (STRATEGIES_SAFE.includes(entry.matchedBy)) {
      kept++; stats[entry.matchedBy] = (stats[entry.matchedBy] || 0) + 1;
      reasons.kept_safe++; continue;
    }

    // Estratégias agressivas — valida marca
    const prod = await prisma.product.findUnique({
      where: { id: entry.productId },
      select: { brand: true, name: true, sku: true },
    });
    if (!prod) {
      // Produto não existe mais — reverte
      delete entry.productId; delete entry.matchedBy; entry.matched = false;
      reverted++; continue;
    }

    const extBrand = entry.ext?.marca || '';
    const compatible = brandsCompatible(extBrand, prod.brand);

    if (compatible) {
      // OK: marca extraída bate (ou é OUTRO) → mantém
      kept++; stats[entry.matchedBy] = (stats[entry.matchedBy] || 0) + 1;
      reasons.kept_brand_match++;
    } else {
      // Falso positivo provável → reverte
      console.log(`REV: ${photo.slice(0,18)} ext=${extBrand} prod=${prod.brand} via ${entry.matchedBy} → ${prod.name.slice(0,55)}`);
      delete entry.productId; delete entry.matchedBy; entry.matched = false;
      reverted++; reasons.brand_mismatch++;
    }
  }

  console.log('\n=== Resumo ===');
  console.log(`  Mantidos:  ${kept}`);
  console.log(`  Revertidos:${reverted}  (${reasons.brand_mismatch} brand mismatch)`);
  console.log(`  Sem match: ${untouched}`);
  console.log('  Por estratégia (mantidos):');
  Object.entries(stats).sort((a,b) => b[1]-a[1]).forEach(([k,n]) => console.log('    ' + k.padEnd(28) + ' ' + n));

  if (!DRY) {
    fs.writeFileSync(PROGRESS, JSON.stringify(progress, null, 2));
    console.log('\n✓ Progress salvo:', PROGRESS);
  } else {
    console.log('\n(DRY-RUN — progress não foi alterado)');
  }
  await prisma.$disconnect();
})().catch(async e => { console.error(e); await prisma.$disconnect(); process.exit(1); });
