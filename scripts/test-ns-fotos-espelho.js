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
  await t('AUDITORIA 2: produto que saiu do ar por falta de estoque VOLTA quando o estoque nas lojas do site volta', async () => {
    const loja = await prisma.store.create({ data: { code: 'LOJA-TESTE-ESP', name: 'Loja Site Teste' } });
    process.env.NS_STOCK_STORE_IDS = loja.id;
    await prisma.nuvemshopProductMapping.updateMany({ where: { localProductId: B.id }, data: { syncStatus: 'hidden-invalid' } });
    await prisma.product.update({ where: { id: B.id }, data: { aiContext: { color: 'Azul' } } });
    await run(); // grava a assinatura "sem estoque nas lojas do site"
    enviados.length = 0; await run();
    assert.ok(!enviados.includes(B.id), 'sem mudança, não reenvia');
    const ps = await prisma.productSize.findFirst({ where: { productId: B.id } });
    await prisma.storeStock.create({ data: { storeId: loja.id, productSizeId: ps.id, stock: 2 } });
    enviados.length = 0; await run();
    assert.ok(enviados.includes(B.id), 'estoque voltou: reenvia (o portão decide a volta)');
    await prisma.storeStock.deleteMany({}); await prisma.store.delete({ where: { id: loja.id } });
    delete process.env.NS_STOCK_STORE_IDS;
  });
  await t('AUDITORIA 2: card que nasceu na própria Nuvemshop fica fora do espelho (a loja é a fonte dele; evita laço)', async () => {
    const antes = (await prisma.product.findUnique({ where: { id: A.id } })).source;
    await prisma.product.update({ where: { id: A.id }, data: { source: 'nuvemshop', name: 'Espelhado da loja' } });
    enviados.length = 0;
    try { await run(); assert.ok(!enviados.includes(A.id)); }
    finally { await prisma.product.update({ where: { id: A.id }, data: { source: antes } }); }
  });
  await t('AUDITORIA 2: troca de fotos incompleta conta como falha (sem assinatura, tenta de novo depois)', async () => {
    await prisma.product.update({ where: { id: A.id }, data: { name: 'Card 1 fotos incompletas' } });
    const parcial = { pushProductToNuvemshop: async () => ({ action: 'updated', imageSync: { changed: false, errors: [{ position: 2, error: 'Remote image not found' }] } }) };
    const r = await run({ handlers: parcial });
    assert.strictEqual(r.errors, 1);
    const a = await prisma.product.findUnique({ where: { id: A.id } });
    assert.ok(a.aiContext.nsMirrorFails >= 1 && /fotos/.test(a.aiContext.nsMirrorLastError));
  });
  await t('AUDITORIA 8: variante (preço/estoque) que não foi para a loja conta como falha e é tentada de novo', async () => {
    await prisma.product.update({ where: { id: B.id }, data: { name: 'Card 2 falha variante' } });
    const falha = { pushProductToNuvemshop: async () => ({ action: 'updated', variantSync: { errors: [{ reason: 'failed to fetch variants: 500' }] }, imageSync: { changed: false } }) };
    const r1 = await run({ handlers: falha });
    assert.strictEqual(r1.errors, 1);
    const ctx = (await prisma.product.findUnique({ where: { id: B.id } })).aiContext;
    assert.ok(ctx.nsMirrorFails >= 1 && /variantes/.test(ctx.nsMirrorLastError), JSON.stringify(ctx));
    assert.notStrictEqual(ctx.nsMirrorSig, espelho.mirrorSig(Object.assign({}, B, { name: 'Card 2 falha variante' })), 'não gravou a assinatura');
    // card editado de novo durante a espera: tenta JÁ (a espera vale só para a versão que falhou)
    await prisma.product.update({ where: { id: B.id }, data: { name: 'Card 2 editado de novo' } });
    let chamou = 0;
    const ok = { pushProductToNuvemshop: async (id) => { if (id === B.id) chamou++; return { action: 'updated', variantSync: { errors: [] }, imageSync: { changed: false } }; } };
    const r2 = await run({ handlers: ok });
    assert.strictEqual(chamou, 1, 'edição nova não espera: ' + JSON.stringify(r2));
    const ctx2 = (await prisma.product.findUnique({ where: { id: B.id } })).aiContext;
    assert.ok(!ctx2.nsMirrorFails && !ctx2.nsMirrorFailSig, 'sucesso limpa a espera');
    Object.assign(ctx, ctx2);
    delete ctx.nsMirrorFails; delete ctx.nsMirrorFailAt; delete ctx.nsMirrorLastError;
    await prisma.product.update({ where: { id: B.id }, data: { aiContext: ctx } }); // tira da espera para o próximo teste
  });
  await t('AUDITORIA 3: erro de foto no formato singular também conta como falha', async () => {
    await prisma.product.update({ where: { id: B.id }, data: { name: 'Card 2 erro singular' } });
    const um = { pushProductToNuvemshop: async () => ({ action: 'updated', imageSync: { changed: false, error: 'exceção na troca' } }) };
    const r = await run({ handlers: um });
    assert.strictEqual(r.errors, 1);
  });
  await prisma.storeStock.deleteMany({});
  await limpar();
  await prisma.$disconnect();
}

