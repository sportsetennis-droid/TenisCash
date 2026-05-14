// =====================================================================
// Import Supplier — lê todos os XMLs de NF-e de um fornecedor e
// importa os produtos pro banco (com IA estruturando nome cru).
// =====================================================================
// Uso:
//   node scripts/import-supplier.js <CNPJ_LIMPO> <PASTA_XMLS> [--dry-run]
//
// Exemplo (CooperShoes — Converse):
//   node scripts/import-supplier.js 02675611000750 "C:/Users/sport/Downloads/nfe-analysis"
//
// O que faz:
//   1. Lê XMLs NFE_* em todas as subpastas da PASTA_XMLS
//   2. Filtra os do CNPJ informado
//   3. Cria/atualiza Supplier no banco
//   4. Pra cada item da NF-e: chama IA pra extrair brand/model/color/size
//   5. Agrupa por baseProductKey (mesmo produto, tamanhos diferentes)
//   6. Cria 1 Product no banco por grupo + ProductSize pra cada variant
//   7. Soma estoque das NF-es (entrada cumulativa)
// =====================================================================

const fs = require('fs');
const path = require('path');
const { PrismaClient } = require('@prisma/client');
const { parseNfeXml } = require('../src/services/xmlNfeParser');
const { extractFromName, groupVariantsByBase } = require('../src/services/productEnrichmentAI');

const prisma = new PrismaClient();

