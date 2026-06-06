// Cria os ProductSize que faltam: EANs comprados (NFe entrada) cujo card JÁ EXISTE
// (XmlFiscalItem.productId setado) mas o tamanho nunca foi criado. comprado = qtd da NFe.
// NÃO cria card novo, NÃO mexe no localizado. DRY-RUN por padrão; --apply pra escrever.
const fs = require('fs'); const path = require('path');
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
const APPLY = process.argv.includes('--apply');

// só aceita tamanho PLAUSÍVEL: calçado EU/BR 33-48, ou letra P..GG. Resto = inválido (vira placeholder).
function plaus(s) {
  if (!s) return null;
  const t = String(s).toUpperCase().trim();
  if (/^(PP|P|M|G|GG|XG|XGG)$/.test(t)) return t;
  if (/^\d{2}(\.5)?$/.test(t)) { const n = parseFloat(t); if (n >= 33 && n <= 48) return t; }
  return null;
}
function inferSize(desc, sc) {
  const d = String(desc || '').toUpperCase().trim();
  if (/\b(MEIA|MEIAS|BOLSA|MOCHILA|GARRAFA|TOALHA|VISEIRA|BONE|BANDEIRA|FAIXA|MUNHEQUEIRA|RAQUETE|BOLA|CORDA|GORRO|TOUCA|LUVA|OCULOS|RELOGIO|MEDALHA|TROFEU|NECESSAIRE|SACOLA|SQUEEZE)\b/.test(d)) return 'Único';
  let m = d.match(/TAMANHO:\s*([A-Z0-9.]+)/); if (m) { const v = plaus(m[1]); if (v) return v; }
  m = d.match(/\bTAM\.?\s*([A-Z0-9.]+)/); if (m) { const v = plaus(m[1]); if (v) return v; }
  if (sc) { // último segmento do código OU final, mas só se for tamanho plausível
    let v = plaus(String(sc).split(/[-_. ]/).pop()); if (v) return v;
    const tr = String(sc).match(/(\d{2}(?:\.5)?)$/); if (tr) { v = plaus(tr[1]); if (v) return v; }
  }
  m = d.match(/\b(PP|XGG|XG|GG|G|M|P)\b\s*$/); if (m) return m[1];
  return null;
}

(async () => {
  // EANs faltando + productId (card) + descrição + supplierCode + qtd
  const rows = await prisma.$queryRawUnsafe(`
    SELECT xi.ean, xi."productId" pid, max(xi.description) descr, max(xi."supplierCode") sc, sum(xi.quantity)::int qty
    FROM "XmlFiscalItem" xi JOIN "XmlFiscalDocument" xd ON xd.id=xi."fiscalDocumentId"
    WHERE xd."docType"='entrada' AND xi.ean IS NOT NULL AND length(xi.ean)>=6 AND xi."productId" IS NOT NULL
      AND NOT EXISTS(SELECT 1 FROM "ProductSize" pz WHERE pz.barcode=xi.ean)
    GROUP BY xi.ean, xi."productId"`);
  // só os cujo product está ativo
  const pids = [...new Set(rows.map(r => r.pid))];
  const active = new Set((await prisma.product.findMany({ where: { id: { in: pids }, active: true }, select: { id: true } })).map(p => p.id));
  const work = rows.filter(r => active.has(r.pid));
  console.log(`EANs faltando (card ativo): ${work.length} · produtos: ${new Set(work.map(r => r.pid)).size} · unidades: ${work.reduce((a, r) => a + r.qty, 0)}`);

  // agrupa por produto p/ controlar tamanho único
  const byProd = {};
  for (const r of work) (byProd[r.pid] = byProd[r.pid] || []).push(r);

  if (!APPLY) {
    // amostra de tamanhos inferidos
    console.log('\nAmostra (10) de tamanhos inferidos:');
    work.slice(0, 10).forEach(r => console.log(`  ean ${r.ean} sc=${(r.sc || '').slice(0, 16).padEnd(16)} → tam "${inferSize(r.descr, r.sc) || 'T-' + r.ean.slice(-4)}"  qtd ${r.qty}  | ${(r.descr || '').slice(0, 32)}`));
    let semTam = work.filter(r => !inferSize(r.descr, r.sc)).length;
    console.log(`\ntamanhos sem inferência (vão de fallback T-EAN): ${semTam} de ${work.length}`);
    console.log('DRY-RUN. --apply pra criar.');
    await prisma.$disconnect(); return;
  }

  // backup
  const dir = path.join(process.cwd(), 'scripts', 'backups'); fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'missing-sizes-' + Date.now() + '.json'), JSON.stringify(work.map(r => ({ ean: r.ean, pid: r.pid, qty: r.qty }))));

  let created = 0;
  for (const pid of Object.keys(byProd)) {
    const used = new Set((await prisma.productSize.findMany({ where: { productId: pid }, select: { size: true } })).map(s => s.size));
    for (const r of byProd[pid]) {
      let sz = inferSize(r.descr, r.sc) || ('T-' + r.ean.slice(-4));
      while (used.has(sz)) sz = sz + '·' + r.ean.slice(-3);
      used.add(sz);
      try { await prisma.productSize.create({ data: { productId: pid, size: sz, barcode: r.ean, stock: r.qty } }); created++; }
      catch (e) { /* skip dup/err */ }
    }
  }
  console.log(`\nFEITO. ProductSize criados: ${created}`);
  await prisma.$disconnect();
})().catch((e) => { console.error('ERR', e.message); process.exit(1); });
