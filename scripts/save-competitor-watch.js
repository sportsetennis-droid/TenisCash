// Atualiza o MONITORAMENTO COMPETITIVO (sob demanda, rodado pelo Claude).
// Grava aiContext.competitorWatch nos produtos pesquisados — preço REAL do concorrente,
// NUNCA inventado. Uso: node scripts/save-competitor-watch.js <arquivo.json> [--apply]
//
// Formato do JSON: [ { "match": "Ghost Max 2", "brand": "BROOKS"(opcional),
//   "competitors": [ { "site":"Amazon", "price":990.72, "inStock":true, "url":"...", "note":"a partir de" } ],
//   "note": "texto livre" } ]
// match = trecho do NOME do produto (case-insensitive). Aplica em TODOS os tênis ativos que casam.
const fs = require('fs');
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

const file = process.argv[2];
const APPLY = process.argv.includes('--apply');
if (!file) { console.log('uso: node scripts/save-competitor-watch.js <arquivo.json> [--apply]'); process.exit(1); }
const updates = JSON.parse(fs.readFileSync(file, 'utf8'));

function parseCtx(v) { try { return typeof v === 'string' ? JSON.parse(v) : (v || {}); } catch { return {}; } }

(async () => {
  const stamp = new Date().toISOString();
  for (const u of updates) {
    const where = { active: true, name: { contains: u.match, mode: 'insensitive' } };
    if (u.brand) where.brand = { contains: u.brand, mode: 'insensitive' };
    const prods = await prisma.product.findMany({ where, select: { id: true, name: true, brand: true, price: true, aiContext: true } });
    if (!prods.length) { console.log(`✗ NENHUM casou "${u.match}"${u.brand ? ' ['+u.brand+']' : ''}`); continue; }
    const cheapest = (u.competitors || []).filter(c => typeof c.price === 'number' && c.price > 0).reduce((a, b) => (a && a.price <= b.price ? a : b), null);
    for (const p of prods) {
      const ctx = parseCtx(p.aiContext);
      ctx.competitorWatch = { updatedAt: stamp, updatedBy: 'claude', competitors: u.competitors || [], note: u.note || '' };
      const tag = cheapest ? `menor R$${cheapest.price} (${cheapest.site}) vs nosso R$${p.price}` : 'sem preço (pendente)';
      console.log(`${APPLY ? '✓' : '·'} ${p.brand} | ${p.name.slice(0, 50)} → ${tag}`);
      if (APPLY) await prisma.product.update({ where: { id: p.id }, data: { aiContext: ctx } });
    }
  }
  console.log(APPLY ? '\n✅ gravado.' : '\n(dry-run — rode com --apply pra gravar)');
  await prisma.$disconnect();
})().catch(e => { console.error(e.message.split('\n')[0]); process.exit(1); });
