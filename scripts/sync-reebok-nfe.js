// Sync REEBOK com a NFe (método HOKA): 1 código(estilo+gênero+cor)=1 card, tamanho real
// (final do código), cor decodificada, gênero, classifica. Cria/sincroniza da NFe.
// NÃO mexe no localizado. Backup antes. DRY-RUN por padrão; --apply pra escrever.
const fs = require('fs'); const path = require('path');
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
const APPLY = process.argv.includes('--apply');

// referência = estilo+gênero+cor (código sem os 2 dígitos do tamanho). Cores decodificadas na web.
const M = {
  '100209958WCRAVD': { model: 'AT Craze 3', color: 'Preto/Azul/Verde Lima', gen: 'Mulher', mod: 'Corrida', tier: 'velocidade' },
  '100209959MCRAPT': { model: 'AT Craze 3', color: 'Preto/Cinza', gen: 'Homem', mod: 'Corrida', tier: 'velocidade' },
  '100221155WCLCCZ': { model: 'Club C Double Revenge', color: 'Cinza/Coral', gen: 'Mulher', mod: 'LifeStyle', tier: 'casual' },
  '100207963WCLCLI': { model: 'Club C Grounds', color: 'Roxo/Lima/Gum', gen: 'Mulher', mod: 'LifeStyle', tier: 'casual' },
  '100204829METPCZ': { model: 'Energen Tech Plus 2', color: 'Cinza', gen: 'Homem', mod: 'Corrida', tier: 'custo benefício' },
  '100204834METPAZ': { model: 'Energen Tech Plus 2', color: 'Azul/Preto/Coral', gen: 'Homem', mod: 'Corrida', tier: 'custo benefício' },
  '100209547MERSMR': { model: 'ERS World', color: 'Marrom/Cinza', gen: 'Homem', mod: 'LifeStyle', tier: 'casual' },
  '100205030MNANLA': { model: 'Nano Court', color: 'Coral/Preto', gen: 'Homem', mod: 'Musculação / CrossFit / Hyrox', tier: 'Treino' },
  '100204815MNANBC': { model: 'Nano Court', color: 'Branco', gen: 'Homem', mod: 'Musculação / CrossFit / Hyrox', tier: 'Treino' },
  '100211615WNANPT': { model: 'Nano Court', color: 'Preto', gen: 'Mulher', mod: 'Musculação / CrossFit / Hyrox', tier: 'Treino' },
  '100204811WNANBC': { model: 'Nano Court', color: 'Branco', gen: 'Mulher', mod: 'Musculação / CrossFit / Hyrox', tier: 'Treino' },
  '100256056WNANRE': { model: 'Nanoflex TR 3', color: 'Rosa', gen: 'Mulher', mod: 'Musculação / CrossFit / Hyrox', tier: 'Treino' },
  '100244382MNANBC': { model: 'Nanoflex TR 3', color: 'Branco', gen: 'Homem', mod: 'Musculação / CrossFit / Hyrox', tier: 'Treino' },
  '100244384MNANMA': { model: 'Nanoflex TR 3', color: 'Marinho', gen: 'Homem', mod: 'Musculação / CrossFit / Hyrox', tier: 'Treino' },
  '100244385WNANPT': { model: 'Nanoflex TR 3', color: 'Preto', gen: 'Mulher', mod: 'Musculação / CrossFit / Hyrox', tier: 'Treino' },
  '100248250MNANPT': { model: 'Nanoflex TR 3', color: 'Preto', gen: 'Homem', mod: 'Musculação / CrossFit / Hyrox', tier: 'Treino' },
  '100211606MNANCO': { model: 'Nano X4', color: 'Verde/Amarelo (Heart)', gen: 'Homem', mod: 'Musculação / CrossFit / Hyrox', tier: 'Profissional' },
  '100204675MNANCZ': { model: 'Nano X4', color: 'Cinza/Lima', gen: 'Homem', mod: 'Musculação / CrossFit / Hyrox', tier: 'Profissional' },
  '100211543WPREBC': { model: 'Premier Road Plus VI', color: 'Branco', gen: 'Mulher', mod: 'Corrida', tier: 'custo benefício' },
  '100201286MROYCZ': { model: 'Royal Ultra Flash', color: 'Cinza', gen: 'Homem', mod: 'LifeStyle', tier: 'casual' },
  '100210034WROYAZ': { model: 'Royal Ultra Flash', color: 'Azul', gen: 'Mulher', mod: 'LifeStyle', tier: 'casual' },
  '100205021WZIGPT': { model: 'Zig Dynamica 5', color: 'Preto', gen: 'Mulher', mod: 'Corrida', tier: 'velocidade' },
  '100205015MZIGBC': { model: 'Zig Dynamica 5', color: 'Branco', gen: 'Homem', mod: 'Corrida', tier: 'velocidade' },
};

