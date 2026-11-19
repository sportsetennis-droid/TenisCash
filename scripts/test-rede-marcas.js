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
process.env.CUIDADOR_COR_OFICIAL = '0'; // sem rede no teste: a busca no site da marca é injetada onde é testada
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
    assert.deepStrictEqual(n.emite, ['marca.relatorio', 'marca.cadastro-incompleto']);
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
      ['TENIS ADIDAS', 'Dropper', 'Homem'], ['CHUTEIRA PUMA FUTURE 7 PLAY NEYMAR JR FG', 'Chuteiras', 'Homem', 'Campo'], ['CAMISA PSG NEYMAR JR', 'Vestuário', 'Homem'], ['SKECHERS GO WALK SLIP INS SEM CADARCO', 'Tênis', 'Homem'], ['ASICS GEL DEDICATE GRIP', 'Tênis', 'Homem'], ['GRIP TENIS WILSON PRO', 'Acessórios', 'Unissex'], ['OVERGRIP TENIS', 'Acessórios', 'Unissex'], ['GRIP PARA RAQUETE BEACH TENIS', 'Acessórios', 'Unissex'], ['CHUTEIRA PUMA NEYMAR JUNIOR', 'Chuteiras', 'Homem', 'Campo'], ['TENIS NIKE', 'Tênis', 'Tamanhos'], ['TENIS NIKE FEMININO', 'Tênis', 'Feminino'], ['CHINELO RIDER', 'Sandálias', 'Homem']]) {
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
    await prisma.aIApproval.deleteMany({ where: { type: 'rna_descricao' } }).catch(() => {}); await prisma.stocktakeBipe.deleteMany({}); await prisma.stocktakeRound.deleteMany({});
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
  const relatorios = sinais.filter((s) => s.tipo === 'marca.relatorio'); // os pedidos de cadastro (regra 31) têm teste próprio
  const R = Object.fromEntries(relatorios.map((s) => [s.dados.marca, s.dados]));

  await t('1 relatório por marca: HOKA (3 grafias juntas, 5 cards) e PENALTY; sem marca e inativo ficam fora', () => {
    assert.deepStrictEqual(Object.keys(R).sort(), ['HOKA', 'PENALTY']);
    assert.ok(relatorios.length === 2 && relatorios.every((s) => s.dados.chave.startsWith('marca|')));
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
    const rel = s.filter((x) => x.tipo === 'marca.relatorio');
    assert.deepStrictEqual(rel.map((x) => x.dados.marca), ['HOKA']);
    assert.ok(rel[0].dados.sobDemanda);
    assert.ok(s.filter((x) => x.tipo === 'marca.cadastro-incompleto').every((x) => x.dados.marca === 'HOKA'), 'pedido sob demanda só aciona a marca pedida');
    const v = await gerente.disparar({ sinal: { tipo: 'marca.pedir', dados: { marca: 'A DEFINIR' } }, ler, agora: new Date(agora) });
    assert.strictEqual(v.length, 1); assert.ok(v[0].dados.erro);
  });
  await t('só leitura: o gerente não escreve nada no banco', async () => {
    const antes = await Promise.all([prisma.product.count(), prisma.storeStock.count(), prisma.sale.count(), prisma.productSize.aggregate({ _sum: { stock: true } })]);
    await gerente.disparar({ sinal: { tipo: 'relogio.diario', dados: {} }, ler, agora: new Date(agora) });
    const depois = await Promise.all([prisma.product.count(), prisma.storeStock.count(), prisma.sale.count(), prisma.productSize.aggregate({ _sum: { stock: true } })]);
    assert.deepStrictEqual(depois, antes);
  });
  await t('regra 31: gerente aciona foto/descrição para card da marca com estoque no site e fora dele (sem descrição)', async () => {
    const s = await gerente.disparar({ sinal: { tipo: 'relogio.diario', dados: {} }, ler, agora: new Date(agora) });
    const pedidos = s.filter((x) => x.tipo === 'marca.cadastro-incompleto');
    const f = pedidos.find((x) => x.dados.productId === F.id);
    assert.ok(f && f.dados.falta.includes('descricao') && f.dados.marca === 'HOKA', JSON.stringify(pedidos.map((x) => x.dados)));
    assert.ok(!pedidos.some((x) => x.dados.productId === A.id), 'o que já está no site não entra');
    assert.ok(!pedidos.some((x) => x.dados.productId === H.id), 'estoque só em loja que não vende no site não entra');
    // o agente de descrição escuta o pedido do gerente e propõe (com o texto de pedido do gerente)
    const desc = require('../src/ai/rede/neuronios/conteudo/descricao');
    assert.ok(desc.escuta.includes('marca.cadastro-incompleto'));
    const props = await desc.disparar({ sinal: f, ler });
    assert.ok(props[0] && props[0].tipo === 'proposta.descricao' && /pedido do gerente da marca/.test(props[0].dados.descricao), JSON.stringify(props));
  });
  await t('regra 31: o gerente PREENCHE sozinho só o que tem prova escrita, nunca sobrescreve, e registra a prova', async () => {
    const cuidador = require('../src/services/cuidadorDeMarca');
    const J = await prod({ sku: 'J1', name: 'CHUTEIRA FUTSAL JOMA TESTE JR (BRANCO/AZUL)', brand: 'JOMA', category: 'Chuteiras', subcategory: null, price: 300, costPrice: 150 }, [{ size: '33', barcode: '8424309000033', stock: 2 }]);
    await loc(L.LOJA04, J.S['33'], 2);
    const K2 = await prod({ sku: 'J2', name: 'CHUTEIRA FUTSAL JOMA TOP FLEX PITO', brand: 'JOMA', category: 'Chuteiras', subcategory: 'Homem', price: 300, costPrice: 150, aiContext: { classification: { modality: 'Society' } } }, [{ size: '40', barcode: '8424309000040', stock: 2 }]);
    await loc(L.LOJA04, K2.S['40'], 1);
    const B = await prod({ sku: 'J3', name: 'BOLA JOMA FUTSAL HYBRID', brand: 'JOMA', category: 'A CLASSIFICAR', price: 100, costPrice: 50 }, [{ size: 'U', barcode: '8424309000099', stock: 3 }]);
    await loc(L.LOJA04, B.S.U, 1);
    const seco = await cuidador.cuidar(prisma, { marca: 'JOMA', aplicar: false });
    assert.strictEqual((await prisma.product.findUnique({ where: { id: J.id } })).subcategory, null, 'ensaio não grava');
    assert.ok(seco.preenchidos >= 2);
    await cuidador.cuidar(prisma, { marca: 'JOMA' });
    const j = await prisma.product.findUnique({ where: { id: J.id } });
    assert.strictEqual(j.subcategory, 'Menino', 'JR em Chuteiras → Menino (único nó infantil)');
    assert.strictEqual(j.aiContext.classification.modality, 'Futsal');
    assert.ok(j.aiContext.preenchidoPeloGerente && j.aiContext.preenchidoPeloGerente.provas.some((x) => /nome diz infantil/.test(x)), 'registra a prova');
    const k = await prisma.product.findUnique({ where: { id: K2.id } });
    assert.strictEqual(k.subcategory, 'Homem'); assert.strictEqual(k.aiContext.classification.modality, 'Society', 'nunca sobrescreve o que já está preenchido');
    assert.ok(!k.aiContext.preenchidoPeloGerente, 'sem prova escrita nada muda (PITO não diz público)');
    assert.strictEqual((await prisma.product.findUnique({ where: { id: B.id } })).category, 'Acessórios', 'BOLA → Acessórios');
    // não mexe em preço, comprado nem estoque
    assert.strictEqual(Number(j.price), 300); assert.strictEqual((await prisma.productSize.findUnique({ where: { id: J.S['33'].id } })).stock, 2);
    // planejar: tênis infantil sem gênero escrito não é chutado
    assert.deepStrictEqual(cuidador.planejar({ name: 'TENIS ADIDAS ADVANTAGE BASE JR', category: 'Tênis', subcategory: null, aiContext: {} }).mudancas, {});
    assert.deepStrictEqual(cuidador.planejar({ name: 'TENIS FILA COMET FEMININO', category: 'Tênis', subcategory: '', aiContext: {}, tamanhos: ['35'] }).mudancas, { subcategory: 'Feminino' });
  });
  await t('regra 31 / auditoria: só valores da árvore oficial, criança nunca vira adulto, chuteira feminina vai para o dono', () => {
    const { planejar } = require('../src/services/cuidadorDeMarca');
    const pl = (name, category, subcategory = null, extra = {}) => planejar({ name, category, subcategory, aiContext: {}, ...extra }).mudancas;
    assert.deepStrictEqual(pl('CHUTEIRA FUTSAL PENALTY JR FEMININA', 'Chuteiras'), { modality: 'Futsal' }, 'chuteira infantil feminina: árvore não tem Menina → não preenche público');
    assert.deepStrictEqual(pl('CHUTEIRA SOCIETY NIKE FEMININA', 'Chuteiras'), { modality: 'Society' }, 'chuteira feminina adulta: árvore não tem → dono');
    assert.deepStrictEqual(pl('CHUTEIRA CAMPO UNISSEX', 'Chuteiras'), { modality: 'Campo' }, 'Unissex não está na árvore');
    assert.deepStrictEqual(pl('TENIS NIKE UNISSEX', 'Tênis'), {});
    assert.deepStrictEqual(pl('CHINELO RIDER MASCULINO', 'A CLASSIFICAR'), {}, 'Sandálias não é categoria na árvore');
    assert.deepStrictEqual(pl('TENIS MASCULINO 28/33', 'Tênis'), {}, 'numeração infantil no nome: não vira Homem');
    assert.deepStrictEqual(pl('TENIS NIKE MASCULINO', 'Tênis', null, { tamanhos: ['28', '29', '30'] }), {}, 'grade infantil no card: não vira Homem');
    assert.deepStrictEqual(pl('TENIS FILA COMET FEMININO', 'Tênis', null, { tamanhos: ['36', '37'] }), { subcategory: 'Feminino' }, 'Tênis feminino = Feminino na árvore');
    assert.deepStrictEqual(pl('CHUTEIRA FUTSAL JOMA SALA MAX JR', 'Chuteiras'), { subcategory: 'Menino', modality: 'Futsal' });
    assert.deepStrictEqual(pl('CAMISETA DRY FIT MASCULINA', 'A CLASSIFICAR', null, { tamanhos: ['P', 'M', 'G'] }), { category: 'Roupas', subcategory: 'Homem' });
    assert.deepStrictEqual(pl('CAMISETA DRY FIT MASCULINA', 'Vestuário'), {}, 'roupa sem grade: sem prova de adulto');
    assert.deepStrictEqual(pl('CALCAO KAPPA MASCULINO', 'Vestuário', null, { tamanhos: ['10', '12', '14'] }), {}, 'grade infantil de roupa (10/12/14) não vira Homem');
    assert.deepStrictEqual(pl('CAMISETA BOTAFOGO MASCULINA 10/12', 'A CLASSIFICAR', null, { tamanhos: ['10', '12'] }), { category: 'Roupas' });
    assert.deepStrictEqual(pl('TENIS NIKE MASCULINO', 'Tênis', null, { tamanhos: ['T-7891234567890'] }), {}, 'grade só com placeholder não prova adulto');
    assert.deepStrictEqual(pl('TENIS NIKE PEGASUS 41 MASCULINO', 'Tênis', null, { tamanhos: ['39', '40'] }), { subcategory: 'Homem' }, 'número de modelo no nome não é grade');
    assert.deepStrictEqual(pl('CAMISETA INFANTIL 8A MASCULINA', 'Vestuário', null, { tamanhos: ['8A'] }), { subcategory: 'Menino' });
    assert.deepStrictEqual(pl('TENIS CROCS MASCULINO', 'Tênis', null, { tamanhos: ['27/28', '29/30'] }), {}, 'faixa infantil na grade não prova adulto');
    assert.deepStrictEqual(pl('MEIA LUPO CANO CURTO MASCULINA', 'Acessórios', null, { tamanhos: ['19/22', '23/26'] }), {}, 'meia usa a numeração do pé');
    assert.deepStrictEqual(pl('MEIA LUPO MASCULINA 23/26', 'Acessórios', null, { tamanhos: ['U'] }), {});
    assert.deepStrictEqual(pl('MEIA LUPO MASCULINA', 'Acessórios', null, { tamanhos: ['39/43'] }), { subcategory: 'Homem' }, 'meia adulta 39/43 preenche');
    // o que preenche não é acusado pela régua do lugar certo (regra 30)
    const { conferirLocal } = require('../src/ai/rede/regras/local-certo');
    for (const [n, c] of [['CHUTEIRA FUTSAL JOMA SALA MAX JR', 'Chuteiras'], ['TENIS FILA COMET FEMININO', 'Tênis'], ['CAMISETA DRY FIT MASCULINA', 'A CLASSIFICAR']]) {
      const m = pl(n, c, null, { tamanhos: c === 'Tênis' ? ['37', '38'] : ['P', 'M'] });
      const card = { name: n, category: m.category || c, subcategory: m.subcategory, aiContext: { classification: { modality: m.modality || 'X', tier: 'Y' } } };
      assert.deepStrictEqual(conferirLocal(card).filter((x) => !/incompleta/.test(x)), [], n);
    }
  });
  await t('regra 31 / auditoria: grava campo a campo só se continuar vazio; a prova registra SÓ o que foi gravado; modalidade atômica', async () => {
    const cuidador = require('../src/services/cuidadorDeMarca');
    const N = await prod({ sku: 'J9', name: 'TENIS JOMA TESTE MASCULINO', brand: 'JOMA', category: 'Não definido', subcategory: null, price: 300, costPrice: 150 }, [{ size: '41', barcode: '8424309000941', stock: 1 }]);
    await loc(L.LOJA04, N.S['41'], 1);
    await cuidador.cuidar(prisma, { marca: 'JOMA' });
    const n = await prisma.product.findUnique({ where: { id: N.id } });
    assert.strictEqual(n.category, 'Tênis'); assert.strictEqual(n.subcategory, 'Homem');
    assert.deepStrictEqual(n.aiContext.preenchidoPeloGerente.campos, { category: 'Tênis', subcategory: 'Homem' });
    // modalidade: não apaga a especialidade gravada por outra edição
    const M = await prod({ sku: 'J8', name: 'CHUTEIRA CAMPO JOMA TESTE MASCULINA', brand: 'JOMA', category: 'Chuteiras', subcategory: 'Homem', price: 300, costPrice: 150, aiContext: { classification: { tier: 'Profissional' } } }, [{ size: '42', barcode: '8424309000942', stock: 1 }]);
    await loc(L.LOJA04, M.S['42'], 1);
    await cuidador.cuidar(prisma, { marca: 'JOMA' });
    const m = await prisma.product.findUnique({ where: { id: M.id } });
    assert.deepStrictEqual(m.aiContext.classification, { tier: 'Profissional', modality: 'Campo' });
    // segunda rodada: nada a fazer, nada registrado de novo
    const r2 = await cuidador.cuidar(prisma, { marca: 'JOMA' });
    assert.ok(!r2.itens.some((x) => x.productId === N.id || x.productId === M.id), JSON.stringify(r2.itens));
  });
  await t('regra 31 / auditoria: descrição não gasta IA se já existe proposta pendente para o card', async () => {
    const desc = require('../src/ai/rede/neuronios/conteudo/descricao');
    await prisma.aIApproval.create({ data: { type: 'rna_descricao', status: 'pending', title: 'teste', payload: { rna: { chave: 'descricao:' + F.id } } } });
    let chamou = 0;
    const r = await desc.disparar({ sinal: { tipo: 'marca.cadastro-incompleto', dados: { productId: F.id, falta: ['descricao'] } }, ler, pensar: async () => { chamou++; return { ok: true, json: { texto: 'x' } }; } });
    assert.deepStrictEqual(r, []); assert.strictEqual(chamou, 0);
    await prisma.aIApproval.deleteMany({ where: { type: 'rna_descricao' } });
  });
  await t('regra 31 / auditoria 3: descrição só com espaço conta como vazia; recusa antiga (>14 dias) volta; cota cheia não gasta IA', async () => {
    const desc = require('../src/ai/rede/neuronios/conteudo/descricao');
    await prisma.product.update({ where: { id: F.id }, data: { longDescription: '  \n\t ' } });
    const s = await gerente.disparar({ sinal: { tipo: 'marca.pedir', dados: { marca: 'hoka' } }, ler, agora: new Date(agora) });
    const f = s.find((x) => x.tipo === 'marca.cadastro-incompleto' && x.dados.productId === F.id);
    assert.ok(f && f.dados.falta.includes('descricao'), 'só espaço/quebra de linha = sem descrição (igual ao portão)');
    await prisma.product.update({ where: { id: F.id }, data: { longDescription: null } });
    let chamou = 0; const pensar = async () => { chamou++; return { ok: true, json: { texto: 'Tênis HOKA Bondi 9 na cor Preto.' } }; };
    await prisma.aIApproval.create({ data: { type: 'rna_descricao', status: 'rejected', title: 'antiga', decidedAt: new Date(Date.now() - 60 * 86400000), payload: { rna: { chave: 'descricao:' + F.id } } } });
    await desc.disparar({ sinal: f, ler, pensar });
    assert.strictEqual(chamou, 1, 'recusada há 60 dias não bloqueia para sempre');
    await prisma.aIApproval.deleteMany({ where: { type: 'rna_descricao' } });
    for (let i = 0; i < 20; i++) await prisma.aIApproval.create({ data: { type: 'rna_descricao', status: 'pending', title: 'cota ' + i, payload: { rna: { chave: 'outra:' + i, neuronio: 'conteudo.descricao' } } } });
    chamou = 0;
    const r = await desc.disparar({ sinal: f, ler, pensar });
    assert.deepStrictEqual(r, []); assert.strictEqual(chamou, 0, 'cota do dia cheia: não chama IA');
    await prisma.aIApproval.deleteMany({ where: { type: 'rna_descricao' } });
  });
  await t('cor pelo site da marca (dono 18/11): busca só o código exato, item vence produto, conflito e palavra desconhecida não gravam', async () => {
    const { buscarCorOficial } = require('../src/services/corOficialMarca');
    const site = (lista) => async () => ({ ok: true, json: async () => lista });
    const prod = (ean, corItem, corProd) => ({ productName: 'X', link: 'https://www.fila.com.br/x/p', ...(corProd ? { Cor: [corProd] } : {}), items: [{ ean, ...(corItem ? { Cor: [corItem] } : {}) }] });
    let r = await buscarCorOficial({ marca: 'FILA', eans: ['7909946138507'] }, { fetchFn: site([prod('7909946138507', null, 'Cinza Gelo/Preto/Cinza')]) });
    assert.ok(r.ok); assert.strictEqual(r.cor, 'Cinza Gelo/Preto/Cinza');
    r = await buscarCorOficial({ marca: 'PENALTY', eans: ['7909342615794'] }, { fetchFn: site([{ ...prod('7909342615794', 'Azul', null), 'Cor predominante': ['Branco'] }]) });
    assert.strictEqual(r.cor, 'Azul', 'cor do item (código) vence; cor predominante nunca é usada');
    r = await buscarCorOficial({ marca: 'FILA', eans: ['7909946138507'] }, { fetchFn: site([prod('7909946999999', null, 'Azul')]) });
    assert.ok(!r.ok, 'item com OUTRO código não vale');
    let n = 0; r = await buscarCorOficial({ marca: 'FILA', eans: ['7909946138507', '7909946138521'] }, { fetchFn: async () => ({ ok: true, json: async () => [prod(n++ ? '7909946138521' : '7909946138507', null, n > 1 ? 'Azul' : 'Preto')] }) });
    assert.ok(!r.ok && /conflito/.test(r.motivo), 'tamanhos com cores diferentes no site = conflito');
    r = await buscarCorOficial({ marca: 'PUMA', eans: ['4099686000001'] }, { fetchFn: site([prod('4099686000001', 'Fizzy Apple', null)]) });
    assert.ok(!r.ok && /fora do dicionário/.test(r.motivo), 'nome comercial sem cor em português não grava');
    r = await buscarCorOficial({ marca: 'MARCA SEM SITE', eans: ['7909946138507'] }, { fetchFn: site([]) });
    assert.ok(!r.ok);
    r = await buscarCorOficial({ marca: 'FILA', eans: ['7909946138507'] }, { fetchFn: async () => { throw new Error('rede'); } });
    assert.ok(!r.ok, 'site fora do ar: não grava nada');
  });
  await t('cor pelo site da marca: o gerente troca só cor vazia ou sigla, guarda a antiga, não repete busca e não atropela edição', async () => {
    const cuidador = require('../src/services/cuidadorDeMarca');
    const A = await prod({ sku: 'C1', name: 'TENIS FILA FASTNESS MASCULINO', brand: 'FILA', category: 'Tênis', subcategory: 'Homem', price: 300, costPrice: 150, aiContext: { color: 'PTO/VE' } }, [{ size: '39', barcode: '7909946138538', stock: 1 }]);
    await loc(L.LOJA04, A.S['39'], 1);
    const B2 = await prod({ sku: 'C2', name: 'TENIS FILA COMET 2 FEMININO', brand: 'FILA', category: 'Tênis', subcategory: 'Feminino', price: 300, costPrice: 150, aiContext: { color: 'Azul' } }, [{ size: '37', barcode: '7909946168320', stock: 1 }]);
    await loc(L.LOJA04, B2.S['37'], 1);
    const C = await prod({ sku: 'C3', name: 'TENIS FILA RACER', brand: 'FILA', category: 'Tênis', subcategory: 'Homem', price: 300, costPrice: 150, aiContext: {} }, [{ size: '40', barcode: '7909946134608', stock: 1 }]);
    await loc(L.LOJA04, C.S['40'], 1);
    const chamados = [];
    const buscarCor = async ({ eans }) => { chamados.push(eans[0]); return eans.includes('7909946138538') ? { ok: true, cor: 'Cinza Gelo/Preto/Cinza', bruto: 'Cinza Gelo/Preto/Cinza', fonte: 'https://www.fila.com.br/x/p', ean: '7909946138538' } : { ok: false, motivo: 'código não encontrado no site oficial' }; };
    const r = await cuidador.cuidar(prisma, { marca: 'FILA', buscarCor });
    const a = await prisma.product.findUnique({ where: { id: A.id } });
    assert.strictEqual(a.aiContext.color, 'Cinza Gelo/Preto/Cinza'); assert.strictEqual(a.aiContext.colorRaw, 'PTO/VE', 'guarda a cor antiga');
    assert.ok(a.aiContext.colorEvidencia && /fila\.com\.br/.test(a.aiContext.colorEvidencia.fonte), 'registra a fonte');
    assert.ok(!chamados.includes('7909946168320'), 'cor já por extenso: não busca nem troca');
    assert.strictEqual((await prisma.product.findUnique({ where: { id: B2.id } })).aiContext.color, 'Azul');
    const c = await prisma.product.findUnique({ where: { id: C.id } });
    assert.ok(!c.aiContext.color && c.aiContext.corOficialTentativa, 'sem resposta: não inventa, registra a tentativa');
    assert.ok(r.cores >= 1);
    chamados.length = 0; await cuidador.cuidar(prisma, { marca: 'FILA', buscarCor });
    assert.ok(!chamados.includes('7909946134608'), 'não repete a mesma busca sem resposta por 7 dias');
    // corrida: o dono edita a cor durante a busca → a busca não atropela
    const D = await prod({ sku: 'C4', name: 'TENIS FILA DAILY', brand: 'FILA', category: 'Tênis', subcategory: 'Homem', price: 300, costPrice: 150, aiContext: { color: 'BCO/VERA' } }, [{ size: '41', barcode: '7909946140001', stock: 1 }]);
    await loc(L.LOJA04, D.S['41'], 1);
    await cuidador.cuidar(prisma, { marca: 'FILA', buscarCor: async () => { await prisma.product.update({ where: { id: D.id }, data: { aiContext: { color: 'Branco/Verde Abeto' } } }); return { ok: true, cor: 'Branco/Verde', bruto: 'x', fonte: 'f', ean: '7909946140001' }; } });
    assert.strictEqual((await prisma.product.findUnique({ where: { id: D.id } })).aiContext.color, 'Branco/Verde Abeto', 'edição do meio vence');
  });
  await t('fotos oficiais (sem crédito, 19/11): fotos do item com o MESMO código; conflito de cor não usa; site fora não grava', async () => {
    const { buscarFotosOficiais } = require('../src/services/corOficialMarca');
    const it = (ean, fotos) => ({ ean, referenceId: [], images: fotos.map((u) => ({ imageUrl: u })) });
    const site = (lista) => async () => ({ ok: true, json: async () => lista });
    const p = (id, cor, itens) => ({ productId: id, productName: 'X', link: '/x/p', Cor: [cor], items: itens });
    let r = await buscarFotosOficiais({ marca: 'FILA', eans: ['7909946138507'] }, { fetchFn: site([p('1', 'Preto', [it('7909946138507', ['https://fila.vteximg.com.br/a.jpg', 'https://fila.vteximg.com.br/b.jpg', 'https://fila.vteximg.com.br/a.jpg', 'http://inseguro/c.jpg'])])]) });
    assert.ok(r.ok && r.fotos.length === 2, 'só https e sem repetir: ' + JSON.stringify(r));
    r = await buscarFotosOficiais({ marca: 'FILA', eans: ['7909946138507'] }, { fetchFn: site([p('1', 'Preto', [it('7909946999999', ['https://fila.vteximg.com.br/a.jpg'])])]) });
    assert.ok(!r.ok, 'item de OUTRO código não vale');
    let n = 0; r = await buscarFotosOficiais({ marca: 'FILA', eans: ['7909946138507', '7909946138521'] }, { fetchFn: async () => ({ ok: true, json: async () => [n++ ? p('2', 'Azul', [it('7909946138521', ['https://f/2.jpg'])]) : p('1', 'Preto', [it('7909946138507', ['https://f/1.jpg'])])] }) });
    assert.ok(!r.ok && /conflito/.test(r.motivo), 'códigos do card em produtos/cores diferentes = conflito');
    r = await buscarFotosOficiais({ marca: 'FILA', eans: ['7909946138507'] }, { fetchFn: async () => { throw new Error('rede'); } });
    assert.ok(!r.ok);
    const seis = Array.from({ length: 7 }, (_, i) => 'https://f/' + i + '.jpg');
    r = await buscarFotosOficiais({ marca: 'FILA', eans: ['7909946138507'] }, { fetchFn: site([p('1', 'Preto', [it('7909946138507', seis)])]) });
    assert.strictEqual(r.fotos.length, 5, 'no máximo 5 fotos');
  });
  await t('fotos oficiais no gerente: completa card com menos de 5 fotos, nunca piora, registra a fonte e não repete por 7 dias', async () => {
    const cuidador = require('../src/services/cuidadorDeMarca');
    const A = await prod({ sku: 'F1', name: 'TENIS FILA FOTO A', brand: 'FILA', category: 'Tênis', subcategory: 'Homem', price: 300, costPrice: 150, imageUrl: 'https://velha/1.jpg', aiContext: { color: 'Preto' } }, [{ size: '39', barcode: '7909946150001', stock: 1 }]);
    await loc(L.LOJA04, A.S['39'], 1);
    const B3 = await prod({ sku: 'F2', name: 'TENIS FILA FOTO B', brand: 'FILA', category: 'Tênis', subcategory: 'Homem', price: 300, costPrice: 150, imageUrl: 'https://v/1.jpg', imageUrls: ['https://v/2.jpg', 'https://v/3.jpg'], aiContext: { color: 'Preto' } }, [{ size: '40', barcode: '7909946150002', stock: 1 }]);
    await loc(L.LOJA04, B3.S['40'], 1);
    const C3 = await prod({ sku: 'F3', name: 'TENIS FILA FOTO C', brand: 'FILA', category: 'Tênis', subcategory: 'Homem', price: 300, costPrice: 150, aiContext: { color: 'Preto' } }, [{ size: '41', barcode: '7909946150003', stock: 1 }]);
    await loc(L.LOJA04, C3.S['41'], 1);
    const chamados = [];
    const buscarFotos = async ({ eans }) => {
      chamados.push(eans[0]);
      if (eans.includes('7909946150001')) return { ok: true, fotos: ['https://fila/1.jpg', 'https://fila/2.jpg', 'https://fila/3.jpg', 'https://fila/4.jpg', 'https://fila/5.jpg'], fonte: 'https://www.fila.com.br/x/p', ean: '7909946150001' };
      if (eans.includes('7909946150002')) return { ok: true, fotos: ['https://fila/x.jpg', 'https://fila/y.jpg'], fonte: 'f', ean: '7909946150002' };
      return { ok: false, motivo: 'código não encontrado no site oficial' };
    };
    const r = await cuidador.cuidarFotos(prisma, { buscarFotos });
    const a = await prisma.product.findUnique({ where: { id: A.id } });
    assert.strictEqual(a.imageUrl, 'https://fila/1.jpg'); assert.strictEqual(a.imageUrls.length, 4, 'principal + 4 = 5 fotos');
    assert.ok(a.aiContext.fotosOficiais && /fila\.com\.br/.test(a.aiContext.fotosOficiais.fonte) && a.aiContext.fotosOficiais.anteriores.includes('https://velha/1.jpg'), 'registra fonte e as fotos antigas');
    const b = await prisma.product.findUnique({ where: { id: B3.id } });
    assert.strictEqual(b.imageUrl, 'https://v/1.jpg', 'site com menos fotos que o card: não troca (nunca piora)');
    const c = await prisma.product.findUnique({ where: { id: C3.id } });
    assert.ok(!c.imageUrl && c.aiContext.fotoOficialTentativa, 'sem resposta: não inventa, registra tentativa');
    assert.ok(r.fotos === 1, JSON.stringify(r));
    chamados.length = 0; await cuidador.cuidarFotos(prisma, { buscarFotos });
    assert.ok(!chamados.includes('7909946150003') && !chamados.includes('7909946150001'), 'não repete tentativa por 7 dias; card com 5 fotos não busca');
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
