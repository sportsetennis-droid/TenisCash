// =====================================================================
// Testes dos neurônios de NF-e, ESTOQUE, BIPE e COMPRAS da Rede Neural.
//   node scripts/test-rede-estoque.js
//   (padrão: postgresql://postgres@localhost:55432/rede_estoque — banco
//    DESCARTÁVEL local; outro: RNA_TEST_DATABASE_URL=...)
// ⚠ APAGA e semeia dados no banco informado. Recusa qualquer host que não
// seja localhost. IA simulada (ia.setCallAI) — custo real zero.
// Prova: cada neurônio emite o certo; transferência não gera órfão/card;
// SEM GTIN fica fora das somas; bipe acima do comprado vira conferência
// (nunca exclusão); dado ausente vira dado-faltante; a rede não cria card.
// =====================================================================
process.env.DATABASE_URL = process.env.RNA_TEST_DATABASE_URL || 'postgresql://postgres@localhost:55432/rede_estoque';
if (!/@(localhost|127\.0\.0\.1)(:\d+)?\//.test(process.env.DATABASE_URL)) { console.error('Recusado: use só banco DESCARTÁVEL local.'); process.exit(2); }
process.env.RNA_RELOGIO = '0';
delete process.env.RNA_ATIVA;
const assert = require('assert');
const registro = require('../src/ai/rede/registro');

const MEUS = ['nfe.entrada-x-transferencia', 'nfe.item-sem-card', 'nfe.formato-fornecedor', 'nfe.custo-medio', 'estoque.ruptura-grade', 'estoque.parado',
  'estoque.transferencia-sugerida', 'bipe.acima-comprado', 'bipe.codigo-desconhecido', 'bipe.tamanho-pendente', 'compra.reposicao'];

let pass = 0; const out = [];
async function t(nome, fn) {
  try { await fn(); pass++; out.push('  ✓ ' + nome); } catch (e) { out.push('  ✗ ' + nome + '\n      ' + (e && e.stack ? e.stack.split('\n').slice(0, 4).join('\n      ') : e)); process.exitCode = 1; }
}

// ---------------------------------------------------------------- A) sem banco
async function partA() {
  const r = registro.carregar();
  await t('contrato: os 11 neurônios carregam sem erro (e a rede inteira também)', () => {
    assert.deepStrictEqual(r.erros, []);
    for (const id of MEUS) assert.ok(r.neuronios.has(id), 'faltou ' + id);
  });
  await t('contrato: detector = regra; quem propõe declara permissão propor e emite proposta.*', () => {
    for (const id of MEUS) {
      const n = r.neuronios.get(id);
      if (n.camada === 'detector') assert.strictEqual(n.custo.tipo, 'regra', id);
      if (n.emite.some((x) => x.startsWith('proposta.'))) assert.strictEqual(n.permissao, 'propor', id);
    }
  });
  const c = require('../src/ai/rede/neuronios/_comum-estoque');
  await t('regras: SEM GTIN nunca é código; variantes UPC↔EAN; tamanho literal (faixa 38/43 não é tamanho)', () => {
    assert.ok(c.semGtin('SEM GTIN') && c.semGtin('') && c.semGtin(null) && !c.semGtin('7891234567890'));
    assert.deepStrictEqual(c.variantes('SEM GTIN'), []);
    assert.ok(c.variantes('195394510652').includes('0195394510652'));
    assert.strictEqual(c.tamanhoLiteralRegra('1162011CBLL43', 'TENIS HOKA CLIFTON 10 CBLL 43'), '43');
    assert.strictEqual(c.tamanhoLiteralRegra('04066000000042', 'REF: JH7925 - TENIS MEGARIDE O1 38/43'), null);
    assert.strictEqual(c.tamanhoNaDescricao('TENIS X 38/43', '38'), false);
    assert.strictEqual(c.tamanhoNoCprod('10010010042', '42'), false, 'número corrido não é sufixo de tamanho');
  });
  await t('classificação: CNPJ raiz igual e CFOP 5152/6152 = transferência; emissor do grupo p/ fora = saída', () => {
    const calc = r.neuronios.get('nfe.entrada-x-transferencia').calcular;
    assert.strictEqual(calc({ issuerCnpj: '11222333000144', recipientCnpj: '44052617000207' }, [{ cfop: '6102' }]).docType, 'entrada');
    assert.strictEqual(calc({ issuerCnpj: '44052617000126', recipientCnpj: '44052617000207' }, [{ cfop: '5102' }]).docType, 'transferencia');
    assert.strictEqual(calc({ issuerCnpj: '11222333000144', recipientCnpj: '44052617000207' }, [{ cfop: '6152' }]).docType, 'transferencia');
    assert.strictEqual(calc({ issuerCnpj: '44052617000126', recipientCnpj: '99888777000166' }, [{ cfop: '5102' }]).docType, 'saida');
  });
  await t('anti-chute da leitura: valor que não está escrito na NF-e vira faltando', () => {
    const f = r.neuronios.get('nfe.formato-fornecedor').conferirLiteral;
    const a = f({ ref: '1162011CBLL', tamanho: '43', cor: 'AZUL' }, { cProd: '1162011CBLL43', xProd: 'TENIS HOKA CLIFTON 10 CBLL 43', adidas: false });
    assert.deepStrictEqual(a.valores, { ref: '1162011CBLL', tamanho: '43', cor: null });
    const b = f({ ref: 'JH7925', tamanho: '41', cor: null }, { cProd: '04066000000042', xProd: 'REF: JH7925 - TENIS MEGARIDE O1 38/43', adidas: true });
    assert.strictEqual(b.valores.tamanho, null); assert.ok(b.faltando.some((x) => x.campo === 'tamanho' && /Adidas/.test(x.motivo)));
  });
}

// ---------------------------------------------------------------- B) banco descartável
async function partB() {
  const { prisma } = require('../src/middleware');
  const motor = require('../src/ai/rede/motor');
  const ia = require('../src/ai/rede/ia');
  const acoes = require('../src/ai/rede/acoes');
  const DIA = 24 * 3600 * 1000;
  const agora = Date.now();
  const atras = (d) => new Date(agora - d * DIA);

  async function limpar() {
    for (const m of ['rnaAtivacao', 'rnaSinal', 'rnaSinapse', 'rnaAjustePeso', 'rnaQuadro', 'rnaObjetivo', 'rnaNeuronio']) await prisma[m].deleteMany({});
    await prisma.aIApproval.deleteMany({ where: { type: { startsWith: 'rna_' } } });
    await prisma.stocktakeBipe.deleteMany({}); await prisma.stocktakeRound.deleteMany({});
    await prisma.storeStockMovement.deleteMany({}); await prisma.saleItem.deleteMany({}); await prisma.sale.deleteMany({});
    await prisma.storeStock.deleteMany({}); await prisma.xmlFiscalItem.deleteMany({}); await prisma.xmlFiscalDocument.deleteMany({});
    await prisma.productSize.deleteMany({}); await prisma.product.deleteMany({}); await prisma.store.deleteMany({});
    await prisma.supplier.deleteMany({}); await prisma.user.deleteMany({ where: { phone: { startsWith: 'teste-rede-estoque' } } });
  }
  await limpar();

  // ---------- semente
  const L = {};
  for (const [code, name] of [['LOJA02', 'Bessa'], ['LOJA05', 'Tambaú'], ['LOJA06', 'Tambiá']]) L[code] = await prisma.store.create({ data: { code, name } });
  const vend = await prisma.user.create({ data: { phone: 'teste-rede-estoque-1', pin: 'x', name: 'Vendedor Teste' } });
  await prisma.supplier.create({ data: { cnpj: '11222333000144', companyName: 'FORNECEDOR HOKA TESTE' } });
  const prod = async (d, sizes) => {
    const p = await prisma.product.create({ data: Object.assign({ category: 'tenis' }, d) });
    const S = {};
    for (const s of sizes) S[s.size] = await prisma.productSize.create({ data: Object.assign({ productId: p.id }, s) });
    return Object.assign(p, { S });
  };
  const A = await prod({ sku: '1162011CBLL', name: 'Tênis HOKA Clifton 10', brand: 'HOKA', price: 900, costPrice: 380 },
    [{ size: '40', barcode: '0196565000040', stock: 3 }, { size: '41', barcode: '0196565000041', stock: 3 }, { size: '42', barcode: '0196565000042', stock: 3 }]);
  const B = await prod({ sku: 'REPOB01', name: 'Chuteira Repo B', brand: 'KAPPA', price: 300, costPrice: 150 },
    [{ size: '39', barcode: '7890000000391', stock: 2 }, { size: '40', barcode: '7890000000401', stock: 2 }]);
  const C = await prod({ sku: 'PARADOC1', name: 'Camiseta Parada C', brand: 'PENALTY', price: 100, costPrice: 50, createdAt: atras(200) },
    [{ size: 'M', barcode: '7890000000551', stock: 10 }]);
  const D = await prod({ sku: 'NOVOD1', name: 'Bermuda Nova D', brand: 'PENALTY', price: 80, costPrice: 40 }, [{ size: 'G', barcode: '7890000000661', stock: 4 }]);
  const E = await prod({ sku: 'JH7925', name: 'Tênis Adidas Megaride O1', brand: 'Adidas', price: 700, costPrice: 300 },
    [{ size: 'T-4066000000011', barcode: '4066000000011', stock: 1 }, { size: '41', barcode: '4066000000028', stock: 1 }, { size: '42', barcode: '4066000000035', stock: 1, sizeConfirmedAt: new Date() }]);
  const F = await prod({ sku: '0258-7891111111118', name: 'Sandália Rider F (curada)', brand: 'RIDER', price: 120, costPrice: 60, active: false }, []);

  const ss = (loja, size, stock) => prisma.storeStock.create({ data: { storeId: L[loja].id, productSizeId: size.id, stock } });
  await ss('LOJA02', A.S['40'], 1); await ss('LOJA02', A.S['41'], 0); await ss('LOJA02', A.S['42'], 1);
  await ss('LOJA05', A.S['41'], 3); await ss('LOJA05', A.S['42'], 0);
  await ss('LOJA02', B.S['40'], 1);
  await ss('LOJA06', C.S.M, 5); await ss('LOJA06', D.S.G, 4);

  const venda = async (loja, p, size, dias) => prisma.sale.create({ data: { sellerId: vend.id, storeId: L[loja].id, totalAmount: p.price, status: 'completed', createdAt: atras(dias),
    items: { create: [{ productId: p.id, productSizeId: size.id, productName: p.name, brand: p.brand, size: size.size, quantity: 1, unitPrice: p.price, totalPrice: p.price }] } } });
  await venda('LOJA02', A, A.S['41'], 50); await venda('LOJA02', A, A.S['41'], 20); const vA = await venda('LOJA02', A, A.S['41'], 2);
  await venda('LOJA02', B, B.S['39'], 60); await venda('LOJA02', B, B.S['39'], 30); const vB = await venda('LOJA02', B, B.S['39'], 3);
  await venda('LOJA05', C, C.S.M, 40); await venda('LOJA05', C, C.S.M, 10);
  await prisma.sale.create({ data: { sellerId: vend.id, storeId: L.LOJA02.id, totalAmount: 900, status: 'cancelled', createdAt: atras(1),
    items: { create: [{ productId: A.id, productSizeId: A.S['40'].id, productName: A.name, brand: A.brand, size: '40', quantity: 5, unitPrice: 900, totalPrice: 4500 }] } } });

  const nfe = (key, d, itens) => prisma.xmlFiscalDocument.create({ data: Object.assign({ accessKey: key, issueDate: atras(10) }, d, { items: { create: itens.map((i) => Object.assign({ cfop: '6102', unitValue: 0, totalValue: 0 }, i)) } }), include: { items: true } });
  const it = (ean, cProd, xProd, quantity, unitValue, extra = {}) => Object.assign({ ean, supplierCode: cProd, description: xProd, quantity, unitValue, totalValue: quantity * unitValue }, extra);
  const D1 = await nfe('K1-ENTRADA-HOKA', { issuerCnpj: '11222333000144', issuerName: 'FORNECEDOR HOKA TESTE', recipientCnpj: '44052617000207', docType: null }, [
    it('0196565000040', '1162011CBLL40', 'TENIS HOKA CLIFTON 10 CBLL 40', 3, 400, { productId: A.id }),
    it('0196565000041', '1162011CBLL41', 'TENIS HOKA CLIFTON 10 CBLL 41', 3, 400, { productId: A.id }),
    it('0196565000042', '1162011CBLL42', 'TENIS HOKA CLIFTON 10 CBLL 42', 3, 400, { productId: A.id }),
    it('0196565000043', '1162011CBLL43', 'TENIS HOKA CLIFTON 10 CBLL 43', 2, 450),
    it('SEM GTIN', 'MEIA01', 'MEIA ESPORTIVA', 79000, 1, { productId: A.id }),
    it('SEM GTIN', 'BONE77', 'BONE TESTE', 5, 20),
    it('7895555555551', 'ZZZ999-40', 'PRODUTO NOVO ZZZ 40', 4, 70),
    it('7891111111118', 'RID01', 'SANDALIA RIDER F 37', 6, 60),
  ]);
  const D2 = await nfe('K2-TRANSF', { issuerCnpj: '44052617000126', recipientCnpj: '44052617000207', docType: 'transferencia' }, [it('7899999999990', 'TRX1', 'TENIS TRANSFERIDO 40', 10, 100, { cfop: '5152' })]);
  const D3 = await nfe('K3-CFOP', { issuerCnpj: '55666777000188', recipientCnpj: '44052617000207', docType: null }, [it('7897777777770', 'CF1', 'ITEM CFOP 6152 41', 2, 50, { cfop: '6152' })]);
  const D4 = await nfe('K4-DIVERGE', { issuerCnpj: '44052617000126', recipientCnpj: '44052617000550', docType: 'entrada' }, [it('7898888888880', 'DV1', 'ITEM DIVERGENTE 42', 3, 50, { cfop: '5102' })]);
  await nfe('K5-ENTRADA-ANTIGA', { issuerCnpj: '11222333000144', issuerName: 'FORNECEDOR HOKA TESTE', recipientCnpj: '44052617000630', docType: 'entrada', issueDate: atras(200) }, [
    it('7890000000551', 'PAR-C-M', 'CAMISETA PARADA C M', 10, 50, { productId: C.id }),
    it('7890000000391', 'REPOB0139', 'CHUTEIRA REPO B 39', 2, 150, { productId: B.id }),
  ]);
  await nfe('K6-ADIDAS', { issuerCnpj: '33444555000166', issuerName: 'ALPAR DO BRASIL', recipientCnpj: '44052617000207', docType: 'entrada' }, [
    it('4066000000042', '04066000000042', 'REF: JH7925 - TENIS MEGARIDE O1 38/43', 2, 300, { productId: E.id }),
  ]);
  await nfe('K7-UPC', { issuerCnpj: '11222333000144', issuerName: 'FORNECEDOR HOKA TESTE', recipientCnpj: '44052617000207', docType: 'entrada' }, [
    it('0195394510652', '1162011CBLL44', 'TENIS HOKA CLIFTON 10 CBLL 44', 1, 400),
  ]);

  const R = await prisma.stocktakeRound.create({ data: { name: 'Rodada teste LOJA02', storeId: L.LOJA02.id, baseline: {} } });
  const bipe = (barcode, size, extra = {}) => prisma.stocktakeBipe.create({ data: Object.assign({ barcode, storeId: L.LOJA02.id, roundId: R.id, sellerName: 'teste',
    productId: size ? size.productId : null, productSizeId: size ? size.id : null, found: !!size, applied: !!size }, extra) });

  // ---------- IA simulada
  const chamadasIA = [];
  ia.setCallAI(async ({ systemPrompt, userPrompt }) => {
    const entrada = JSON.parse(userPrompt.slice(userPrompt.indexOf('\n') + 1));
    if (/Ler referência, tamanho e cor/.test(systemPrompt)) {
      const cp = entrada.item.cProd;
      chamadasIA.push('formato:' + cp);
      const resp = {
        '1162011CBLL43': { ref: '1162011CBLL', tamanho: '43', cor: 'CBLL' },
        'ZZZ999-40': { ref: 'ZZZ999', tamanho: '40', cor: 'AZUL' }, // cor INVENTADA (não está no xProd)
        BONE77: { ref: 'BONE77', tamanho: null, cor: null },
        RID01: { ref: 'RID01', tamanho: '37', cor: 'PRETO' },
      }[cp] || { ref: null, tamanho: null, cor: null };
      return { ok: true, json: Object.assign({ explicacao: 'teste' }, resp), text: '{}', cost: { brl: 0 } };
    }
    if (/transferência/.test(systemPrompt)) { chamadasIA.push('transf'); return { ok: true, json: { justificativas: [] }, cost: { brl: 0 } }; }
    if (/reposição/.test(systemPrompt)) { chamadasIA.push('repo'); return { ok: true, json: { justificativa: 'Vende bem e acabou em todas as lojas.' }, cost: { brl: 0 } }; }
    chamadasIA.push('?'); return { ok: false, error: 'mock sem resposta' };
  });

  // ---------- motor só com os neurônios deste domínio (isolado dos outros domínios)
  const todos = registro.carregar().neuronios;
  motor.iniciar({ db: prisma, neuronios: new Map(MEUS.map((id) => [id, todos.get(id)])) });
  await motor.sincronizar();
  const produtosAntes = await prisma.product.count();

  const rodar = async (tipo, dados, origem) => { const s = await motor.emitir({ tipo, origem: origem || 's.teste', forca: tipo.startsWith('relogio.') ? 0.9 : 1, dados }); await motor.ocioso(60000); return s.traceId; };
  const sinais = async (traceId, tipo) => prisma.rnaSinal.findMany({ where: { traceId, ...(tipo ? { tipo } : {}) }, orderBy: { criadoEm: 'asc' } });
  const propostas = async (traceId, type) => (await prisma.aIApproval.findMany({ where: { type: { startsWith: 'rna_' }, ...(type ? { type } : {}) } })).filter((a) => !traceId || a.payload.rna.traceId === traceId);

  // ---------- NF-e
  let trD1;
  await t('nfe.entrada-x-transferencia: NF-e de fornecedor (docType vazio) → classificada entrada', async () => {
    trD1 = await rodar('nfe.importada', { documentId: D1.id, accessKey: D1.accessKey }, 's.nfe');
    const [cl] = await sinais(trD1, 'nfe.classificada');
    assert.ok(cl); assert.strictEqual(cl.dados.docType, 'entrada'); assert.strictEqual(cl.dados.entrada, true); assert.strictEqual(cl.dados.divergente, false);
  });
  await t('nfe.item-sem-card: só os códigos sem tamanho viram órfãos (SEM GTIN ligado fica fora)', async () => {
    const orf = await sinais(trD1, 'nfe.item-orfao');
    const cps = orf.map((s) => s.dados.cProd).sort();
    assert.deepStrictEqual(cps, ['1162011CBLL43', 'BONE77', 'RID01', 'ZZZ999-40'], cps.join(','));
    const e43 = orf.find((s) => s.dados.cProd === '1162011CBLL43');
    assert.strictEqual(e43.dados.cardExistente.id, A.id, 'devia achar o card HOKA pelo sku-prefixo do cProd');
    assert.strictEqual(orf.find((s) => s.dados.cProd === 'RID01').dados.cardExistente.id, F.id, 'devia achar o card curado inativo pelo EAN no sku');
    assert.strictEqual(orf.find((s) => s.dados.cProd === 'ZZZ999-40').dados.cardExistente, null);
    assert.strictEqual(orf.find((s) => s.dados.cProd === 'BONE77').dados.semGtin, true);
  });
  await t('nfe.item-sem-card: card existente → proposta de LIGAR (nunca criar), com evidência NF-e + item', async () => {
    const ps = await propostas(trD1, 'rna_ligar_card');
    assert.strictEqual(ps.length, 2, ps.map((p) => p.title).join(' | '));
    const f = ps.find((p) => p.payload.acao.args.productId === F.id);
    assert.ok(/INATIVO/.test(f.title)); assert.ok(f.payload.evidencia.some((e) => /K1-ENTRADA-HOKA item 8/.test(e)));
    assert.strictEqual(f.payload.acao.nome, 'estoque.ligar-item-nfe');
  });
  await t('nfe.formato-fornecedor: lê literal; cor inventada pela IA vira dado-faltante; sem card não propõe', async () => {
    assert.ok(chamadasIA.filter((x) => x.startsWith('formato:')).length === 4, chamadasIA.join(','));
    const leit = await sinais(trD1, 'nfe.leitura-ref');
    const z = leit.find((s) => s.dados.ref === 'ZZZ999');
    assert.ok(z); assert.strictEqual(z.dados.tamanho, '40'); assert.strictEqual(z.dados.cor, null);
    const falt = await sinais(trD1, 'dado-faltante');
    assert.ok(falt.some((s) => s.dados.campo === 'cor' && /AZUL/.test(s.dados.motivo)), 'cor inventada devia virar dado-faltante');
    assert.ok(falt.some((s) => s.dados.campo === 'card' && /ZZZ/.test(s.dados.chave) || (s.dados.campo === 'card' && s.dados.nItem === 7)));
    const vinc = await propostas(trD1, 'rna_vincular_codigo');
    const cods = vinc.map((p) => p.payload.acao.args.barcode).sort();
    assert.deepStrictEqual(cods, ['0196565000043', '7891111111118'], 'só vincula onde o card existe e há EAN: ' + cods);
    const v43 = vinc.find((p) => p.payload.acao.args.barcode === '0196565000043');
    assert.strictEqual(v43.payload.acao.args.size, '43');
    assert.ok(v43.payload.evidencia.some((e) => /K1-ENTRADA-HOKA item 4/.test(e)));
  });
  await t('nfe.custo-medio: entrada informa custo novo = Σ vProd/Σ qCom SEM o "SEM GTIN" (79 mil un fora)', async () => {
    const cs = await sinais(trD1, 'preco.custo-atualizado');
    const a = cs.find((s) => s.dados.productId === A.id);
    assert.ok(a, 'faltou custo do card A');
    assert.strictEqual(a.dados.custoAnterior, 380); assert.strictEqual(a.dados.custoNovo, 400); assert.strictEqual(a.dados.base.quantidade, 9);
    assert.strictEqual((await prisma.product.findUnique({ where: { id: A.id } })).costPrice, 380, 'só informa, não grava');
  });
  await t('transferência (gravada, por CNPJ raiz, por CFOP 6152, ou divergente) NÃO gera item órfão, custo nem proposta', async () => {
    for (const doc of [D2, D3, D4]) {
      const tr = await rodar('nfe.importada', { documentId: doc.id }, 's.nfe');
      const [cl] = await sinais(tr, 'nfe.classificada');
      assert.strictEqual(cl.dados.entrada, false, doc.accessKey);
      assert.strictEqual((await sinais(tr, 'nfe.item-orfao')).length, 0, doc.accessKey);
      assert.strictEqual((await sinais(tr, 'preco.custo-atualizado')).length, 0, doc.accessKey);
      assert.strictEqual((await propostas(tr)).length, 0, doc.accessKey);
      if (doc === D3) assert.strictEqual(cl.dados.docType, 'transferencia');
      if (doc === D4) {
        assert.strictEqual(cl.dados.divergente, true);
        const pend = await sinais(tr, 'dono.pendencia');
        assert.ok(pend.length === 1 && pend[0].dados.tipo === 'nfe-tipo-divergente');
      }
    }
  });
  await t('NF-e inexistente → dado-faltante (nada inventado)', async () => {
    const tr = await rodar('nfe.importada', { documentId: 'nao-existe' }, 's.nfe');
    const f = await sinais(tr, 'dado-faltante');
    assert.strictEqual(f.length, 1); assert.strictEqual((await sinais(tr, 'nfe.classificada')).length, 0);
  });

  // ---------- Estoque
  let trVA;
  await t('estoque.ruptura-grade: venda do 41 na LOJA02 → ruptura só do tamanho-chave zerado (venda cancelada não conta)', async () => {
    trVA = await rodar('venda.registrada', { saleId: vA.id, storeCode: 'LOJA02', total: 900, itens: [{ productId: A.id, sizeId: A.S['41'].id, qty: 1, price: 900 }] }, 's.venda');
    const r = await sinais(trVA, 'estoque.ruptura');
    assert.strictEqual(r.length, 1);
    assert.deepStrictEqual(r[0].dados.tamanhosFaltando.map((x) => x.size), ['41']);
    assert.strictEqual(r[0].dados.tamanhosFaltando[0].vendas90dRede, 3);
    assert.ok(r[0].impactoRS > 0);
  });
  await t('estoque.transferencia-sugerida: sobra na LOJA05 → proposta LOJA05→LOJA02 tam 41; reposição NÃO (tem na rede)', async () => {
    const tp = await propostas(trVA, 'rna_transferencia');
    assert.strictEqual(tp.length, 1);
    assert.deepStrictEqual([tp[0].payload.previa.de, tp[0].payload.previa.para, tp[0].payload.previa.tamanho, tp[0].payload.previa.quantidade], ['LOJA05', 'LOJA02', '41', 1]);
    assert.strictEqual(tp[0].payload.acao.nome, 'rna.registrar');
    assert.strictEqual((await propostas(trVA, 'rna_reposicao')).length, 0);
  });
  await t('compra.reposicao: zerado na rede + giro → proposta com histórico e fornecedor = EMISSOR da entrada', async () => {
    const tr = await rodar('venda.registrada', { saleId: vB.id, storeCode: 'LOJA02', itens: [{ productId: B.id, sizeId: B.S['39'].id, qty: 1 }] }, 's.venda');
    const rp = await propostas(tr, 'rna_reposicao');
    assert.strictEqual(rp.length, 1);
    const pv = rp[0].payload.previa;
    assert.strictEqual(pv.fornecedor.cnpj, '11222333000144'); assert.ok(!pv.fornecedor.cnpj.startsWith('44052617'));
    assert.deepStrictEqual(pv.itens.map((i) => [i.tamanho, i.vendas90d, i.sugerido]), [['39', 3, 3]]);
    assert.strictEqual(rp[0].payload.rna.impactoRS, 900);
    assert.strictEqual((await propostas(tr, 'rna_transferencia')).length, 0, 'sem estoque em loja nenhuma: não há transferência');
  });
  await t('relógio diário: acha as mesmas rupturas e NÃO duplica propostas pendentes', async () => {
    const antes = (await propostas()).length;
    const tr = await rodar('relogio.diario', { quando: new Date().toISOString() }, 's.relogio');
    const r = await sinais(tr, 'estoque.ruptura');
    assert.deepStrictEqual(r.map((s) => s.dados.productId).sort(), [A.id, B.id].sort());
    assert.strictEqual((await propostas()).length, antes);
  });
  let trPar;
  await t('estoque.parado: só o card sem venda na loja há ≥90 dias, com valor a custo; recém-chegado não', async () => {
    trPar = await rodar('relogio.semanal', { quando: new Date().toISOString() }, 's.relogio');
    const p = await sinais(trPar, 'estoque.parado');
    assert.deepStrictEqual(p.map((s) => [s.dados.productId, s.dados.loja]), [[C.id, 'LOJA06']]);
    assert.strictEqual(p[0].dados.unidades, 5); assert.strictEqual(p[0].dados.valorCustoRS, 250); assert.strictEqual(p[0].impactoRS, 250);
    assert.ok(p[0].dados.dias >= 90);
  });
  await t('estoque.transferencia-sugerida (do parado): LOJA06 parado → LOJA05 que vende e está zerada', async () => {
    const tp = await propostas(trPar, 'rna_transferencia');
    assert.strictEqual(tp.length, 1);
    assert.deepStrictEqual([tp[0].payload.previa.de, tp[0].payload.previa.para, tp[0].payload.previa.tamanho], ['LOJA06', 'LOJA05', 'M']);
  });

  // ---------- Bipe
  for (let i = 0; i < 3; i++) await bipe('0196565000040', A.S['40']);
  const b4 = await bipe('0196565000040', A.S['40']);
  let trB4;
  await t('bipe.acima-comprado: 4º bipe com comprado 3 → proposta de CONFERÊNCIA na loja (nenhum bipe apagado)', async () => {
    trB4 = await rodar('bipe.registrado', { bipeId: b4.id, storeCode: 'LOJA02', barcode: b4.barcode, productId: A.id, sizeId: A.S['40'].id, found: true, roundId: R.id }, 's.bipe');
    const cf = await propostas(trB4, 'rna_conferencia_loja');
    assert.strictEqual(cf.length, 1);
    assert.strictEqual(cf[0].payload.previa.bipados, 4); assert.strictEqual(cf[0].payload.previa.comprado, 3);
    assert.strictEqual(cf[0].payload.acao.nome, 'rna.registrar');
    assert.ok(!/apag|exclu|delet/i.test(cf[0].payload.acao.nome));
    assert.strictEqual(await prisma.stocktakeBipe.count({ where: { productSizeId: A.S['40'].id, excludedAt: null } }), 4);
    assert.strictEqual((await prisma.productSize.findUnique({ where: { id: A.S['40'].id } })).stock, 3, 'comprado intocado');
  });
  await t('bipe repetido com Σ ≤ comprado é par real (nada); SEM GTIN e bipe sem rodada não contam', async () => {
    await bipe('0196565000042', A.S['42']); const b42 = await bipe('0196565000042', A.S['42']);
    const sg = await bipe('SEM GTIN', A.S['41']);
    const semRodada = await bipe('0196565000040', A.S['40'], { roundId: null });
    for (const b of [b42, sg, semRodada]) {
      const tr = await rodar('bipe.registrado', { bipeId: b.id, storeCode: 'LOJA02', barcode: b.barcode, found: true }, 's.bipe');
      assert.strictEqual((await propostas(tr)).length, 0, b.barcode);
    }
  });
  await t('bipe.tamanho-pendente: Adidas sem confirmação e placeholder → pendência; Adidas confirmado e HOKA → nada', async () => {
    const casos = [[E.S['41'], 1], [E.S['T-4066000000011'], 1], [E.S['42'], 0], [A.S['42'], 0]];
    for (const [size, esperado] of casos) {
      const b = await bipe(size.barcode, size);
      const tr = await rodar('bipe.registrado', { bipeId: b.id, storeCode: 'LOJA02', barcode: b.barcode, found: true }, 's.bipe');
      const p = await sinais(tr, 'dono.pendencia');
      assert.strictEqual(p.length, esperado, size.size);
      if (esperado) assert.strictEqual(p[0].dados.tipo, 'tamanho-pendente');
    }
    const p41 = (await prisma.rnaSinal.findMany({ where: { tipo: 'dono.pendencia' } })).find((s) => s.dados.sizeId === E.S['41'].id);
    assert.strictEqual(p41.dados.tamanhoAtual, '41'); assert.ok(!/T-|chute/i.test(p41.dados.tamanhoSugerido || ''), 'nunca sugere número');
  });
  const bUPC = await bipe('195394510652', null);
  const bAdi = await bipe('4066000000042', null);
  const bTrf = await bipe('7899999999990', null);
  const bNada = await bipe('7891234500000', null);
  const trCod = {};
  await t('bipe.codigo-desconhecido: UPC-12 casa com GTIN-13 da NF-e de ENTRADA → vincular no card existente, tam literal 44', async () => {
    trCod.upc = await rodar('bipe.registrado', { bipeId: bUPC.id, storeCode: 'LOJA02', barcode: bUPC.barcode, found: false }, 's.bipe');
    const v = await propostas(trCod.upc, 'rna_vincular_codigo');
    assert.strictEqual(v.length, 1);
    assert.deepStrictEqual([v[0].payload.acao.args.productId, v[0].payload.acao.args.size, v[0].payload.acao.args.bipeId], [A.id, '44', bUPC.id]);
    assert.ok(v[0].payload.evidencia.some((e) => /K7-UPC/.test(e)));
  });
  await t('bipe.codigo-desconhecido: Adidas → vincula com tamanho PENDENTE + dado-faltante (caixa decide)', async () => {
    trCod.adi = await rodar('bipe.registrado', { bipeId: bAdi.id, storeCode: 'LOJA02', barcode: bAdi.barcode, found: false }, 's.bipe');
    const v = await propostas(trCod.adi, 'rna_vincular_codigo');
    assert.strictEqual(v.length, 1); assert.strictEqual(v[0].payload.acao.args.size, null); assert.strictEqual(v[0].payload.acao.args.productId, E.id);
    assert.ok((await sinais(trCod.adi, 'dado-faltante')).some((s) => s.dados.campo === 'tamanho' && /Adidas/.test(s.dados.motivo)));
  });
  await t('bipe.codigo-desconhecido: só em transferência ou em lugar nenhum → dado-faltante, sem proposta', async () => {
    for (const b of [bTrf, bNada]) {
      const tr = await rodar('bipe.registrado', { bipeId: b.id, storeCode: 'LOJA02', barcode: b.barcode, found: false }, 's.bipe');
      assert.strictEqual((await propostas(tr)).length, 0, b.barcode);
      const f = await sinais(tr, 'dado-faltante');
      assert.strictEqual(f.length, 1, b.barcode);
      if (b === bTrf) assert.ok(/transferência/.test(f[0].dados.motivo));
    }
  });

  // ---------- Ações (só depois do "sim"), revalidando as regras
  const aprovarExecutar = async (ap) => { await prisma.aIApproval.update({ where: { id: ap.id }, data: { status: 'approved' } }); return acoes.executar(ap.id, { executadoPor: 'teste' }, prisma); };
  await t('ação vincular-codigo (E43): cria o tamanho 43 no card EXISTENTE com comprado = Σ qCom (2), sem SEM GTIN, sem mexer em StoreStock', async () => {
    const ssAntes = await prisma.storeStock.count();
    const ap = (await propostas(trD1, 'rna_vincular_codigo')).find((p) => p.payload.acao.args.barcode === '0196565000043');
    const r = await aprovarExecutar(ap);
    assert.strictEqual(r.resultado.tamanho, '43'); assert.strictEqual(r.resultado.comprado, 2); assert.strictEqual(r.resultado.criado, true);
    const ps = await prisma.productSize.findFirst({ where: { barcode: '0196565000043' } });
    assert.strictEqual(ps.productId, A.id);
    assert.strictEqual((await prisma.xmlFiscalItem.findFirst({ where: { ean: '0196565000043' } })).productId, A.id);
    assert.strictEqual(await prisma.storeStock.count(), ssAntes);
    assert.strictEqual((await prisma.aIApproval.findUnique({ where: { id: ap.id } })).status, 'executed');
  });
  await t('revalidação: executar de novo o mesmo vínculo é barrado (código já tem dono); proposta não aprovada não executa', async () => {
    const def = acoes.ACOES.get('estoque.vincular-codigo');
    await assert.rejects(() => def.executar({ productId: A.id, barcode: '0196565000043', size: '43', itemIds: [D1.items.find((i) => i.ean === '0196565000043').id] }, { db: prisma }), /já pertence/);
    await assert.rejects(() => def.executar({ productId: A.id, barcode: 'SEM GTIN', itemIds: ['x'] }, { db: prisma }), /SEM GTIN/);
    const pend = (await propostas(trCod.adi, 'rna_vincular_codigo'))[0];
    await assert.rejects(() => acoes.executar(pend.id, {}, prisma), /APROVADA/);
  });
  await t('revalidação: ligar item de TRANSFERÊNCIA a card é barrado; tamanho não literal vira placeholder', async () => {
    const lig = acoes.ACOES.get('estoque.ligar-item-nfe');
    await assert.rejects(() => lig.executar({ itemIds: [D2.items[0].id], productId: A.id }, { db: prisma }), /entrada|transfer/i);
    const vin = acoes.ACOES.get('estoque.vincular-codigo');
    const zzz = D1.items.find((i) => i.supplierCode === 'ZZZ999-40');
    const r = await vin.executar({ productId: D.id, barcode: '7895555555551', size: '41', itemIds: [zzz.id] }, { db: prisma }); // 41 NÃO está escrito
    assert.strictEqual(r.tamanho, 'T-7895555555551'); assert.strictEqual(r.comprado, 4);
    await prisma.productSize.delete({ where: { id: r.productSizeId } }); await prisma.xmlFiscalItem.update({ where: { id: zzz.id }, data: { productId: null, matchStatus: 'pending' } });
  });
  await t('ação ligar-item-nfe (card curado inativo F): só liga o item; não cria tamanho, não reativa, não cria card', async () => {
    const ap = (await propostas(trD1, 'rna_ligar_card')).find((p) => p.payload.acao.args.productId === F.id);
    const r = await aprovarExecutar(ap);
    assert.strictEqual(r.resultado.ligados, 1);
    const f = await prisma.product.findUnique({ where: { id: F.id }, include: { sizes: true } });
    assert.strictEqual(f.active, false); assert.strictEqual(f.sizes.length, 0);
  });
  await t('ação vincular-codigo (bipe UPC): cria tam 44 com o código LIDO, religa o bipe; Adidas entra como placeholder', async () => {
    const r1 = await aprovarExecutar((await propostas(trCod.upc, 'rna_vincular_codigo'))[0]);
    assert.deepStrictEqual([r1.resultado.tamanho, r1.resultado.comprado, r1.resultado.bipeReligado], ['44', 1, true]);
    const b = await prisma.stocktakeBipe.findUnique({ where: { id: bUPC.id } });
    assert.ok(b.found); assert.strictEqual(b.productSizeId, r1.resultado.productSizeId);
    const r2 = await aprovarExecutar((await propostas(trCod.adi, 'rna_vincular_codigo'))[0]);
    assert.deepStrictEqual([r2.resultado.tamanho, r2.resultado.comprado], ['T-4066000000042', 2]);
  });
  await t('conferência aprovada só registra a decisão: os 4 bipes continuam lá', async () => {
    const r = await aprovarExecutar((await propostas(trB4, 'rna_conferencia_loja'))[0]);
    assert.strictEqual(r.acao, 'rna.registrar');
    assert.strictEqual(await prisma.stocktakeBipe.count({ where: { productSizeId: A.S['40'].id, excludedAt: null, roundId: R.id } }), 4);
  });
  await t('a rede NÃO criou nenhum card; nenhum neurônio deu erro; custo de IA = 0', async () => {
    assert.strictEqual(await prisma.product.count(), produtosAntes);
    const erros = await prisma.rnaAtivacao.findMany({ where: { status: { in: ['erro', 'bloqueado'] } } });
    assert.deepStrictEqual(erros.map((e) => e.neuronio + ': ' + (e.erro || JSON.stringify(e.saida))), []);
    const custo = await prisma.rnaAtivacao.aggregate({ _sum: { custoRS: true } });
    assert.strictEqual(custo._sum.custoRS || 0, 0);
  });
  out.push(`  (IA simulada: ${chamadasIA.length} chamadas — ${[...new Set(chamadasIA.map((x) => x.split(':')[0]))].join(', ')})`);
  await limpar();
  await prisma.$disconnect();
}

(async () => {
  console.log('A) contrato e regras (sem banco)');
  await partA();
  console.log('B) neurônios no banco DESCARTÁVEL ' + process.env.DATABASE_URL.replace(/\/\/[^@]*@/, '//***@'));
  await partB();
  console.log(out.join('\n'));
  console.log((process.exitCode ? 'FALHOU' : 'OK') + ' — ' + pass + ' testes passaram');
  process.exit(process.exitCode || 0);
})().catch((e) => { console.error(e); process.exit(1); });
