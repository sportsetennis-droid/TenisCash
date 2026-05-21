// =====================================================================
// sync-products-from-nfe.js — sincroniza Products a partir de XmlFiscalItem
// =====================================================================
// SOMENTE NFes do tipo 'entrada' (compra de fornecedor).
// Pra cada XmlFiscalItem:
//   1. Procura Product matching por: EAN no sku, supplierRef = cProd,
//      ou (brand + nome contém keywords)
//   2. Se ACHA: vincula item.productId + adiciona NFe ao histórico
//   3. Se NÃO ACHA: cria Product novo com:
//      - sku = "<supplier_prefix>-<cProd>" ou "<EAN>"
//      - name = xProd do XML
//      - brand = supplier.suppliedBrands[0] ou parsed do nome
//      - supplierId (da NFe.supplierId)
//      - aiContext.supplierCnpj, supplierRef, importedFromNFe: chave
//
// Idempotente: roda várias vezes sem duplicar.
// =====================================================================
try {
  const env = require('fs').readFileSync('.env', 'utf8');
  env.split('\n').forEach(l => {
    const m = l.match(/^([^=#]+)=(.*)$/);
    if (m) process.env[m[1].trim()] = m[2].trim().replace(/^["']|["']$/g, '');
  });
} catch {}

const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

const args = Object.fromEntries(process.argv.slice(2).reduce((acc, v, i, a) => {
  if (v.startsWith('--')) acc.push([v.slice(2), a[i + 1] && !a[i + 1].startsWith('--') ? a[i + 1] : true]);
  return acc;
}, []));
const DRY = args.dry || (!args.apply);

function cleanEan(e) { return (e || '').replace(/\D/g, ''); }

(async () => {
  console.log('\n=== Sync Products from NFe Entrada ===');
  console.log('Modo:', DRY ? 'DRY-RUN' : 'APPLY');

  // Pega só items de NFes entrada
  const items = await prisma.$queryRaw`
    SELECT i.id as "itemId", i."supplierCode", i.description, i.ean, i.ncm, i.cfop,
           i.unit, i.quantity, i."unitValue", i."totalValue", i."productId",
           d.id as "docId", d."issuerCnpj", d."issuerName", d."supplierId", d.brand,
           d."accessKey", d."issueDate"
    FROM "XmlFiscalItem" i
    JOIN "XmlFiscalDocument" d ON i."fiscalDocumentId" = d.id
    WHERE d."docType" = 'entrada'
  `;
  console.log('XmlFiscalItem (entrada):', items.length);

  // Suppliers map
  const suppliers = await prisma.supplier.findMany();
  const supById = Object.fromEntries(suppliers.map(s => [s.id, s]));
  const supByCnpj = Object.fromEntries(suppliers.filter(s => s.cnpj).map(s => [s.cnpj, s]));

  // Pre-cache products: lookup por (supplierCnpj + cProd), por EAN no sku, e por nome
  const allProducts = await prisma.product.findMany({
    select: { id: true, sku: true, name: true, brand: true, aiContext: true, active: true },
  });
  const byCnpjCProd = new Map();
  const byEan = new Map();
  for (const p of allProducts) {
    try {
      const ctx = typeof p.aiContext === 'string' ? JSON.parse(p.aiContext) : (p.aiContext || {});
      const cnpj = ctx.supplierCnpj || '';
      const ref = ctx.supplierRef || '';
      if (cnpj && ref) byCnpjCProd.set(cnpj + '||' + ref, p);
      // sku pode ter EAN embutido
      const eans = (p.sku || '').match(/\d{12,14}/g) || [];
      eans.forEach(e => { if (!byEan.has(e)) byEan.set(e, p); });
    } catch {}
  }

  let matched = 0, created = 0, alreadyLinked = 0, skipped = 0;
  const supByCnpjDefaultBrand = (cnpj) => {
    const s = supByCnpj[cnpj];
    return (s?.suppliedBrands && Array.isArray(s.suppliedBrands) && s.suppliedBrands[0]) || null;
  };

  for (const it of items) {
    if (it.productId) { alreadyLinked++; continue; }
    if (!it.description) { skipped++; continue; }
    const cnpj = it.issuerCnpj || '';
    const cProd = (it.supplierCode || '').trim();
    const ean = cleanEan(it.ean);
    let prod = null;

    // 1) match exato (cnpj + cProd)
    if (cnpj && cProd) prod = byCnpjCProd.get(cnpj + '||' + cProd);
    // 2) match por EAN
    if (!prod && ean && ean.length >= 12) prod = byEan.get(ean);

    if (prod) {
      matched++;
      if (!DRY) {
        await prisma.xmlFiscalItem.update({
          where: { id: it.itemId },
          data: { productId: prod.id, matchStatus: 'matched' },
        });
      }
      continue;
    }

    // 3) Cria novo Product
    const brand = it.brand || supByCnpjDefaultBrand(cnpj) || 'A DEFINIR';
    const supplierId = it.supplierId || supByCnpj[cnpj]?.id || null;
    // SKU: prefere EAN se tiver, senão cnpj-cProd
    const sku = ean && ean.length >= 12
      ? `${cnpj.slice(0,4)}-${ean}`
      : `${cnpj.slice(0,4)}-${cProd || it.itemId.slice(-8)}`;

    if (!DRY) {
      try {
        const newProd = await prisma.product.create({
          data: {
            sku,
            name: it.description.slice(0, 200),
            brand,
            category: 'A CLASSIFICAR',
            price: it.unitValue || 0,
            ncm: it.ncm,
            cfop: it.cfop,
            unidade: it.unit || 'UN',
            active: true,
            aiContext: {
              supplierCnpj: cnpj,
              supplierId,
              supplierRef: cProd,
              importedFrom: 'nfe-batch',
              firstNFeKey: it.accessKey,
              firstNFeDate: it.issueDate,
            },
          },
        });
        byCnpjCProd.set(cnpj + '||' + cProd, newProd);
        if (ean) byEan.set(ean, newProd);
        await prisma.xmlFiscalItem.update({
          where: { id: it.itemId },
          data: { productId: newProd.id, matchStatus: 'new_product' },
        });
        created++;
      } catch (e) {
        // sku já existe — só vincula
        const existing = await prisma.product.findUnique({ where: { sku } });
        if (existing) {
          await prisma.xmlFiscalItem.update({ where: { id: it.itemId }, data: { productId: existing.id, matchStatus: 'matched' } });
          matched++;
        } else {
          skipped++;
          if (skipped <= 3) console.error('  ERR criar:', sku, e.message);
        }
      }
    } else {
      created++; // contagem hipotética em dry
    }

    if ((matched + created) % 500 === 0) console.log(`  processados: ${matched + created}/${items.length}...`);
  }

  console.log('\n=== Resumo ===');
  console.log('  Items totais:        ', items.length);
  console.log('  Já vinculados:       ', alreadyLinked);
  console.log('  Matched (existente): ', matched);
  console.log('  Criados (novos):     ', created);
  console.log('  Skipped:             ', skipped);

  if (!DRY) {
    const newTotal = await prisma.product.count();
    const newActive = await prisma.product.count({ where: { active: true } });
    console.log('\nProdutos no banco agora:');
    console.log('  Total: ', newTotal);
    console.log('  Ativos:', newActive);
  }

  await prisma.$disconnect();
})().catch(async e => { console.error('FATAL:', e); await prisma.$disconnect(); process.exit(1); });
