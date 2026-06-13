// Roda o orquestrador BRASIL-INTEL e salva o briefing em docs/intel/.
// Uso: node scripts/run-brasil-intel.js [--fast]   (--fast = só fronts prioritários)
const ROOT = 'C:/Users/sport/TenisCash';
const fs = require('fs');
const path = require('path');

for (const line of fs.readFileSync(ROOT + '/.env', 'utf8').split(/\r?\n/)) {
  const m = line.match(/^\s*([A-Za-z0-9_]+)\s*=(.*)$/);
  if (!m) continue;
  let v = m[2].trim();
  if ((v[0] === '"' && v.endsWith('"')) || (v[0] === "'" && v.endsWith("'"))) v = v.slice(1, -1);
  process.env[m[1]] = v;
}

const { runBrasilIntel, FRONTS } = require(ROOT + '/src/ai/intel/brasilIntel');

(async () => {
  const fast = process.argv.includes('--fast');
  const fronts = fast ? FRONTS.filter((f) => f.priority || ['argentina', 'eua', 'inglaterra'].includes(f.id)) : FRONTS;
  console.log(`BRASIL-INTEL — ${fronts.length} frentes, busca web nativa do Claude...\n`);

  const r = await runBrasilIntel({ fronts });

  console.log('Frentes:');
  for (const f of r.fronts) console.log(`  ${f.ok ? '✅' : '❌'} ${f.label}: ${f.found} achados${f.error ? ' — ' + f.error : ''}`);
  console.log(`\nTotal de achados: ${r.totalItems} · tempo ${r.elapsedSec}s\n`);

  const dir = path.join(ROOT, 'docs', 'intel');
  fs.mkdirSync(dir, { recursive: true });
  const md = path.join(dir, `brasil-intel-${r.date}.md`);
  const json = path.join(dir, `brasil-intel-${r.date}.json`);
  fs.writeFileSync(md, r.briefing, 'utf8');
  fs.writeFileSync(json, JSON.stringify(r, null, 2), 'utf8');

  console.log('Briefing salvo em:', md);
  console.log('\n================ BRIEFING ================\n');
  console.log(r.briefing);
})().catch((e) => { console.error('ERRO:', e.message); process.exit(1); });
