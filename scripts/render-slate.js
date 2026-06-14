// BATCH RENDER do molde do dia: lê Config daily_slate → p/ cada produto baixa a foto,
// renderiza no padrão travado (render_reel.py) e hospeda o mp4 (catbox) → grava videoUrl no slate.
// Uso: node scripts/render-slate.js [limite]   (limite opcional p/ teste)
const fs = require('fs'); const path = require('path');
const ROOT = path.join(__dirname, '..');
for (const line of fs.readFileSync(path.join(ROOT, '.env'), 'utf8').split(/\r?\n/)) {
  const m = line.match(/^\s*([A-Za-z0-9_]+)\s*=(.*)$/); if (!m) continue;
  let v = m[2].trim(); if ((v[0] === '"' && v.endsWith('"')) || (v[0] === "'" && v.endsWith("'"))) v = v.slice(1, -1);
  if (!process.env[m[1]]) process.env[m[1]] = v;
}
const { PrismaClient } = require('@prisma/client'); const prisma = new PrismaClient();
const { execFileSync } = require('child_process');
const ST = String.raw`C:\Users\sport\st-reinado`;
const OUTDIR = path.join(ST, 'reels_out'); const TMPDIR = path.join(ST, '_batch');
fs.mkdirSync(OUTDIR, { recursive: true }); fs.mkdirSync(TMPDIR, { recursive: true });

async function getImg(url) {
  if (url.startsWith('data:')) return Buffer.from(url.split(',')[1], 'base64');
  const r = await fetch(url); return Buffer.from(await r.arrayBuffer());
}
function slug(s) { return String(s || '').replace(/[^a-z0-9]+/gi, '').slice(0, 16); }

(async () => {
  const limit = parseInt(process.argv[2] || '0', 10);
  const row = await prisma.config.findUnique({ where: { key: 'daily_slate' } });
  const slate = JSON.parse(row.value);
  let prods = slate.produtos || [];
  const targets = limit > 0 ? prods.slice(0, limit) : prods;
  let okN = 0;
  for (let i = 0; i < prods.length; i++) {
    const p = prods[i];
    if (limit > 0 && i >= limit) break;
    if (!p.imageUrl) { console.log(`[${i + 1}] sem foto, pulo`); continue; }
    try {
      const buf = await getImg(p.imageUrl);
      const foto = path.join(TMPDIR, `p${i}.jpg`); fs.writeFileSync(foto, buf);
      const base = `REEL_${slug(p.conta)}_${i}`; const out = path.join(OUTDIR, base + '.mp4');
      const spec = { handle: p.conta, loja: p.loja, produto: p.produto, preco: p.preco, gancho: p.gancho, sub: p.sub || '', foto, palette: p.palette || 'bessa', out };
      fs.writeFileSync(path.join(TMPDIR, base + '.json'), JSON.stringify(spec));
      execFileSync('python', [path.join(ST, 'render_reel.py'), path.join(TMPDIR, base + '.json')], { encoding: 'utf-8' });
      let url = '';
      try { url = execFileSync('curl', ['-s', '-F', 'reqtype=fileupload', '-F', 'fileToUpload=@' + out, 'https://catbox.moe/user/api.php'], { encoding: 'utf-8' }).trim(); } catch (e) { url = ''; }
      p.localMp4 = out; p.videoUrl = url.startsWith('http') ? url : '';
      okN++;
      console.log(`[${i + 1}/${targets.length}] ${p.conta} ${String(p.produto).slice(0, 26)} -> ${p.videoUrl || out}`);
    } catch (e) {
      p.renderError = String(e.message || e).slice(0, 160);
      console.log(`[${i + 1}] ERRO ${p.conta}: ${p.renderError}`);
    }
  }
  slate.renderedAt = new Date().toISOString();
  await prisma.config.update({ where: { key: 'daily_slate' }, data: { value: JSON.stringify(slate) } });
  console.log(`\nRENDER BATCH: ${okN} ok. Config atualizado.`);
  await prisma.$disconnect();
})().catch((e) => { console.error(e); process.exit(1); });
