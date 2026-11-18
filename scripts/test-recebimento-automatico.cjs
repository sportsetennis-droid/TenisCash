'use strict';
// =====================================================================
// Testes: RECEBIMENTO ATIVO AUTOMÁTICO (dono 18/11/2026)
//   ROUND_TEST_DATABASE_URL=postgresql://roundtest@127.0.0.1:55329/stock_replacement_<nome> node scripts/test-recebimento-automatico.cjs
// Banco DESCARTÁVEL local (mesma trava dos testes da substituição). Nada sai do banco de teste.
// =====================================================================
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const url = process.env.ROUND_TEST_DATABASE_URL;
if (!url?.startsWith('postgresql://roundtest@127.0.0.1:55329/stock_replacement_')) throw Error('Use exclusivamente o banco isolado stock_replacement_ na porta 55329.');
process.env.DATABASE_URL = url;
const { prisma } = require('../src/middleware');
const auto = require('../src/services/receiptAutoApply');
const replacement = require('../src/services/stockReplacement');

let pass = 0; const out = [];
async function t(nome, fn) {
  try { await fn(); pass++; out.push('  ✓ ' + nome); }
  catch (e) { out.push('  ✗ ' + nome + '\n      ' + (e && e.stack ? e.stack.split('\n').slice(0, 4).join('\n      ') : e)); process.exitCode = 1; }
}
const P = 'rcb-' + Date.now() + '-';
const T0 = new Date(Date.now() - 6 * 3600e3); // início da contagem nova
const min = (n) => new Date(T0.getTime() + n * 60e3);

