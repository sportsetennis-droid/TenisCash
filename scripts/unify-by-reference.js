// =====================================================================
// Unificador por REFERÊNCIA — compara catálogo com NFe de COMPRA (entrada).
// 1 referência = 1 card; cada EAN = 1 tamanho dentro do card. SÓ entrada.
//
//   node scripts/unify-by-reference.js                 -> DRY-RUN (só relata)
//   node scripts/unify-by-reference.js --apply --only=IF1404  -> aplica 1 ref (teste)
//   node scripts/unify-by-reference.js --apply         -> aplica TUDO (faz backup antes)
//
// Regras de segurança:
//  - Backup JSON dos produtos/tamanhos/estoque afetados antes de escrever.
//  - DESATIVA duplicados (active=false), NUNCA apaga Product (histórico de venda intacto).
//  - NÃO reescreve o comprado dos tamanhos existentes; só cria os que faltam
//    (comprado vindo da NFe de entrada).
//  - StoreStock (localizado/bipe) é somado por loja ao consolidar.
//  - Rótulo do tamanho: real se der pra ler, senão 'T-<últimos4 do EAN>' (único).
// =====================================================================
const fs = require('fs');
const path = require('path');
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
const APPLY = process.argv.includes('--apply');
const ONLY = (process.argv.find(a => a.startsWith('--only=')) || '').split('=')[1] || null;

function extractRef(desc) {
  if (!desc) return null;
  const m = String(desc).match(/REF:\s*([A-Za-z0-9.\-]+)/i);
  return m ? m[1].toUpperCase() : null;
}
const last4 = (ean) => String(ean || '').slice(-4);
function isUnknownLabel(s) {
  if (!s) return true;
  const t = String(s).trim();
  return t === '' || t === '?' || /\//.test(t) || /^\?/.test(t) || /^T-/.test(t) || t.length > 6;
}

async function buildPlan() {
  const items = await prisma.$queryRawUnsafe(`
    SELECT xi.description, xi.ean, xi.quantity
    FROM "XmlFiscalItem" xi JOIN "XmlFiscalDocument" xd ON xd.id=xi."fiscalDocumentId"
    WHERE xd."docType"='entrada' AND xi.ean IS NOT NULL AND xi.description LIKE '%REF:%'`);
  const refs = new Map();
  for (const it of items) {
    const ref = extractRef(it.description);
    if (!ref) continue;
    if (!refs.has(ref)) refs.set(ref, { eans: new Set(), qty: {} });
    const r = refs.get(ref);
    r.eans.add(it.ean);
    r.qty[it.ean] = (r.qty[it.ean] || 0) + (it.quantity || 0);
  }
  let multi = [...refs.entries()].filter(([, r]) => r.eans.size > 1);
  if (ONLY) multi = multi.filter(([ref]) => ref === ONLY.toUpperCase());
  return multi;
}

async function loadSizesFor(eans) {
  if (!eans.length) return [];
  return prisma.$queryRawUnsafe(
    `SELECT pz.id, pz."productId", pz.barcode, pz.size, pz.stock, pr.name, pr.brand, pr."imageUrl", pr.active
     FROM "ProductSize" pz JOIN "Product" pr ON pr.id=pz."productId"
     WHERE pz.barcode = ANY($1::text[])`, eans);
}

function pickCanonical(prodIds, sizes) {
  const prods = [...prodIds].map(id => {
    const mine = sizes.filter(s => s.productId === id);
    return { id, name: mine[0]?.name, img: !!mine[0]?.imageUrl, nSizes: mine.length, stock: mine.reduce((a, s) => a + (s.stock || 0), 0) };
  }).sort((a, b) => (b.img - a.img) || (b.nSizes - a.nSizes) || (b.stock - a.stock));
  return prods[0];
}

async function backup(affectedProductIds) {
  const dir = path.join(process.cwd(), 'scripts', 'backups');
  fs.mkdirSync(dir, { recursive: true });
  const products = await prisma.product.findMany({ where: { id: { in: affectedProductIds } }, select: { id: true, name: true, active: true, sku: true, aiContext: true } });
  const psizes = await prisma.productSize.findMany({ where: { productId: { in: affectedProductIds } }, select: { id: true, productId: true, size: true, barcode: true, stock: true } });
  const psIds = psizes.map(s => s.id);
  const stores = await prisma.storeStock.findMany({ where: { productSizeId: { in: psIds } }, select: { id: true, storeId: true, productSizeId: true, stock: true } });
  const file = path.join(dir, 'unify-' + Date.now() + '.json');
  fs.writeFileSync(file, JSON.stringify({ products, productSizes: psizes, storeStocks: stores }, null, 0));
  return { file, products: products.length, productSizes: psizes.length, storeStocks: stores.length };
}