(async () => {
  const lines = await prisma.$queryRawUnsafe(`
    SELECT xi.ean, xi."supplierCode" sc, sum(xi.quantity)::int qty
    FROM "XmlFiscalItem" xi JOIN "XmlFiscalDocument" xd ON xd.id=xi."fiscalDocumentId"
    WHERE xd."docType"='entrada' AND xi.ean IS NOT NULL AND xi."supplierCode" ~ '^100[0-9]{6}[MW]'
    GROUP BY xi.ean, xi."supplierCode"`);
  const byRef = {};
  for (const l of lines) {
    const ref = l.sc.replace(/[0-9]{2}$/, '');
    if (!M[ref]) continue;
    const size = l.sc.slice(ref.length);
    (byRef[ref] = byRef[ref] || []).push({ ean: l.ean, size, qty: l.qty });
  }

  console.log('=== SYNC REEBOK × NFe ===');
  let cards = 0, sizes = 0;
  for (const ref of Object.keys(byRef)) {
    const m = M[ref]; const items = byRef[ref];
    const card = await prisma.$queryRawUnsafe(`SELECT id FROM "Product" WHERE active AND sku=$1 LIMIT 1`, ref);
    let nCreate = 0;
    for (const it of items) { const ps = await prisma.productSize.findFirst({ where: { barcode: it.ean }, select: { id: true } }); if (!ps) nCreate++; }
    if (!card.length) cards++; sizes += nCreate;
    console.log(`  ${m.model.padEnd(22)} ${m.color.padEnd(22)} ${m.gen.padEnd(6)} | ${items.length} tam | ${card.length ? 'card ok' : 'CRIAR'} · criar ${nCreate} tam`);
  }
  console.log(`\nTOTAL: criar ${cards} card(s) · criar ${sizes} tamanho(s) · refs: ${Object.keys(byRef).length}`);

  if (!APPLY) { console.log('\nDRY-RUN. --apply pra executar.'); await prisma.$disconnect(); return; }

  const ids = (await prisma.$queryRawUnsafe(`SELECT id FROM "Product" WHERE active AND upper(brand) LIKE '%REEBOK%'`)).map(r => r.id);
  const dir = path.join(process.cwd(), 'scripts', 'backups'); fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'reebok-sync-' + Date.now() + '.json'), JSON.stringify({ ids, pss: await prisma.productSize.findMany({ where: { productId: { in: ids } } }) }));

  for (const ref of Object.keys(byRef)) {
    const m = M[ref]; const items = byRef[ref];
    let card = (await prisma.$queryRawUnsafe(`SELECT id FROM "Product" WHERE active AND sku=$1 LIMIT 1`, ref))[0];
    const ctx = { color: m.color, supplierRef: ref, classification: { modality: m.mod, tier: m.tier, type: 'Calçado', gender: m.gen, source: 'reebok-sync', classifiedAt: new Date().toISOString() } };
    const data = { name: m.model, brand: 'REEBOK', sku: ref, category: 'Calçados', subcategory: m.gen, aiContext: ctx, imageUrl: null, imageUrls: [] };
    if (!card) card = await prisma.product.create({ data: { ...data, price: 0, active: true } });
    else await prisma.product.update({ where: { id: card.id }, data });
    const used = new Set((await prisma.productSize.findMany({ where: { productId: card.id }, select: { size: true } })).map(s => s.size));
    for (const it of items) {
      const ex = await prisma.productSize.findFirst({ where: { barcode: it.ean } });
      if (ex) { const d = { stock: it.qty, productId: card.id }; if (!used.has(it.size) || ex.size === it.size) { d.size = it.size; used.add(it.size); } await prisma.productSize.update({ where: { id: ex.id }, data: d }); }
      else { let sz = it.size; while (used.has(sz)) sz = sz + '·' + it.ean.slice(-3); used.add(sz); await prisma.productSize.create({ data: { productId: card.id, size: sz, barcode: it.ean, stock: it.qty } }); }
    }
  }
  // desativa cards Reebok antigos esvaziados (tamanhos migraram pros cards novos)
  let deact = 0;
  for (const r of await prisma.$queryRawUnsafe(`SELECT id FROM "Product" WHERE active AND upper(brand) LIKE '%REEBOK%'`)) {
    const n = await prisma.productSize.count({ where: { productId: r.id } });
    if (n === 0) { await prisma.product.update({ where: { id: r.id }, data: { active: false } }); deact++; }
  }
  const final = await prisma.$queryRawUnsafe(`SELECT count(*)::int n FROM "Product" WHERE active AND upper(brand) LIKE '%REEBOK%'`);
  console.log(`\nFEITO. cards Reebok ativos: ${final[0].n} · antigos vazios desativados: ${deact}`);
  await prisma.$disconnect();
})().catch((e) => { console.error('ERR', e.message); process.exit(1); });
