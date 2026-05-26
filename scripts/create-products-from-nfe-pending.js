// =====================================================================
// Cria Products a partir dos XmlFiscalItem pendentes (sem productId)
// =====================================================================
// Estratégia:
// 1. Agrupa itens pendentes por EAN (cada EAN = 1 SKU único)
// 2. Pra cada EAN, pega o item com MAIOR quantidade (representa o melhor dado)
// 3. Cria Product (active=true, sem imagem, source='nfe-import-auto')
//    + 1 ProductSize com EAN + size inferido do nome + stock=0
// 4. Vincula TODOS os XmlFiscalItem daquele EAN ao Product criado
//
// Uso:
//   node scripts/create-products-from-nfe-pending.js          → preview (max 20)
//   node scripts/create-products-from-nfe-pending.js --apply  → cria todos
// =====================================================================

const { PrismaClient } = require('@prisma/client');
const p = new PrismaClient();
const APPLY = process.argv.includes('--apply');

// Inferência de tamanho a partir do nome (mesmo regex do match-bipes-com-xml.js)
function inferSize(description) {
  if (!description) return 'Único';
  const d = String(description).toUpperCase().trim();
  const acessorios = /\b(MEIA|MEIAS|BOLSA|MOCHILA|GARRAFA|TOALHA|VISEIRA|BONE|BONÉ|BANDEIRA|FAIXA|MUNHEQUEIRA|RAQUETE|BOLA|CORDA|CASQUEIRA|GORRO|TOUCA|LUVA|ÓCULOS|OCULOS|RELOGIO|MEDALHA|TROFEU)\b/;
  if (acessorios.test(d)) return 'Único';
  const mTam = d.match(/\bTAM\.?\s*(\d{2})\b/);
  if (mTam) return mTam[1];
  const mTamL = d.match(/\bTAM\.?\s*(PP|P|M|G|GG|XGG|XG)\b/);
  if (mTamL) return mTamL[1];
  if (/\b\d{2}[\/\-A]\s*\d{2}\b/.test(d) || /\b\d{2}\s+A\s+\d{2}\b/.test(d)) return '?';
  const mEnd = d.match(/\s(\d{2})\s*$/);
  if (mEnd) return mEnd[1];
  if (/\b(PP|XGG|XG|GG|G|M|P)\b\s*$/.test(d)) {
    const m = d.match(/\b(PP|XGG|XG|GG|G|M|P)\b\s*$/);
    if (m) return m[1];
  }
  return 'Único';
}

// Extrai marca do nome (heurística simples)
const KNOWN_BRANDS = ['UMBRO','NIKE','ADIDAS','PUMA','MIZUNO','ASICS','FILA','TOPPER','OLYMPIKUS','PENALTY','UHLSPORT','KAPPA','LUPO','HAVAIANAS','RIDER','IPANEMA','KENNER','OAKLEY','MORMAII','PROGNE','SPALDEEN','JOMA','BABOLAT','WILSON','YONEX','HEAD','SPEEDO','ARENA','UNDER ARMOUR','CAJUBRASIL','CAJU','FIBER','CHX','REEBOK','DIADORA','VANS','CONVERSE','LACOSTE'];
function inferBrand(description, nfeBrand) {
  if (nfeBrand) return nfeBrand;
  if (!description) return null;
  const d = String(description).toUpperCase();
  for (const b of KNOWN_BRANDS) {
    if (d.includes(b)) return b;
  }
  return null;
}

