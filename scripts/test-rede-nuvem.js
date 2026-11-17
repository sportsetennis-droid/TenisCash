// =====================================================================
// Testes dos neurônios NUVEMSHOP / CONTEÚDO / PREÇO da Rede Neural.
//   RNA_TEST_DATABASE_URL=postgresql://postgres@localhost:55432/rede_nuvem node scripts/test-rede-nuvem.js
// ⚠ APAGA e semeia o banco informado: use SÓ banco DESCARTÁVEL.
// A API da Nuvemshop é SIMULADA (nenhuma chamada sai da máquina) e a IA
// também (ia.setCallAI). Prova: cada detector acha o caso certo, nada é
// inventado, nada é publicado/despublicado/repreçado sem aprovação, e as
// ações aprovadas revalidam as regras antes de mexer.
// =====================================================================
if (process.env.RNA_TEST_DATABASE_URL) process.env.DATABASE_URL = process.env.RNA_TEST_DATABASE_URL;
process.env.RNA_RELOGIO = '0';
const assert = require('assert');
const registro = require('../src/ai/rede/registro');

const MEUS = ['nuvem.sem-foto', 'nuvem.sem-classificacao', 'nuvem.estoque-divergente', 'nuvem.ghost', 'nuvem.correcao', 'conteudo.descricao', 'conteudo.foto-oficial', 'preco.abaixo-custo', 'preco.desconto-acima-15', 'preco.plano-markdown'];

let pass = 0; const out = [];
async function t(nome, fn) {
  try { await fn(); pass++; out.push('  ✓ ' + nome); } catch (e) { out.push('  ✗ ' + nome + '\n      ' + (e && e.stack ? e.stack.split('\n').slice(0, 4).join('\n      ') : e)); process.exitCode = 1; }
}