async function partC() {
  // stub da API da Nuvemshop ANTES de carregar os handlers (nada sai para a loja)
  const nsPath = require.resolve('../src/services/nuvemshop');
  const chamadas = []; const corpos = []; let falharPost = false; let falharUma = null; let falharGet = false; let falharDelete = false; let seq = 800; let variantesRemotas = null; let falharDeleteVar = false; let falharZerar = false;
  require.cache[nsPath] = { id: nsPath, filename: nsPath, loaded: true, exports: { fetchAllPages: async () => [], nuvemshopApi: async (conn, metodo, url, corpo) => {
    chamadas.push(metodo + ' ' + url + (corpo && corpo.published === false ? ' DESPUBLICA' : ''));
    corpos.push({ metodo, url, corpo });
    if (metodo === 'GET' && /images$/.test(url)) { if (falharGet) throw new Error('GET caiu'); return [{ id: 901, position: 1 }, { id: 902, position: 2 }]; }
    if (metodo === 'DELETE' && falharDelete && /images\/90\d$/.test(url)) throw new Error('delete caiu');
    if (metodo === 'DELETE' && falharDeleteVar && /variants\/\d+$/.test(url)) throw new Error('variante não apaga');
    if (metodo === 'PUT' && falharZerar && /variants\/\d+$/.test(url) && corpo && corpo.stock === 0) throw new Error('zerar caiu');
    if (metodo === 'POST' && (falharPost || (falharUma && JSON.stringify(corpo || {}).includes(falharUma)))) throw new Error('falhou');
    if (metodo === 'POST' && url === '/products') return { id: ++seq, images: (corpo.images || []).map((x, i) => ({ id: 700 + i })), variants: [] };
    if (metodo === 'POST') return { id: ++seq };
    if (metodo === 'GET' && /variants$/.test(url) && variantesRemotas) return variantesRemotas;
    if (metodo === 'GET' && /^\/products\/\d+$/.test(url)) return { id: Number(url.split('/').pop()), variants: [] };
    return {};
  } } };
  const h = require('../src/services/nuvemshopHandlers');
  const { prisma } = require('../src/middleware');
  await prisma.nuvemshopProductMapping.deleteMany({}); await prisma.productSize.deleteMany({}); await prisma.product.deleteMany({});
  const lojaSite = await prisma.store.create({ data: { code: 'LOJA-SITE-C', name: 'Loja Site C' } });
  process.env.NS_STOCK_STORE_IDS = lojaSite.id;
  let nCard = 0;
  const cardValido = async (estoque = 2) => {
    nCard++;
    const c = await prisma.product.create({ data: { sku: 'VAL' + nCard, name: 'Tênis Válido Azul ' + nCard, brand: 'HOKA', category: 'Tênis', subcategory: 'Corrida',
      price: 900, costPrice: 400, longDescription: 'Descrição real.', imageUrl: 'https://img/v' + nCard + '.jpg',
      aiContext: { color: 'Azul', classification: { modality: 'Corrida', tier: 'Performance' }, confirmedForNuvemshop: true } } });
    const ps = await prisma.productSize.create({ data: { productId: c.id, size: '40', barcode: '0196565' + String(100000 + nCard), stock: 3, sizeConfirmedAt: new Date() } });
    await prisma.storeStock.create({ data: { storeId: lojaSite.id, productSizeId: ps.id, stock: estoque } });
    return { c, ps };
  };
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
  await t('AUDITORIA 9: troca PARCIAL fica com as novas que subiram, tira as antigas (nunca acumula) e não grava a assinatura', async () => {
    const q = await prisma.product.update({ where: { id: p.id }, data: { imageUrls: ['https://img/quebrada.jpg', ...fotos(5).slice(1, 4)] } });
    chamadas.length = 0; falharUma = 'quebrada';
    const r = await h.syncNuvemshopImages({ id: 'c' }, '555', q);
    falharUma = null;
    assert.ok(r.added > 0 && r.errors.length > 0, JSON.stringify(r));
    assert.ok(chamadas.some((c) => c === 'DELETE /products/555/images/901') && chamadas.some((c) => c === 'DELETE /products/555/images/902'), 'antigas saíram: ' + chamadas.join(' | '));
    assert.ok(!chamadas.some((c) => /^DELETE \/products\/555\/images\/8\d\d$/.test(c)), 'novas ficaram: ' + chamadas.join(' | '));
    assert.notStrictEqual((await prisma.product.findUnique({ where: { id: p.id } })).aiContext.nsImagesSig, r.sig, 'não gravou a assinatura: tenta de novo');
  });
  await t('AUDITORIA 2: se não der para ler as fotos atuais, não troca nada (não passa de 5 na loja)', async () => {
    const q = await prisma.product.update({ where: { id: p.id }, data: { imageUrls: fotos(5).reverse() } });
    chamadas.length = 0; falharGet = true;
    const r = await h.syncNuvemshopImages({ id: 'c' }, '555', q);
    falharGet = false;
    assert.ok(r.errors && r.errors.length); assert.ok(!chamadas.some((c) => c.startsWith('POST')));
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
  await t('AUDITORIA 2: card inválido que divide o produto da loja com OUTRO card não despublica (não derruba o card certo)', async () => {
    const curado = (await cardValido()).c;
    assert.ok(h.assessProductForNuvemshop(await prisma.product.findUnique({ where: { id: curado.id }, include: { sizes: { include: { storeStocks: true } } } })).eligible, 'curado de teste passa no portão');
    const fantasma = await prisma.product.create({ data: { sku: 'SHARE1-NS', name: 'Fantasma', brand: 'A DEFINIR', category: 'geral', price: 0, source: 'nuvemshop' } });
    await prisma.nuvemshopProductMapping.create({ data: { localProductId: curado.id, nuvemshopProductId: '888' } });
    await prisma.nuvemshopProductMapping.create({ data: { localProductId: fantasma.id, nuvemshopProductId: '888' } });
    chamadas.length = 0;
    const r = await h.pushProductToNuvemshop(fantasma.id, { id: 'c' });
    assert.strictEqual(r.action, 'skipped-shared');
    assert.ok(!chamadas.some((c) => c.endsWith('DESPUBLICA')), 'não despublicou: ' + chamadas.join(' | '));
    assert.ok((await prisma.product.findUnique({ where: { id: curado.id } })).aiContext.nsReenvioPedidoAt, 'pediu reenvio do card certo');
  });
  await t('AUDITORIA 2: eco de produto recém-enviado com código ALFANUMÉRICO não cria card-fantasma (corrida antes do mapping)', async () => {
    const c = await prisma.product.create({ data: { sku: 'EKPB999', name: 'Camisa Alfa', brand: 'BOTAFOGO', category: 'Roupas', price: 300, imageUrl: 'https://img/alfa.jpg', aiContext: { color: 'Preto' } } });
    await prisma.productSize.create({ data: { productId: c.id, size: 'G', barcode: 'EKPB999044G', stock: 1 } });
    const antes = await prisma.product.count();
    await h.upsertLocalProduct({ id: 9911, name: { pt: 'Camisa Alfa' }, brand: 'BOTAFOGO', categories: [], images: [], variants: [{ sku: 'EKPB999044G', price: '300' }], published: true });
    assert.strictEqual(await prisma.product.count(), antes, 'não criou card novo');
    const m = await prisma.nuvemshopProductMapping.findUnique({ where: { localProductId: c.id } });
    assert.ok(m && m.nuvemshopProductId === '9911', 'só ligou o mapping no card certo');
  });
  await t('AUDITORIA 3: despublicar (qualquer caminho, inclusive o reajuste de estoque) não derruba produto da loja compartilhado', async () => {
    const um = (await cardValido()).c;
    const dois = await prisma.product.create({ data: { sku: 'SH2B', name: 'Inválido 2', brand: 'HOKA', category: 'Tênis', price: 0 } });
    await prisma.nuvemshopProductMapping.create({ data: { localProductId: um.id, nuvemshopProductId: '889' } });
    const m2 = await prisma.nuvemshopProductMapping.create({ data: { localProductId: dois.id, nuvemshopProductId: '889' } });
    chamadas.length = 0;
    const r = await h.unpublishMappedProduct(dois.id, { id: 'c' }, 'produto inativo', m2);
    assert.ok(r.shared && !r.unpublished);
    assert.ok(!chamadas.some((c) => c.endsWith('DESPUBLICA')), 'não despublicou: ' + chamadas.join(' | '));
    assert.strictEqual((await prisma.nuvemshopProductMapping.findUnique({ where: { id: m2.id } })).syncStatus, 'hidden-invalid');
  });
  await t('AUDITORIA 3: eco não liga quando o código casa com DOIS cards, nem reaponta card que já é de outro NS#', async () => {
    const x1 = await prisma.product.create({ data: { sku: 'DUP1', name: 'Dup 1', brand: 'HOKA', category: 'Tênis', price: 1 } });
    const x2 = await prisma.product.create({ data: { sku: 'DUP2', name: 'Dup 2', brand: 'HOKA', category: 'Tênis', price: 1 } });
    await prisma.productSize.create({ data: { productId: x1.id, size: '40', barcode: 'REFDUPLA01', stock: 1 } });
    await prisma.productSize.create({ data: { productId: x2.id, size: '41', barcode: 'REFDUPLA01', stock: 1 } });
    const antes = await prisma.product.count();
    const r1 = await h.upsertLocalProduct({ id: 7001, name: { pt: 'X' }, categories: [], images: [], variants: [{ sku: 'REFDUPLA01', price: '1' }] });
    assert.strictEqual(r1, null); assert.strictEqual(await prisma.product.count(), antes, 'não criou card');
    assert.strictEqual(await prisma.nuvemshopProductMapping.count({ where: { nuvemshopProductId: '7001' } }), 0, 'não ligou nada');
    const y = await prisma.product.create({ data: { sku: 'OUTRONS', name: 'Já de outro NS', brand: 'HOKA', category: 'Tênis', price: 1 } });
    await prisma.productSize.create({ data: { productId: y.id, size: 'U', barcode: 'ACESS0RI0REF', stock: 1 } });
    await prisma.nuvemshopProductMapping.create({ data: { localProductId: y.id, nuvemshopProductId: '444' } });
    const r2 = await h.upsertLocalProduct({ id: 333, name: { pt: 'Z' }, categories: [], images: [], variants: [{ sku: 'ACESS0RI0REF', price: '1' }] });
    assert.strictEqual(r2, null);
    assert.strictEqual((await prisma.nuvemshopProductMapping.findUnique({ where: { localProductId: y.id } })).nuvemshopProductId, '444', 'não reapontou');
  });
  await t('AUDITORIA 4: card certo que ESGOTOU sai do ar mesmo dividindo o anúncio com um fantasma (não vende o que não tem)', async () => {
    const { c: certo, ps } = await cardValido(1);
    const fantasma = await prisma.product.create({ data: { sku: 'GHOST4', name: 'Fantasma 4', brand: 'A DEFINIR', category: 'geral', price: 0, source: 'nuvemshop' } });
    const mc = await prisma.nuvemshopProductMapping.create({ data: { localProductId: certo.id, nuvemshopProductId: '4040' } });
    await prisma.nuvemshopProductMapping.create({ data: { localProductId: fantasma.id, nuvemshopProductId: '4040' } });
    await prisma.storeStock.updateMany({ where: { productSizeId: ps.id }, data: { stock: 0 } });
    chamadas.length = 0;
    const r = await h.unpublishMappedProduct(certo.id, { id: 'c' }, 'sem tamanho valido com estoque fisico', mc);
    assert.ok(!r.shared, 'irmão é fantasma inválido: não segura');
    assert.ok(chamadas.some((x) => x === 'PUT /products/4040 DESPUBLICA'), 'despublicou: ' + chamadas.join(' | '));
  });
  await t('AUDITORIA 4: código que só existe em card INATIVO não cria card-fantasma', async () => {
    const inat = await prisma.product.create({ data: { sku: 'INAT4', name: 'Inativo 4', brand: 'HOKA', category: 'Tênis', price: 1, active: false } });
    await prisma.productSize.create({ data: { productId: inat.id, size: '40', barcode: '0196565999404', stock: 1 } });
    const antes = await prisma.product.count();
    const r = await h.upsertLocalProduct({ id: 4041, name: { pt: 'W' }, categories: [], images: [], variants: [{ sku: '0196565999404', price: '1' }] });
    assert.strictEqual(r, null); assert.strictEqual(await prisma.product.count(), antes);
  });
  await t('AUDITORIA 5: dois cards válidos no mesmo anúncio — o que esgota faz o OUTRO ser reenviado (loja fica com o estoque real dele)', async () => {
    const { c: a } = await cardValido(1);
    const { c: b, ps: psB } = await cardValido(3);
    await prisma.nuvemshopProductMapping.create({ data: { localProductId: a.id, nuvemshopProductId: '5050' } });
    const mb = await prisma.nuvemshopProductMapping.create({ data: { localProductId: b.id, nuvemshopProductId: '5050' } });
    await prisma.storeStock.updateMany({ where: { productSizeId: psB.id }, data: { stock: 0 } });
    chamadas.length = 0;
    const r = await h.unpublishMappedProduct(b.id, { id: 'c' }, 'sem estoque', mb);
    assert.ok(r.shared && r.irmao === a.id && r.reenvioPedido, JSON.stringify(r));
    assert.ok(!chamadas.some((c) => c.startsWith('PUT')), 'não envia daqui (sem espera circular): ' + chamadas.join(' | '));
    const ctxA = (await prisma.product.findUnique({ where: { id: a.id } })).aiContext;
    assert.ok(ctxA.nsReenvioPedidoAt && !ctxA.nsMirrorSig && !ctxA.nsCardSig && !ctxA.nsImagesSig, 'espelho vai reenviar A, fotos inclusive');
    // rodada seguinte do reajuste: não pede de novo (sem envio a cada 5 min)
    const r2 = await h.unpublishMappedProduct(b.id, { id: 'c' }, 'sem estoque', await prisma.nuvemshopProductMapping.findUnique({ where: { id: mb.id } }));
    assert.ok(r2.shared && !r2.reenvioPedido, 'não repete o pedido');
  });
  await t('AUDITORIA 6: card VÁLIDO com cópia da loja errada não é marcado como fora e nada é enviado daqui', async () => {
    const { c: a } = await cardValido(1);
    const { c: b } = await cardValido(1);
    const ma = await prisma.nuvemshopProductMapping.create({ data: { localProductId: a.id, nuvemshopProductId: '6161' } });
    await prisma.nuvemshopProductMapping.create({ data: { localProductId: b.id, nuvemshopProductId: '6161' } });
    chamadas.length = 0;
    const r = await h.unpublishMappedProduct(a.id, { id: 'c' }, 'copia remota invalida: marca', ma);
    assert.ok(r.shared); assert.strictEqual(chamadas.length, 0);
    assert.strictEqual((await prisma.nuvemshopProductMapping.findUnique({ where: { id: ma.id } })).syncStatus, 'synced');
    const r2 = await h.unpublishMappedProduct(a.id, { id: 'c' }, 'copia remota invalida: marca', ma);
    const r3 = await h.unpublishMappedProduct(a.id, { id: 'c' }, 'copia remota invalida: marca', ma);
    assert.ok(r.reenvioPedido && !r2.reenvioPedido && !r3.reenvioPedido, 'card válido: pede uma vez e respeita o limite de 6 h');
  });
  await t('AUDITORIA 6: dois caminhos ao mesmo tempo (reajuste + espelho) não despublicam o card válido nem travam', async () => {
    const { c: valido } = await cardValido(1);
    const fantasma = await prisma.product.create({ data: { sku: 'GHOST6C', name: 'Fantasma 6c', brand: 'A DEFINIR', category: 'geral', price: 0, source: 'nuvemshop', active: false } });
    await prisma.nuvemshopProductMapping.create({ data: { localProductId: valido.id, nuvemshopProductId: '6363' } });
    const mf = await prisma.nuvemshopProductMapping.create({ data: { localProductId: fantasma.id, nuvemshopProductId: '6363' } });
    chamadas.length = 0;
    const limite = new Promise((_, rej) => setTimeout(() => rej(new Error('travou (espera circular)')), 20000));
    const rs = await Promise.race([Promise.all([
      h.unpublishMappedProduct(fantasma.id, { id: 'c' }, 'produto inativo', mf),
      h.pushProductToNuvemshop(fantasma.id, { id: 'c' }),
      h.unpublishMappedProduct(fantasma.id, { id: 'c' }, 'produto inativo', mf),
    ]), limite]);
    assert.ok(rs.every((r) => r.shared || r.action === 'skipped-shared'), JSON.stringify(rs));
    assert.ok(!chamadas.some((c) => c.endsWith('DESPUBLICA')), 'não despublicou: ' + chamadas.join(' | '));
  });
  await t('AUDITORIA 6: eco do webhook num anúncio com fantasma + curado não reativa nem regrava o fantasma', async () => {
    const { c: curado } = await cardValido(1);
    const fantasma = await prisma.product.create({ data: { sku: 'GHOST6', name: 'Fantasma 6', brand: 'A DEFINIR', category: 'geral', price: 0, source: 'nuvemshop', active: false } });
    await prisma.nuvemshopProductMapping.create({ data: { localProductId: fantasma.id, nuvemshopProductId: '6262' } });
    await prisma.nuvemshopProductMapping.create({ data: { localProductId: curado.id, nuvemshopProductId: '6262' } });
    const r = await h.upsertLocalProduct({ id: 6262, name: { pt: 'Nome da loja' }, brand: 'HOKA', categories: [], images: [], variants: [{ sku: 'X6262', price: '1', stock: 9 }], published: true });
    assert.strictEqual(r && r.id, curado.id);
    const f = await prisma.product.findUnique({ where: { id: fantasma.id } });
    assert.strictEqual(f.active, false); assert.strictEqual(f.name, 'Fantasma 6');
    assert.strictEqual((await prisma.product.findUnique({ where: { id: curado.id } })).name, curado.name);
  });
  await t('AUDITORIA 5: produto NOVO com 8 fotos é criado com no máximo 5', async () => {
    const { c } = await cardValido(2);
    const fotos = ['https://img/n1.jpg', 'https://img/n2.jpg', 'https://img/n3.jpg', 'https://img/n4.jpg', 'https://img/n5.jpg', 'https://img/n6.jpg', 'https://img/n7.jpg'];
    await prisma.product.update({ where: { id: c.id }, data: { imageUrls: fotos } });
    const payload = h.buildNuvemshopProductPayload(await prisma.product.findUnique({ where: { id: c.id } }), [], { mode: 'create' });
    assert.strictEqual(payload.images.length, 5);
  });
  await t('AUDITORIA 5: foto antiga que não sai da loja não dá a troca por concluída (tenta de novo depois)', async () => {
    const { c } = await cardValido(2);
    await prisma.product.update({ where: { id: c.id }, data: { imageUrls: ['https://img/z1.jpg'] } });
    falharDelete = true;
    try {
      const r = await h.syncNuvemshopImages({ id: 'c' }, '6060', await prisma.product.findUnique({ where: { id: c.id } }));
      assert.ok(r.errors && r.errors.length, 'reportou erro');
      const ctx = (await prisma.product.findUnique({ where: { id: c.id } })).aiContext;
      assert.ok(!ctx.nsImagesSig, 'não gravou a assinatura');
    } finally { falharDelete = false; }
  });
  await t('AUDITORIA 7: preço ou promoção mudou com o MESMO estoque → chega à loja', async () => {
    const { c, ps } = await cardValido(2);
    const card = await prisma.product.update({ where: { id: c.id }, data: { price: 799 } });
    variantesRemotas = [{ id: 71, values: [{ pt: '40' }], sku: ps.barcode, barcode: ps.barcode, stock_management: true, stock: 2, price: '900.00', promotional_price: '850.00' }];
    corpos.length = 0;
    const r = await h.updateNuvemshopVariants({ id: 'c' }, '7171', card, [{ size: '40', barcode: ps.barcode, stock: 2 }]);
    const put = corpos.find((x) => x.metodo === 'PUT' && x.url === '/products/7171/variants/71');
    assert.ok(put && put.corpo.price === '799.00' && put.corpo.promotional_price === null, JSON.stringify(r) + ' ' + JSON.stringify(put));
    // tudo igual → não manda nada
    variantesRemotas = [{ id: 71, values: [{ pt: '40' }], sku: ps.barcode, barcode: ps.barcode, stock_management: true, stock: 2, price: '799.00', promotional_price: null }];
    corpos.length = 0;
    await h.updateNuvemshopVariants({ id: 'c' }, '7171', card, [{ size: '40', barcode: ps.barcode, stock: 2 }]);
    assert.ok(!corpos.some((x) => x.metodo === 'PUT'), 'sem mudança: nenhum envio');
    variantesRemotas = null;
  });
  await t('A1: tamanho que zerou e a loja recusa apagar → estoque vai a ZERO no site (não vende o que não tem) e fica para nova tentativa', async () => {
    const { c, ps } = await cardValido(2);
    const card = await prisma.product.findUnique({ where: { id: c.id } });
    const remoto = () => [
      { id: 81, values: [{ pt: '40' }], sku: ps.barcode, barcode: ps.barcode, stock_management: true, stock: 2, price: '900.00', promotional_price: null },
      { id: 82, values: [{ pt: '41' }], sku: 'X41', barcode: 'X41', stock_management: true, stock: 3, price: '900.00', promotional_price: null },
    ];
    falharDeleteVar = true;
    try {
      variantesRemotas = remoto(); corpos.length = 0;
      const r = await h.updateNuvemshopVariants({ id: 'c' }, '8181', card, [{ size: '40', barcode: ps.barcode, stock: 2 }, { size: '41', barcode: 'X41', stock: 0 }]);
      const zera = corpos.find((x) => x.metodo === 'PUT' && x.url === '/products/8181/variants/82');
      assert.ok(zera && zera.corpo.stock === 0 && zera.corpo.stock_management === true, 'zerou o 41: ' + JSON.stringify(corpos));
      assert.strictEqual(r.zeroed, 1); assert.strictEqual(r.deleted, 0);
      assert.ok(r.errors.length === 1 && r.errors[0].zeroed === true && /zerado na loja/.test(r.errors[0].error), 'segue como erro p/ tentar apagar de novo: ' + JSON.stringify(r.errors));
      assert.ok(!corpos.some((x) => x.metodo === 'PUT' && x.url === '/products/8181/variants/81'), 'tamanho 40 sem mudança não é reenviado');
      // já zerado na loja → não manda PUT de novo, só tenta apagar
      variantesRemotas = remoto(); variantesRemotas[1].stock = 0; corpos.length = 0;
      const r2 = await h.updateNuvemshopVariants({ id: 'c' }, '8181', card, [{ size: '40', barcode: ps.barcode, stock: 2 }, { size: '41', barcode: 'X41', stock: 0 }]);
      assert.ok(!corpos.some((x) => x.metodo === 'PUT'), 'nada a reenviar: ' + JSON.stringify(corpos));
      assert.strictEqual(r2.zeroed, 1); assert.strictEqual(r2.errors.length, 1);
      // apagar E zerar falham → erro diz isso (não finge que resolveu)
      falharZerar = true; variantesRemotas = remoto();
      const r3 = await h.updateNuvemshopVariants({ id: 'c' }, '8181', card, [{ size: '40', barcode: ps.barcode, stock: 2 }, { size: '41', barcode: 'X41', stock: 0 }]);
      assert.ok(!r3.zeroed && r3.errors[0].zeroed === false && /nem zerado/.test(r3.errors[0].error), JSON.stringify(r3));
    } finally { falharDeleteVar = false; falharZerar = false; variantesRemotas = null; }
    // apagar funcionando → nada de zerar, sem erro
    variantesRemotas = remoto(); corpos.length = 0;
    const r4 = await h.updateNuvemshopVariants({ id: 'c' }, '8181', card, [{ size: '40', barcode: ps.barcode, stock: 2 }, { size: '41', barcode: 'X41', stock: 0 }]);
    assert.strictEqual(r4.deleted, 1); assert.ok(!r4.zeroed && !r4.errors.length, JSON.stringify(r4));
    variantesRemotas = null;
  });
  await t('A1: no espelho, tamanho que não apaga fica zerado e o card volta a tentar (não grava como enviado)', async () => {
    const { c, ps } = await cardValido(2);
    await prisma.product.update({ where: { id: c.id }, data: { name: 'Tênis Válido Azul Espelho' } }); // número no nome parece tamanho
    await prisma.nuvemshopProductMapping.create({ data: { localProductId: c.id, nuvemshopProductId: '8282' } });
    falharDeleteVar = true;
    variantesRemotas = [
      { id: 91, values: [{ pt: '40' }], sku: ps.barcode, barcode: ps.barcode, stock_management: true, stock: 2, price: '900.00', promotional_price: null },
      { id: 92, values: [{ pt: '39' }], sku: 'X39', barcode: 'X39', stock_management: true, stock: 4, price: '900.00', promotional_price: null },
    ];
    try {
      corpos.length = 0;
      const r = await h.pushProductToNuvemshop(c.id, { id: 'c' });
      assert.ok(corpos.some((x) => x.metodo === 'PUT' && x.url === '/products/8282/variants/92' && x.corpo.stock === 0), 'zerou o 39 no push: ' + JSON.stringify(r));
      assert.ok(r.variantSync && r.variantSync.errors.length, 'push reporta para nova tentativa');
    } finally { falharDeleteVar = false; variantesRemotas = null; }
  });
  await t('AUDITORIA 3: foto inválida (Instagram/crawler) não vai para a loja nem trava a troca', () => {
    const lista = h.collectLocalImages({ imageUrl: 'https://lookaside.instagram.com/x', imageUrls: ['https://img/ok1.jpg', 'https://x/crawler/y', 'https://img/ok2.jpg'] });
    assert.deepStrictEqual(lista, ['https://img/ok1.jpg', 'https://img/ok2.jpg']);
  });
  await prisma.storeStock.deleteMany({}); await prisma.nuvemshopProductMapping.deleteMany({}); await prisma.productSize.deleteMany({}); await prisma.product.deleteMany({});
  await prisma.store.delete({ where: { id: lojaSite.id } }).catch(() => {});
  delete process.env.NS_STOCK_STORE_IDS;
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
