// =====================================================================
// Consolida Products que são o mesmo (brand + modelGroup + name_base + color)
// mas viraram cards separados por tamanho.
//
// Estratégia:
// 1. Agrupa por (brand, modelGroup, name_base, color)
// 2. Pra grupos com 2+ Products: escolhe representante (foto + mais sizes + mais antigo)
// 3. Migra ProductSize, StocktakeBipe, XmlFiscalItem, ProductCreative, Sale items
// 4. Deleta Products não-representantes
//
// Roda com --apply pra aplicar de verdade. Sem flag = DRY RUN.
// =====================================================================

const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
const APPLY = process.argv.includes('--apply');

function nameBase(name) {
  if (!name) return '';
  let n = name.toUpperCase().trim();
  n = n.replace(/\s+TAMANHO[:;].+$/i, '');
  n = n.replace(/\s+(PP|XGG|XG|GG|G|M|P)\s*$/, '');
  n = n.replace(/\s+\d{1,3}([.,]\d{1,2})?\s*$/, '');
  n = n.replace(/\s+\d{1,2}\/\d{1,2}\s*$/, '');
  return n.trim();
}

// Extrai gênero da chave de agrupamento (Masculino/Feminino/Infantil)
// Procura em: subcategory, aiContext.classification.gender, ou no NOME do produto
function inferGender(prod, ctx) {
  const cls = ctx?.classification || {};
  // 1. Da classification (mais confiável)
  if (cls.gender === 'F' || cls.gender === 'Feminino' || cls.gender === 'Mulher') return 'F';
  if (cls.gender === 'M' || cls.gender === 'Masculino' || cls.gender === 'Homem') return 'M';
  // 2. Da subcategory
  const sub = (prod.subcategory || '').toUpperCase();
  if (/MULHER|FEMININO|MENINA/.test(sub)) return 'F';
  if (/HOMEM|MASCULINO|MENINO/.test(sub)) return 'M';
  // 3. Do NOME (palavras explícitas)
  const name = (prod.name || '').toUpperCase();
  if (/\bFEMININ[OA]?\b|\bMULHER\b|\bMENINA\b/.test(name)) return 'F';
  if (/\bMASCULIN[OA]?\b|\bHOMEM\b|\bMENINO\b/.test(name)) return 'M';
  // 4. Suffix W ou M (ADIDAS/Salomon: 'X ULTRA 5 MID GTX M Black')
  if (/\s+W\s+[A-Z]/.test(prod.name || '')) return 'F';
  if (/\s+M\s+[A-Z]/.test(prod.name || '')) return 'M';
  return 'U'; // unisex/indefinido
}

