// =====================================================================
// Testes: FOTOS PELA LOJA (dono 19/11: "Arrume outro jeito" — foto sem crédito).
//   RNA_TEST_DATABASE_URL=postgresql://postgres@localhost:55432/rede_marcas node scripts/test-fotos-loja.js
// ⚠ APAGA e semeia dados no banco informado (só localhost).
// =====================================================================
process.env.DATABASE_URL = process.env.RNA_TEST_DATABASE_URL || 'postgresql://postgres@localhost:55432/rede_marcas';
if (!/@(localhost|127\.0\.0\.1)(:\d+)?\//.test(process.env.DATABASE_URL)) { console.error('Recusado: use só banco DESCARTÁVEL local.'); process.exit(2); }
delete process.env.NS_MIN_FOTOS;
const assert = require('assert');
const sharp = require('sharp');
const { prisma } = require('../src/middleware');
const fotos = require('../src/services/fotosDaLoja');

let pass = 0; const out = [];
async function t(nome, fn) {
  try { await fn(); pass++; out.push('  ✓ ' + nome); } catch (e) { out.push('  ✗ ' + nome + '\n      ' + (e && e.stack ? e.stack.split('\n').slice(0, 4).join('\n      ') : e)); process.exitCode = 1; }
}
const jpg = async (w, h, cor) => 'data:image/jpeg;base64,' + (await sharp({ create: { width: w, height: h, channels: 3, background: cor } }).jpeg().toBuffer()).toString('base64');
const erro = async (p, status, rx) => { try { await p; } catch (e) { assert.strictEqual(e.status, status, e.message); if (rx) assert.ok(rx.test(e.message), e.message); return; } assert.fail('devia falhar com ' + status); };

(async () => {
  const sufixo = 'FL' + Date.now();
  const lojaA = await prisma.store.create({ data: { code: sufixo + 'A', name: 'Loja Foto A' } });
  const lojaB = await prisma.store.create({ data: { code: sufixo + 'B', name: 'Loja Foto B' } });
  const vendedor = { id: 'v1', name: 'Vendedor Teste', role: 'seller', storeId: lojaA.id, storeIds: [] };
  const gestor = { id: 'g1', name: 'Gestor', role: 'manager', storeId: null, storeIds: [] };
  const mk = async (sku, ean, imageUrl = null, imageUrls = [], estoqueA = 1) => {
    const p = await prisma.product.create({ data: { sku, name: 'LEGGING TESTE ' + sku, brand: 'TESTE', category: 'Roupas', price: 100, imageUrl, imageUrls, aiContext: { color: 'Preto' } } });
    const s = await prisma.productSize.create({ data: { productId: p.id, size: 'M', barcode: ean, stock: 2 } });
    if (estoqueA) await prisma.storeStock.create({ data: { storeId: lojaA.id, productSizeId: s.id, stock: estoqueA } });
    return p;
  };
  const A = await mk(sufixo + '1', '7890000000011', 'https://x/1.jpg');
  const B = await mk(sufixo + '2', '7890000000028');
  const C = await mk(sufixo + '3', '7890000000035', null, [], 0);
  const cheio = await mk(sufixo + '4', '7890000000042', 'https://x/a.jpg', ['https://x/b.jpg', 'https://x/c.jpg', 'https://x/d.jpg', 'https://x/e.jpg']);
  const img1 = await jpg(800, 900, '#222'), img2 = await jpg(900, 800, '#333'), img3 = await jpg(2400, 2400, '#444');

  await t('pendentes: só cards com estoque NESTA loja e menos de 5 fotos, os com menos fotos primeiro', async () => {
    const l = await fotos.pendentes(prisma, vendedor, lojaA.id);
    const ids = l.map((x) => x.id);
    assert.ok(ids.includes(A.id) && ids.includes(B.id), 'A e B pendentes');
    assert.ok(!ids.includes(C.id), 'sem estoque na loja: fora');
    assert.ok(!ids.includes(cheio.id), 'já tem 5 fotos: fora');
    assert.ok(ids.indexOf(B.id) < ids.indexOf(A.id), 'sem foto vem antes de quem tem 1');
    assert.strictEqual(l.find((x) => x.id === A.id).faltam, 4);
  });
  await t('vendedor não acessa loja que não é dele; gestor acessa', async () => {
    await erro(fotos.pendentes(prisma, vendedor, lojaB.id), 403);
    await erro(fotos.salvar(prisma, vendedor, A.id, { storeId: lojaB.id, codigo: '7890000000011', imagens: [img1] }), 403);
    assert.ok(Array.isArray(await fotos.pendentes(prisma, gestor, lojaB.id)));
  });
  await t('código bipado de OUTRO card é recusado (a foto tem de ser da mesma cor e modelo)', async () => {
    await erro(fotos.salvar(prisma, vendedor, A.id, { storeId: lojaA.id, codigo: '7890000000028', imagens: [img1] }), 409, /não é deste produto/);
    await erro(fotos.salvar(prisma, vendedor, A.id, { storeId: lojaA.id, codigo: '', imagens: [img1] }), 400, /Bipe/);
  });
  await t('sem estoque na loja escolhida: recusa', async () => {
    await erro(fotos.salvar(prisma, gestor, C.id, { storeId: lojaA.id, codigo: '7890000000035', imagens: [img1] }), 409, /estoque/);
  });
  await t('foto inválida, pequena demais ou mais de 5: recusa', async () => {
    await erro(fotos.salvar(prisma, vendedor, A.id, { storeId: lojaA.id, codigo: '7890000000011', imagens: ['data:text/plain;base64,aGVsbG8='] }), 400);
    await erro(fotos.salvar(prisma, vendedor, A.id, { storeId: lojaA.id, codigo: '7890000000011', imagens: [await jpg(120, 120, '#000')] }), 400, /pequena/);
    await erro(fotos.salvar(prisma, vendedor, A.id, { storeId: lojaA.id, codigo: '7890000000011', imagens: [img1, img1, img1, img1, img1, img1] }), 400, /5/);
  });
  await t('completar: soma às fotos válidas do card, reduz para JPEG ≤ 1200 px e registra quem/onde/código', async () => {
    const r = await fotos.salvar(prisma, vendedor, A.id, { storeId: lojaA.id, codigo: '07890000000011', imagens: [img1, img3] });
    assert.strictEqual(r.fotos, 3); assert.strictEqual(r.faltam, 2);
    const a = await prisma.product.findUnique({ where: { id: A.id } });
    assert.strictEqual(a.imageUrl, 'https://x/1.jpg', 'a foto que já existia continua na frente');
    assert.strictEqual(a.imageUrls.length, 2);
    const meta = await sharp(Buffer.from(a.imageUrls[1].split(',')[1], 'base64')).metadata();
    assert.ok(meta.format === 'jpeg' && meta.width <= 1200 && meta.height <= 1200, 'reduzida: ' + meta.width);
    assert.strictEqual(a.aiContext.fotosDaLoja.por, 'Vendedor Teste'); assert.strictEqual(a.aiContext.fotosDaLoja.storeId, lojaA.id); assert.strictEqual(a.aiContext.fotosDaLoja.codigo, '7890000000011');
  });
  await t('trocar: substitui todas (fotos atuais de outra cor) e guarda os links anteriores', async () => {
    const r = await fotos.salvar(prisma, vendedor, A.id, { storeId: lojaA.id, codigo: '7890000000011', imagens: [img2], modo: 'trocar' });
    assert.strictEqual(r.fotos, 1);
    const a = await prisma.product.findUnique({ where: { id: A.id } });
    assert.ok(a.imageUrl.startsWith('data:image/jpeg;base64,')); assert.deepStrictEqual(a.imageUrls, []);
    assert.ok(a.aiContext.fotosDaLoja.anteriores.includes('https://x/1.jpg'), 'link anterior guardado');
    assert.strictEqual(a.aiContext.fotosDaLojaHistorico.length, 2);
  });
  await t('nunca passa de 5 fotos no card', async () => {
    const r = await fotos.salvar(prisma, vendedor, B.id, { storeId: lojaA.id, codigo: '7890000000028', imagens: [img1, img2, img3, await jpg(700, 700, '#555'), await jpg(701, 700, '#666')] });
    assert.strictEqual(r.fotos, 5);
    const r2 = await fotos.salvar(prisma, vendedor, B.id, { storeId: lojaA.id, codigo: '7890000000028', imagens: [await jpg(702, 700, '#777')] });
    assert.strictEqual(r2.fotos, 5, 'completar com card cheio não passa de 5');
  });
  await t('AUDITORIA 19/11: card com galeria em JSON null (sem foto nenhuma) recebe as fotos (não dá 409 eterno)', async () => {
    const N = await mk(sufixo + '5', '7890000000059');
    await prisma.$executeRawUnsafe('UPDATE "Product" SET "imageUrls" = \'null\'::jsonb WHERE id = $1', N.id);
    const r = await fotos.salvar(prisma, vendedor, N.id, { storeId: lojaA.id, codigo: '7890000000059', imagens: [img1] });
    assert.strictEqual(r.fotos, 1);
  });
  await t('AUDITORIA 19/11: "trocar" guarda no arquivo as fotos base64 que saem (nada se perde)', async () => {
    const antes = (await prisma.product.findUnique({ where: { id: B.id } }));
    const base64 = [antes.imageUrl, ...antes.imageUrls].filter((u) => u.startsWith('data:'));
    await fotos.salvar(prisma, vendedor, B.id, { storeId: lojaA.id, codigo: '7890000000028', imagens: [img2], modo: 'trocar' });
    const arq = await prisma.$queryRawUnsafe('SELECT image FROM "ProductPhotoArchive" WHERE "productId" = $1', B.id);
    for (const u of base64.filter((x) => x !== (fotos.fotosValidas({ imageUrl: null, imageUrls: [] })[0]))) assert.ok(arq.some((a) => a.image === u) || u === (await prisma.product.findUnique({ where: { id: B.id } })).imageUrl, 'base64 arquivada');
    assert.ok(arq.length >= base64.length - 1, 'arquivou ' + arq.length + ' de ' + base64.length);
    const reg = (await prisma.product.findUnique({ where: { id: B.id } })).aiContext.fotosDaLoja;
    assert.ok(reg.arquivadas >= 1 && !JSON.stringify(reg).includes('data:image'), 'registro sem base64 dentro do card');
  });
  await t('AUDITORIA 19/11: lista não entrega os códigos; conferência do código é no servidor com a mesma regra', async () => {
    const l = await fotos.pendentes(prisma, gestor, lojaA.id);
    assert.ok(l.length && l.every((x) => (x.tamanhos || []).every((t) => !('codigo' in t))), 'sem código na lista');
    assert.deepStrictEqual(await fotos.conferir(prisma, vendedor, A.id, { storeId: lojaA.id, codigo: '07890000000011' }), { ok: true, tamanho: 'M' });
    assert.strictEqual((await fotos.conferir(prisma, vendedor, A.id, { storeId: lojaA.id, codigo: '7890000000028' })).ok, false);
    assert.strictEqual((await fotos.conferir(prisma, vendedor, A.id, { storeId: lojaA.id, codigo: '11' })).ok, false, 'pedaço do código não vale');
    await erro(fotos.conferir(prisma, vendedor, A.id, { storeId: lojaB.id, codigo: '7890000000011' }), 403);
  });
  await limpar();
  console.log(out.join('\n'));
  console.log((process.exitCode ? 'FALHOU' : 'OK') + ' — ' + pass + ' testes passaram');
  await prisma.$disconnect();
  process.exit(process.exitCode || 0);

  async function limpar() {
    const prods = await prisma.product.findMany({ where: { sku: { startsWith: sufixo } }, select: { id: true } });
    const ids = prods.map((p) => p.id);
    await prisma.$executeRawUnsafe('DELETE FROM "ProductPhotoArchive" WHERE "productId" = ANY($1::text[])', ids).catch(() => {});
    await prisma.storeStock.deleteMany({ where: { storeId: { in: [lojaA.id, lojaB.id] } } });
    await prisma.productSize.deleteMany({ where: { productId: { in: ids } } });
    await prisma.product.deleteMany({ where: { id: { in: ids } } });
    await prisma.store.deleteMany({ where: { id: { in: [lojaA.id, lojaB.id] } } });
  }
})().catch((e) => { console.error(e); process.exit(1); });