function findXmlFiles(rootDir) {
  const out = [];
  function walk(dir) {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const e of entries) {
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
    console.error('Uso: node scripts/import-supplier.js <CNPJ_14_DIGITOS> <PASTA_XMLS> [--dry-run]');
    process.exit(1);
  }

  console.log(`\n=== Import Supplier ===`);
  console.log(`CNPJ alvo: ${cnpj}`);
  console.log(`Pasta:     ${folder}`);
  console.log(`Modo:      ${dryRun ? 'DRY-RUN (não escreve no banco)' : 'WRITE (persiste)'}\n`);

  const files = findXmlFiles(folder);
  console.log(`Encontrados ${files.length} arquivos NFE_*.xml\n`);

  // 1. Filtra NF-es do fornecedor
  const supplierNotes = [];
  for (const f of files) {
    try {
      const xml = fs.readFileSync(f, 'utf8');
      const parsed = await parseNfeXml(xml);
      if (parsed.issuerCnpj === cnpj) {
        supplierNotes.push({ file: path.basename(f), parsed });
      }
    } catch (_) { /* skip */ }
  }
  console.log(`✓ ${supplierNotes.length} NF-es do CNPJ ${cnpj} encontradas`);
  if (!supplierNotes.length) { console.log('Nada a fazer.'); return; }

  const firstNote = supplierNotes[0].parsed;
  console.log(`Fornecedor: ${firstNote.issuerName}\n`);

  // 2. Cria/atualiza Supplier
  let supplier;
  if (!dryRun) {
    supplier = await prisma.supplier.findUnique({ where: { cnpj } });
    if (supplier) {
      console.log(`Fornecedor já existe no banco (id=${supplier.id})`);
    } else {
      supplier = await prisma.supplier.create({
        data: { companyName: firstNote.issuerName, cnpj, active: true, notes: `Importado via script em ${new Date().toISOString()}` },
      });
      console.log(`✓ Fornecedor criado (id=${supplier.id})`);
    }
  }

  // 3. Junta TODOS os itens das NF-es desse fornecedor
  const allItems = [];
  for (const n of supplierNotes) {
    for (const it of n.parsed.items) {
      allItems.push({
        sku: it.supplierCode || it.ean || `noref-${allItems.length}`,
        rawName: it.description,
        ean: it.ean,
        cost: it.unitValue,
        qty: it.quantity,
        ncm: it.ncm,
        unit: it.unit,
        noteNumber: n.parsed.number,
      });
    }
  }
  console.log(`Total de linhas (variantes brutas): ${allItems.length}`);

  // 4. IA extrai estrutura (se chave disponível). Senão, usa parser simples.
  const useAI = !!process.env.ANTHROPIC_API_KEY;
  console.log(`\nModo: ${useAI ? 'COM IA (estrutura limpa)' : 'SEM IA (parser regex simples)'}\n`);

  function simpleParse(rawName) {
    // Regex simples pra extrair tamanho do final ("...BRANCO 38")
    const m = rawName.match(/^(.*?)\s+(\d{2,3}|PP|P|M|G|GG|XG|XXG|XS|S|L|XL|XXL)\s*$/i);
    let baseName = rawName, size = '';
    if (m) { baseName = m[1].trim(); size = m[2]; }
    // Tenta extrair cor (última palavra com /)
    const colorMatch = baseName.match(/([A-Z]+(?:\/[A-Z]+)+)/);
    const color = colorMatch ? colorMatch[1] : '';
    const baseKey = baseName.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 80);
    return {
      brand: '',
      model: '',
      color,
      size,
      gender: null,
      category: 'tenis',
      subcategory: null,
      sport: null,
      cleanName: baseName,
      baseProductKey: baseKey,
    };
  }

  const enriched = [];
  let totalCostAI = 0;
  for (let i = 0; i < allItems.length; i++) {
    const item = allItems[i];
    process.stdout.write(`\r  ${i + 1}/${allItems.length}                                              `);
    let data;
    if (useAI) {
      const result = await extractFromName(item.rawName, firstNote.issuerName);
      totalCostAI += result.cost || 0;
      data = result.ok ? result.data : null;
      await new Promise((r) => setTimeout(r, 200));
    } else {
      data = simpleParse(item.rawName);
    }
    enriched.push({ ...item, data });
  }
  console.log(`\n✓ Processamento terminou. ${useAI ? 'Custo IA: R$ ' + totalCostAI.toFixed(2) : 'Sem IA (sem custo)'}\n`);

  // 5. Agrupa por baseProductKey
  const groups = groupVariantsByBase(enriched.filter((e) => e.data));
  console.log(`✓ Agrupamento: ${enriched.length} variantes brutas → ${groups.length} produtos únicos\n`);

  // 6. Cria/atualiza Products + ProductSizes
  let created = 0;
  let updated = 0;
  let totalStock = 0;
  for (const g of groups) {
    if (dryRun) {
      console.log(`[DRY] ${g.cleanName || g.brand + ' ' + g.model} — ${g.variants.length} tamanhos, ${g.variants.reduce((s,v)=>s+v.qty,0)} unidades`);
      continue;
    }

    // SKU base único: usa o primeiro EAN se houver, senão o primeiro sku fornecedor
    const baseSku = g.variants[0].ean || g.variants[0].sku;
    const sku = `${cnpj.slice(-4)}-${baseSku}`.slice(0, 64);

    // Referência do fornecedor — tenta 3 fontes em ordem:
    //   1) cProd alfanumérico (não-EAN). Ex: "CT00010001" pra Converse
    //   2) "REF: XYZ1234" no nome do produto. Ex: ALPAR/Adidas usa esse padrão
    //   3) Código no início do nome (2-4 letras + 4-12 dígitos)
    let supplierRef = null;
    const refCandidate = g.variants.find((v) => v.sku && !/^\d{12,14}$/.test(v.sku));
    if (refCandidate) supplierRef = String(refCandidate.sku).toUpperCase();
    if (!supplierRef) {
      const raw = g.variants[0]?.rawName || g.cleanName || '';
      const m1 = raw.match(/REF:\s*([A-Z]{2,4}\d{3,12})/i);
      if (m1) supplierRef = m1[1].toUpperCase();
      else {
        const m2 = raw.match(/\b([A-Z]{2,4}\d{4,12})\b/);
        if (m2) supplierRef = m2[1];
      }
    }

    // Custo médio ponderado pela quantidade — base pro markup
    let totalQty = 0, totalCost = 0;
    for (const v of g.variants) {
      const c = Number(v.cost) || 0;
      const q = Number(v.qty) || 0;
      totalQty += q;
      totalCost += c * q;
    }
    const avgCost = totalQty > 0 ? Math.round((totalCost / totalQty) * 100) / 100 : null;

    const productData = {
      name: g.cleanName || `${g.brand} ${g.model} ${g.color}`.trim(),
      brand: g.brand || 'A DEFINIR',
      category: g.category || 'tenis',
      subcategory: g.subcategory || null,
      price: 0, // será definido depois com markup
      costPrice: avgCost,
      shortDescription: g.cleanName || null,
      active: true,
      source: 'nfe-import',
      aiContext: {
        supplierCnpj: cnpj,
        supplierRef,
        baseProductKey: g.baseKey,
        gender: g.gender,
        sport: g.sport,
        color: g.color,
      },
    };

    let product = await prisma.product.findUnique({ where: { sku } });
    if (product) {
      product = await prisma.product.update({ where: { id: product.id }, data: productData });
      updated++;
    } else {
      product = await prisma.product.create({ data: { sku, ...productData } });
      created++;
    }

    for (const v of g.variants) {
      const size = String(v.size || '');
      if (!size) continue;
      const existing = await prisma.productSize.findFirst({
        where: { productId: product.id, size },
      });
      if (existing) {
        await prisma.productSize.update({
          where: { id: existing.id },
          data: {
            stock: existing.stock + v.qty,
            barcode: v.ean || existing.barcode,
          },
        });
      } else {
        await prisma.productSize.create({
          data: {
            productId: product.id,
            size,
            stock: v.qty,
            barcode: v.ean || null,
          },
        });
      }
      totalStock += v.qty;
    }
  }

  console.log(`\n✅ Resultado:`);
  console.log(`   Produtos criados:    ${created}`);
  console.log(`   Produtos atualizados:${updated}`);
  console.log(`   Estoque somado:      ${totalStock} unidades`);
  console.log(`   Custo IA:            R$ ${totalCostAI.toFixed(2)}`);

  await prisma.$disconnect();
}

main().catch((err) => {
  console.error('\nERRO:', err);
  process.exit(1);
});
