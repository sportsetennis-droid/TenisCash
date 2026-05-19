// =====================================================================
// export-whatsapp-not-found.js
// Lê progress.json e exporta CSV das fotos sem match — pra revisão manual.
// Cada linha: foto, loja, marca extraída, codigoFornecedor, modelo, ean,
// quantidade de tamanhos, lista de tamanhos.
//
// Uso:
//   node scripts/export-whatsapp-not-found.js \
//        --progress /c/tmp/estoque-fotos/parahyba.entries.progress.json \
//        --store LOJA02 \
//        --out /c/tmp/estoque-fotos/parahyba.not-found.csv
// =====================================================================

const fs = require('fs');

const args = Object.fromEntries(process.argv.slice(2).reduce((acc, v, i, a) => {
  if (v.startsWith('--')) acc.push([v.slice(2), a[i + 1] && !a[i + 1].startsWith('--') ? a[i + 1] : true]);
  return acc;
}, []));

const PROGRESS = args.progress;
const STORE = args.store || '';
const OUT = args.out;

if (!PROGRESS || !OUT) {
  console.error('Uso: --progress <file.json> --store <CODE> --out <file.csv>');
  process.exit(1);
}

const progress = JSON.parse(fs.readFileSync(PROGRESS, 'utf8'));
const entries = Object.entries(progress);

function csvCell(v) {
  if (v == null) return '';
  const s = String(v).replace(/"/g, '""').replace(/\n/g, ' ').replace(/\r/g, '');
  return `"${s}"`;
}

const header = ['foto', 'loja', 'marca_extraida', 'codigo_fornecedor', 'modelo', 'cor', 'ean', 'qtd_tamanhos', 'tamanhos', 'motivo_skip', 'raw_text'].map(csvCell).join(',');
const rows = [header];
let count = 0;
for (const [photo, entry] of entries) {
  if (!entry) continue;
  // Inclui NOT FOUND (sem productId) e SKIP (com .skipped)
  if (entry.productId) continue;
  const ext = entry.ext || {};
  const sizes = entry.sizes || [];
  const tamanhos = sizes.map(s => s.qty > 1 ? `${s.size}x${s.qty}` : s.size).join(' | ');
  const row = [
    photo,
    STORE,
    ext.marca || '',
    ext.codigoFornecedor || '',
    ext.modelo || '',
    ext.cor || '',
    ext.ean || '',
    sizes.length,
    tamanhos,
    entry.skipped || ext.erro || '',
    (entry.rawText || ext.raw || '').slice(0, 200),
  ].map(csvCell).join(',');
  rows.push(row);
  count++;
}

fs.writeFileSync(OUT, rows.join('\n'), 'utf8');
console.log(`✓ ${count} fotos sem match exportadas → ${OUT}`);

// Distribuição por marca
const byBrand = {};
for (const [_, entry] of entries) {
  if (!entry || entry.productId) continue;
  const b = (entry.ext && entry.ext.marca) || 'SEM_MARCA';
  byBrand[b] = (byBrand[b] || 0) + 1;
}
console.log('\nPor marca:');
Object.entries(byBrand).sort((a, b) => b[1] - a[1]).forEach(([b, n]) => console.log(`  ${b.padEnd(20)} ${n}`));