(async () => {
  console.log('🔎 Buscando XmlFiscalItem pendentes de NFe de ENTRADA (compras de fornecedor)...');
  console.log('   ⚠️  Transferencias sao IGNORADAS por regra (CLAUDE.md):');
  console.log('   transferencia NAO cria Product, so aparece em card existente.');
  const pendingItems = await p.xmlFiscalItem.findMany({
    where: {
      productId: null,
      ean: { not: null },
      fiscalDocument: { docType: 'entrada' }, // SO entrada, NUNCA transferencia
    },
    include: { fiscalDocument: { select: { brand: true, issuerName: true, docType: true } } },
  });
  // Defesa extra: nem se filtro falhar, deixa passar transferencia
  const onlyEntradaItems = pendingItems.filter(i => i.fiscalDocument?.docType === 'entrada');
  if (onlyEntradaItems.length !== pendingItems.length) {
    console.warn(`  ⚠️  Filtro deixou passar ${pendingItems.length - onlyEntradaItems.length} transferencias, descartadas pela defesa extra`);
  }
  // EANs válidos
  const validItems = onlyEntradaItems.filter(i => i.ean && i.ean.length >= 8 && i.ean !== 'SEM GTIN');
  console.log(`  ${onlyEntradaItems.length} pendentes de ENTRADA, ${validItems.length} com EAN válido`);

  // Agrupa por EAN
  const byEan = {};
  validItems.forEach(item => {
    if (!byEan[item.ean]) byEan[item.ean] = [];
    byEan[item.ean].push(item);
  });
  const uniqueEans = Object.keys(byEan);
  console.log(`  ${uniqueEans.length} EANs únicos pra processar\n`);

  let created = 0, linked = 0, skipped = 0, errors = 0;

  for (let i = 0; i < uniqueEans.length; i++) {
    const ean = uniqueEans[i];
    if (i % 100 === 0) process.stdout.write(`  ${i}/${uniqueEans.length}\r`);

    // Pega item com maior qty (melhor representante)
    const items = byEan[ean].sort((a, b) => (b.quantity || 0) - (a.quantity || 0));
    const best = items[0];

    // Verifica se já existe ProductSize com esse barcode
    const existingSize = await p.productSize.findFirst({
      where: { barcode: ean },
      include: { product: { select: { id: true } } },
    });
    if (existingSize) {
      // Só vincula os items àquele product e pula criação
      if (APPLY) {
        await p.xmlFiscalItem.updateMany({
          where: { ean, productId: null },
          data: { productId: existingSize.product.id, matchStatus: 'matched' },
        });
        linked += items.length;
      }
      skipped++;
      continue;
    }

    if (!APPLY) continue;

    try {
      const description = (best.description || 'Produto sem descrição').trim().slice(0, 200);
      const brand = inferBrand(description, best.fiscalDocument?.brand);
      const sku = `nfe-${ean}`;
      const size = inferSize(description);

      // Cria Product
      const product = await p.product.create({
        data: {
          sku,
          name: description,
          brand: brand || 'SEM MARCA',
          category: 'A CLASSIFICAR',
          active: true,
          price: 0,
          source: 'nfe-import-auto',
          aiContext: { needsCuration: true, createdFromNfe: true, sourceFornecedor: best.fiscalDocument?.issuerName || null },
        },
      });

      // Cria ProductSize com o EAN
      await p.productSize.create({
        data: {
          productId: product.id,
          size,
          barcode: ean,
          stock: 0,
        },
      });

      // Vincula TODOS os items daquele EAN
      await p.xmlFiscalItem.updateMany({
        where: { ean, productId: null },
        data: { productId: product.id, matchStatus: 'matched' },
      });

      created++;
      linked += items.length;
    } catch (err) {
      errors++;
      if (errors <= 5) console.log(`  ERR ${ean}: ${err.message.slice(0, 80)}`);
    }
  }

  console.log('\n\n=== RESULTADO ===');
  console.log(`EANs únicos processados: ${uniqueEans.length}`);
  console.log(`✅ Products NOVOS criados: ${created}`);
  console.log(`🔗 Items NFe re-vinculados: ${linked}`);
  console.log(`⏭️  Pulados (já tinha barcode): ${skipped}`);
  console.log(`❌ Erros: ${errors}`);
  if (!APPLY) console.log('\n💡 Era PREVIEW. Pra criar de verdade: node scripts/create-products-from-nfe-pending.js --apply');
  process.exit(0);
})().catch((e) => { console.error('FATAL:', e); process.exit(1); });
