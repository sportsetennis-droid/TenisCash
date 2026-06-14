// Roda o serviço generateDailySlate (testa + popula o Config de prod com a pauta de hoje).
const fs = require('fs'); const path = require('path');
const ROOT = path.join(__dirname, '..');
for (const line of fs.readFileSync(path.join(ROOT, '.env'), 'utf8').split(/\r?\n/)) {
  const m = line.match(/^\s*([A-Za-z0-9_]+)\s*=(.*)$/); if (!m) continue;
  let v = m[2].trim(); if ((v[0] === '"' && v.endsWith('"')) || (v[0] === "'" && v.endsWith("'"))) v = v.slice(1, -1);
  if (!process.env[m[1]]) process.env[m[1]] = v;
}
const { generateDailySlate, getSavedSlate } = require(path.join(ROOT, 'src/services/dailySlate'));
const ctx = process.argv[2];
(async () => {
  const s = await generateDailySlate(ctx ? { ctx } : {});
  console.log(`OK ${s.data} — ${s.produtos.length} produtos + ${s.temas.length} temas = ${s.totalPosts} posts${s.errors.length ? ' | ERROS: ' + s.errors.join('; ') : ''}`);
  const back = await getSavedSlate();
  console.log('Config daily_slate lido de volta:', back ? `${back.totalPosts} posts ✓` : 'VAZIO ✗');
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
