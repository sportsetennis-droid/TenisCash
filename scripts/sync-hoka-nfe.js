// Sincroniza HOKA com a NFe de entrada: cada EAN da nota = 1 tamanho (ProductSize)
// dentro do card do código (estilo+cor), comprado = qtd da NFe. Cria o que falta
// (24 tamanhos + colorway SCQ). NÃO mexe no localizado (StoreStock). Backup antes.
// DRY-RUN por padrão. --apply pra escrever.
const fs = require('fs'); const path = require('path');
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
const APPLY = process.argv.includes('--apply');

const M = {
  '1123202EQB':  { model: 'Bondi 8',    color: 'Electric Aqua/Black',      gender: 'Homem',  tier: 'máximo conforto' },
  '1162011CBLL': { model: 'Bondi 9',    color: 'Cobalt Blue/Ultramarine',  gender: 'Homem',  tier: 'máximo conforto' },
  '1162030PTYG': { model: 'Clifton 10', color: 'Putty/Grout',              gender: 'Homem',  tier: 'máximo conforto' },
  '1162031SLSSN':{ model: 'Clifton 10', color: 'Sea Glass/Neon Flame',     gender: 'Mulher', tier: 'máximo conforto' },
  '1162031WWH':  { model: 'Clifton 10', color: 'Branco/Branco',            gender: 'Mulher', tier: 'máximo conforto' },
  '1127895STLC': { model: 'Clifton 9',  color: 'Stardust/Electric Cobalt', gender: 'Homem',  tier: 'máximo conforto' },
  '1171904FYZ':  { model: 'Mach 7',     color: 'Frost/Neon Yuzu',          gender: 'Homem',  tier: 'velocidade' },
  '1171938FYZ':  { model: 'Mach 7',     color: 'Frost/Neon Yuzu',          gender: 'Mulher', tier: 'velocidade' },
  '1155119FCT':  { model: 'Mach X 2',   color: 'Frost/Citrus',             gender: 'Homem',  tier: 'velocidade' },
  '1155131FNK':  { model: 'Rincon 4',   color: 'Frost/Pink Twilight',      gender: 'Mulher', tier: 'velocidade' },
  '1155131SCQ':  { model: 'Rincon 4',   color: 'Seafoam Electric Aqua',    gender: 'Mulher', tier: 'velocidade' },
  '1155111FSTS': { model: 'Skyflow',    color: 'Frost/Solar Flare',        gender: 'Homem',  tier: 'máximo conforto' },
};

(async () => {
  const lines = await prisma.$queryRawUnsafe(`
    SELECT xi.ean, xi."supplierCode" sc, sum(xi.quantity)::int qty
    FROM "XmlFiscalItem" xi JOIN "XmlFiscalDocument" xd ON xd.id=xi."fiscalDocumentId"
    WHERE xd."docType"='entrada' AND xi.ean IS NOT NULL AND xi."supplierCode" IS NOT NULL
    GROUP BY xi.ean, xi."supplierCode"`);
  // code -> [{ean,size,qty}]
  const byCode = {};
  for (const l of lines) {
    const code = Object.keys(M).find((k) => l.sc.startsWith(k));
    if (!code) continue;
    const size = l.sc.slice(code.length).replace(/^[^0-9]*/, '') || '?';
    (byCode[code] = byCode[code] || []).push({ ean: l.ean, size, qty: l.qty });
  }

  console.log('=== SYNC HOKA × NFe ===');
  let createSizes = 0, createCards = 0, fixStock = 0;
  for (const code of Object.keys(byCode)) {
    const m = M[code]; const items = byCode[code];
    const card = await prisma.$queryRawUnsafe(`SELECT id FROM "Product" WHERE active AND sku=$1 LIMIT 1`, code);
    const has = card.length > 0;
    if (!has) createCards++;
    let nCreate = 0, nFix = 0;
    for (const it of items) {
      const ps = await prisma.productSize.findFirst({ where: { barcode: it.ean }, select: { id: true, stock: true } });
      if (!ps) nCreate++;
      else if (ps.stock !== it.qty) nFix++;
    }
    createSizes += nCreate; fixStock += nFix;
    const nfeTotal = items.reduce((a, x) => a + x.qty, 0);
    console.log(`  ${m.model.padEnd(11)} ${m.color.padEnd(26)} ${m.gender.padEnd(6)} | NFe ${items.length} tam (${nfeTotal} un) | ${has ? 'card ok' : 'CRIAR CARD'} · criar ${nCreate} tam · ajustar estoque ${nFix}`);
  }
  console.log(`\nTOTAL: criar ${createCards} card(s) · criar ${createSizes} tamanho(s) · ajustar comprado de ${fixStock} tamanho(s)`);

  if (!APPLY) { console.log('\nDRY-RUN. --apply pra executar.'); await prisma.$disconnect(); return; }

  // backup
  const ids = (await prisma.$queryRawUnsafe(`SELECT id FROM "Product" WHERE active AND (upper(brand) LIKE '%HOKA%' OR upper(name) LIKE '%HOKA%')`)).map(r => r.id);
  const dir = path.join(process.cwd(), 'scripts', 'backups'); fs.mkdirSync(dir, { recursive: true });
  const pss = await prisma.productSize.findMany({ where: { productId: { in: ids } } });
  fs.writeFileSync(path.join(dir, 'hoka-sync-' + Date.now() + '.json'), JSON.stringify({ ids, pss }));

  for (const code of Object.keys(byCode)) {
    const m = M[code]; const items = byCode[code];
    let card = (await prisma.$queryRawUnsafe(`SELECT id FROM "Product" WHERE active AND sku=$1 LIMIT 1`, code))[0];
    const ctx = { color: m.color, supplierRef: code, classification: { modality: 'Corrida', tier: m.tier, type: 'Calçado', gender: m.gender, source: 'hoka-sync', classifiedAt: new Date().toISOString() } };
    if (!card) {
      card = await prisma.product.create({ data: { name: m.model, brand: 'HOKA', sku: code, category: 'Calçados', subcategory: m.gender, aiContext: ctx, price: 0, active: true } });
    }
    const used = new Set((await prisma.productSize.findMany({ where: { productId: card.id }, select: { size: true } })).map(s => s.size));
    for (const it of items) {
      const existing = await prisma.productSize.findFirst({ where: { barcode: it.ean } });
      if (existing) {
        const data = { stock: it.qty, productId: card.id };
        if (!used.has(it.size) || existing.size === it.size) { data.size = it.size; used.add(it.size); }
        await prisma.productSize.update({ where: { id: existing.id }, data });
      } else {
        let sz = it.size; while (used.has(sz)) sz = sz + '·' + String(it.ean).slice(-3);
        used.add(sz);
        await prisma.productSize.create({ data: { productId: card.id, size: sz, barcode: it.ean, stock: it.qty } });
      }
    }
  }
  const final = await prisma.$queryRawUnsafe(`SELECT count(*)::int n FROM "Product" WHERE active AND (upper(brand) LIKE '%HOKA%' OR upper(name) LIKE '%HOKA%')`);
  console.log(`\nFEITO. cards HOKA ativos: ${final[0].n}`);
  await prisma.$disconnect();
})().catch((e) => { console.error('ERR', e.message); process.exit(1); });
