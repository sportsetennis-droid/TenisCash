// =====================================================================
// Testes: regra das 5 FOTOS (produto novo na Nuvemshop) e ESPELHO DO CARD
// (toda mudança do card publicado vai sozinha pra Nuvemshop).
//   node scripts/test-ns-fotos-espelho.js
//   (padrão: postgresql://postgres@localhost:55432/ns_espelho — banco
//    DESCARTÁVEL local; outro: RNA_TEST_DATABASE_URL=...)
// ⚠ APAGA e semeia dados no banco informado (só localhost). O envio à
// Nuvemshop é SIMULADO (handlers falsos) — nada sai para a loja de verdade.
// =====================================================================
process.env.DATABASE_URL = process.env.RNA_TEST_DATABASE_URL || 'postgresql://postgres@localhost:55432/ns_espelho';
if (!/@(localhost|127\.0\.0\.1)(:\d+)?\//.test(process.env.DATABASE_URL)) { console.error('Recusado: use só banco DESCARTÁVEL local.'); process.exit(2); }
delete process.env.NS_MIN_FOTOS;
const assert = require('assert');
const elig = require('../src/services/nuvemshopEligibility');
const espelho = require('../src/services/nuvemshopCardMirror');

let pass = 0; const out = [];
async function t(nome, fn) {
  try { await fn(); pass++; out.push('  ✓ ' + nome); } catch (e) { out.push('  ✗ ' + nome + '\n      ' + (e && e.stack ? e.stack.split('\n').slice(0, 4).join('\n      ') : e)); process.exitCode = 1; }
}
const fotos = (n) => Array.from({ length: n }, (_, i) => `https://img.exemplo/f${i + 1}.jpg`);
const card = (over = {}) => Object.assign({
  id: 'p1', active: true, name: 'Tênis Exemplo Run', brand: 'HOKA', category: 'Tênis', subcategory: 'Corrida', price: 900, costPrice: 400,
  longDescription: 'Descrição real.', imageUrl: 'https://img.exemplo/f1.jpg', imageUrls: fotos(5),
  aiContext: { color: 'Azul', classification: { modality: 'Corrida', tier: 'Performance' }, confirmedForNuvemshop: true },
  sizes: [{ size: '40', barcode: '0196565000040', stock: 2, sizeConfirmedAt: new Date(), storeStocks: [{ storeId: elig.nuvemshopStockStoreIds()[0], stock: 1 }] }],
}, over);

async function partA() {
  await t('contagem de fotos: principal + galeria, sem repetir e só URL/arquivo válido', () => {
    assert.strictEqual(elig.usableImageCount(card()), 5, 'principal repetida na galeria conta 1 vez');
    assert.strictEqual(elig.usableImageCount(card({ imageUrls: ['https://lookaside.instagram.com/x', '', 'nada'] })), 1);
    assert.strictEqual(elig.minPhotos(), 5);
  });
  await t('produto NOVO com menos de 5 fotos não sobe; com 5 sobe', () => {
    const r4 = elig.assessProductForNuvemshop(card({ imageUrls: fotos(4) }), { isNew: true });
    assert.ok(r4.reasons.some((x) => /menos de 5 fotos \(4\)/.test(x)), r4.reasons.join('|'));
    const r5 = elig.assessProductForNuvemshop(card(), { isNew: true });
    assert.ok(!r5.reasons.some((x) => /fotos/.test(x)), r5.reasons.join('|'));
  });
  await t('produto JÁ publicado com menos de 5 fotos não é tirado do ar por esta regra (decisão do dono)', () => {
    const r = elig.assessProductForNuvemshop(card({ imageUrls: fotos(2) }));
    assert.ok(!r.reasons.some((x) => /menos de/.test(x)), r.reasons.join('|'));
  });
  await t('manual de conserto ensina a resolver "menos de 5 fotos"', () => {
    const p = require('../src/ai/rede/regras/conserto-nuvemshop').passoDe('menos de 5 fotos (3)');
    assert.strictEqual(p.id, 'fotos-minimas');
    assert.match(p.como, /alternateIds_Ean/); assert.match(p.como, /loja fotografa/); assert.match(p.como, /no máximo 5/);
  });
  await t('assinatura do espelho muda com foto, ordem da galeria, cor, preço, tamanho/código, classificação, oculto', () => {
    const base = espelho.mirrorSig(card());
    const muda = [
      card({ imageUrls: fotos(5).reverse() }), card({ imageUrls: fotos(6) }), card({ aiContext: { ...card().aiContext, color: 'Verde' } }),
      card({ price: 950 }), card({ sizes: [{ size: '41', barcode: '0196565000040' }] }), card({ sizes: [{ size: '40', barcode: '0196565000099' }] }),
      card({ aiContext: { ...card().aiContext, classification: { modality: 'Caminhada', tier: 'Performance' } } }), card({ aiContext: { ...card().aiContext, hideFromNuvemshop: true } }),
      card({ longDescription: 'Outra' }), card({ name: 'Outro nome' }),
    ];
    for (const c of muda) assert.notStrictEqual(espelho.mirrorSig(c), base);
  });
  await t('assinatura NÃO muda com campos internos de sincronização nem com estoque (estoque tem reajuste próprio a cada 5 min)', () => {
    const base = espelho.mirrorSig(card());
    assert.strictEqual(espelho.mirrorSig(card({ aiContext: { ...card().aiContext, nsCardSig: 'x', nsMirrorSig: 'y', nsPhysicalStockVerifiedSig: 'z' } })), base);
    assert.strictEqual(espelho.mirrorSig(card({ sizes: [{ size: '40', barcode: '0196565000040', stock: 99, storeStocks: [{ stock: 7 }] }] })), base);
  });
}

async function partB() {
  const { PrismaClient } = require('@prisma/client');
  const prisma = new PrismaClient();
  const limpar = async () => {
    await prisma.nuvemshopProductMapping.deleteMany({}); await prisma.productSize.deleteMany({}); await prisma.product.deleteMany({});
  };
  await limpar();
  const mk = async (i, publicado = true) => {
    const p = await prisma.product.create({ data: { sku: 'ESP' + i, name: 'Card ' + i, brand: 'HOKA', category: 'Tênis', price: 900, costPrice: 400, imageUrl: 'https://img/' + i + '.jpg', imageUrls: fotos(5), aiContext: { color: 'Azul' } } });
    await prisma.productSize.create({ data: { productId: p.id, size: '40', barcode: '019656500' + String(1000 + i), stock: 1 } });
    if (publicado) await prisma.nuvemshopProductMapping.create({ data: { localProductId: p.id, nuvemshopProductId: 'ns' + i } });
    return p;
  };
  const A = await mk(1); const B = await mk(2); await mk(3, false);
  const enviados = [];
  const handlers = { pushProductToNuvemshop: async (id) => { enviados.push(id); return { action: 'updated' }; } };
  const run = (o = {}) => espelho.runNuvemshopCardMirror(Object.assign({ prisma, handlers, connection: { id: 'conn-teste' } }, o));

  await t('1ª rodada: envia todo card PUBLICADO (não mexe no que não está no site) e grava a assinatura', async () => {
    const r = await run();
    assert.strictEqual(r.checked, 2); assert.strictEqual(r.pushed, 2);
    assert.deepStrictEqual(enviados.sort(), [A.id, B.id].sort());
    const a = await prisma.product.findUnique({ where: { id: A.id } });
    assert.ok(a.aiContext.nsMirrorSig && a.aiContext.color === 'Azul', 'assinatura gravada sem apagar o resto do aiContext');
  });
  await t('nada mudou: 2ª rodada não envia nada', async () => {
    enviados.length = 0; const r = await run();
    assert.strictEqual(r.changed, 0); assert.strictEqual(enviados.length, 0);
  });
  await t('mudou a galeria do A e o código de barras do B: só eles vão, sozinhos, na rodada seguinte', async () => {
    await prisma.product.update({ where: { id: A.id }, data: { imageUrls: fotos(5).reverse() } });
    await prisma.productSize.updateMany({ where: { productId: B.id }, data: { barcode: '0196565009999' } });
    enviados.length = 0; const r = await run();
    assert.strictEqual(r.pushed, 2); assert.deepStrictEqual(enviados.sort(), [A.id, B.id].sort());
  });
  await t('lote por rodada: o que passa do limite fica para a próxima (pending)', async () => {
    await prisma.product.update({ where: { id: A.id }, data: { price: 990 } });
    await prisma.product.update({ where: { id: B.id }, data: { price: 991 } });
    enviados.length = 0; const r = await run({ limit: 1 });
    assert.strictEqual(r.pushed, 1); assert.ok(r.pending);
    const r2 = await run({ limit: 1 });
    assert.strictEqual(r2.pushed, 1); assert.ok(!r2.pending);
  });
  await t('falha no envio: não grava a assinatura e tenta de novo', async () => {
    await prisma.product.update({ where: { id: A.id }, data: { name: 'Card 1 novo' } });
    const ruim = { pushProductToNuvemshop: async () => { throw new Error('Nuvemshop 500'); } };
    const r = await run({ handlers: ruim });
    assert.strictEqual(r.errors, 1);
    enviados.length = 0; const r2 = await run();
    assert.strictEqual(r2.pushed, 1); assert.deepStrictEqual(enviados, [A.id]);
  });
  await t('card que deixou de passar no portão é despublicado (contado à parte)', async () => {
    await prisma.product.update({ where: { id: B.id }, data: { longDescription: 'mudou' } });
    const desp = { pushProductToNuvemshop: async () => ({ skipped: true, action: 'unpublished-invalid', reason: 'sem descricao' }) };
    const r = await run({ handlers: desp });
    assert.strictEqual(r.unpublished, 1);
  });
  await limpar();
  await prisma.$disconnect();
}

(async () => {
  console.log('A) regra das 5 fotos e assinatura do espelho (sem banco)');
  await partA();
  console.log('B) espelho no banco DESCARTÁVEL ' + process.env.DATABASE_URL.replace(/\/\/[^@]*@/, '//***@'));
  await partB();
  console.log(out.join('\n'));
  console.log((process.exitCode ? 'FALHOU' : 'OK') + ' — ' + pass + ' testes passaram');
  process.exit(process.exitCode || 0);
})().catch((e) => { console.error(e); process.exit(1); });
