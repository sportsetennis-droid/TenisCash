// =====================================================================
// Testes do GERENTE DE MARCA (marca.gerente) da Rede Neural.
//   node scripts/test-rede-marcas.js
//   (padrão: postgresql://postgres@localhost:55432/rede_marcas — banco
//    DESCARTÁVEL local; outro: RNA_TEST_DATABASE_URL=...)
// ⚠ APAGA e semeia dados no banco informado. Recusa qualquer host que não
// seja localhost. Não chama IA (o gerente é regra pura).
// Prova: 1 relatório por marca (grafias diferentes = mesma marca; "A DEFINIR"
// fora); comprado = Σ ProductSize.stock; localizado = StoreStock > 0 por loja;
// negativo separado; venda de loja física × site (NS-); margem só com custo;
// parado, ruptura, preço ≤ custo e gate do site; pedido sob demanda = 1 marca.
// =====================================================================
process.env.DATABASE_URL = process.env.RNA_TEST_DATABASE_URL || 'postgresql://postgres@localhost:55432/rede_marcas';
if (!/@(localhost|127\.0\.0\.1)(:\d+)?\//.test(process.env.DATABASE_URL)) { console.error('Recusado: use só banco DESCARTÁVEL local.'); process.exit(2); }
process.env.RNA_RELOGIO = '0';
delete process.env.RNA_ATIVA;
const assert = require('assert');
const registro = require('../src/ai/rede/registro');

let pass = 0; const out = [];
async function t(nome, fn) {
  try { await fn(); pass++; out.push('  ✓ ' + nome); } catch (e) { out.push('  ✗ ' + nome + '\n      ' + (e && e.stack ? e.stack.split('\n').slice(0, 4).join('\n      ') : e)); process.exitCode = 1; }
}

// ---------------------------------------------------------------- A) sem banco
async function partA() {
  const r = registro.carregar();
  const marcas = require('../src/ai/rede/regras/marcas');
  const rx = require('../src/ai/rede/neuronios/marca/_raio-x');
  await t('contrato: marca.gerente carrega (e a rede inteira também), detector = regra, só lê', () => {
    assert.deepStrictEqual(r.erros, []);
    const n = r.neuronios.get('marca.gerente');
    assert.ok(n, 'faltou marca.gerente');
    assert.strictEqual(n.custo.tipo, 'regra');
    assert.strictEqual(n.permissao, 'ler');
    assert.deepStrictEqual(n.emite, ['marca.relatorio']);
    assert.ok(n.escuta.includes('relogio.diario') && n.escuta.includes('marca.pedir'));
  });
  await t('marca: grafias diferentes viram a mesma chave; sem marca fica fora', () => {
    assert.strictEqual(marcas.chave('Hoka'), 'HOKA');
    assert.strictEqual(marcas.chave(' hoka '), 'HOKA');
    assert.strictEqual(marcas.chave('Caju Brasil'), 'CAJU BRASIL');
    assert.strictEqual(marcas.chave('Asics'), marcas.chave('ASICS'));
    for (const x of ['A DEFINIR', 'Marca nao informada', 'Marca não informada', '', null]) assert.strictEqual(marcas.chave(x), null, String(x));
  });
  await t('ficha: Adidas avisa que tamanho só vem da caixa; marca sem ficha devolve null (não inventa)', () => {
    assert.match(marcas.ficha('ADIDAS').tamanho, /CAIXA/);
    assert.strictEqual(marcas.ficha('MARCA QUE NAO EXISTE'), null);
  });
  await t('alertas: preço ≤ custo e estoque negativo vêm antes de cadastro; nota de atenção 0–100', () => {
    const m = { cadastro: { precoAbaixoCusto: 1, itensPreco: [], semFoto: 3, semCor: 0, tamanhoTecnicoComEstoque: 0, semCusto: 0 }, negativos: { linhas: 2, unidades: -2, itens: [] },
      ruptura: { cards: 0, itens: [] }, parados: { cards: 0, unidades: 0, valorCustoRS: 0, itens: [] }, site: { prontosParaSubir: 0, publicadosSemEstoque: 0, bloqueados: 0, motivos: {}, itens: [] } };
    const a = rx.alertas(m);
    assert.deepStrictEqual(a.map((x) => x.area), ['preço', 'estoque', 'cadastro']);
    const nota = rx.nota(m);
    assert.ok(nota > 0 && nota <= 100);
  });
}

// ---------------------------------------------------------------- B) banco descartável
async function partB() {
  const { prisma } = require('../src/middleware');
  const ferramentas = require('../src/ai/rede/ferramentas');
  const gerente = require('../src/ai/rede/neuronios/marca/gerente');
  const DIA = 24 * 3600 * 1000;
  const agora = Date.now();
  const atras = (d) => new Date(agora - d * DIA);

  async function limpar() {
    await prisma.nuvemshopProductMapping.deleteMany({});
    await prisma.storeStockMovement.deleteMany({}); await prisma.saleItem.deleteMany({}); await prisma.sale.deleteMany({});
    await prisma.storeStock.deleteMany({}); await prisma.productSize.deleteMany({}); await prisma.product.deleteMany({}); await prisma.store.deleteMany({});
    await prisma.user.deleteMany({ where: { phone: { startsWith: 'teste-rede-marcas' } } });
  }
  await limpar();

  const L = {};
  for (const [code, name] of [['LOJA02', 'Bessa'], ['LOJA04', 'Fábrica']]) L[code] = await prisma.store.create({ data: { code, name } });
  process.env.NS_STOCK_STORE_IDS = L.LOJA04.id; // só a LOJA04 vale pro site neste teste
  const vend = await prisma.user.create({ data: { phone: 'teste-rede-marcas-1', pin: 'x', name: 'Vendedor Teste' } });
  const prod = async (d, sizes) => {
    const p = await prisma.product.create({ data: Object.assign({ category: 'Tênis' }, d) });
    const S = {};
    for (const s of sizes) S[s.size] = await prisma.productSize.create({ data: Object.assign({ productId: p.id }, s) });
    return Object.assign(p, { S });
  };
  const loc = (store, size, stock) => prisma.storeStock.create({ data: { storeId: store.id, productSizeId: size.id, stock } });
  const venda = async ({ store, site, em, p, size, qtd, total, custo }) => {
    const s = await prisma.sale.create({ data: { sellerId: vend.id, storeId: store ? store.id : null, totalAmount: total, status: 'completed', createdAt: em, erpReference: site ? 'NS-999' + Math.floor(Math.random() * 1e6) : null } });
    await prisma.saleItem.create({ data: { saleId: s.id, productId: p.id, productSizeId: size.id, productName: p.name, brand: p.brand, size: size.size, quantity: qtd, unitPrice: total / qtd, totalPrice: total, unitCost: custo } });
  };

  // HOKA (duas grafias) — A publicado com venda na loja e no site; B com preço abaixo do custo; F com físico no site sem descrição
  const A = await prod({ sku: 'H1', name: 'Tênis HOKA Clifton 10 Azul', brand: 'HOKA', price: 900, costPrice: 380, aiContext: { color: 'Azul' }, imageUrl: 'https://x/a.jpg' },
    [{ size: '40', barcode: '0196565000040', stock: 3 }, { size: '41', barcode: '0196565000041', stock: 3 }]);
  await loc(L.LOJA02, A.S['40'], 1); await loc(L.LOJA04, A.S['41'], 2);
  await prisma.nuvemshopProductMapping.create({ data: { localProductId: A.id, nuvemshopProductId: '111' } });
  await venda({ store: L.LOJA02, em: atras(5), p: A, size: A.S['40'], qtd: 1, total: 900, custo: 380 });
  await venda({ site: true, em: atras(3), p: A, size: A.S['41'], qtd: 1, total: 900, custo: 380 });
  await prod({ sku: 'H2', name: 'Meia Hoka', brand: 'Hoka', price: 100, costPrice: 120 }, [{ size: 'U', barcode: '0196565000099', stock: 0 }]);
  const F = await prod({ sku: 'H3', name: 'Tênis HOKA Bondi 9 Preto', brand: 'hoka', price: 1000, costPrice: 400, aiContext: { color: 'Preto' }, imageUrl: 'https://x/f.jpg' },
    [{ size: '42', barcode: '0196565000042', stock: 1 }]);
  await loc(L.LOJA04, F.S['42'], 1);

  // PENALTY — C parado (200 dias, sem venda); D vendeu e não tem físico (ruptura); E com estoque negativo
  const C = await prod({ sku: 'P1', name: 'Camiseta Parada', brand: 'PENALTY', price: 100, costPrice: 50, createdAt: atras(200) }, [{ size: 'M', barcode: '7890000000551', stock: 10 }]);
  await loc(L.LOJA02, C.S.M, 10);
  const D = await prod({ sku: 'P2', name: 'Bola Vendida', brand: 'PENALTY', price: 200, costPrice: 80 }, [{ size: 'U', barcode: '7890000000661', stock: 4 }]);
  await venda({ store: L.LOJA02, em: atras(10), p: D, size: D.S.U, qtd: 2, total: 400, custo: null });
  const E = await prod({ sku: 'P3', name: 'Bermuda Negativa', brand: 'PENALTY', price: 80, costPrice: 40 }, [{ size: 'G', barcode: '7890000000771', stock: 2 }]);
  await loc(L.LOJA02, E.S.G, -1);

  // fora do relatório: sem marca e inativo
  await prod({ sku: 'X1', name: 'Sem Marca', brand: 'A DEFINIR', price: 10, costPrice: 5 }, [{ size: 'U', barcode: '7890000000881', stock: 1 }]);
  await prod({ sku: 'X2', name: 'Inativo', brand: 'NIKE', price: 10, costPrice: 5, active: false }, [{ size: 'U', barcode: '7890000000991', stock: 1 }]);

  const ler = ferramentas.soLeitura(prisma);
  const sinais = await gerente.disparar({ sinal: { tipo: 'relogio.diario', dados: {} }, ler, agora: new Date(agora) });
  const R = Object.fromEntries(sinais.map((s) => [s.dados.marca, s.dados]));

  await t('1 relatório por marca: HOKA (3 grafias juntas) e PENALTY; sem marca e inativo ficam fora', () => {
    assert.deepStrictEqual(Object.keys(R).sort(), ['HOKA', 'PENALTY']);
    assert.ok(sinais.every((s) => s.tipo === 'marca.relatorio' && s.dados.chave.startsWith('marca|')));
    assert.strictEqual(R.HOKA.cards, 3);
    assert.deepStrictEqual(R.HOKA.nomes.sort(), ['HOKA', 'Hoka', 'hoka']);
  });
  await t('estoque: comprado = Σ ProductSize.stock; localizado = StoreStock > 0 por loja; negativo à parte', () => {
    assert.strictEqual(R.HOKA.comprado, 7);
    assert.strictEqual(R.HOKA.localizado, 4);
    assert.deepStrictEqual(R.HOKA.porLoja, { LOJA02: 1, LOJA04: 3 });
    assert.strictEqual(R.PENALTY.localizado, 10, 'o -1 não desconta do localizado');
    assert.strictEqual(R.PENALTY.negativos.linhas, 1);
    assert.strictEqual(R.PENALTY.negativos.unidades, -1);
  });
  await t('venda: loja física × site (NS-) e margem só sobre venda com custo gravado', () => {
    assert.deepStrictEqual(R.HOKA.vendas.porCanal30, { LOJA02: { un: 1, rs: 900 }, SITE: { un: 1, rs: 900 } });
    assert.strictEqual(R.HOKA.vendas.d30.un, 2);
    assert.strictEqual(R.HOKA.vendas.d7.un, 2);
    assert.strictEqual(R.HOKA.vendas.d30.margemPct, 57.78);
    assert.strictEqual(R.PENALTY.vendas.d30.margemPct, null, 'venda sem custo não inventa margem');
    assert.strictEqual(R.PENALTY.vendas.d30.unSemCusto, 2);
  });
  await t('parado (200 dias sem venda, valor a custo) e ruptura (vendeu e não tem físico)', () => {
    assert.strictEqual(R.PENALTY.parados.cards, 1);
    assert.strictEqual(R.PENALTY.parados.valorCustoRS, 500);
    assert.strictEqual(R.PENALTY.parados.itens[0].base, 'cadastro');
    assert.strictEqual(R.PENALTY.ruptura.cards, 1);
    assert.strictEqual(R.PENALTY.ruptura.itens[0].vendidos30, 2);
  });
  await t('site: publicado contado; físico na loja do site sem publicar passa pelo gate oficial (sem descrição = barrado)', () => {
    assert.strictEqual(R.HOKA.site.publicados, 1);
    assert.strictEqual(R.HOKA.site.bloqueados, 1);
    assert.ok(R.HOKA.site.motivos['sem descricao'] >= 1, JSON.stringify(R.HOKA.site.motivos));
    assert.strictEqual(R.HOKA.site.prontosParaSubir, 0);
  });
  await t('alertas: preço ≤ custo da HOKA é o primeiro; PENALTY aponta negativo, ruptura e parado', () => {
    assert.strictEqual(R.HOKA.alertas[0].area, 'preço');
    assert.strictEqual(R.HOKA.cadastro.precoAbaixoCusto, 1);
    const areas = R.PENALTY.alertas.map((a) => a.area);
    for (const x of ['estoque', 'venda']) assert.ok(areas.includes(x), areas.join(','));
    assert.ok(R.HOKA.ficha && /cProd/.test(R.HOKA.ficha.nfe), 'ficha da HOKA viaja no relatório');
  });
  await t('pedido sob demanda (marca.pedir "hoka") gera só a HOKA; marca indefinida não inventa relatório', async () => {
    const s = await gerente.disparar({ sinal: { tipo: 'marca.pedir', dados: { marca: 'hoka' } }, ler, agora: new Date(agora) });
    assert.deepStrictEqual(s.map((x) => x.dados.marca), ['HOKA']);
    assert.ok(s[0].dados.sobDemanda);
    const v = await gerente.disparar({ sinal: { tipo: 'marca.pedir', dados: { marca: 'A DEFINIR' } }, ler, agora: new Date(agora) });
    assert.strictEqual(v.length, 1); assert.ok(v[0].dados.erro);
  });
  await t('só leitura: o gerente não escreve nada no banco', async () => {
    const antes = await Promise.all([prisma.product.count(), prisma.storeStock.count(), prisma.sale.count(), prisma.productSize.aggregate({ _sum: { stock: true } })]);
    await gerente.disparar({ sinal: { tipo: 'relogio.diario', dados: {} }, ler, agora: new Date(agora) });
    const depois = await Promise.all([prisma.product.count(), prisma.storeStock.count(), prisma.sale.count(), prisma.productSize.aggregate({ _sum: { stock: true } })]);
    assert.deepStrictEqual(depois, antes);
  });
  await limpar();
  await prisma.$disconnect();
}

(async () => {
  console.log('A) contrato e regras (sem banco)');
  await partA();
  console.log('B) gerente de marca no banco DESCARTÁVEL ' + process.env.DATABASE_URL.replace(/\/\/[^@]*@/, '//***@'));
  await partB();
  console.log(out.join('\n'));
  console.log((process.exitCode ? 'FALHOU' : 'OK') + ' — ' + pass + ' testes passaram');
  process.exit(process.exitCode || 0);
})().catch((e) => { console.error(e); process.exit(1); });
