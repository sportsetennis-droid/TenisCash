const fs = require('fs'); const path = require('path');
const ROOT = path.join(__dirname, '..');
for (const line of fs.readFileSync(path.join(ROOT, '.env'), 'utf8').split(/\r?\n/)) {
  const m = line.match(/^\s*([A-Za-z0-9_]+)\s*=(.*)$/); if (!m) continue;
  let v = m[2].trim(); if ((v[0] === '"' && v.endsWith('"')) || (v[0] === "'" && v.endsWith("'"))) v = v.slice(1, -1);
  if (!process.env[m[1]]) process.env[m[1]] = v;
}
const { PrismaClient } = require('@prisma/client'); const prisma = new PrismaClient();
(async () => {
  const r = await prisma.config.findUnique({ where: { key: 'daily_slate' } });
  const s = JSON.parse(r.value);
  const byC = {};
  for (const p of s.produtos) byC[p.conta] = (byC[p.conta] || 0) + 1;
  console.log('por conta:', JSON.stringify(byC));
  console.log('com produtoId+foto:', s.produtos.filter((p) => p.produtoId && p.imageUrl).length, '/', s.produtos.length);
  const comVenda = s.produtos.filter((p) => p.pra_quem && p.resolve).length;
  console.log('com pra_quem+resolve:', comVenda, '/', s.produtos.length);
  const x = s.produtos[0];
  console.log('exemplo:', JSON.stringify({ conta: x.conta, produto: x.produto, gancho: x.gancho, pra_quem: x.pra_quem, resolve: x.resolve }, null, 0));
  if (s.errors && s.errors.length) console.log('ERROS:', s.errors.join(' | '));
  await prisma.$disconnect();
})();
