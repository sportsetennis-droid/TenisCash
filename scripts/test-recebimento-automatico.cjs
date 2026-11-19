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
process.env.RECEBIMENTO_AUTOMATICO_DESDE = new Date(T0.getTime() + 5 * 60e3).toISOString(); // "a partir de hoje" (5 min depois do início da contagem)
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
  await t('recebimento de ANTES da contagem nova não entra quando é calçado (a contagem recontou calçado)', async () => {
    const l = await lote();
    await leitura(l, ps40, new Date(T0.getTime() - 60e3));
    await aplicar(l);
    assert.equal(await estoque(ps40), 0);
  });
  await t('recebimento depois da contagem nova mas ANTES do ponto de partida pedido pelo dono ("hoje") não entra', async () => {
    const ps = await tam('38');
    const l = await lote(); await leitura(l, ps, min(2));
    await aplicar(l); assert.equal(await estoque(ps), 0);
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
  // ---- casos da auditoria 18/11 (viram teste permanente) ----
  await t('AUDITORIA 1: lote CONFIRMADO pela remessa nunca é mexido (a remessa já contou) — inclusive Adidas que ganhou tamanho na confirmação', async () => {
    const ps = await tam('36');
    const l = await lote();
    await leitura(l, ps, min(140)); const ad = await leitura(l, ps, min(141), { requiresSizeConfirmation: true });
    await aplicar(l); assert.equal(await estoque(ps), 1);
    // remessa confirmada: soma o que faltava (1) e grava o tamanho; lote vira confirmed
    const { applyStoreStockDelta } = require('../src/services/storeStockLedger');
    await prisma.$transaction((tx) => applyStoreStockDelta(tx, { storeId: loja.id, productSizeId: ps.id, quantity: 1, type: 'transfer_in', source: 'teste-remessa', reason: 'teste' }));
    await prisma.scanActionRead.update({ where: { clientScanId: ad.clientScanId }, data: { confirmedSize: '36' } });
    await prisma.scanActionLot.update({ where: { sessionId: l.sessionId }, data: { status: 'confirmed', confirmedAt: new Date() } });
    await aplicar(l); await auto.aplicarTodos(prisma);
    assert.equal(await estoque(ps), 2, 'nada somado de novo depois de confirmado');
  });
  await t('AUDITORIA 1b: tirar o tempo de corte depois não desfaz o que já entrou (só sai por motivo da leitura)', async () => {
    const ps = await tam('35');
    const l = await lote(); await leitura(l, ps, min(150));
    await aplicar(l); assert.equal(await estoque(ps), 1);
    const antes = process.env.RECEBIMENTO_AUTOMATICO_DESDE;
    process.env.RECEBIMENTO_AUTOMATICO_DESDE = new Date(Date.now() + 86400e3).toISOString();
    try { await aplicar(l); assert.equal(await estoque(ps), 1); } finally { process.env.RECEBIMENTO_AUTOMATICO_DESDE = antes; }
  });
  await t('AUDITORIA 2: contagem FECHADA + recebimento pareado removido depois = a peça contada continua (não perde unidade)', async () => {
    const ps = await tam('34');
    const l = await lote(); const rd = await leitura(l, ps, min(160));
    await aplicar(l); await contar(ps, min(170));
    assert.equal(await estoque(ps), 1);
    await prisma.stocktakeRound.update({ where: { id: round.id }, data: { status: 'closed', activeReplacementStoreId: null } });
    try {
      await prisma.scanActionRead.update({ where: { clientScanId: rd.clientScanId }, data: { removed: true } });
      await aplicar(l);
      assert.equal(await estoque(ps), 1, 'peça contada continua');
      // recebimento NÃO pareado removido com a contagem fechada: desfaz normalmente
      const ps2 = await tam('33');
      const l2 = await lote(); const r2 = await leitura(l2, ps2, min(180));
      await aplicar(l2); assert.equal(await estoque(ps2), 1, 'rodada fechada: recebimento continua entrando');
      await prisma.scanActionRead.update({ where: { clientScanId: r2.clientScanId }, data: { removed: true } });
      await aplicar(l2); assert.equal(await estoque(ps2), 0);
    } finally { await prisma.stocktakeRound.update({ where: { id: round.id }, data: { status: 'counting', activeReplacementStoreId: loja.id } }); }
  });
  await t('AUDITORIA 3: contagem nova aberta depois (zera a loja) não desfaz recebimento da contagem anterior', async () => {
    const ps = await tam('32');
    const l = await lote(); const rd = await leitura(l, ps, min(190));
    await aplicar(l); assert.equal(await estoque(ps), 1);
    await prisma.stocktakeRound.update({ where: { id: round.id }, data: { status: 'closed', activeReplacementStoreId: null } });
    const r2 = await prisma.stocktakeRound.create({ data: { name: 'Substituição 2', storeId: loja.id, status: 'counting', operationType: 'replacement', activeReplacementStoreId: loja.id, baseline: [], startedAt: new Date() } });
    try {
      const { applyStoreStockDelta } = require('../src/services/storeStockLedger');
      await prisma.$transaction((tx) => applyStoreStockDelta(tx, { storeId: loja.id, productSizeId: ps.id, quantity: -1, type: 'inventory_adjustment', source: 'stock-replacement-start', reason: 'zera' }));
      await auto.aplicarTodos(prisma);
      assert.equal(await estoque(ps), 0, 'varredura não desfaz (não fica -1)');
      await prisma.scanActionRead.update({ where: { clientScanId: rd.clientScanId }, data: { removed: true } });
      await aplicar(l);
      assert.equal(await estoque(ps), 0, 'nem leitura removida desfaz entrada de contagem antiga');
    } finally {
      await prisma.stocktakeRound.update({ where: { id: r2.id }, data: { status: 'cancelled', activeReplacementStoreId: null } });
      await prisma.stocktakeRound.update({ where: { id: round.id }, data: { status: 'counting', activeReplacementStoreId: loja.id } });
    }
  });
  await t('ANTERIOR (dono 18/11 "valide todos"): roupa/acessório recebido ANTES da contagem e não contado entra; venda apagada pelo arquivamento é baixada de novo, uma vez', async () => {
    const { applyStoreStockDelta } = require('../src/services/storeStockLedger');
    const roupa = await prisma.product.create({ data: { sku: P + 'R', name: 'Legging Teste', brand: 'LUPO', category: 'Vestuário', price: 100 } });
    const rp = await prisma.productSize.create({ data: { productId: roupa.id, size: 'M', barcode: P + 'RM', stock: 4 } });
    const docR = await prisma.xmlFiscalDocument.create({ data: { docType: 'entrada', issuerName: 'Lupo teste' } });
    await prisma.xmlFiscalItem.create({ data: { fiscalDocumentId: docR.id, description: 'Legging M', ean: rp.barcode, quantity: 4 } });
    // venda ANTES da contagem (baixa -1) e o arquivamento do saldo na abertura (+1 de volta a zero)
    const vendaAntes = new Date(T0.getTime() - 30 * 60e3);
    await prisma.$transaction((tx) => applyStoreStockDelta(tx, { storeId: loja.id, productSizeId: rp.id, quantity: -1, type: 'sale', source: 'teste-venda', reason: 'venda' }));
    await prisma.storeStockMovement.updateMany({ where: { productSizeId: rp.id, type: 'sale' }, data: { createdAt: vendaAntes } });
    await prisma.$transaction((tx) => applyStoreStockDelta(tx, { storeId: loja.id, productSizeId: rp.id, quantity: 1, type: 'inventory_adjustment', source: 'stock-replacement-start', reason: 'arquiva' }));
    await prisma.storeStockMovement.updateMany({ where: { productSizeId: rp.id, source: 'stock-replacement-start' }, data: { createdAt: T0 } });
    assert.equal(await estoque(rp), 0);
    const l = await lote();
    await leitura(l, rp, new Date(T0.getTime() - 60 * 60e3), { productName: 'Legging Teste', brand: 'LUPO', size: 'M' });
    await leitura(l, rp, new Date(T0.getTime() - 59 * 60e3), { productName: 'Legging Teste', brand: 'LUPO', size: 'M' });
    const r = await aplicar(l);
    assert.equal(r.aplicadas, 2, 'as 2 peças recebidas antes entram');
    assert.equal(await estoque(rp), 1, 'recebeu 2, vendeu 1 antes da contagem → 1');
    await aplicar(l); await auto.aplicarTodos(prisma);
    assert.equal(await estoque(rp), 1, 'idempotente: não soma nem baixa de novo');
    // a contagem bipa a peça depois: pareia com o recebimento, não soma em dobro
    const b = await prisma.stocktakeBipe.create({ data: { roundId: round.id, storeId: loja.id, barcode: rp.barcode, productId: roupa.id, productSizeId: rp.id, found: true, applied: true, bipedAt: min(200) } });
    await prisma.$transaction(async (tx) => {
      await applyStoreStockDelta(tx, { storeId: loja.id, productSizeId: rp.id, quantity: 1, type: 'inventory_adjustment', source: 'stock-replacement-scan', reason: 'teste', metadata: { roundId: round.id, bipeId: b.id } });
      await tx.stockReplacementCheck.create({ data: { bipeId: b.id, roundId: round.id, status: 'applied', evidence: {}, appliedProductSizeId: rp.id, appliedAt: new Date() } });
      await auto.parear(tx, loja.id, rp.id);
    });
    assert.equal(await estoque(rp), 1, 'bipe da contagem: vale a contagem (1) — o anterior sai e a venda volta');
    // lote arquivado: desfaz recebimentos E devolve a baixa das vendas (volta ao que a contagem diz)
    await prisma.scanActionLot.update({ where: { sessionId: l.sessionId }, data: { status: 'archived' } });
    await prisma.$transaction(async (tx) => { await auto.aplicarLote(tx, l.sessionId); });
    assert.equal(await estoque(rp), 1, 'sem recebimento: vale o bipe da contagem (1)');
  });
  await t('ANTERIOR: calçado recebido antes não entra (calçado foi contado); tamanho já bipado na contagem não entra', async () => {
    const l = await lote();
    await leitura(l, ps43, new Date(T0.getTime() - 60e3));
    await aplicar(l); assert.equal(await estoque(ps43), 0, 'chuteira = calçado, não entra');
    const ac = await prisma.product.create({ data: { sku: P + 'A', name: 'Meia Teste', brand: 'LUPO', category: 'Acessórios', price: 30 } });
    const ap = await prisma.productSize.create({ data: { productId: ac.id, size: 'U', barcode: P + 'AU', stock: 3 } });
    const b = await prisma.stocktakeBipe.create({ data: { roundId: round.id, storeId: loja.id, barcode: ap.barcode, productId: ac.id, productSizeId: ap.id, found: true, applied: true, bipedAt: min(210) } });
    await prisma.stockReplacementCheck.create({ data: { bipeId: b.id, roundId: round.id, status: 'applied', evidence: {}, appliedProductSizeId: ap.id, appliedAt: new Date() } });
    const l2 = await lote(); await leitura(l2, ap, new Date(T0.getTime() - 60e3), { productName: 'Meia Teste', brand: 'LUPO', size: 'U' });
    await aplicar(l2); assert.equal(await estoque(ap), 0, 'tamanho contado: a contagem manda');
  });
  await t('ANTERIOR: loja que já está contando a família (≥ mínimo de bipes) não recebe o anterior', async () => {
    const antes = process.env.RECEBIMENTO_FAMILIA_CONTADA_MIN;
    const ac = await prisma.product.create({ data: { sku: P + 'B', name: 'Boné Teste', brand: 'LUPO', category: 'Acessórios', price: 30 } });
    const ap = await prisma.productSize.create({ data: { productId: ac.id, size: 'U', barcode: P + 'BU', stock: 3 } });
    // há 1 bipe de acessório na contagem (o da meia do teste anterior); com mínimo 1 a família conta como "em contagem"
    delete require.cache[require.resolve('../src/services/receiptAutoApply')];
    process.env.RECEBIMENTO_FAMILIA_CONTADA_MIN = '1';
    try {
      const auto2 = require('../src/services/receiptAutoApply');
      const l = await lote(); await leitura(l, ap, new Date(T0.getTime() - 60e3), { productName: 'Boné Teste', brand: 'LUPO', size: 'U' });
      await prisma.$transaction((tx) => auto2.aplicarLote(tx, l.sessionId));
      assert.equal(await estoque(ap), 0);
    } finally {
      if (antes === undefined) delete process.env.RECEBIMENTO_FAMILIA_CONTADA_MIN; else process.env.RECEBIMENTO_FAMILIA_CONTADA_MIN = antes;
      delete require.cache[require.resolve('../src/services/receiptAutoApply')];
    }
  });
  await t('ANTERIOR: família da categoria', () => {
    assert.equal(auto.familiaDaCategoria('Tênis'), 'calcado'); assert.equal(auto.familiaDaCategoria('Chuteiras'), 'calcado');
    assert.equal(auto.familiaDaCategoria('Roupas'), 'vestuario'); assert.equal(auto.familiaDaCategoria('Vestuário'), 'vestuario');
    assert.equal(auto.familiaDaCategoria('ACESSÓRIOS'), 'acessorio'); assert.equal(auto.familiaDaCategoria('INSUMO'), 'outro'); assert.equal(auto.familiaDaCategoria('A classificar'), 'outro');
  });
  await t('ANTERIOR / auditoria 2: a contagem MANDA — bipe posterior desfaz o anterior (corrige para baixo); código lido vale mais que a variante antiga; teto = comprado; sem NF-e não entra', async () => {
    const { applyStoreStockDelta } = require('../src/services/storeStockLedger');
    const doc = await prisma.xmlFiscalDocument.create({ data: { docType: 'entrada', issuerName: 'Fornecedor teste' } });
    const nf = (ean, q = 5) => prisma.xmlFiscalItem.create({ data: { fiscalDocumentId: doc.id, description: 'item ' + ean, ean, quantity: q } });
    const cardV = await prisma.product.create({ data: { sku: P + 'V', name: 'Regata Teste', brand: 'BODY FOR SURE', category: 'Roupas', price: 80 } });
    const novoCard = async (n, bc, comprado = 5) => { const pr = await prisma.product.create({ data: { sku: P + n, name: 'Regata ' + n, brand: 'BODY FOR SURE', category: 'Roupas', price: 80 } }); return prisma.productSize.create({ data: { productId: pr.id, size: 'M', barcode: bc, stock: comprado } }); };
    // (a) contagem corrige para baixo: recebeu 3 antes, contagem acha 1 → 1
    const a = await novoCard('A1', P + 'A1'); await nf(a.barcode);
    const la = await lote(); for (const k of [70, 69, 68]) await leitura(la, a, new Date(T0.getTime() - k * 60e3));
    await aplicar(la); assert.equal(await estoque(a), 3);
    const b = await prisma.stocktakeBipe.create({ data: { roundId: round.id, storeId: loja.id, barcode: a.barcode, productSizeId: a.id, found: true, applied: true, bipedAt: min(220) } });
    await prisma.$transaction(async (tx) => {
      await applyStoreStockDelta(tx, { storeId: loja.id, productSizeId: a.id, quantity: 1, type: 'inventory_adjustment', source: 'stock-replacement-scan', reason: 'teste', metadata: { roundId: round.id, bipeId: b.id } });
      await tx.stockReplacementCheck.create({ data: { bipeId: b.id, roundId: round.id, status: 'applied', evidence: {}, appliedProductSizeId: a.id, appliedAt: new Date() } });
      await auto.parear(tx, loja.id, a.id);
    });
    assert.equal(await estoque(a), 1, 'vale a contagem (1), não o recebido (3)');
    await auto.aplicarTodos(prisma); assert.equal(await estoque(a), 1, 'a varredura não devolve o anterior de um tamanho contado');
    // (b) leitura antiga aponta para a variante errada (card dividido depois): entra no dono do código lido
    const certo = await novoCard('B1', P + 'B1'); const errado = await novoCard('B2', P + 'B2'); await nf(certo.barcode);
    const lb = await lote(); await leitura(lb, errado, new Date(T0.getTime() - 50 * 60e3), { barcode: certo.barcode });
    await aplicar(lb);
    assert.equal(await estoque(certo), 1, 'entra no tamanho que é dono do código lido'); assert.equal(await estoque(errado), 0);
    // (c) teto = comprado: recebeu 3 com comprado 2 → só 2 entram
    const c = await novoCard('C1', P + 'C1', 2); await nf(c.barcode, 2);
    const lc = await lote(); for (const k of [40, 39, 38]) await leitura(lc, c, new Date(T0.getTime() - k * 60e3));
    await aplicar(lc); assert.equal(await estoque(c), 2, 'acima do comprado vai para conferência');
    // (d) sem NF-e de entrada do código: não entra
    const d = await novoCard('D1', P + 'D1');
    const ld = await lote(); await leitura(ld, d, new Date(T0.getTime() - 30 * 60e3));
    await aplicar(ld); assert.equal(await estoque(d), 0);
    // (e) venda consome primeiro o estoque antigo: tinha 2 antes do recebimento, vendeu 2, recebeu 1 → baixa 0 → 1
    const e = await novoCard('E1', P + 'E1'); await nf(e.barcode);
    const mov = async (q, type, quando) => { await prisma.$transaction((tx) => applyStoreStockDelta(tx, { storeId: loja.id, productSizeId: e.id, quantity: q, type, source: 'teste', reason: 'teste' })); const m = await prisma.storeStockMovement.findFirst({ where: { productSizeId: e.id }, orderBy: { createdAt: 'desc' } }); await prisma.storeStockMovement.update({ where: { id: m.id }, data: { createdAt: quando } }); };
    await mov(2, 'inventory_adjustment', new Date(T0.getTime() - 120 * 60e3));
    await mov(-2, 'sale', new Date(T0.getTime() - 20 * 60e3));
    const le = await lote(); await leitura(le, e, new Date(T0.getTime() - 25 * 60e3));
    await aplicar(le); assert.equal(await estoque(e), 1, 'as 2 vendas consumiram o estoque antigo; a peça recebida continua');
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