async function partA() {
  await t('contrato: os 10 neurônios carregam sem erro, ids/camadas/custos certos', () => {
    const r = registro.carregar();
    const meusErros = r.erros.filter((e) => /^(nuvem|conteudo|preco)\//.test(e));
    assert.deepStrictEqual(meusErros, []);
    for (const id of MEUS) assert.ok(r.neuronios.has(id), 'faltou ' + id);
    for (const id of MEUS) {
      const n = r.neuronios.get(id);
      if (n.camada === 'detector') assert.strictEqual(n.custo.tipo, 'regra', id);
      if (n.emite.some((x) => x.startsWith('proposta.'))) assert.strictEqual(n.permissao, 'propor', id);
      assert.notStrictEqual(n.permissao, 'agir', id + ' não pode agir');
    }
    assert.strictEqual(r.neuronios.get('preco.plano-markdown').custo.tipo, 'ia-forte');
    assert.strictEqual(r.neuronios.get('nuvem.correcao').custo.tipo, 'ia-barata');
  });
  await t('ações registradas: nuvem.despublicar, ressincronizar-estoque, remover-fantasma, aplicar-descricao', () => {
    const acoes = require('../src/ai/rede/acoes');
    const nomes = acoes.listar().map((a) => a.nome);
    for (const n of ['nuvem.despublicar', 'nuvem.ressincronizar-estoque', 'nuvem.remover-fantasma', 'nuvem.aplicar-descricao']) assert.ok(nomes.includes(n), n);
    assert.ok(!nomes.some((n) => /preco|price/.test(n)), 'nenhuma ação de preço');
  });
}

async function partB() {
  const { prisma } = require('../src/middleware');
  const motor = require('../src/ai/rede/motor');
  const ia = require('../src/ai/rede/ia');
  const acoes = require('../src/ai/rede/acoes');
  const nsApi = require('../src/services/nuvemshop');

  // ---------- Nuvemshop simulada: registra tudo, nada sai da máquina ----------
  const chamadas = [];
  const variantesRemotas = {};
  nsApi.nuvemshopApi = async (conn, method, path, body) => {
    chamadas.push({ method, path, body });
    const mv = path.match(/^\/products\/([^/]+)\/variants$/);
    if (method === 'GET' && mv) return variantesRemotas[mv[1]] || [];
    return { ok: true };
  };
  nsApi.deleteProduct = async (c, id) => { chamadas.push({ method: 'DELETE', path: '/products/' + id }); return {}; };

  // ---------- IA simulada ----------
  const iaChamadas = [];
  ia.setCallAI(async ({ systemPrompt, userPrompt }) => {
    iaChamadas.push(systemPrompt.slice(0, 120));
    const entrada = JSON.parse(userPrompt.slice(userPrompt.indexOf('\n') + 1));
    if (/remarca/i.test(systemPrompt)) {
      return { ok: true, json: { itens: entrada.itens.map((x) => ({ productId: x.productId, descontoPct: 25, motivo: 'parado há muito tempo' })), resumo: 'Plano teste.' }, cost: { brl: 0.01 } };
    }
    if (/descri/i.test(systemPrompt)) {
      if (/CHUTE/.test(entrada.nome)) return { ok: true, json: { texto: entrada.nome + ' azul, numeração 42, com amortecimento em gel.' }, cost: { brl: 0.001 } };
      return { ok: true, json: { texto: entrada.nome + ' da ' + entrada.marca + ' na cor ' + entrada.cor + '. Ideal para ' + entrada.modalidade + '.' }, cost: { brl: 0.001 } };
    }
    return { ok: true, json: {}, cost: { brl: 0 } };
  });

  // ---------- limpeza e semente ----------
  const limpar = async () => {
    for (const m of ['rnaAtivacao', 'rnaSinal', 'rnaSinapse', 'rnaAjustePeso', 'rnaQuadro', 'rnaObjetivo', 'rnaNeuronio']) await prisma[m].deleteMany({});
    await prisma.aIApproval.deleteMany({});
    await prisma.nuvemshopVariantMapping.deleteMany({});
    await prisma.nuvemshopProductMapping.deleteMany({});
    await prisma.nuvemshopSyncLog.deleteMany({});
    await prisma.nuvemshopConnection.deleteMany({});
    await prisma.storeStock.deleteMany({});
    await prisma.productSize.deleteMany({});
    await prisma.product.deleteMany({});
    await prisma.supplier.deleteMany({});
    await prisma.store.deleteMany({ where: { code: { startsWith: 'TST' } } });
  };
  await limpar();

  const lojaSite = await prisma.store.create({ data: { name: 'Teste Loja04', code: 'TST04' } });
  const lojaSite2 = await prisma.store.create({ data: { name: 'Teste Loja06', code: 'TST06' } });
  const lojaFora = await prisma.store.create({ data: { name: 'Teste Loja02 (fora do site)', code: 'TST02' } });
  process.env.NS_STOCK_STORE_IDS = lojaSite.id + ',' + lojaSite2.id;
  await prisma.nuvemshopConnection.create({ data: { nuvemshopUserId: '7890890', accessToken: 'fake-teste', status: 'active' } });
  await prisma.supplier.create({ data: { companyName: 'Fornecedor Teste', cnpj: '11222333000181', averageMarkup: 100 } });

  const FOTO = 'https://cdn.exemplo.com/foto.jpg';
  const CLASS = { modality: 'Corrida', tier: 'Performance', gender: 'Masculino' };
  const ctxBase = (extra = {}) => Object.assign({ color: 'Preto', classification: CLASS, confirmedForNuvemshop: true }, extra);
  let seq = 0;
  async function produto(o) {
    seq++;
    const { sizes = [{ size: '40', barcode: String(7890000000000 + seq * 10), stock: 3, loc: [[lojaSite.id, 2]] }], ns, nsStatus = 'synced', variantes, ...dados } = o;
    const p = await prisma.product.create({ data: Object.assign({
      sku: 'SKU' + seq, name: 'Tênis Corrida Modelo ' + seq, brand: 'Marca', category: 'Calçados', subcategory: 'Tênis',
      price: 300, costPrice: 100, imageUrl: FOTO, longDescription: 'Descrição real.', aiContext: ctxBase(), source: 'nfe-import',
    }, dados) });
    const tam = [];
    for (const s of sizes) {
      const ps = await prisma.productSize.create({ data: { productId: p.id, size: s.size, barcode: s.barcode, stock: s.stock || 0 } });
      for (const [storeId, qtd] of s.loc || []) await prisma.storeStock.create({ data: { storeId, productSizeId: ps.id, stock: qtd } });
      tam.push(ps);
    }
    if (ns) {
      await prisma.nuvemshopProductMapping.create({ data: { localProductId: p.id, nuvemshopProductId: ns, syncStatus: nsStatus } });
      for (const ps of (variantes === undefined ? tam : variantes(tam))) await prisma.nuvemshopVariantMapping.create({ data: { localInventoryId: ps.id, localProductId: p.id, nuvemshopProductId: ns, nuvemshopVariantId: 'v' + ps.id.slice(0, 6), barcode: ps.barcode } });
    }
    return { p, tam };
  }
  const sig = (pairs) => 'physical-v1|' + pairs.map(([s, q]) => s + ':' + q).sort().join('|');

  const ok = await produto({ ns: 'NS1', aiContext: ctxBase({ nsPhysicalStockVerifiedSig: sig([['40', 2]]) }) });
  const semFoto = await produto({ ns: 'NS2', imageUrl: null, aiContext: ctxBase({ supplierRef: 'REF-PRETO-001', nsPhysicalStockVerifiedSig: sig([['40', 2]]) }) });
  const semDesc = await produto({ ns: 'NS3', longDescription: null, aiContext: ctxBase({ nsPhysicalStockVerifiedSig: sig([['40', 2]]) }) });
  const semDescChute = await produto({ ns: 'NS3B', name: 'Tênis CHUTE Teste', longDescription: null, aiContext: ctxBase({ nsPhysicalStockVerifiedSig: sig([['40', 2]]) }) });
  const semMod = await produto({ ns: 'NS4', aiContext: { color: 'Branco', classification: { tier: 'Performance' }, nsPhysicalStockVerifiedSig: sig([['40', 2]]) } });
  const semFotoSemCor = await produto({ ns: 'NS4B', imageUrl: null, aiContext: { classification: CLASS, nsPhysicalStockVerifiedSig: sig([['40', 2]]) } });
  const naoPublicado = await produto({ imageUrl: null, longDescription: null });
  const oculto = await produto({ ns: 'NS6', nsStatus: 'hidden-invalid', imageUrl: null });
  const curado = await produto({ ns: 'NS700', aiContext: ctxBase({ nsPhysicalStockVerifiedSig: sig([['40', 2]]) }) });
  const fantasma = await produto({ ns: 'NS700', source: 'nuvemshop', imageUrl: null, longDescription: null, subcategory: null, aiContext: {}, sizes: [{ size: '40', barcode: '7899999999990', stock: 1 }], variantes: () => [] });
  const fantasmaMedio = await produto({ ns: 'NS800', source: 'nuvemshop', subcategory: null, aiContext: {}, sizes: [{ size: '40', barcode: ok.tam[0].barcode + '', stock: 1 }], variantes: () => [] });
  // estoque: assinatura velha (publicou 3, físico agora 2) | sem assinatura com variantes ok | sem assinatura e tamanho sem variante
  const div = await produto({ ns: 'NS8', aiContext: ctxBase({ nsPhysicalStockVerifiedSig: sig([['40', 3]]) }), sizes: [{ size: '40', barcode: '7891111111110', stock: 3, loc: [[lojaSite.id, 2], [lojaFora.id, 5]] }] });
  const semSig = await produto({ ns: 'NS9' });
  const semSigFalta = await produto({ ns: 'NS10', sizes: [{ size: '40', barcode: '7892222222220', stock: 2, loc: [[lojaSite.id, 1]] }, { size: '41', barcode: '7892222222221', stock: 2, loc: [[lojaSite2.id, 2]] }], variantes: (t) => [t[0]] });
  // preço
  const abaixo = await produto({ price: 100, costPrice: 120 });
  const zerado = await produto({ price: 0, costPrice: 50 });
  const igual = await produto({ price: 80, costPrice: 80, markupPercent: 100 });
  const igualForn = await produto({ price: 60, costPrice: 60, aiContext: ctxBase({ supplierCnpj: '11.222.333/0001-81' }) });
  const inativoZerado = await produto({ price: 0, costPrice: 50, active: false });
  // markdown
  const parado = await produto({ price: 300, costPrice: 100 });
  const paradoSemCusto = await produto({ price: 200, costPrice: null });
  const paradoApertado = await produto({ price: 140, costPrice: 100 });

  const precosAntes = new Map((await prisma.product.findMany({ select: { id: true, price: true, promoPrice: true } })).map((p) => [p.id, p.price + '|' + p.promoPrice]));

  const todos = registro.carregar().neuronios;
  const N = new Map([...todos].filter(([id]) => MEUS.includes(id)));
  motor.iniciar({ db: prisma, neuronios: N });
  await motor.sincronizar();

  const props = (where = {}) => prisma.aIApproval.findMany({ where: Object.assign({ type: { startsWith: 'rna_' } }, where), orderBy: { createdAt: 'asc' } });
  const acaoDe = (ap) => ap.payload && ap.payload.acao;
  const args = (ap) => (acaoDe(ap) && acaoDe(ap).args) || {};

  // ================= PULSO DIÁRIO =================
  await motor.emitir({ tipo: 'relogio.diario', origem: 's.relogio', forca: 0.8, dados: {} });
  await motor.ocioso(60000);

  const nuvem = await props({ type: 'rna_nuvem' });
  const despublicar = nuvem.filter((a) => acaoDe(a).nome === 'nuvem.despublicar');
  const alvoDesp = new Set(despublicar.map((a) => args(a).productId));

  await t('sem-foto / sem-classificacao: só publicados incompletos viram "despublicar" (com evidência)', () => {
    for (const x of [semFoto, semDesc, semDescChute, semMod, semFotoSemCor, fantasmaMedio]) assert.ok(alvoDesp.has(x.p.id), 'faltou ' + x.p.name);
    for (const x of [ok, naoPublicado, oculto, curado, fantasma, div, semSig]) assert.ok(!alvoDesp.has(x.p.id), 'não devia: ' + x.p.name);
    for (const a of despublicar) { assert.ok(Array.isArray(a.payload.evidencia) && a.payload.evidencia.length); assert.ok(a.payload.rna.caminho.includes('nuvem.correcao')); }
    const m = despublicar.find((a) => args(a).productId === semMod.p.id);
    assert.deepStrictEqual(m.payload.previa.classificacoesFaltando, ['modalidade']);
  });
  await t('card-fantasma não gera "despublicar" (NS# dividido esconderia o curado)', () => {
    assert.ok(!alvoDesp.has(fantasma.p.id) && !alvoDesp.has(curado.p.id));
  });
  await t('ghost FORTE (NS# com 2 mappings, source=nuvemshop + curado) → proposta remover-fantasma', () => {
    const g = nuvem.filter((a) => acaoDe(a).nome === 'nuvem.remover-fantasma');
    assert.strictEqual(g.length, 1);
    assert.deepStrictEqual(args(g[0]), { ghostId: fantasma.p.id, curadoId: curado.p.id, nuvemshopProductId: 'NS700' });
  });
  await t('ghost MÉDIO (código já de outro card) → só conferência manual (rna.registrar)', () => {
    const g = nuvem.find((a) => a.payload.rna.chave === 'nuvem:ghost:' + fantasmaMedio.p.id);
    assert.ok(g); assert.strictEqual(acaoDe(g).nome, 'rna.registrar');
  });
  await t('foto-oficial: busca exata marca + referência + cor; sem cor → dado-faltante, sem proposta', async () => {
    const f = await props({ type: 'rna_foto' });
    const sf = f.find((a) => a.payload.previa.productId === semFoto.p.id);
    assert.ok(sf); assert.strictEqual(sf.payload.previa.busca, '"Marca" "REF-PRETO-001" Preto');
    assert.ok(!f.some((a) => a.payload.previa.productId === semFotoSemCor.p.id));
    const df = await prisma.rnaSinal.findFirst({ where: { tipo: 'dado-faltante', origem: 'conteudo.foto-oficial' } });
    assert.ok(df && df.dados.campos.includes('cor'));
    assert.ok(!f.some((a) => a.payload.previa.productId === fantasma.p.id), 'fantasma não recebe proposta de foto');
  });
  await t('descricao: texto só com dados do card; texto da IA com cor/número inventados é RECUSADO', async () => {
    const d = await props({ type: 'rna_descricao' });
    const boa = d.find((a) => args(a).productId === semDesc.p.id);
    assert.ok(boa); assert.strictEqual(boa.payload.previa.origem, 'ia-barata');
    assert.ok(/Preto/.test(args(boa).texto) && /Corrida/.test(args(boa).texto));
    const chute = d.find((a) => args(a).productId === semDescChute.p.id);
    assert.ok(chute); assert.strictEqual(chute.payload.previa.origem, 'modelo-fixo');
    assert.ok(!/azul|42|gel/i.test(args(chute).texto), args(chute).texto);
    assert.ok(/anti-chute/.test(chute.description));
    assert.ok(!d.some((a) => args(a).productId === semFoto.p.id), 'quem tem descrição não recebe proposta');
  });
  await t('preco.abaixo-custo: preço ≤ custo / zerado em ativo → proposta de REVISÃO (não muda preço)', async () => {
    const pr = await props({ type: 'rna_preco_revisar' });
    const ids = new Set(pr.map((a) => a.payload.previa.productId));
    for (const x of [abaixo, zerado, igual, igualForn]) assert.ok(ids.has(x.p.id), 'faltou ' + x.p.name);
    assert.ok(!ids.has(inativoZerado.p.id) && !ids.has(ok.p.id));
    assert.ok(pr.every((a) => acaoDe(a).nome === 'rna.registrar'));
    const i = pr.find((a) => a.payload.previa.productId === igual.p.id);
    assert.strictEqual(i.payload.previa.precoReferenciaMarkup, 160);
    const f = pr.find((a) => a.payload.previa.productId === igualForn.p.id);
    assert.strictEqual(f.payload.previa.precoReferenciaMarkup, 120);
    assert.ok(/Supplier\.averageMarkup/.test(f.payload.previa.markup.fonte));
    const a = pr.find((x) => x.payload.previa.productId === abaixo.p.id);
    assert.strictEqual(a.payload.previa.precoReferenciaMarkup, null, 'sem markup não calcula referência');
  });
  await t('pulso diário não chamou a Nuvemshop nem mudou preço', async () => {
    assert.strictEqual(chamadas.length, 0, JSON.stringify(chamadas));
    const agora = await prisma.product.findMany({ select: { id: true, price: true, promoPrice: true } });
    for (const p of agora) assert.strictEqual(p.price + '|' + p.promoPrice, precosAntes.get(p.id));
  });

  // ================= PULSO DE HORA (estoque) =================
  await motor.emitir({ tipo: 'relogio.hora', origem: 's.relogio', forca: 0.6, dados: {} });
  await motor.ocioso(60000);
  await t('estoque-divergente: assinatura velha → ressincronizar; loja fora do site não conta', async () => {
    const s = await prisma.rnaSinal.findMany({ where: { tipo: 'nuvem.divergente' } });
    const d = s.find((x) => x.dados.productId === div.p.id);
    assert.ok(d); assert.deepStrictEqual(d.dados.diferencas, [{ tamanho: '40', publicado: 3, fisico: 2, fonte: 'assinatura' }]);
    assert.ok(!s.some((x) => x.dados.productId === ok.p.id), 'estoque igual não diverge');
    const pr = (await props({ type: 'rna_nuvem' })).filter((a) => acaoDe(a).nome === 'nuvem.ressincronizar-estoque');
    assert.ok(pr.some((a) => args(a).productId === div.p.id));
  });
  await t('estoque-divergente: sem estoque publicado gravado → dado-faltante (não afirma divergência)', async () => {
    const df = await prisma.rnaSinal.findFirst({ where: { tipo: 'dado-faltante', origem: 'nuvem.estoque-divergente' } });
    assert.ok(df && df.dados.produtos.includes(semSig.p.id));
    const s = await prisma.rnaSinal.findMany({ where: { tipo: 'nuvem.divergente' } });
    assert.ok(!s.some((x) => x.dados.productId === semSig.p.id), 'sem registro e variantes ok: não é divergência');
    const f = s.find((x) => x.dados.productId === semSigFalta.p.id);
    assert.ok(f && f.dados.dadoFaltante.includes('estoque-publicado'));
    assert.deepStrictEqual(f.dados.diferencas.map((x) => x.tamanho), ['41']);
    assert.strictEqual(chamadas.length, 0);
  });

  // ================= WEBHOOK =================
  await t('webhook de um NS#: só aquele produto é examinado', async () => {
    const antes = await prisma.rnaSinal.count({ where: { tipo: 'nuvem.incompleto' } });
    await motor.emitir({ tipo: 'nuvem.webhook', origem: 's.nuvem', dados: { evento: 'product/updated', nuvemshopProductId: 'NS2' } });
    await motor.ocioso();
    const novos = await prisma.rnaSinal.findMany({ where: { tipo: 'nuvem.incompleto' }, orderBy: { criadoEm: 'desc' }, take: (await prisma.rnaSinal.count({ where: { tipo: 'nuvem.incompleto' } })) - antes });
    assert.ok(novos.length >= 1 && novos.every((x) => x.dados.productId === semFoto.p.id));
    assert.strictEqual(await prisma.aIApproval.count({ where: { type: 'rna_nuvem', payload: { path: ['rna', 'chave'], equals: 'nuvem:despublicar:' + semFoto.p.id } } }), 1, 'dedupe da proposta pendente');
  });

  // ================= DESCONTO > 15% =================
  await t('desconto > 15% sem pricing → seg.bloqueio; ≤ 15% ou validado → passa', async () => {
    await motor.emitir({ tipo: 'preco.desconto-proposto', origem: 's.teste', dados: { productId: ok.p.id, descontoPct: 20 } });
    await motor.emitir({ tipo: 'preco.desconto-proposto', origem: 's.teste', dados: { productId: ok.p.id, precoAtual: 100, precoNovo: 90 } });
    await motor.emitir({ tipo: 'preco.desconto-proposto', origem: 's.teste', dados: { productId: semSig.p.id, desconto: 0.3, validacaoMargem: { agente: 'pricing-margin', ok: true } } });
    await motor.emitir({ tipo: 'preco.desconto-proposto', origem: 's.whatsapp', externo: true, dados: { productId: semDesc.p.id, descontoPct: 40, validacaoMargem: { agente: 'pricing-margin', ok: true } } });
    await motor.ocioso();
    const b = await prisma.rnaSinal.findMany({ where: { tipo: 'seg.bloqueio' } });
    const ids = b.map((x) => x.dados.itens[0].productId).sort();
    assert.deepStrictEqual(ids, [ok.p.id, semDesc.p.id].sort());
    assert.ok(b.find((x) => x.dados.itens[0].productId === semDesc.p.id).dados.motivo.includes('externo'));
  });

  // ================= MARKDOWN =================
  await t('plano-markdown: impacto baixo não acorda a IA forte', async () => {
    const n0 = iaChamadas.filter((x) => /remarca/i.test(x)).length;
    await motor.emitir({ tipo: 'estoque.parado', origem: 's.teste', impactoRS: 100, dados: { produtos: [{ productId: parado.p.id, diasSemVenda: 200, estoque: 5 }] } });
    await motor.ocioso();
    assert.strictEqual(iaChamadas.filter((x) => /remarca/i.test(x)).length, n0);
  });
  await t('plano-markdown: respeita margem e teto de 15%, barra o pedido de 25%, sem custo fica fora, risco ALTO', async () => {
    await motor.emitir({ tipo: 'estoque.parado', origem: 's.teste', impactoRS: 5000, loja: 'LOJA05', dados: { produtos: [
      { productId: parado.p.id, diasSemVenda: 200, estoque: 5 }, { productId: paradoSemCusto.p.id, diasSemVenda: 200 }, { productId: paradoApertado.p.id, diasSemVenda: 200 }] } });
    await motor.ocioso();
    const p = (await props({ type: 'rna_preco' }))[0];
    assert.ok(p, 'sem proposta de markdown');
    assert.strictEqual(p.riskLevel, 'high');
    assert.strictEqual(acaoDe(p).nome, 'rna.registrar');
    const itens = p.payload.previa.itens;
    assert.strictEqual(itens.length, 1); assert.strictEqual(itens[0].productId, parado.p.id);
    assert.strictEqual(itens[0].descontoPct, 15); assert.strictEqual(itens[0].precoProposto, 255);
    assert.ok(itens[0].margemNova >= 0.35);
    const fora = p.payload.previa.fora.map((x) => x.productId).sort();
    assert.deepStrictEqual(fora, [paradoSemCusto.p.id, paradoApertado.p.id].sort());
    const blq = await prisma.rnaSinal.findMany({ where: { tipo: 'seg.bloqueio' } });
    assert.ok(blq.some((x) => x.dados.itens[0].productId === parado.p.id && x.dados.itens[0].descontoPct === 25), 'pedido de 25% devia ser bloqueado');
  });
  await t('nenhum preço mudou e nada foi publicado pela rede', async () => {
    const agora = await prisma.product.findMany({ select: { id: true, price: true, promoPrice: true } });
    for (const p of agora) assert.strictEqual(p.price + '|' + p.promoPrice, precosAntes.get(p.id));
    assert.strictEqual(chamadas.length, 0);
    assert.strictEqual(await prisma.aIApproval.count({ where: { type: { startsWith: 'rna_' }, status: { not: 'pending' } } }), 0);
  });

  // ================= AÇÕES APROVADAS =================
  const aprovar = (id) => prisma.aIApproval.update({ where: { id }, data: { status: 'approved' } });
  const chave = async (c) => prisma.aIApproval.findFirst({ where: { payload: { path: ['rna', 'chave'], equals: c } } });

  await t('ação só roda APROVADA (pendente → 409)', async () => {
    const a = await chave('nuvem:despublicar:' + semFoto.p.id);
    await assert.rejects(() => acoes.executar(a.id, {}, prisma), /APROVADA/);
    assert.strictEqual(chamadas.length, 0);
  });
  await t('despublicar aprovado: PUT published:false + mapping hidden-invalid', async () => {
    const a = await chave('nuvem:despublicar:' + semFoto.p.id);
    await aprovar(a.id);
    const r = await acoes.executar(a.id, { executadoPor: 'teste' }, prisma);
    assert.ok(r.resultado.executado);
    assert.deepStrictEqual(chamadas.map((c) => [c.method, c.path, c.body]), [['PUT', '/products/NS2', { published: false }]]);
    assert.strictEqual((await prisma.nuvemshopProductMapping.findUnique({ where: { localProductId: semFoto.p.id } })).syncStatus, 'hidden-invalid');
    assert.strictEqual((await prisma.aIApproval.findUnique({ where: { id: a.id } })).status, 'executed');
  });
  await t('despublicar revalida: card completado depois da proposta NÃO é despublicado', async () => {
    chamadas.length = 0;
    await prisma.product.update({ where: { id: semMod.p.id }, data: { aiContext: { color: 'Branco', classification: { tier: 'Performance', modality: 'Corrida' } } } });
    const a = await chave('nuvem:despublicar:' + semMod.p.id);
    await aprovar(a.id);
    const r = await acoes.executar(a.id, {}, prisma);
    assert.strictEqual(r.resultado.executado, false); assert.strictEqual(chamadas.length, 0);
  });
  await t('remover-fantasma aprovado: desativa o fantasma, apaga só os mappings dele, curado intacto, sem API', async () => {
    chamadas.length = 0;
    const a = await chave('nuvem:ghost:' + fantasma.p.id);
    await aprovar(a.id);
    const r = await acoes.executar(a.id, {}, prisma);
    assert.ok(r.resultado.executado);
    assert.strictEqual((await prisma.product.findUnique({ where: { id: fantasma.p.id } })).active, false);
    assert.strictEqual(await prisma.nuvemshopProductMapping.count({ where: { localProductId: fantasma.p.id } }), 0);
    const mc = await prisma.nuvemshopProductMapping.findUnique({ where: { localProductId: curado.p.id } });
    assert.strictEqual(mc.nuvemshopProductId, 'NS700');
    assert.strictEqual((await prisma.product.findUnique({ where: { id: curado.p.id } })).active, true);
    assert.strictEqual(chamadas.length, 0);
  });
  await t('ressincronizar aprovado: manda SÓ estoque físico (2, não 7) e não manda preço em variante existente', async () => {
    chamadas.length = 0;
    const vId = 'vx1';
    variantesRemotas.NS8 = [{ id: vId, sku: div.tam[0].barcode, values: [{ pt: '40' }], stock_management: true, stock: 3 }];
    const a = (await props({ type: 'rna_nuvem' })).find((x) => acaoDe(x).nome === 'nuvem.ressincronizar-estoque' && args(x).productId === div.p.id);
    await aprovar(a.id);
    const r = await acoes.executar(a.id, {}, prisma);
    assert.ok(r.resultado.executado, JSON.stringify(r));
    const put = chamadas.find((c) => c.method === 'PUT');
    assert.ok(put, JSON.stringify(chamadas));
    assert.strictEqual(put.path, '/products/NS8/variants/' + vId);
    assert.deepStrictEqual(put.body, { stock_management: true, stock: 2 });
  });
  await t('ressincronizar revalida: produto que saiu do gate não é ressincronizado', async () => {
    chamadas.length = 0;
    await prisma.product.update({ where: { id: semSigFalta.p.id }, data: { imageUrl: null } });
    const a = (await props({ type: 'rna_nuvem' })).find((x) => acaoDe(x).nome === 'nuvem.ressincronizar-estoque' && args(x).productId === semSigFalta.p.id);
    assert.ok(a);
    await aprovar(a.id);
    const r = await acoes.executar(a.id, {}, prisma);
    assert.strictEqual(r.resultado.executado, false); assert.ok(r.resultado.motivos.includes('sem foto valida'));
    assert.strictEqual(chamadas.length, 0);
  });
  await t('aplicar-descricao aprovado grava; se o card já tiver descrição, não sobrescreve', async () => {
    const a = (await props({ type: 'rna_descricao' })).find((x) => args(x).productId === semDesc.p.id);
    await aprovar(a.id);
    await acoes.executar(a.id, {}, prisma);
    assert.strictEqual((await prisma.product.findUnique({ where: { id: semDesc.p.id } })).longDescription, args(a).texto);
    await prisma.product.update({ where: { id: semDescChute.p.id }, data: { shortDescription: 'escrita pelo dono' } });
    const b = (await props({ type: 'rna_descricao' })).find((x) => args(x).productId === semDescChute.p.id);
    await aprovar(b.id);
    const r = await acoes.executar(b.id, {}, prisma);
    assert.strictEqual(r.resultado.executado, false);
    assert.strictEqual((await prisma.product.findUnique({ where: { id: semDescChute.p.id } })).longDescription, null);
  });
  await t('revisão de preço aprovada só registra: preço continua igual', async () => {
    const a = (await props({ type: 'rna_preco_revisar' })).find((x) => x.payload.previa.productId === abaixo.p.id);
    await aprovar(a.id);
    const r = await acoes.executar(a.id, {}, prisma);
    assert.strictEqual(r.acao, 'rna.registrar');
    assert.strictEqual((await prisma.product.findUnique({ where: { id: abaixo.p.id } })).price, 100);
    const m = (await props({ type: 'rna_preco' }))[0];
    await aprovar(m.id);
    await acoes.executar(m.id, {}, prisma);
    assert.strictEqual((await prisma.product.findUnique({ where: { id: parado.p.id } })).price, 300);
  });
  await t('nenhum ProductSize.stock (comprado) nem StoreStock foi alterado', async () => {
    const tam = await prisma.productSize.findMany({ select: { barcode: true, stock: true } });
    assert.strictEqual(tam.find((x) => x.barcode === div.tam[0].barcode).stock, 3);
    const ss = await prisma.storeStock.aggregate({ _sum: { stock: true } });
    assert.ok(ss._sum.stock > 0);
  });

  await limpar();
  await prisma.$disconnect();
}

(async () => {
  console.log('A) contrato (sem banco)');
  await partA();
  if (process.env.RNA_TEST_DATABASE_URL) { console.log('B) neurônios Nuvemshop/Conteúdo/Preço no banco de TESTE'); await partB(); }
  else out.push('  (parte B pulada: defina RNA_TEST_DATABASE_URL com banco DESCARTÁVEL)');
  console.log(out.join('\n'));
  console.log((process.exitCode ? 'FALHOU' : 'OK') + ' — ' + pass + ' testes passaram');
  process.exit(process.exitCode || 0);
})().catch((e) => { console.error(e); process.exit(1); });
