// =====================================================================
// scripts/match-bipes-com-xml.js
// =====================================================================
// Pega bipes órfãos (found=false) e tenta achar o EAN nas NFes
// processadas (XmlFiscalItem). Cruza barcode <-> ean e mostra:
//   - bipes que dá pra resolver (EAN existe em XML + tem productId vinculado)
//   - bipes que existe em XML mas SEM productId vinculado (precisa cadastrar)
//   - bipes que NEM tem no XML (produto realmente novo / fora do catálogo)
//
// Modo:
//   node scripts/match-bipes-com-xml.js              → só relatório
//   node scripts/match-bipes-com-xml.js --apply      → aplica matches automáticos
//                                                      (vincula barcode ao ProductSize correto)
// =====================================================================

const { PrismaClient } = require('@prisma/client');
const p = new PrismaClient();

const APPLY = process.argv.includes('--apply');
const PREVIEW = process.argv.includes('--preview');

// =====================================================
// Parser de tamanho a partir do nome do produto no XML
// =====================================================
// Cada EAN é único por SKU. O nome no XML pode ter:
//   - "MEIA LUPO AU"             → acessório → size='Único'
//   - "TENIS DURAMO SL 34/39"    → range ambíguo (várias SKUs agrupadas) → size='?'
//   - "CAMISETA UMBRO TAM M"     → tamanho explícito → size='M'
//   - "CHUTEIRA ASICS 41"        → tamanho no fim → size='41'
function inferSize(description) {
  if (!description) return 'Único';
  const d = String(description).toUpperCase().trim();

  // 1. Acessórios = tamanho único
  const acessorios = /\b(MEIA|MEIAS|BOLSA|MOCHILA|GARRAFA|TOALHA|VISEIRA|BONE|BONÉ|BANDEIRA|FAIXA|MUNHEQUEIRA|RAQUETE|BOLA|CORDA|CASQUEIRA|GORRO|TOUCA|LUVA|ÓCULOS|OCULOS|RELOGIO|MEDALHA|TROFEU)\b/;
  if (acessorios.test(d)) return 'Único';

  // 2. "TAM XX" ou "TAM. XX" — número
  const mTam = d.match(/\bTAM\.?\s*(\d{2})\b/);
  if (mTam) return mTam[1];

  // 3. "TAM PP/P/M/G/GG/XGG" — letra
  const mTamL = d.match(/\bTAM\.?\s*(PP|P|M|G|GG|XGG|XG)\b/);
  if (mTamL) return mTamL[1];

  // 4. Range numérico "34/39" "34-39" "34 A 39" → ambíguo (várias SKUs num só EAN, raro)
  if (/\b\d{2}[\/\-A]\s*\d{2}\b/.test(d) || /\b\d{2}\s+A\s+\d{2}\b/.test(d)) return '?';

  // 5. Número solto no fim do nome (após espaço): "TENIS NIKE 42" → 42
  const mEnd = d.match(/\s(\d{2})\s*$/);
  if (mEnd) return mEnd[1];

  // 6. Padrão letra solta "P/G" "M/G"
  if (/\b(PP|XGG|XG|GG|GG|G|M|P)\b\s*$/.test(d)) {
    const m = d.match(/\b(PP|XGG|XG|GG|G|M|P)\b\s*$/);
    if (m) return m[1];
  }

  // 7. Default
  return 'Único';
}

