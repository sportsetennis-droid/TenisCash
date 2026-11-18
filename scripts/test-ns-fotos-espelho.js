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
  await t('falha no envio: não grava a assinatura e tenta de novo (depois da espera)', async () => {
    await prisma.product.update({ where: { id: A.id }, data: { name: 'Card 1 novo' } });
    const ruim = { pushProductToNuvemshop: async () => { throw new Error('Nuvemshop 500'); } };
    const t0 = Date.now();
    const r = await run({ handlers: ruim, agora: t0 });
    assert.strictEqual(r.errors, 1);
    enviados.length = 0; const r2 = await run({ agora: t0 + 6 * 60 * 1000 });
    assert.strictEqual(r2.pushed, 1); assert.deepStrictEqual(enviados, [A.id]);
  });
  await t('card que deixou de passar no portão é despublicado (contado à parte)', async () => {
    await prisma.product.update({ where: { id: B.id }, data: { longDescription: 'mudou' } });
    const desp = { pushProductToNuvemshop: async () => ({ skipped: true, action: 'unpublished-invalid', reason: 'sem descricao' }) };
    const r = await run({ handlers: desp });
    assert.strictEqual(r.unpublished, 1);
  });
  // ---------- regressões da AUDITORIA de 18/11 ----------
  await t('AUDITORIA: sem connection passada usa getConnection(); sem conexão ativa avisa no estado (não fica "saudável" calado)', async () => {
    const usada = []; const comConn = { getConnection: async () => ({ id: 'c-real' }), pushProductToNuvemshop: async (id, c) => { usada.push(c && c.id); return { action: 'updated' }; } };
    await prisma.product.update({ where: { id: A.id }, data: { name: 'Card 1 conexão' } });
    await espelho.runNuvemshopCardMirror({ prisma, handlers: comConn });
    assert.deepStrictEqual(usada, ['c-real']);
    const semConn = { getConnection: async () => null, pushProductToNuvemshop: async () => { throw new Error('não devia enviar'); } };
    const r = await espelho.runNuvemshopCardMirror({ prisma, handlers: semConn });
    assert.ok(r.semConexao);
    const st = espelho.getNuvemshopCardMirrorState();
    assert.ok(st.lastError && /sem conexão/.test(st.lastError) && st.lastResult.semConexao);
  });
  await t('AUDITORIA: produto que saiu do ar (hidden-invalid) também é reenviado quando o card muda (pode voltar)', async () => {
    await prisma.nuvemshopProductMapping.updateMany({ where: { localProductId: B.id }, data: { syncStatus: 'hidden-invalid' } });
    await prisma.product.update({ where: { id: B.id }, data: { name: 'Card 2 reposto' } });
    enviados.length = 0; await run();
    assert.ok(enviados.includes(B.id));
  });
  await t('AUDITORIA: falha espera tempo crescente e não trava o lote', async () => {
    await prisma.product.update({ where: { id: A.id }, data: { name: 'Card 1 falha' } });
    const ruim = { pushProductToNuvemshop: async () => { throw new Error('Nuvemshop 404'); } };
    const t0 = Date.now();
    await run({ handlers: ruim, agora: t0 });
    enviados.length = 0;
    const r1 = await run({ agora: t0 + 60 * 1000 });
    assert.strictEqual(r1.waitingRetry, 1); assert.ok(!enviados.includes(A.id), 'dentro da espera não reenvia');
    await run({ agora: t0 + 6 * 60 * 1000 });
    assert.ok(enviados.includes(A.id), 'depois da espera tenta de novo');
    const a = await prisma.product.findUnique({ where: { id: A.id } });
    assert.ok(!a.aiContext.nsMirrorFails, 'sucesso limpa o contador de falhas');
    assert.strictEqual(espelho.esperaMs(1), 5 * 60000); assert.strictEqual(espelho.esperaMs(20), 24 * 3600000);
  });
  await t('AUDITORIA: assinatura cobre referência e mapeamento de categorias', () => {
    const base = espelho.mirrorSig(card());
    assert.notStrictEqual(espelho.mirrorSig(card({ sku: 'OUTRA' })), base);
    assert.notStrictEqual(espelho.mirrorSig(card({ aiContext: { ...card().aiContext, nuvemshopMapping: { categoryIds: [1] } } })), base);
  });
  await t('AUDITORIA: gravação de assinatura não desfaz o resto do aiContext, nem em formato texto antigo', async () => {
    const { mergeAiContext } = require('../src/services/aiContextMerge');
    await prisma.product.update({ where: { id: A.id }, data: { aiContext: { color: 'Azul', classification: { tier: 'X' } } } });
    await mergeAiContext(prisma, A.id, { nsMirrorSig: 's1' });
    let a = await prisma.product.findUnique({ where: { id: A.id } });
    assert.strictEqual(a.aiContext.color, 'Azul'); assert.strictEqual(a.aiContext.classification.tier, 'X'); assert.strictEqual(a.aiContext.nsMirrorSig, 's1');
    await prisma.$executeRawUnsafe('UPDATE "Product" SET "aiContext" = to_jsonb($2::text) WHERE id = $1', A.id, JSON.stringify({ color: 'Verde' }));
    await mergeAiContext(prisma, A.id, { nsMirrorSig: 's2' });
    a = await prisma.product.findUnique({ where: { id: A.id } });
    assert.strictEqual(a.aiContext.color, 'Verde'); assert.strictEqual(a.aiContext.nsMirrorSig, 's2');
  });
  await limpar();
  await prisma.$disconnect();
}

