// =====================================================================
// unify-products-batch.js — unificação automática em massa
// =====================================================================
// Agrupa produtos ativos por (cleanName + supplierRef + brand) e cria
// 1 produto mestre por grupo com 2+ produtos. ProductSizes copiadas,
// StoreStocks movidos, originais marcados inactive.
//
// Uso:
//   node scripts/unify-products-batch.js --dry      (só relatório)
//   node scripts/unify-products-batch.js --apply    (executa)
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

const args = process.argv.slice(2);
const APPLY = args.includes('--apply');
const DRY = !APPLY;

function cleanName(name) {
  if (!name) return '';
  return name
    .replace(/-+\s*Tam[:.]?\s*[A-Z0-9./-]+/gi, '')
    .replace(/\s+\d{2}([,.]\d)?\s*$/i, '')
    .replace(/\s+-\s*$/, '')
    .trim();
}

function getCtx(p) {
  try { return typeof p.aiContext === 'string' ? JSON.parse(p.aiContext) : (p.aiContext || {}); }
  catch { return {}; }
}

async function main() {
  console.log('\n=== Unificação batch ===');
  console.log('Modo:', DRY ? 'DRY-RUN' : 'APPLY');

  // Pega todos ativos, fora os já unificados (que têm unifiedIntoId em aiContext)
  const products = await prisma.product.findMany({
    where: { active: true },
    select: { id: true, sku: true, name: true, brand: true, imageUrl: true, imageUrls: true, aiContext: true, price: true,
      category: true, subcategory: true, shortDescription: true, longDescription: true, ncm: true, cfop: true, unidade: true, promoPrice: true,
      sizes: { include: { storeStocks: true } } },
  });
  console.log('Produtos ativos:', products.length);

  // Filtra já unificados
  const candidates = products.filter(p => !getCtx(p).unifiedIntoId && !p.sku?.startsWith('UNI-'));
  console.log('Candidatos (excluindo mestres existentes e originais já unificados):', candidates.length);

  // Agrupa
  const groups = new Map();
  candidates.forEach(p => {
    const ctx = getCtx(p);
    const cn = cleanName(p.name);
    const ref = (ctx.supplierRef || '').trim();
    const brand = (p.brand || '').trim();
    // Chave robusta: precisa de pelo menos nome E (ref OU brand)
    if (!cn) return;
    if (!ref && !brand) return;
    const key = `${cn}||${ref}||${brand}`;
    if (!groups.has(key)) groups.set(key, { cleanName: cn, supplierRef: ref, brand, products: [] });
    groups.get(key).products.push(p);
  });

  // Filtra só grupos com 2+
  const grupos = Array.from(groups.values()).filter(g => g.products.length >= 2);
  const stats = {
    totalGroups: grupos.length,
    totalSources: grupos.reduce((acc, g) => acc + g.products.length, 0),
    largestGroup: grupos.reduce((m, g) => Math.max(m, g.products.length), 0),
  };
  console.log('\nGrupos detectados:', stats.totalGroups);
  console.log('Produtos serão unificados:', stats.totalSources);
  console.log('Maior grupo:', stats.largestGroup, 'variantes');
  console.log('\nAmostras (top 10):');
  grupos.sort((a, b) => b.products.length - a.products.length).slice(0, 10).forEach((g, i) => {
    console.log(`  ${i+1}. [${g.products.length}x] ${g.brand} | ${g.cleanName.slice(0,55)} | REF: ${g.supplierRef.slice(0,15)}`);
  });

  if (DRY) {
    console.log('\n(DRY-RUN — passe --apply pra executar)');
    await prisma.$disconnect();
    return;
  }

  // EXECUTA
  console.log('\nExecutando unificação...');
  let ok = 0, fail = 0;
  for (const g of grupos) {
    try {
      const first = g.products[0];
      const firstCtx = getCtx(first);
      // imagens: junta todas
      const allImgs = new Set();
      if (first.imageUrl) allImgs.add(first.imageUrl);
      g.products.forEach(p => {
        if (p.imageUrl) allImgs.add(p.imageUrl);
        try {
          const extras = typeof p.imageUrls === 'string' ? JSON.parse(p.imageUrls) : (p.imageUrls || []);
          if (Array.isArray(extras)) extras.forEach(u => u && allImgs.add(u));
        } catch {}
      });
      const imgsArr = Array.from(allImgs);
      const masterImageUrl = imgsArr[0] || null;

      const masterCtx = {
        ...firstCtx,
        supplierRef: g.supplierRef,
        unifiedFromSkus: g.products.map(p => p.sku),
        unifiedFromIds: g.products.map(p => p.id),
        unifiedAt: new Date().toISOString(),
        unifiedBy: 'batch',
      };

      const newSku = `UNI-${first.sku || first.id}-${Date.now().toString(36).slice(-4)}-${Math.floor(Math.random()*999)}`;
      const master = await prisma.product.create({
        data: {
          sku: newSku,
          name: g.cleanName,
          brand: g.brand || first.brand,
          category: first.category,
          subcategory: first.subcategory,
          shortDescription: first.shortDescription,
          longDescription: first.longDescription,
          price: first.price,
          promoPrice: first.promoPrice,
          imageUrl: masterImageUrl,
          imageUrls: imgsArr,
          aiContext: masterCtx,
          ncm: first.ncm,
          cfop: first.cfop,
          unidade: first.unidade,
          active: true,
        },
      });

      for (const o of g.products) {
        for (const s of (o.sizes || [])) {
          const ps = await prisma.productSize.create({
            data: { productId: master.id, size: String(s.size), stock: s.stock || 0 },
          });
          if (s.storeStocks && s.storeStocks.length) {
            await prisma.storeStock.updateMany({
              where: { productSizeId: s.id },
              data: { productSizeId: ps.id },
            });
          }
        }
      }
      // Marca originais inactive
      for (const o of g.products) {
        const ctx = getCtx(o);
        ctx.unifiedIntoId = master.id;
        ctx.unifiedAt = new Date().toISOString();
        await prisma.product.update({ where: { id: o.id }, data: { active: false, aiContext: ctx } });
      }
      ok++;
      if (ok % 50 === 0) console.log(`  ${ok}/${grupos.length}...`);
    } catch (e) {
      fail++;
      console.error('  ERRO grupo', g.cleanName.slice(0,40), ':', e.message);
    }
  }

  console.log(`\n=== Resumo ===`);
  console.log(`  Grupos unificados: ${ok}`);
  console.log(`  Falhas:            ${fail}`);
  console.log(`  Produtos finais:   ${stats.totalSources - stats.totalGroups} a menos no catálogo ativo`);

  // Conta final
  const finalActive = await prisma.product.count({ where: { active: true } });
  const masters = await prisma.product.count({ where: { active: true, sku: { startsWith: 'UNI-' } } });
  console.log(`  Produtos ativos:   ${finalActive}`);
  console.log(`  Mestres criados:   ${masters}`);

  await prisma.$disconnect();
}

main().catch(async (e) => { console.error('FATAL:', e); await prisma.$disconnect(); process.exit(1); });
