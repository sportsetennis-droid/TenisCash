// =====================================================================
// Backfill costPrice nos produtos importados — relê as NF-es e calcula
// custo médio ponderado por supplierRef (cProd da NF-e).
// =====================================================================
// Uso:
//   node scripts/backfill-cost-from-nfe.js <CNPJ> <PASTA_XMLS> [--dry-run]
//
// Exemplo (CooperShoes):
//   node scripts/backfill-cost-from-nfe.js 02675611000750 "C:/Users/sport/Downloads/nfe-analysis"
// =====================================================================

const fs = require('fs');
const path = require('path');
const { PrismaClient } = require('@prisma/client');
const { parseNfeXml } = require('../src/services/xmlNfeParser');

const prisma = new PrismaClient();

function findXmlFiles(rootDir) {
  const out = [];
  function walk(dir) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.isFile() && /^NFE_.*\.xml$/i.test(e.name)) out.push(full);
    }
  }
  walk(rootDir);
  return out;
}

async function main() {
  const cnpj = process.argv[2];
  const folder = process.argv[3];
  const dryRun = process.argv.includes('--dry-run');

  if (!cnpj || !folder) {
    console.error('Uso: node scripts/backfill-cost-from-nfe.js <CNPJ> <PASTA_XMLS> [--dry-run]');
    process.exit(1);
  }

  console.log(`\n=== Backfill custo (NF-e → Product.costPrice) ===`);
  console.log(`CNPJ:  ${cnpj}`);
  console.log(`Pasta: ${folder}`);
  console.log(`Modo:  ${dryRun ? 'DRY-RUN' : 'WRITE'}\n`);

  const files = findXmlFiles(folder);
  console.log(`Encontrados ${files.length} XMLs`);

  // 1. Junta TODOS os items das NF-es do CNPJ
  // costsByRef = { CT00010001: { qty: 30, totalCost: 750.00 } }
  // Cada item da NF-e tem cProd (interno do fornecedor, ex "120953"), EAN e a
  // ref do MODELO embutida na descrição (xProd, ex "TENIS CT00010001 CHUCK...").
  // Extrai a ref do modelo via regex sobre a descrição.
  const REF_REGEX = /\b([A-Z]{2,4}\d{6,12})\b/i;
  const costsByRef = new Map();
  for (const f of files) {
    try {
      const xml = fs.readFileSync(f, 'utf8');
      const parsed = await parseNfeXml(xml);
      if (parsed.issuerCnpj !== cnpj) continue;
      for (const it of parsed.items) {
        let ref = null;
        // Tenta 1: ref alfanumérica na descrição (ex: "TENIS CT00010001 ...")
        // É o padrão do CooperShoes — o ref do modelo vem embutido em xProd.
        if (it.description) {
          const m = it.description.match(REF_REGEX);
          if (m) ref = m[1];
        }
        // Tenta 2: cProd, só se for alfanumérico (não puro número, não puro EAN)
        if (!ref && it.supplierCode) {
          const s = String(it.supplierCode);
          if (/[A-Z]/i.test(s) && !/^\d{12,14}$/.test(s)) ref = s;
        }
        if (!ref) continue;
        ref = String(ref).toUpperCase();
        const entry = costsByRef.get(ref) || { qty: 0, totalCost: 0 };
        const q = Number(it.quantity) || 0;
        const c = Number(it.unitValue) || 0;
        entry.qty += q;
        entry.totalCost += c * q;
        costsByRef.set(ref, entry);
      }
    } catch (_) { /* skip */ }
  }
  console.log(`✓ ${costsByRef.size} referências únicas com custo agregado\n`);

  // 2. Pra cada produto do CNPJ, acha a ref e atualiza costPrice
  const products = await prisma.product.findMany({
    where: {
      active: true,
      aiContext: { path: ['supplierCnpj'], equals: cnpj },
    },
    select: { id: true, sku: true, name: true, aiContext: true, costPrice: true },
  });
  console.log(`Encontrados ${products.length} produtos no banco\n`);

  let updated = 0;
  let noRef = 0;
  let noCost = 0;
  const samples = [];

  for (const p of products) {
    const ctx = (() => {
      try { return typeof p.aiContext === 'string' ? JSON.parse(p.aiContext) : (p.aiContext || {}); }
      catch (_) { return {}; }
    })();
    const ref = ctx.supplierRef;
    if (!ref) { noRef++; continue; }

    const entry = costsByRef.get(String(ref).toUpperCase());
    if (!entry || entry.qty === 0) { noCost++; continue; }
    const avgCost = Math.round((entry.totalCost / entry.qty) * 100) / 100;

    if (samples.length < 10) {
      samples.push({ ref, sku: p.sku, name: p.name?.slice(0, 50), oldCost: p.costPrice, newCost: avgCost, qty: entry.qty });
    }

    if (!dryRun) {
      await prisma.product.update({ where: { id: p.id }, data: { costPrice: avgCost } });
    }
    updated++;
  }

  console.log('Amostra:');
  for (const s of samples) {
    console.log(`  ${s.ref}  custo R$ ${s.newCost.toFixed(2)}  (${s.qty} un. em NF-es)  ←  ${s.sku} (${s.name})`);
  }
  console.log(`\n✅ Resultado:`);
  console.log(`   Atualizados:        ${updated}`);
  console.log(`   Sem ref:            ${noRef}`);
  console.log(`   Ref sem custo NFe:  ${noCost}`);

  await prisma.$disconnect();
}

main().catch((err) => {
  console.error('ERRO:', err);
  process.exit(1);
});
