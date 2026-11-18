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
  await t('regra 30 — lugar certo: tipo escrito no nome × categoria, modalidade da chuteira, público; sem chute', () => {
    const { conferirLocal } = require('../src/ai/rede/regras/local-certo');
    const { passoDe } = require('../src/ai/rede/regras/conserto-nuvemshop');
    const card = (name, category, subcategory, modality, tier) => ({ name, category, subcategory, aiContext: { classification: { modality, tier } } });
    assert.deepStrictEqual(conferirLocal(card('TENIS NIKE PEGASUS 41 MASCULINO PRETO', 'Tênis', 'Homem', 'Corrida', 'Super Amortecimento')), []);
    assert.ok(/categoria errada \(nome diz acessório, card está em Tênis\)/.test(conferirLocal(card('MEIA PENALTY CANO ALTO', 'Tênis', 'Unissex', 'Meia', 'Básica'))[0]));
    assert.ok(/categoria errada \(nome diz acessório, card está em Chuteiras\)/.test(conferirLocal(card('BOLA SOCIETY PENALTY 8 X', 'Chuteiras', 'Homem', 'Society', 'Treino'))[0]));
    assert.ok(/nome diz roupa/.test(conferirLocal(card('Camiseta Dry Fit Athleisure Preta', 'Tênis', 'Homem', 'Camiseta', 'Básica'))[0]));
    // o 1º tipo escrito manda; "beach tênis" e "tênis de mesa" são o esporte, não o calçado
    assert.deepStrictEqual(conferirLocal(card('MEIA DE CHUTEIRA PENALTY', 'Acessórios', 'Unissex', 'Meias', 'cano longo')), []);
    assert.deepStrictEqual(conferirLocal(card('REDE BEACH TENIS 8M', 'Acessórios', 'Unissex', 'Outro', 'Básica')), []);
    assert.deepStrictEqual(conferirLocal(card('MARCACAO BEACH TENIS VERMELHA', 'Acessórios', 'Unissex', 'Outro', 'Básica')), []);
    assert.deepStrictEqual(conferirLocal(card('Raquete Tenis De Mesa Gold', 'Acessórios', 'Unissex', 'Outro', 'Básica')), []);
    assert.deepStrictEqual(conferirLocal(card('PORTA CHUTEIRA ZONA', 'Acessórios', 'Unissex', 'Bolsa', 'Básica')), []);
    // chuteira: modalidade escrita no nome
    assert.ok(/modalidade errada \(nome diz futsal, card está em Society\)/.test(conferirLocal(card('CHUTEIRA FUTSAL UMBRO CLASS', 'Chuteiras', 'Homem', 'Society', 'Treino'))[0]));
    assert.deepStrictEqual(conferirLocal(card('CHUTEIRA UMBRO CLASS', 'Chuteiras', 'Homem', 'Society', 'Treino')), [], 'nome não diz a modalidade: não acusa');
    // público
    assert.ok(/público errado \(nome diz infantil, card está em Mulher\)/.test(conferirLocal(card('CHUTEIRA FUTSAL UMBRO CLASS 2.2 JR PTO/BCO', 'Chuteiras', 'Mulher', 'Futsal', 'Treino'))[0]));
    assert.ok(/público errado \(nome diz feminino, card está em Homem\)/.test(conferirLocal(card('TENIS FILA COMET 2 FEMININO', 'Tênis', 'Homem', 'Corrida', 'Iniciante'))[0]));
    assert.deepStrictEqual(conferirLocal(card('TENIS FILA COMET 2 MASCULINO', 'Tênis', 'Unissex', 'Corrida', 'Iniciante')), [], 'unissex não acusa');
    assert.ok(/subcategoria fora da árvore \(Óculos \/ Natação/.test(conferirLocal(card('SPEEDO OCULOS VULCAN AZUL', 'Acessórios', 'Óculos / Natação', 'Óculos', 'Básica'))[0]));
    // AUDITORIA 18/11: criança nunca vai para adulto; BABY LOOK é adulto; acessório "para tênis/chuteira" não é calçado
    for (const [nome, cat, sub, mod] of [['TENIS INF MASC', 'Tênis', 'Menino'], ['TENIS INF. FEM', 'Tênis', 'Menina'], ['CHUTEIRA FUTSAL JUNIOR MASCULINA', 'Chuteiras', 'Menino', 'Futsal'],
      ['TENIS MASC 28', 'Tênis', 'Menino'], ['CAMISETA BABY LOOK DRY FIT', 'Vestuário', 'Mulher'], ['BLUSA BABY LOOK FEMININA', 'Roupas', 'Mulher'],
      ['PALMILHA PARA TENIS', 'Acessórios', 'Unissex'], ['CADARÇO PARA TÊNIS', 'Acessórios', 'Unissex'], ['KIT LIMPEZA TENIS', 'Acessórios', 'Unissex'], ['OVERGRIP TENIS WILSON', 'Acessórios', 'Unissex'],
      ['TRAVA PARA CHUTEIRA', 'Acessórios', 'Unissex'], ['CRAVO CHUTEIRA CAMPO', 'Acessórios', 'Unissex'], ['KIT BEACH  TENIS', 'Acessórios', 'Unissex'],
      ['TENIS ADIDAS', 'Dropper', 'Homem'], ['TENIS NIKE', 'Tênis', 'Tamanhos'], ['TENIS NIKE FEMININO', 'Tênis', 'Feminino'], ['CHINELO RIDER', 'Sandálias', 'Homem']]) {
      assert.deepStrictEqual(conferirLocal(card(nome, cat, sub, mod || 'X', 'Y')), [], nome + ' em ' + cat + ' > ' + sub + ' está certo');
    }
    assert.ok(/nome diz feminino, card está em Menino/.test(conferirLocal(card('TENIS INFANTIL FEMININO', 'Tênis', 'Menino', 'X', 'Y'))[0]), 'gênero da criança também é conferido');
    assert.ok(/2ª classificação/.test(conferirLocal({ name: 'TENIS Y', category: 'Tênis', subcategory: 'Homem', aiContext: { classification: { modality: 'Corrida', tier: 'Z' }, classification2: { category: 'Acessórios' } } })[0]), '2ª cadeia do menu também é conferida');
    // incompleta e INSUMO
    assert.deepStrictEqual(conferirLocal(card('TENIS HOKA CLIFTON', 'Tênis', null, null, null)), ['local: classificação incompleta']);
    assert.deepStrictEqual(conferirLocal(card('MEIA ACTVITTA USO COMUM', 'INSUMO', 'Unissex', 'Meia', 'Básica')), [], 'INSUMO é uso interno, fora da conferência');
    // cada motivo tem passo de conserto (ensinado)
    assert.strictEqual(passoDe(conferirLocal(card('MEIA X', 'Tênis', 'Unissex', 'Meia', 'Básica'))[0]).id, 'local-categoria');
    assert.strictEqual(passoDe(conferirLocal(card('CHUTEIRA FUTSAL X', 'Chuteiras', 'Homem', 'Society', 'Treino'))[0]).id, 'local-modalidade');
    assert.strictEqual(passoDe(conferirLocal(card('CHUTEIRA FUTSAL X JR', 'Chuteiras', 'Mulher', 'Futsal', 'Treino'))[0]).id, 'local-publico');
    assert.strictEqual(passoDe(conferirLocal(card('SPEEDO OCULOS', 'Acessórios', 'Óculos / Natação', 'Óculos', 'Básica'))[0]).id, 'local-subcategoria');
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
    await prisma.stocktakeBipe.deleteMany({}); await prisma.stocktakeRound.deleteMany({});
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

  // estoque NOVO: rodada de substituição em curso (vale) e rodada cancelada (não vale)
  const rNova = await prisma.stocktakeRound.create({ data: { name: 'Substituição LOJA04', storeId: L.LOJA04.id, status: 'counting', operationType: 'replacement', baseline: {} } });
  const rCanc = await prisma.stocktakeRound.create({ data: { name: 'Substituição cancelada', storeId: L.LOJA02.id, status: 'cancelled', operationType: 'replacement', baseline: {} } });
  const bipe = (round, store, p, size, applied = true) => prisma.stocktakeBipe.create({ data: { roundId: round.id, storeId: store.id, barcode: size.barcode, productId: p.id, productSizeId: size.id, found: true, applied } });
  await bipe(rNova, L.LOJA04, A, A.S['41']); await bipe(rNova, L.LOJA04, A, A.S['41']); // A publicado e bipado (2 un)
  await bipe(rNova, L.LOJA04, F, F.S['42']);                                            // F bipado e fora da Nuvemshop (loja do site)
  await bipe(rNova, L.LOJA04, F, F.S['42'], false);                                     // pendente: não conta como bipado
  await bipe(rCanc, L.LOJA02, C, C.S.M);                                                // rodada cancelada: não vale
  const rVelha = await prisma.stocktakeRound.create({ data: { name: 'Substituição antiga', storeId: L.LOJA02.id, status: 'counting', operationType: 'replacement', baseline: {}, startedAt: new Date('2026-10-20T12:00:00-03:00') } });
  await bipe(rVelha, L.LOJA02, C, C.S.M);                                               // rodada de antes de 09/11: bipe antigo, não vale
  const G = await prod({ sku: 'H4', name: 'Tênis HOKA no site sem bipe', brand: 'HOKA', price: 900, costPrice: 400, aiContext: { color: 'Branco' }, imageUrl: 'https://x/g.jpg' }, [{ size: '39', barcode: '0196565000039', stock: 2 }]);
  await prisma.nuvemshopProductMapping.create({ data: { localProductId: G.id, nuvemshopProductId: '222' } });
  // H: bipado só na LOJA02 (loja que não abastece o site neste teste)
  const rNova2 = await prisma.stocktakeRound.create({ data: { name: 'Substituição LOJA02', storeId: L.LOJA02.id, status: 'counting', operationType: 'replacement', baseline: {} } });
  const H = await prod({ sku: 'H5', name: 'Tênis HOKA só na Bessa', brand: 'HOKA', price: 900, costPrice: 400, aiContext: { color: 'Verde' }, imageUrl: 'https://x/h.jpg' }, [{ size: '43', barcode: '0196565000043', stock: 1 }]);
  await loc(L.LOJA02, H.S['43'], 1); await bipe(rNova2, L.LOJA02, H, H.S['43']);
  // K: 1 foto principal + 4 na galeria (repetindo a principal) = 5 fotos válidas → não é "menos de 5"
  const K = await prod({ sku: 'P9', name: 'Bola Penalty 5 fotos', brand: 'PENALTY', price: 200, costPrice: 80, imageUrl: 'https://x/k1.jpg', imageUrls: ['https://x/k1.jpg', 'https://x/k2.jpg', 'https://x/k3.jpg', 'https://x/k4.jpg', 'https://x/k5.jpg', 'nada'] }, [{ size: 'U', barcode: '7890000000999', stock: 1 }]);
  await loc(L.LOJA02, K.S.U, 1); await bipe(rNova2, L.LOJA02, K, K.S.U);

  // L: chuteira infantil (JR) classificada em "Mulher" e publicada → no site no lugar errado (regra 30)
  const Lc = await prod({ sku: 'P10', name: 'CHUTEIRA FUTSAL PENALTY TESTE JR PRETO', brand: 'PENALTY', category: 'Chuteiras', subcategory: 'Mulher', price: 200, costPrice: 80,
    aiContext: { color: 'Preto', classification: { modality: 'Futsal', tier: 'Treino' } } }, [{ size: '31', barcode: '7890000001001', stock: 0 }]);
  await prisma.nuvemshopProductMapping.create({ data: { localProductId: Lc.id, nuvemshopProductId: '333' } });

  const ler = ferramentas.soLeitura(prisma);
  const sinais = await gerente.disparar({ sinal: { tipo: 'relogio.diario', dados: {} }, ler, agora: new Date(agora) });
  const R = Object.fromEntries(sinais.map((s) => [s.dados.marca, s.dados]));

  await t('1 relatório por marca: HOKA (3 grafias juntas, 5 cards) e PENALTY; sem marca e inativo ficam fora', () => {
    assert.deepStrictEqual(Object.keys(R).sort(), ['HOKA', 'PENALTY']);
    assert.ok(sinais.every((s) => s.tipo === 'marca.relatorio' && s.dados.chave.startsWith('marca|')));
    assert.strictEqual(R.HOKA.cards, 5);
    assert.deepStrictEqual(R.HOKA.nomes.sort(), ['HOKA', 'Hoka', 'hoka']);
  });
  await t('estoque: comprado = Σ ProductSize.stock; localizado = StoreStock > 0 por loja; negativo à parte', () => {
    assert.strictEqual(R.HOKA.comprado, 10);
    assert.strictEqual(R.HOKA.localizado, 5);
    assert.deepStrictEqual(R.HOKA.porLoja, { LOJA02: 2, LOJA04: 3 });
    assert.strictEqual(R.PENALTY.localizado, 11, '10 do C + 1 do K; o -1 não desconta do localizado');
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
    assert.strictEqual(R.HOKA.site.publicados, 2);
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
  await t('conferência: bipado no estoque novo × Nuvemshop (rodada cancelada e bipe pendente não contam)', () => {
    const cf = R.HOKA.conferencia;
    assert.strictEqual(cf.cardsComprados, 4, 'A, F, G e H têm comprado');
    assert.strictEqual(cf.cardsBipados, 3, 'A, F e H');
    assert.strictEqual(cf.unidadesBipadas, 4, '2 do A + 1 do F + 1 do H (o pendente fica fora)');
    assert.strictEqual(cf.bipesPendentes, 1);
    assert.deepStrictEqual(cf.porLoja, { LOJA04: 3, LOJA02: 1 });
    assert.strictEqual(cf.bipadosNaNuvemshop, 1, 'A');
    assert.strictEqual(cf.publicadosNaoBipados, 1, 'G está no site sem bipe');
    assert.strictEqual(cf.itensPublicadosNaoBipados[0].nome, 'Tênis HOKA no site sem bipe');
    assert.strictEqual(cf.bipadosForaNuvemshop, 2, 'F e H');
    assert.strictEqual(cf.foraNuvemshopNasLojasDoSite, 1);
    assert.strictEqual(cf.compradosNaoBipados, 1, 'G');
    assert.strictEqual(cf.pctCardsBipados, 75);
    assert.strictEqual(cf.compradosBipados, 3);
    assert.strictEqual(cf.bipadosSemCompra, 0);
    assert.strictEqual(cf.bipadosMenosDe5Fotos, 3, 'A, F e H têm 1 foto (regra do dono: 5)');
    assert.ok(R.HOKA.alertas.some((x) => x.area === 'fotos'));
    assert.strictEqual(R.PENALTY.conferencia.cardsBipados, 1, 'só o K (bipe novo); rodada cancelada e anterior a 09/11 não valem');
    assert.strictEqual(R.PENALTY.conferencia.bipadosMenosDe5Fotos, 0, 'foto conta igual ao portão: principal + galeria, sem repetir, só válidas');
    assert.ok(R.HOKA.alertas.some((a) => a.area === 'conferência' && /NÃO foram bipados/.test(a.texto)));
  });
  await t('manual de conserto: cada card bipado fora do site cai no passo do motivo que o segura', () => {
    const cs = R.HOKA.conferencia.conserto;
    const P = Object.fromEntries(cs.passos.map((p) => [p.id, p]));
    assert.ok(P['loja-fora-do-site'] && P['loja-fora-do-site'].cards === 1 && P['loja-fora-do-site'].itens[0].nome === 'Tênis HOKA só na Bessa', JSON.stringify(cs.passos.map((p) => p.id)));
    assert.ok(P.descricao && P.descricao.itens[0].nome === 'Tênis HOKA Bondi 9 Preto', 'F sem descrição');
    assert.ok(!P.confirmacao, 'gerente avalia como a subida automática, que confirma sozinha: confirmação não trava');
    assert.ok(cs.passos.every((p) => p.como && p.quem), 'todo passo diz como e quem');
    assert.ok(P['fotos-minimas'] && P['fotos-minimas'].cards === 3, 'todo bipado com < 5 fotos aprende a completar');
    assert.strictEqual(cs.prontosParaSubir, 0);
    const reg = require('../src/ai/rede/regras/conserto-nuvemshop');
    assert.strictEqual(reg.passoDe('cor crua (numero/tamanho na cor)').id, 'cor');
    assert.strictEqual(reg.passoDe('motivo que ninguém conhece').id, 'outro');
  });
  await t('regra 30 no gerente: cada marca confere o lugar de TODO card dela; o que está no site no lugar errado vem primeiro', () => {
    const lh = R.HOKA.local, lp = R.PENALTY.local;
    assert.strictEqual(lh.conferidos, 5);
    assert.strictEqual(lh.foraDoLugar, 1, 'Meia Hoka em Tênis');
    assert.strictEqual(lh.incompletos, 5, 'nenhum card HOKA de teste tem as 4 classificações');
    assert.strictEqual(lp.foraDoLugar, 5, 'Camiseta, Bola, Bermuda e Bola K em Tênis + chuteira JR em Mulher');
    assert.strictEqual(lp.foraDoLugarNoSite, 1);
    assert.strictEqual(lp.itens[0].nome, 'CHUTEIRA FUTSAL PENALTY TESTE JR PRETO', 'o que está no site vem primeiro');
    assert.ok(lp.itens[0].noSite && /público errado/.test(lp.itens[0].motivo));
    assert.ok(lp.motivos['local: categoria errada'] === 4 && lp.motivos['local: público errado'] === 1, JSON.stringify(lp.motivos));
    const al = R.PENALTY.alertas.find((a) => a.area === 'lugar' && a.gravidade === 3);
    assert.ok(al && /NO SITE no lugar errado/.test(al.texto) && al.itens.length === 1, JSON.stringify(R.PENALTY.alertas.map((a) => a.texto)));
    assert.ok(R.PENALTY.alertas.some((a) => a.area === 'lugar' && a.gravidade === 2 && /4 card\(s\) fora do lugar certo/.test(a.texto)));
    // bipado no lugar errado entra no manual de conserto (ensina a corrigir)
    const P = Object.fromEntries(R.PENALTY.conferencia.conserto.passos.map((p) => [p.id, p]));
    assert.ok(P['local-categoria'] && P['local-categoria'].itens[0].nome === 'Bola Penalty 5 fotos', JSON.stringify(Object.keys(P)));
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