(async () => {
  console.log('🔎 Buscando bipes órfãos (found=false)...');
  const orphans = await p.stocktakeBipe.findMany({
    where: { found: false },
    select: { id: true, barcode: true, sellerName: true, bipedAt: true, storeId: true },
    orderBy: { bipedAt: 'desc' },
  });
  console.log(`  → ${orphans.length} bipes órfãos no total`);

  // Agrupa por barcode (não interessa quantos bipes do mesmo código)
  const byBarcode = {};
  for (const b of orphans) {
    if (!byBarcode[b.barcode]) byBarcode[b.barcode] = [];
    byBarcode[b.barcode].push(b);
  }
  const uniqueBarcodes = Object.keys(byBarcode);
  console.log(`  → ${uniqueBarcodes.length} barcodes únicos\n`);

  // Cruza cada barcode com XmlFiscalItem.ean
  let resolvidos = 0;       // tem EAN no XML + productId vinculado
  let semProduto = 0;        // tem EAN no XML mas item sem productId
  let foraDeCatalogo = 0;    // não tem em nenhum XML
  const matchesPraAplicar = []; // { barcode, productId, sizes: [] }
  const semProdutoList = [];
  const foraList = [];

  console.log('🔄 Cruzando com NFes processadas...');
  let idx = 0;
  for (const barcode of uniqueBarcodes) {
    idx++;
    if (idx % 20 === 0) process.stdout.write(`  ${idx}/${uniqueBarcodes.length}\r`);

    const xmlItems = await p.xmlFiscalItem.findMany({
      where: { ean: barcode },
      select: { id: true, description: true, productId: true, supplierCode: true, fiscalDocument: { select: { issuerName: true, brand: true } } },
      take: 5,
    });

    if (xmlItems.length === 0) {
      foraDeCatalogo++;
      foraList.push({ barcode, bipes: byBarcode[barcode].length });
      continue;
    }

    // Tem em XML — algum tem productId vinculado?
    const withProduct = xmlItems.find(i => i.productId);
    if (withProduct) {
      resolvidos++;
      // Busca ProductSize correto pra esse produto (pra vincular o barcode)
      const sizes = await p.productSize.findMany({
        where: { productId: withProduct.productId, OR: [{ barcode: null }, { barcode: '' }, { barcode }] },
        select: { id: true, size: true, barcode: true },
      });
      matchesPraAplicar.push({
        barcode,
        productId: withProduct.productId,
        description: withProduct.description,
        bipesCount: byBarcode[barcode].length,
        sizes,
      });
    } else {
      semProduto++;
      semProdutoList.push({
        barcode,
        description: xmlItems[0].description,
        supplier: xmlItems[0].fiscalDocument?.issuerName,
        brand: xmlItems[0].fiscalDocument?.brand,
        bipes: byBarcode[barcode].length,
      });
    }
  }

  console.log('\n\n=== RELATÓRIO ===');
  console.log(`✅ Resolvíveis (tem EAN + productId): ${resolvidos} barcodes`);
  console.log(`⚠️  EAN no XML mas SEM productId:     ${semProduto} barcodes`);
  console.log(`❌ Sem trace em nenhum XML:           ${foraDeCatalogo} barcodes`);
  console.log(`📊 Total bipes órfãos:                ${orphans.length}`);

  // Sample dos top 10 de cada categoria
  console.log('\n--- TOP 10 RESOLVÍVEIS (preview) ---');
  matchesPraAplicar.slice(0, 10).forEach(m => {
    console.log(`  ${m.barcode} · ${m.bipesCount} bipes · ${m.sizes.length} tamanhos cadastrados · ${m.description?.slice(0, 50)}`);
  });

  console.log('\n--- TOP 10 SEM PRODUTO VINCULADO ---');
  semProdutoList.slice(0, 10).forEach(m => {
    console.log(`  ${m.barcode} · ${m.bipes} bipes · ${m.supplier?.slice(0,20) || '?'} · ${m.brand || '?'} · ${m.description?.slice(0, 50)}`);
  });

  console.log('\n--- TOP 10 FORA DE CATÁLOGO ---');
  foraList.slice(0, 10).forEach(m => {
    console.log(`  ${m.barcode} · ${m.bipes} bipes`);
  });

  // PREVIEW: mostra exatamente o que será criado/vinculado
  if (PREVIEW) {
    console.log('\n\n🔍 PREVIEW DO QUE SERÁ APLICADO:\n');
    // Agrupa por tipo de ação
    const acaoVincular = []; // já existe ProductSize sem barcode
    const acaoCriar = [];    // vai criar ProductSize novo
    const acaoPular = [];    // todos sizes já com outro barcode (manual)

    for (const m of matchesPraAplicar) {
      const inferred = inferSize(m.description);
      const already = m.sizes.find(s => s.barcode === m.barcode);
      if (already) continue; // já vinculado
      const matching = m.sizes.find(s => !s.barcode && s.size === inferred);
      const empty = m.sizes.find(s => !s.barcode);
      if (matching) {
        acaoVincular.push({ ...m, action: 'vincular_match', sizeId: matching.id, sizeStr: matching.size });
      } else if (m.sizes.length === 0) {
        acaoCriar.push({ ...m, action: 'criar', inferredSize: inferred });
      } else if (empty) {
        acaoVincular.push({ ...m, action: 'vincular_empty', sizeId: empty.id, sizeStr: empty.size });
      } else {
        acaoPular.push({ ...m, action: 'pular' });
      }
    }
    console.log(`📦 CRIAR ProductSize novo:    ${acaoCriar.length}`);
    console.log(`🔗 VINCULAR em ProductSize:    ${acaoVincular.length}`);
    console.log(`⏭️  PULAR (manual):             ${acaoPular.length}`);

    console.log('\n--- AMOSTRAS DE CADA AÇÃO ---');
    console.log('\n[CRIAR novo ProductSize]:');
    acaoCriar.slice(0, 15).forEach(m => {
      console.log(`  ${m.barcode} → size='${m.inferredSize}' · ${m.bipesCount} bipes · ${m.description.slice(0, 50)}`);
    });
    if (acaoVincular.length > 0) {
      console.log('\n[VINCULAR em ProductSize existente]:');
      acaoVincular.slice(0, 5).forEach(m => {
        console.log(`  ${m.barcode} → size='${m.sizeStr}' (já existe) · ${m.description.slice(0, 50)}`);
      });
    }
    if (acaoPular.length > 0) {
      console.log('\n[PULAR — todos sizes já têm outro barcode]:');
      acaoPular.slice(0, 5).forEach(m => {
        console.log(`  ${m.barcode} · ${m.description.slice(0, 60)}`);
      });
    }

    const totalBipesQueViramFound = [...acaoCriar, ...acaoVincular].reduce((s, x) => s + x.bipesCount, 0);
    console.log(`\n💡 ${totalBipesQueViramFound} bipes virariam found=true (de ${orphans.length} órfãos)`);
    console.log('\nPra aplicar de verdade: node scripts/match-bipes-com-xml.js --apply');
    process.exit(0);
  }

  if (!APPLY) {
    console.log('\n💡 Pra ver detalhe: node scripts/match-bipes-com-xml.js --preview');
    console.log('💡 Pra aplicar:     node scripts/match-bipes-com-xml.js --apply');
    process.exit(0);
  }

  // APPLY MODE
  console.log('\n\n🔧 APLICANDO MATCHES...');
  let appliedSize = 0;
  let createdSize = 0;
  let appliedBipe = 0;
  for (const m of matchesPraAplicar) {
    const inferred = inferSize(m.description);
    const already = m.sizes.find(s => s.barcode === m.barcode);
    let sizeRow = null;

    if (already) {
      sizeRow = already;
    } else if (m.sizes.length === 0) {
      // Cria ProductSize novo. Trata constraint (productId, size) único:
      // se já existe size='Único' pra esse produto, varia pra 'Único-XXX'.
      let attemptSize = inferred;
      let attempt = 0;
      while (attempt < 5) {
        try {
          sizeRow = await p.productSize.create({
            data: { productId: m.productId, size: attemptSize, barcode: m.barcode, stock: 0 },
          });
          createdSize++;
          break;
        } catch (err) {
          if (String(err.message).includes('Unique constraint')) {
            // Já existe size com esse nome. Refresca lista e tenta vincular.
            const existing = await p.productSize.findMany({ where: { productId: m.productId } });
            const semBarcode = existing.find(s => !s.barcode);
            if (semBarcode) {
              sizeRow = await p.productSize.update({ where: { id: semBarcode.id }, data: { barcode: m.barcode } });
              appliedSize++;
              break;
            }
            // Senão, varia sufixo
            attempt++;
            attemptSize = `${inferred}-${m.barcode.slice(-4)}${attempt > 1 ? '-' + attempt : ''}`;
          } else throw err;
        }
      }
      if (!sizeRow) {
        console.log(`  ⚠️ ${m.barcode}: nao conseguiu criar/vincular size apos ${attempt} tentativas`);
        continue;
      }
    } else {
      const matching = m.sizes.find(s => !s.barcode && s.size === inferred);
      const empty = m.sizes.find(s => !s.barcode);
      const target = matching || empty;
      if (target) {
        sizeRow = await p.productSize.update({ where: { id: target.id }, data: { barcode: m.barcode } });
        appliedSize++;
      } else {
        console.log(`  ⚠️ ${m.barcode}: produto ${m.productId} todos sizes têm outro barcode (manual)`);
        continue;
      }
    }

    // Re-processa bipes do barcode pra marcar found=true
    const prod = await p.product.findUnique({ where: { id: m.productId }, select: { name: true, brand: true } });
    const r = await p.stocktakeBipe.updateMany({
      where: { barcode: m.barcode, found: false },
      data: {
        productId: m.productId,
        productSizeId: sizeRow.id,
        productName: prod?.name || null,
        productSize: sizeRow.size,
        productBrand: prod?.brand || null,
        found: true,
      },
    });
    appliedBipe += r.count;
  }
  console.log(`\n✅ ${createdSize} ProductSize NOVOS criados`);
  console.log(`✅ ${appliedSize} ProductSize existentes vinculados`);
  console.log(`✅ ${appliedBipe} bipes re-processados (found=true)`);
  process.exit(0);
})().catch(e => { console.error('ERR:', e.message); process.exit(1); });