async function applyRef(ref, r) {
  const eans = [...r.eans];
  // recarrega FRESH do banco (evita snapshot defasado quando um produto aparece em 2 refs)
  const involved = await prisma.$queryRawUnsafe(
    `SELECT pz.id, pz."productId", pz.barcode, pz.size, pz.stock, pr.name, pr.brand, pr."imageUrl", pr.active
     FROM "ProductSize" pz JOIN "Product" pr ON pr.id=pz."productId" WHERE pz.barcode = ANY($1::text[])`, eans);
  const prodIds = new Set(involved.filter(s => s.active).map(s => s.productId));
  if (prodIds.size === 0) return { ref, skipped: 'sem card' };
  const canon = pickCanonical(prodIds, involved);
  const otherProds = [...prodIds].filter(id => id !== canon.id);

  await prisma.$transaction(async (tx) => {
    const usedLabels = new Set(involved.filter(s => s.productId === canon.id).map(s => s.size));
    const uniqLabel = (preferred, ean) => {
      let l = (preferred && !isUnknownLabel(preferred)) ? preferred : ('T-' + last4(ean));
      if (usedLabels.has(l)) l = 'T-' + last4(ean);
      while (usedLabels.has(l)) l = 'T-' + String(ean).slice(-6) + '-' + (usedLabels.size);
      usedLabels.add(l);
      return l;
    };
    for (const ean of eans) {
      const ps = involved.filter(s => s.barcode === ean);
      let target = ps.find(s => s.productId === canon.id) || null;
      if (!target && ps.length) {
        const donor = ps[0];
        const label = uniqLabel(donor.size, ean);
        await tx.productSize.update({ where: { id: donor.id }, data: { productId: canon.id, size: label } });
        target = { ...donor, productId: canon.id, size: label };
      } else if (!target) {
        const label = uniqLabel(null, ean);
        const created = await tx.productSize.create({ data: { productId: canon.id, size: label, barcode: ean, stock: Math.round(r.qty[ean] || 0) } });
        target = { id: created.id };
      }
      // consolida os OUTROS ProductSize com o mesmo EAN no target (move StoreStock somando, depois apaga)
      for (const dup of ps) {
        if (dup.id === target.id) continue;
        const dss = await tx.storeStock.findMany({ where: { productSizeId: dup.id } });
        for (const ss of dss) {
          await tx.storeStock.upsert({
            where: { storeId_productSizeId: { storeId: ss.storeId, productSizeId: target.id } },
            update: { stock: { increment: ss.stock || 0 } },
            create: { storeId: ss.storeId, productSizeId: target.id, stock: ss.stock || 0 },
          });
        }
        await tx.storeStock.deleteMany({ where: { productSizeId: dup.id } });
        await tx.productSize.delete({ where: { id: dup.id } });
      }
    }
    // desativa os produtos que ficaram sem nenhum tamanho
    for (const pid of otherProds) {
      const left = await tx.productSize.count({ where: { productId: pid } });
      if (left === 0) await tx.product.update({ where: { id: pid }, data: { active: false } });
    }
  }, { timeout: 30000 });

  return { ref, canonical: canon.id, fundidos: otherProds.length, tamanhos: eans.length };
}

(async () => {
  const multi = await buildPlan();
  const allEans = [...new Set(multi.flatMap(([, r]) => [...r.eans]))];
  const sizesAll = await loadSizesFor(allEans);

  if (!APPLY) {
    let cardsBefore = 0, deact = 0, newSizes = 0;
    for (const [, r] of multi) {
      const eans = [...r.eans];
      const inv = sizesAll.filter(s => eans.includes(s.barcode) && s.active);
      const pids = new Set(inv.map(s => s.productId));
      cardsBefore += pids.size; if (pids.size) deact += pids.size - 1;
      newSizes += eans.filter(e => !inv.some(s => s.barcode === e)).length;
    }
    console.log(`DRY-RUN — refs:${multi.length} cardsAntes:${cardsBefore} desativar:${deact} tamanhosCriar:${newSizes}`);
    console.log('rode com --apply (ou --apply --only=IF1404 pra testar 1).');
    await prisma.$disconnect(); return;
  }

  // APPLY
  const affected = [...new Set(sizesAll.map(s => s.productId))];
  const bk = await backup(affected);
  console.log('BACKUP:', bk.file, `(${bk.products} produtos, ${bk.productSizes} tamanhos, ${bk.storeStocks} estoques)`);
  let ok = 0, err = 0;
  for (const [ref, r] of multi) {
    try { const res = await applyRef(ref, r); if (res.skipped) { console.log('  pulado', ref, res.skipped); } else { ok++; if (ONLY) console.log('  OK', JSON.stringify(res)); } }
    catch (e) { err++; console.log('  ERRO', ref, e.message); }
  }
  console.log(`\nFEITO. refs aplicadas:${ok} · erros:${err}`);
  await prisma.$disconnect();
})().catch((e) => { console.error('FATAL', e.message); process.exit(1); });