async function main() {
  console.log(APPLY ? '🚀 MODO APPLY — vai modificar o banco' : '👀 DRY RUN — sem mudar nada (use --apply pra aplicar)');

  const products = await prisma.product.findMany({
    where: { active: true },
    include: { sizes: { include: { storeStocks: true } } },
  });
  console.log('Total Products:', products.length);

  // Agrupa por (brand, modelGroup, name_base, color)
  // GÊNERO NÃO entra na chave: cores diferentes do mesmo modelo podem ser de
  // linhas masc/fem diferentes — isso é OK (mostra como variantes de cor).
  // O que NÃO pode juntar é tamanhos do MESMO modelo+cor, e a chave (name_base +
  // color) já garante isso pq cor vem no nome (ex: "TENIS UA HOOPER BLWHMG").
  const groups = {};
  for (const prod of products) {
    let mg = null, color = null;
    try {
      const ctx = typeof prod.aiContext === 'string' ? JSON.parse(prod.aiContext) : (prod.aiContext || {});
      mg = ctx.modelGroup;
      color = ctx.color;
    } catch {}
    const nb = nameBase(prod.name);
    const key = (prod.brand || '') + '||' + (mg || '_nomg') + '||' + nb + '||' + (color || '');
    if (!groups[key]) groups[key] = [];
    groups[key].push(prod);
  }

  const multiGroups = Object.entries(groups).filter(([_, arr]) => arr.length > 1);
  console.log('Grupos a consolidar:', multiGroups.length);
  console.log('Products a remover:', multiGroups.reduce((s, [_, a]) => s + a.length - 1, 0));

  let consolidados = 0;
  let removidos = 0;
  let sizesMigrados = 0;
  let bipesMigrados = 0;
  let nfeMigrados = 0;
  let saleMigrados = 0;
  let criativosMigrados = 0;
  let erros = 0;

  for (let i = 0; i < multiGroups.length; i++) {
    const [key, arr] = multiGroups[i];
    if (i % 100 === 0) process.stdout.write(`  ${i}/${multiGroups.length}\r`);

    // Escolhe representante: prioriza imageUrl > maisSizes > maisAntigo (id menor)
    const sorted = [...arr].sort((a, b) => {
      const aImg = a.imageUrl ? 1 : 0;
      const bImg = b.imageUrl ? 1 : 0;
      if (bImg !== aImg) return bImg - aImg;
      const aSizes = (a.sizes || []).length;
      const bSizes = (b.sizes || []).length;
      if (bSizes !== aSizes) return bSizes - aSizes;
      return a.id.localeCompare(b.id);
    });
    const keep = sorted[0];
    const remove = sorted.slice(1);

    if (!APPLY) {
      consolidados++;
      removidos += remove.length;
      continue;
    }

    try {
      await prisma.$transaction(async (tx) => {
        // Pega sizes existentes no representante (pra evitar conflito de (productId, size) único)
        const keepSizes = await tx.productSize.findMany({ where: { productId: keep.id }, select: { id: true, size: true } });
        const keepSizeMap = Object.fromEntries(keepSizes.map(s => [s.size, s.id]));

        for (const r of remove) {
          const rSizes = r.sizes || [];
          for (const sz of rSizes) {
            const existing = keepSizeMap[sz.size];
            if (existing) {
              // Conflito: já existe size com mesmo nome. Migra storeStocks e bipes pro existente.
              await tx.storeStock.updateMany({ where: { productSizeId: sz.id }, data: { productSizeId: existing } }).catch(() => {});
              await tx.stocktakeBipe.updateMany({ where: { productSizeId: sz.id }, data: { productSizeId: existing, productId: keep.id } });
              await tx.productSize.delete({ where: { id: sz.id } });
            } else {
              // Move o ProductSize pro representante
              await tx.productSize.update({ where: { id: sz.id }, data: { productId: keep.id } });
              keepSizeMap[sz.size] = sz.id;
              sizesMigrados++;
            }
          }

          // Migra StocktakeBipe (caso ainda tenha vínculo direto via productId sem size match)
          const bipesUpdated = await tx.stocktakeBipe.updateMany({ where: { productId: r.id }, data: { productId: keep.id } });
          bipesMigrados += bipesUpdated.count;

          // Migra XmlFiscalItem
          const nfeUpdated = await tx.xmlFiscalItem.updateMany({ where: { productId: r.id }, data: { productId: keep.id } });
          nfeMigrados += nfeUpdated.count;

          // Migra SaleItem (vendas)
          try {
            const saleUpdated = await tx.saleItem.updateMany({ where: { productId: r.id }, data: { productId: keep.id } });
            saleMigrados += saleUpdated.count;
          } catch {}

          // Migra ProductCreative
          try {
            const cretUpdated = await tx.productCreative.updateMany({ where: { productId: r.id }, data: { productId: keep.id } });
            criativosMigrados += cretUpdated.count;
          } catch {}

          // Deleta o Product removido
          await tx.product.delete({ where: { id: r.id } });
          removidos++;
        }

        consolidados++;
      }, { timeout: 30000 });
    } catch (e) {
      erros++;
      if (erros <= 10) console.log(`\n  ERR grupo ${key.slice(0, 50)}: ${e.message.slice(0, 120)}`);
    }
  }

  console.log('\n\n=== RESULTADO ===');
  console.log('Grupos consolidados:', consolidados);
  console.log('Products removidos:', removidos);
  if (APPLY) {
    console.log('ProductSize migrados:', sizesMigrados);
    console.log('Bipes migrados:', bipesMigrados);
    console.log('NFe items migrados:', nfeMigrados);
    console.log('Sale items migrados:', saleMigrados);
    console.log('Criativos migrados:', criativosMigrados);
    console.log('Erros:', erros);
  } else {
    console.log('\n💡 DRY RUN. Pra aplicar: node scripts/consolidate-products-by-model.js --apply');
  }

  await prisma.$disconnect();
}

main().catch(e => { console.error(e); process.exit(1); });
