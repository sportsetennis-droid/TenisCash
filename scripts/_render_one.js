// Prova do engine: pega 1 produto real (CG/Messi), baixa foto, usa gancho da pauta, renderiza mp4.
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

async function getImg(url) {
  if (url.startsWith('data:')) { const b64 = url.split(',')[1]; return Buffer.from(b64, 'base64'); }
  const r = await fetch(url); return Buffer.from(await r.arrayBuffer());
}

(async () => {
  const store = await prisma.store.findFirst({ where: { name: { contains: 'Rainha' }, active: true }, select: { id: true } });
  const rows = await prisma.$queryRawUnsafe(`
    SELECT p.id,p.brand,p.name,p.price,p."imageUrl", SUM(ss.stock)::int qt
    FROM "StoreStock" ss JOIN "ProductSize" psz ON psz.id=ss."productSizeId" JOIN "Product" p ON p.id=psz."productId"
    WHERE ss."storeId"=$1 AND ss.stock>0 AND p.active AND p."imageUrl" IS NOT NULL AND p.price>0 AND p.name ILIKE '%MESSI%'
    GROUP BY p.id ORDER BY qt DESC LIMIT 1`, store.id);
  const p = rows[0]; if (!p) { console.log('sem produto MESSI com foto'); process.exit(1); }
  const buf = await getImg(p.imageUrl); const foto = path.join(ST, '_prod_tmp.jpg'); fs.writeFileSync(foto, buf);
  let gancho = 'A chuteira do Messi chegou em Campina Grande.';
  try {
    const slate = JSON.parse((await prisma.config.findUnique({ where: { key: 'daily_slate' } })).value);
    const cg = (slate.produtos || []).find((x) => x.conta === '@sportsetenniscg' && /messi|f50/i.test(x.produto));
    if (cg) gancho = cg.gancho;
  } catch {}
  const nome = (p.brand + ' ' + p.name)
    .replace(/REF:.*?-\s*/, '').replace(/\bCHUTEIRA\b/i, '').replace(/\b\d{2}\/\d{2}\b/g, '')
    .replace(/\s+/g, ' ').trim().slice(0, 40);
  const preco = 'R$ ' + Number(p.price).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const out = path.join(ST, 'REEL_CG_MESSI.mp4');
  const spec = { handle: '@sportsetenniscg', loja: 'Rainha da Borborema', produto: nome, preco, gancho, sub: '', foto, palette: 'cg', out };
  fs.writeFileSync(path.join(ST, '_spec_tmp.json'), JSON.stringify(spec));
  console.log('PRODUTO:', nome, '|', preco, '| foto', buf.length, 'bytes\nGANCHO:', gancho);
  const o = execFileSync('python', [path.join(ST, 'render_reel.py'), path.join(ST, '_spec_tmp.json')], { encoding: 'utf-8' });
  console.log('RENDER:', o.trim());
  await prisma.$disconnect();
})().catch((e) => { console.error(e.message || e); process.exit(1); });
