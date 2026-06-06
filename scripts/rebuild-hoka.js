// Reconstrói HOKA pelo CÓDIGO da NFe (estilo+cor). 1 código = 1 card, tamanho
// real (final do código), cor/gênero decodificados. Limpa a foto de revendedor (errada).
// DRY-RUN por padrão. --apply pra escrever (backup antes).
const fs = require('fs'); const path = require('path');
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
const APPLY = process.argv.includes('--apply');

// Verificado na NFe + site oficial HOKA/retailers
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
  '1155111FSTS': { model: 'Skyflow',    color: 'Frost/Solar Flare',        gender: 'Homem',  tier: 'máximo conforto' },
};

(async () => {
  // sizes ativos HOKA com código(estilo+cor) + tamanho real
  const sizes = await prisma.$queryRawUnsafe(`
    SELECT DISTINCT pz.id psid, pz."productId" pid, pz.barcode,
      regexp_replace(xi."supplierCode",'[0-9]{2}$','') code, right(xi."supplierCode",2) realsize
    FROM "ProductSize" pz
    JOIN "Product" pr ON pr.id=pz."productId" AND pr.active AND (upper(pr.brand) LIKE '%HOKA%' OR upper(pr.name) LIKE '%HOKA%')
    JOIN "XmlFiscalItem" xi ON xi.ean=pz.barcode
    JOIN "XmlFiscalDocument" xd ON xd.id=xi."fiscalDocumentId" AND xd."docType"='entrada'`);

  // 1 código → sizes[] (dedup por psid)
  const byCode = {}; const seen = new Set();
  for (const s of sizes) {
    if (seen.has(s.psid)) continue; seen.add(s.psid);
    if (!M[s.code]) continue;
    (byCode[s.code] = byCode[s.code] || []).push(s);
  }
  const allHoka = await prisma.$queryRawUnsafe(`SELECT id, name, price FROM "Product" WHERE active AND (upper(brand) LIKE '%HOKA%' OR upper(name) LIKE '%HOKA%')`);
  const priceById = Object.fromEntries(allHoka.map(p => [p.id, p.price]));

  console.log('=== RECONSTRUÇÃO HOKA (por código) ===');
  for (const code of Object.keys(byCode)) {
    const m = M[code]; const ss = byCode[code];
    console.log(`  ${m.model.padEnd(11)} ${m.color.padEnd(28)} ${m.gender.padEnd(6)} | ${ss.length} tam: ${ss.map(x => x.realsize).sort().join(',')}  [${code}]`);
  }
  const codesSemSize = Object.keys(M).filter(c => !byCode[c]);
  if (codesSemSize.length) console.log('  (sem tamanho no banco:', codesSemSize.join(', '), ')');

  if (!APPLY) { console.log('\nDRY-RUN. --apply pra executar.'); await prisma.$disconnect(); return; }

  // backup
  const ids = allHoka.map(p => p.id);
  const dir = path.join(process.cwd(), 'scripts', 'backups'); fs.mkdirSync(dir, { recursive: true });
  const pss = await prisma.productSize.findMany({ where: { productId: { in: ids } } });
  const sss = await prisma.storeStock.findMany({ where: { productSizeId: { in: pss.map(s => s.id) } } });
  const prods = await prisma.product.findMany({ where: { id: { in: ids } } });
  const bf = path.join(dir, 'hoka-rebuild-' + Date.now() + '.json'); fs.writeFileSync(bf, JSON.stringify({ prods, pss, sss }, null, 0));
  console.log('\nBACKUP:', bf);

  const claimed = new Set();
  for (const code of Object.keys(byCode)) {
    const m = M[code]; const ss = byCode[code];
    // canonical: card que já segura mais sizes desse código e ainda não foi reivindicado
    const cnt = {}; ss.forEach(s => { cnt[s.pid] = (cnt[s.pid] || 0) + 1; });
    const cand = Object.keys(cnt).sort((a, b) => cnt[b] - cnt[a]).find(pid => !claimed.has(pid));
    let canonId = cand;
    const ctx = { color: m.color, supplierRef: code, classification: { modality: 'Corrida', tier: m.tier, type: 'Calçado', gender: m.gender, source: 'hoka-rebuild', classifiedAt: new Date().toISOString() } };
    const data = { name: m.model, brand: 'HOKA', sku: code, category: 'Calçados', subcategory: m.gender, aiContext: ctx, imageUrl: null, imageUrls: null };
    if (!canonId) {
      const srcPrice = priceById[ss[0].pid] || 0;
      const created = await prisma.product.create({ data: { ...data, price: srcPrice, active: true } });
      canonId = created.id;
    } else {
      await prisma.product.update({ where: { id: canonId }, data });
    }
    claimed.add(canonId);
    // move os sizes desse código pro canonical, com tamanho REAL (sem colisão)
    const used = new Set((await prisma.productSize.findMany({ where: { productId: canonId }, select: { size: true } })).map(x => x.size));
    for (const s of ss) {
      let label = m.gender === 'Mulher' && false ? s.realsize : s.realsize; // tamanho real
      if (used.has(label) && s.psid && !(await prisma.productSize.findFirst({ where: { id: s.psid, productId: canonId } }))) label = s.realsize + '·' + String(s.barcode).slice(-3);
      while (used.has(label)) label = label + '_';
      used.add(label);
      await prisma.productSize.update({ where: { id: s.psid }, data: { productId: canonId, size: label } });
    }
  }

  // desativa HOKA que ficou sem nenhum size
  const after = await prisma.$queryRawUnsafe(`SELECT id, name FROM "Product" WHERE active AND (upper(brand) LIKE '%HOKA%' OR upper(name) LIKE '%HOKA%')`);
  let deact = 0;
  for (const p of after) { const n = await prisma.productSize.count({ where: { productId: p.id } }); if (n === 0) { await prisma.product.update({ where: { id: p.id }, data: { active: false } }); deact++; } }
  const final = await prisma.$queryRawUnsafe(`SELECT count(*)::int n FROM "Product" WHERE active AND (upper(brand) LIKE '%HOKA%' OR upper(name) LIKE '%HOKA%')`);
  console.log(`\nFEITO. cards finais HOKA: ${final[0].n} · cards vazios desativados: ${deact}`);
  await prisma.$disconnect();
})().catch((e) => { console.error('ERR', e.message); process.exit(1); });