async function partC() {
  // stub da API da Nuvemshop ANTES de carregar os handlers (nada sai para a loja)
  const nsPath = require.resolve('../src/services/nuvemshop');
  const chamadas = []; let falharPost = false;
  require.cache[nsPath] = { id: nsPath, filename: nsPath, loaded: true, exports: { nuvemshopApi: async (conn, metodo, url) => {
    chamadas.push(metodo + ' ' + url);
    if (metodo === 'GET') return [{ id: 901, position: 1 }, { id: 902, position: 2 }];
    if (metodo === 'POST' && falharPost) throw new Error('falhou');
    return {};
  } } };
  const h = require('../src/services/nuvemshopHandlers');
  const { prisma } = require('../src/middleware');
  await prisma.nuvemshopProductMapping.deleteMany({}); await prisma.productSize.deleteMany({}); await prisma.product.deleteMany({});
  const p = await prisma.product.create({ data: { sku: 'IMG1', name: 'Card fotos', brand: 'HOKA', category: 'Tênis', price: 10, imageUrl: 'https://img/a.jpg', imageUrls: fotos(7), aiContext: { color: 'Azul' } } });
  await t('AUDITORIA: no máximo 5 fotos vão para a loja', () => {
    assert.strictEqual(h.collectLocalImages(p).length, 5);
  });
  await t('AUDITORIA: troca de fotos SOBE as novas antes de APAGAR as antigas (nunca fica sem foto)', async () => {
    chamadas.length = 0;
    const r = await h.syncNuvemshopImages({ id: 'c' }, '555', p);
    const iPost = chamadas.findIndex((c) => c.startsWith('POST')), iDel = chamadas.findIndex((c) => c.startsWith('DELETE'));
    assert.ok(iPost >= 0 && iDel > iPost, chamadas.join(' | '));
    assert.strictEqual(r.added, 5); assert.strictEqual(r.removed, 2);
  });
  await t('AUDITORIA: se nenhuma foto nova subir, as antigas ficam (não apaga)', async () => {
    const q = await prisma.product.update({ where: { id: p.id }, data: { imageUrls: fotos(5).reverse() } });
    chamadas.length = 0; falharPost = true;
    const r = await h.syncNuvemshopImages({ id: 'c' }, '555', q);
    falharPost = false;
    assert.strictEqual(r.added, 0); assert.strictEqual(r.removed, 0);
    assert.ok(!chamadas.some((c) => c.startsWith('DELETE')));
  });
  await t('AUDITORIA: eco de webhook não sobrescreve card curado (nem com código alfanumérico)', async () => {
    const c = await prisma.product.create({ data: { sku: 'EKPB471902', name: 'Camisa Botafogo Curada', brand: 'BOTAFOGO', category: 'Roupas', price: 300, imageUrl: 'https://img/curada.jpg', aiContext: { color: 'Preto' } } });
    await prisma.productSize.create({ data: { productId: c.id, size: 'M', barcode: 'EKPB471902044M', stock: 1 } });
    await prisma.nuvemshopProductMapping.create({ data: { localProductId: c.id, nuvemshopProductId: '777' } });
    await h.upsertLocalProduct({ id: 777, name: { pt: 'Nome da Loja' }, brand: 'X', categories: [{ name: { pt: 'geral' } }], images: [{ src: 'https://cdn.loja/x.jpg' }], variants: [{ sku: 'EKPB471902044M', price: '1' }], published: true });
    const depois = await prisma.product.findUnique({ where: { id: c.id } });
    assert.strictEqual(depois.name, 'Camisa Botafogo Curada'); assert.strictEqual(depois.imageUrl, 'https://img/curada.jpg'); assert.strictEqual(depois.price, 300);
  });
  await prisma.nuvemshopProductMapping.deleteMany({}); await prisma.productSize.deleteMany({}); await prisma.product.deleteMany({});
  await prisma.$disconnect();
}

(async () => {
  console.log('A) regra das 5 fotos e assinatura do espelho (sem banco)');
  await partA();
  console.log('B) espelho no banco DESCARTÁVEL ' + process.env.DATABASE_URL.replace(/\/\/[^@]*@/, '//***@'));
  await partB();
  console.log('C) envio de fotos e eco de webhook (API da Nuvemshop simulada)');
  await partC();
  console.log(out.join('\n'));
  console.log((process.exitCode ? 'FALHOU' : 'OK') + ' — ' + pass + ' testes passaram');
  process.exit(process.exitCode || 0);
})().catch((e) => { console.error(e); process.exit(1); });
