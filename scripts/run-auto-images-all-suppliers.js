// =====================================================================
// Auto-importa a 1ª imagem da busca pra TODOS os produtos sem imageUrl,
// rodando os 5 fornecedores (CooperShoes, Lu Martins, FILO, TOP, RECCO, HOPE)
// em sequência. Usa o site oficial mapeado pra cada um.
// =====================================================================
// Uso:
//   1. Setar SERPER_API_KEY no .env (mesmo valor que está no Railway)
//   2. Rodar: node scripts/run-auto-images-all-suppliers.js
//
//   Ou one-shot:
//   SERPER_API_KEY=xxx node scripts/run-auto-images-all-suppliers.js
// =====================================================================

// Carrega .env manualmente (não tem dotenv instalado no projeto)
const fs = require('fs');
const path = require('path');
try {
  const envPath = path.join(__dirname, '..', '.env');
  const envFile = fs.readFileSync(envPath, 'utf8');
  for (const line of envFile.split('\n')) {
    const m = line.match(/^\s*([A-Z_][A-Z_0-9]*)\s*=\s*(.*)$/);
    if (m) {
      const key = m[1];
      let val = m[2].trim();
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
        val = val.slice(1, -1);
      }
      if (!process.env[key]) process.env[key] = val;
    }
  }
} catch (_) { /* sem .env, segue sem */ }

const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
const gis = require('../src/services/serperImageSearch');
const { getSupplierMeta } = require('../src/services/supplierOfficialSites');

const TARGETS = [
  { cnpj: '02675611000750', name: 'CooperShoes (Converse)' },
  { cnpj: '20071305000100', name: 'Lu Martins (Lets Gym)' },
  { cnpj: '30535975002390', name: 'FILO SA (Body for Sure)' },
  { cnpj: '07458302000157', name: 'TOP CONFECÇÕES (Caju Brasil)' },
  { cnpj: '76795418000102', name: 'RECCO (Alto Giro)' },
  { cnpj: '03007414000130', name: 'HOPE (Hope Resort)' },
];

async function importImagesFor(cnpj, name) {
  const meta = getSupplierMeta(cnpj);
  const officialSite = meta && meta.site;
  console.log(`\n=== ${name} — CNPJ ${cnpj} ===`);
  console.log(`Site oficial: ${officialSite || '(busca ampla)'}`);

  const products = await prisma.product.findMany({
    where: {
      active: true,
      imageUrl: null,
      aiContext: { path: ['supplierCnpj'], equals: cnpj },
    },
  });
  console.log(`Produtos sem imagem: ${products.length}`);
  if (!products.length) return { ok: 0, failed: 0 };

  let ok = 0, failed = 0;
  for (let i = 0; i < products.length; i++) {
    const product = products[i];
    process.stdout.write(`\r  [${i + 1}/${products.length}] ${product.sku.padEnd(25)}`);
    try {
      const ctx = (() => {
        try { return typeof product.aiContext === 'string' ? JSON.parse(product.aiContext) : (product.aiContext || {}); }
        catch (_) { return {}; }
      })();
      const supplierRef = ctx.supplierRef || null;
      const cleanName = (product.name || '').replace(/\s*\/\s*/g, ' ').replace(/\s+/g, ' ').trim();
      const brandToUse = (meta && meta.brand) || product.brand;
      let query = gis.buildProductQuery({
        brand: brandToUse,
        supplierRef,
        model: cleanName || product.name,
        color: ctx.color,
        category: product.category,
      });
      if (officialSite) query = `${query} site:${officialSite}`.trim();

      const result = await gis.searchImages(query, { count: 5 });
      if (!result.ok || !result.items?.length) {
        failed++;
        continue;
      }
      const first = result.items[0];
      const extras = result.items.slice(1, 5).map((it) => it.url).filter(Boolean);
      await prisma.product.update({
        where: { id: product.id },
        data: {
          imageUrl: first.url,
          imageUrls: extras.length ? extras : undefined,
        },
      });
      ok++;
      await new Promise((r) => setTimeout(r, 250));
    } catch (err) {
      failed++;
    }
  }
  console.log(`\n  → ${ok} importados, ${failed} falhas`);
  return { ok, failed };
}

async function main() {
  if (!gis.isConfigured()) {
    console.error('SERPER_API_KEY não setada. Adiciona em .env ou exporta antes do comando.');
    process.exit(1);
  }
  console.log(`\n=== Auto-importação de imagens — ${TARGETS.length} fornecedores ===`);
  const totals = { ok: 0, failed: 0 };
  for (const t of TARGETS) {
    const r = await importImagesFor(t.cnpj, t.name);
    totals.ok += r.ok;
    totals.failed += r.failed;
  }
  console.log(`\n\n========================================`);
  console.log(`✅ TOTAL: ${totals.ok} imagens importadas, ${totals.failed} falhas`);
  console.log(`========================================\n`);
  await prisma.$disconnect();
}

main().catch((err) => {
  console.error('ERRO:', err);
  process.exit(1);
});