async function main() {
  const loja = await prisma.store.create({ data: { code: P + 'L', name: 'Loja teste recebimento' } });
  const user = await prisma.user.create({ data: { phone: P + 'u', pin: 'x', name: 'Operador teste' } });
  const prod = await prisma.product.create({ data: { sku: P + 'S', name: 'Chuteira Teste', brand: 'JOMA', category: 'Chuteiras', price: 300 } });
  const tam = async (s, extra = {}) => prisma.productSize.create({ data: { productId: prod.id, size: s, barcode: P + s, stock: 5, ...extra } });
  const ps39 = await tam('39'), ps40 = await tam('40'), ps41 = await tam('41'), ps42 = await tam('42'), ps43 = await tam('43');
  const round = await prisma.stocktakeRound.create({ data: { name: 'Substituição teste', storeId: loja.id, status: 'counting', operationType: 'replacement', activeReplacementStoreId: loja.id, baseline: [], startedAt: T0 } });
  const estoque = async (ps) => (await prisma.storeStock.findUnique({ where: { storeId_productSizeId: { storeId: loja.id, productSizeId: ps.id } } }))?.stock || 0;
  const somaMov = async (ps) => (await prisma.storeStockMovement.aggregate({ where: { storeId: loja.id, productSizeId: ps.id }, _sum: { quantity: true } }))._sum.quantity || 0;
  const lote = async (extra = {}) => prisma.scanActionLot.create({ data: { sessionId: randomUUID(), mode: 'receipt', operatorId: user.id, toStoreId: loja.id, payloadHash: '', ...extra } });
  const leitura = async (lot, ps, em, extra = {}) => prisma.scanActionRead.create({ data: { clientScanId: randomUUID(), lotId: lot.sessionId, barcode: ps.barcode, scannedAt: em, recognized: true, productSizeId: ps.id, productName: 'Chuteira Teste', brand: 'JOMA', size: ps.size, ...extra } });
  const aplicar = (lot) => prisma.$transaction((tx) => auto.aplicarLote(tx, lot.sessionId));
  // bipe da contagem validado (o que o applyVerified faz) + pareamento
  const contar = async (ps, em) => {
    const b = await prisma.stocktakeBipe.create({ data: { roundId: round.id, storeId: loja.id, barcode: ps.barcode, productId: prod.id, productSizeId: ps.id, found: true, applied: true, bipedAt: em } });
    await prisma.$transaction(async (tx) => {
      const { applyStoreStockDelta } = require('../src/services/storeStockLedger');
      await applyStoreStockDelta(tx, { storeId: loja.id, productSizeId: ps.id, quantity: 1, type: 'inventory_adjustment', source: 'stock-replacement-scan', reason: 'teste', metadata: { roundId: round.id, bipeId: b.id } });
      await tx.stockReplacementCheck.create({ data: { bipeId: b.id, roundId: round.id, status: 'applied', evidence: {}, appliedProductSizeId: ps.id, appliedAt: new Date() } });
      await auto.parear(tx, loja.id, ps.id);
    });
    return b;
  };

  await t('recebimento depois da contagem nova entra NA HORA no estoque da loja (uma vez só)', async () => {
    const l = await lote();
    await leitura(l, ps39, min(10)); await leitura(l, ps39, min(11));
    const r = await aplicar(l);
    assert.equal(r.aplicadas, 2); assert.equal(await estoque(ps39), 2);
    const r2 = await aplicar(l);
    assert.equal(r2.aplicadas, 0, 'idempotente'); assert.equal(await estoque(ps39), 2);
    assert.equal(await somaMov(ps39), 2, 'estoque explicado pelo histórico de movimentos');
  });
  await t('recebimento de ANTES da contagem nova não entra (só vale bipe novo)', async () => {
    const l = await lote();
    await leitura(l, ps40, new Date(T0.getTime() - 60e3));
    await aplicar(l);
    assert.equal(await estoque(ps40), 0);
  });
  await t('Adidas sem tamanho confirmado não entra; confirmado na caixa, entra', async () => {
    const l = await lote();
    const rd = await leitura(l, ps41, min(20), { requiresSizeConfirmation: true, confirmedSize: null });
    await aplicar(l); assert.equal(await estoque(ps41), 0);
    await prisma.scanActionRead.update({ where: { clientScanId: rd.clientScanId }, data: { confirmedSize: '41' } });
    await aplicar(l); assert.equal(await estoque(ps41), 1);
  });
  await t('leitura removida ou trocada de variante desfaz; lote arquivado desfaz tudo', async () => {
    const l = await lote();
    const a = await leitura(l, ps42, min(30)); const b = await leitura(l, ps42, min(31));
    await aplicar(l); assert.equal(await estoque(ps42), 2);
    await prisma.scanActionRead.update({ where: { clientScanId: a.clientScanId }, data: { removed: true } });
    await aplicar(l); assert.equal(await estoque(ps42), 1);
    await prisma.scanActionRead.update({ where: { clientScanId: b.clientScanId }, data: { productSizeId: ps43.id, barcode: ps43.barcode } });
    await aplicar(l); assert.equal(await estoque(ps42), 0); assert.equal(await estoque(ps43), 1, 'trocou de variante: sai de uma, entra na outra');
    await prisma.scanActionLot.update({ where: { sessionId: l.sessionId }, data: { status: 'archived' } });
    await aplicar(l); assert.equal(await estoque(ps43), 0);
    assert.equal(await somaMov(ps42), 0); assert.equal(await somaMov(ps43), 0);
  });
  await t('SEM SOMA DUPLA: contagem que bipa a peça já recebida confirma a mesma peça (recebeu 2, contou 2 → 2; contou 3 → 3)', async () => {
    const ps = await tam('44');
    const l = await lote();
    await leitura(l, ps, min(40)); await leitura(l, ps, min(41));
    await aplicar(l); assert.equal(await estoque(ps), 2);
    await contar(ps, min(50)); assert.equal(await estoque(ps), 2, '1º bipe da contagem confirma recebido');
    await contar(ps, min(51)); assert.equal(await estoque(ps), 2, '2º bipe confirma o outro recebido');
    await contar(ps, min(52)); assert.equal(await estoque(ps), 3, '3º bipe é outra peça');
    assert.equal(await somaMov(ps), 3, 'tudo explicado por movimentos (o fechamento da contagem confere isso)');
  });
  await t('contagem ANTES do recebimento: são peças diferentes, as duas contam', async () => {
    const ps = await tam('45');
    await contar(ps, min(60));
    const l = await lote(); await leitura(l, ps, min(70));
    await aplicar(l);
    assert.equal(await estoque(ps), 2);
  });
  await t('recebimento removido depois de pareado: o bipe da contagem volta a valer a peça', async () => {
    const ps = await tam('46');
    const l = await lote(); const rd = await leitura(l, ps, min(80));
    await aplicar(l); await contar(ps, min(90));
    assert.equal(await estoque(ps), 1);
    await prisma.scanActionRead.update({ where: { clientScanId: rd.clientScanId }, data: { removed: true } });
    await aplicar(l);
    assert.equal(await estoque(ps), 1, 'a peça contada continua'); assert.equal(await somaMov(ps), 1);
  });
  await t('bipe da contagem pareado e EXCLUÍDO: o recebimento continua valendo a peça', async () => {
    const ps = await tam('47');
    const l = await lote(); await leitura(l, ps, min(100));
    await aplicar(l); const b = await contar(ps, min(110));
    assert.equal(await estoque(ps), 1);
    await prisma.$transaction((tx) => replacement.exclude(tx, b, 'teste: bipe errado'));
    assert.equal(await estoque(ps), 1, 'recebimento fica'); assert.equal(await somaMov(ps), 1);
  });
  await t('remessa confirmada depois não soma de novo o que já entrou no bipe', async () => {
    const l = await lote(); const a = await leitura(l, ps39, min(120)); const b = await leitura(l, ps40, min(121));
    await aplicar(l);
    const ja = await prisma.$transaction((tx) => auto.jaEntrouPorLeituras(tx, loja.id, [a.clientScanId, b.clientScanId]));
    assert.equal(ja.get(ps39.id), 1); assert.equal(ja.get(ps40.id), 1);
  });
  await t('varredura geral (a cada 10 min) aplica lote que ganhou tamanho depois e não duplica', async () => {
    const ps = await tam('48');
    const l = await lote(); const rd = await leitura(l, ps, min(130), { requiresSizeConfirmation: true });
    await auto.aplicarTodos(prisma); assert.equal(await estoque(ps), 0);
    await prisma.scanActionRead.update({ where: { clientScanId: rd.clientScanId }, data: { confirmedSize: '48' } });
    await auto.aplicarTodos(prisma); await auto.aplicarTodos(prisma);
    assert.equal(await estoque(ps), 1);
  });
  await t('loja sem contagem nova aberta nem fechada: nada é somado (não chuta o ponto de partida)', async () => {
    const outra = await prisma.store.create({ data: { code: P + 'L2', name: 'Loja sem substituição' } });
    const l = await prisma.scanActionLot.create({ data: { sessionId: randomUUID(), mode: 'receipt', operatorId: user.id, toStoreId: outra.id, payloadHash: '' } });
    await prisma.scanActionRead.create({ data: { clientScanId: randomUUID(), lotId: l.sessionId, barcode: ps39.barcode, scannedAt: new Date(), recognized: true, productSizeId: ps39.id } });
    await prisma.$transaction((tx) => auto.aplicarLote(tx, l.sessionId));
    assert.equal((await prisma.storeStock.findUnique({ where: { storeId_productSizeId: { storeId: outra.id, productSizeId: ps39.id } } }))?.stock || 0, 0);
  });
  await t('o comprado (ProductSize.stock) nunca muda', async () => {
    for (const ps of [ps39, ps40, ps41, ps42, ps43]) assert.equal((await prisma.productSize.findUnique({ where: { id: ps.id } })).stock, 5);
  });
}

main().catch((e) => { out.push('  ✗ erro geral: ' + e.stack); process.exitCode = 1; })
  .finally(async () => {
    console.log(out.join('\n'));
    console.log(process.exitCode ? 'FALHOU' : 'OK — ' + pass + ' testes passaram');
    await prisma.$disconnect();
  });
