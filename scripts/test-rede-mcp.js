// =====================================================================
// Teste do SERVIDOR MCP do TenisCash (src/ai/rede/mcp/servidor.js).
//   node scripts/test-rede-mcp.js
// Cria um banco DESCARTÁVEL (padrão: Postgres local :55432, banco rede_mcp,
// recriado do zero), sobe um Express em porta aleatória com mount(app) e
// conversa com ele pelo CLIENTE OFICIAL do SDK (Streamable HTTP).
// Override: MCP_TEST_DATABASE_URL=postgres://…  (⚠ será APAGADO/RECRIADO).
// PSQL: caminho do psql.exe (padrão PostgreSQL 16 no Windows).
// =====================================================================
'use strict';
const { execSync } = require('child_process');
const path = require('path');
const assert = require('assert');

const PSQL = process.env.PSQL || 'C:/Program Files/PostgreSQL/16/bin/psql.exe';
const DB_URL = process.env.MCP_TEST_DATABASE_URL || 'postgresql://postgres@localhost:55432/rede_mcp';
if (!/localhost|127\.0\.0\.1/.test(DB_URL) || !/rede_mcp|test|teste/.test(DB_URL)) {
  console.error('Recuso rodar: o banco de teste tem que ser local e descartável (nome com rede_mcp/test).');
  process.exit(2);
}
process.env.DATABASE_URL = DB_URL;
process.env.JWT_SECRET = 'segredo-de-teste-mcp-' + Date.now();
process.env.RNA_RELOGIO = '0';
process.env.RNA_ORCAMENTO_DIA_RS = '5';
delete process.env.RNA_ATIVA;

const ROOT = path.join(__dirname, '..');
function prepararBanco() {
  const u = new URL(DB_URL);
  const nome = u.pathname.slice(1);
  const base = ['-h', u.hostname, '-p', u.port || '5432', '-U', decodeURIComponent(u.username || 'postgres')];
  const q = (sql) => execSync(`"${PSQL}" ${base.join(' ')} -d postgres -v ON_ERROR_STOP=1 -c "${sql}"`, { stdio: 'pipe' });
  q(`DROP DATABASE IF EXISTS ${nome} WITH (FORCE)`);
  q(`CREATE DATABASE ${nome}`);
  execSync('npx prisma db push --skip-generate --accept-data-loss', { cwd: ROOT, stdio: 'pipe', env: Object.assign({}, process.env, { DATABASE_URL: DB_URL }) });
}

let pass = 0; const out = [];
async function t(nome, fn) {
  if (process.env.MCP_TEST_VERBOSE) console.log('… ' + nome);
  try { await fn(); pass++; out.push('  ✓ ' + nome); } catch (e) { out.push('  ✗ ' + nome + '\n      ' + (e && e.stack ? e.stack.split('\n').slice(0, 4).join('\n      ') : e)); process.exitCode = 1; }
}

const CPF = '123.456.789-09';
const FONE = '(83) 99671-3153';
const EMAIL = 'cliente.secreto@example.com';
const VAZAMENTOS = [CPF, '12345678909', '99671-3153', '996713153', '83996713153', EMAIL];
const textos = []; // tudo que o servidor devolveu (prova de não vazamento)

async function main() {
  console.log('Preparando banco descartável…');
  if (!process.env.MCP_TEST_PULAR_BANCO) prepararBanco();

  const jwt = require('jsonwebtoken');
  const express = require('express');
  const compression = require('compression');
  const { prisma } = require('../src/middleware');
  const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
  const { StreamableHTTPClientTransport } = require('@modelcontextprotocol/sdk/client/streamableHttp.js');
  const { ElicitRequestSchema } = require('@modelcontextprotocol/sdk/types.js');
  const mcp = require('../src/ai/rede/mcp/servidor');
  const motor = require('../src/ai/rede/motor');
  const ia = require('../src/ai/rede/ia');

  // ---------------- semente ----------------
  const LOJA04_ID = '01b5a498-4dce-49b9-b359-5b031936aae9'; // loja que vale pro site
  const [l02, l04, l05] = await Promise.all([
    prisma.store.create({ data: { name: 'Sports & Tennis Bessa', code: 'LOJA02' } }),
    prisma.store.create({ data: { id: LOJA04_ID, name: 'Sports & Tennis Ecommerce', code: 'LOJA04' } }),
    prisma.store.create({ data: { name: 'Sports & Tennis Tambaú', code: 'LOJA05' } }),
  ]);
  const mkUser = (d) => prisma.user.create({ data: Object.assign({ pin: 'x', active: true }, d) });
  const admin = await mkUser({ name: 'Dono Teste', phone: '83900000001', role: 'admin', email: 'dono@example.com' });
  const admin2 = await mkUser({ name: 'Gerente Teste', phone: '83900000002', role: 'manager' });
  const vendedor = await mkUser({ name: 'Vendedor Teste', phone: '83900000003', role: 'seller', storeId: l02.id });
  const inativo = await mkUser({ name: 'Admin Inativo', phone: '83900000004', role: 'admin', active: false });
  const atleta = await mkUser({ name: 'Atleta Exemplo', phone: '83996713153', cpf: '12345678909', email: EMAIL, role: 'user', username: 'atletax' });
  await prisma.badgeEarned.create({ data: { userId: atleta.id, badgeKey: '5k_club' } });

  const prod = await prisma.product.create({ data: {
    sku: 'CK09090001', name: 'Tênis Converse Chuck Taylor Side Zip', brand: 'Converse', category: 'Calçados', subcategory: 'Tênis',
    price: 399.9, costPrice: 180, imageUrl: 'https://cdn.example.com/ck.jpg', longDescription: 'Tênis clássico de lona.',
    aiContext: { color: 'Azul Escuro/Laranja/Branco', classification: { modality: 'Casual', tier: 'Lifestyle' }, confirmedForNuvemshop: true },
    sizes: { create: [
      { size: '38', stock: 3, barcode: '7908341493884', sizeConfirmedAt: new Date() },
      { size: '39', stock: 2, barcode: '7908341493891', sizeConfirmedAt: new Date() },
    ] },
  }, include: { sizes: true } });
  const [s38, s39] = prod.sizes.sort((a, b) => a.size.localeCompare(b.size));
  await prisma.storeStock.createMany({ data: [
    { storeId: l02.id, productSizeId: s38.id, stock: 1 },
    { storeId: l04.id, productSizeId: s38.id, stock: 1 },
    { storeId: l05.id, productSizeId: s39.id, stock: 3 }, // localizado > comprado → alerta
  ] });
  const prodRuim = await prisma.product.create({ data: {
    sku: 'REF-SEM-FOTO', name: 'Camiseta Treino Dry', brand: 'Kappa', category: 'Roupas', subcategory: 'Camisetas',
    price: 0, aiContext: {}, sizes: { create: [{ size: 'M', stock: 4, barcode: 'SEM GTIN' }] },
  } });

  const docE = await prisma.xmlFiscalDocument.create({ data: {
    accessKey: '25261012345678000190550010000123451000123456', number: '12345', series: '1', issuerCnpj: '12345678000190', issuerName: 'Fornecedor Exemplo LTDA',
    recipientCnpj: '44052617000207', recipientName: 'Meta Esportes Bessa', totalValue: 999.5, docType: 'entrada',
    items: { create: [
      { description: 'TENIS CHUCK SIDE ZIP 38', ean: '7908341493884', quantity: 3, cfop: '6102', productId: prod.id, supplierCode: 'CK0909000138' },
      { description: 'TENIS ORFAO 40', ean: '7890000000017', quantity: 2, cfop: '6102' },
      { description: 'MEIA SEM CODIGO', ean: 'SEM GTIN', quantity: 5, cfop: '6102' },
    ] },
  } });
  await prisma.xmlFiscalDocument.create({ data: {
    accessKey: '25261044052617000126550020000000011000000019', number: '1', series: '2', issuerCnpj: '44052617000126', issuerName: 'Meta Esportes Matriz',
    recipientCnpj: '44052617000550', recipientName: 'Meta Esportes Tambaú', totalValue: 100, docType: 'entrada', // errado de propósito
    items: { create: [{ description: 'TENIS TRANSFERIDO 41', ean: '7890000000024', quantity: 1, cfop: '5152' }] },
  } });

  const agora = new Date();
  await prisma.sale.create({ data: { sellerId: vendedor.id, storeId: l02.id, totalAmount: 399.9, discount: 0, status: 'completed', createdAt: agora,
    items: { create: [{ productId: prod.id, productSizeId: s38.id, productName: prod.name, brand: 'Converse', size: '38', quantity: 1, unitPrice: 399.9, totalPrice: 399.9 }] } } });
  await prisma.sale.create({ data: { sellerId: vendedor.id, storeId: l02.id, totalAmount: 200, status: 'completed', createdAt: agora,
    items: { create: [{ productName: 'Meia', brand: 'Lupo', quantity: 2, unitPrice: 100, totalPrice: 200 }] } } });
  await prisma.sale.create({ data: { sellerId: vendedor.id, storeId: l05.id, totalAmount: 50, status: 'cancelled', createdAt: agora } });

  const caminho = ['s.teste', 'teste.detector', 'teste.propositor'];
  const novaProposta = (titulo) => prisma.aIApproval.create({ data: {
    type: 'rna_reposicao', title: titulo, riskLevel: 'medium', status: 'pending',
    description: `Cliente ${CPF} pediu pelo WhatsApp ${FONE} (${EMAIL}).`,
    payload: { rna: { neuronio: 'teste.propositor', traceId: 'tr_semente', caminho }, acao: { nome: 'rna.registrar' }, previa: 'Repor 2 pares do 38 no Bessa', evidencia: ['NF-e 12345 item 1'] },
  } });
  const p1 = await novaProposta('Repor Chuck 38 no Bessa');
  const p2 = await novaProposta('Repor Chuck 39 na Tambaú');
  await prisma.aIApproval.create({ data: { type: 'discount', title: 'Não é da rede', status: 'pending' } });
  await prisma.rnaNeuronio.createMany({ data: [{ id: 'teste.detector', camada: 'detector', limiar: 0 }, { id: 'teste.propositor', camada: 'analista', limiar: 0.3 }] });

  // Rede de teste: 1 mini agente (regra) que escuta a pergunta do dono e propõe.
  const neuronios = new Map([['teste.responde', {
    id: 'teste.responde', camada: 'analista', missao: 'responde pergunta do dono no teste', escuta: ['dono.pergunta'], emite: ['proposta.teste'],
    custo: { tipo: 'regra' }, permissao: 'propor', limiar: 0, tempoMax: 3000, regras: [],
    disparar: async (ctx) => [{ tipo: 'proposta.teste', dados: { titulo: 'Resposta: ' + ctx.sinal.dados.texto.slice(0, 40), evidencia: ['pergunta do dono'], chave: 'k-' + ctx.sinal.id } }],
  }]]);
  motor.iniciar({ db: prisma, neuronios });
  await motor.sincronizar();
  ia.setCallAI(async () => ({ ok: true, json: { kpis: [{ nome: 'giro', meta: '+20%' }], regiao: ['estoque.*'], restricoes: ['nunca inventar dado'], loja: 'LOJA02', prazoDias: 30, orcamentoRS: 30, duvidas: [] }, cost: { brl: 0.02 } }));

  // ---------------- servidor ----------------
  const app = express();
  app.use(compression({ threshold: 1024 })); // igual ao index.js (não pode travar o SSE)
  app.use(express.json({ limit: '1.5mb' }));
  const montado = mcp.mount(app, { db: prisma });
  const appSemEstado = express(); appSemEstado.use(express.json());
  const montadoSE = mcp.mount(appSemEstado, { db: prisma, sessoes: false });
  const srv = app.listen(0); const srvSE = appSemEstado.listen(0);
  const ouvindo = (s) => (s.listening ? Promise.resolve() : new Promise((r) => s.once('listening', r)));
  await ouvindo(srv); await ouvindo(srvSE);
  const URL_MCP = `http://127.0.0.1:${srv.address().port}/mcp`;
  const URL_SE = `http://127.0.0.1:${srvSE.address().port}/mcp`;
  const token = (u) => jwt.sign({ userId: u.id }, process.env.JWT_SECRET, { expiresIn: '1h' });

  async function conectar(url, u, caps) {
    const c = new Client({ name: 'teste-mcp', version: '1.0.0' }, { capabilities: caps || {} });
    const tr = new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers: { Authorization: 'Bearer ' + token(u) } } });
    await c.connect(tr);
    return { c, tr };
  }
  async function chamar(c, name, args) {
    const r = await c.callTool({ name, arguments: args || {} });
    const txt = r.content.map((x) => x.text).join('');
    textos.push(txt);
    return { erro: !!r.isError, j: JSON.parse(txt.replace(/…\[cortado.*$/, '')) };
  }
  const rawPost = (url, headers, body) => fetch(url, { method: 'POST', headers: Object.assign({ 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' }, headers), body: JSON.stringify(body) });
  const INIT = { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'x', version: '1' } } };

  // ---------------- autenticação ----------------
  await t('sem token → 401 (com WWW-Authenticate); token só na URL (?token=) também → 401', async () => {
    const r = await rawPost(URL_MCP, {}, INIT);
    assert.strictEqual(r.status, 401); assert.ok(r.headers.get('www-authenticate'));
    const b = await r.json(); assert.ok(/Authorization: Bearer/.test(b.error.message));
    const r2 = await rawPost(URL_MCP + '?token=' + token(admin), {}, INIT);
    assert.strictEqual(r2.status, 401);
  });
  await t('token inválido / assinado com outro segredo → 401', async () => {
    assert.strictEqual((await rawPost(URL_MCP, { Authorization: 'Bearer abc.def.ghi' }, INIT)).status, 401);
    const falso = jwt.sign({ userId: admin.id }, 'outro-segredo');
    assert.strictEqual((await rawPost(URL_MCP, { Authorization: 'Bearer ' + falso }, INIT)).status, 401);
  });
  await t('usuário comum (vendedor) → 403; admin inativo → 401', async () => {
    assert.strictEqual((await rawPost(URL_MCP, { Authorization: 'Bearer ' + token(vendedor) }, INIT)).status, 403);
    assert.strictEqual((await rawPost(URL_MCP, { Authorization: 'Bearer ' + token(atleta) }, INIT)).status, 403);
    assert.strictEqual((await rawPost(URL_MCP, { Authorization: 'Bearer ' + token(inativo) }, INIT)).status, 401);
  });
  await t('GET/DELETE /mcp sem token → 401', async () => {
    assert.strictEqual((await fetch(URL_MCP)).status, 401);
    assert.strictEqual((await fetch(URL_MCP, { method: 'DELETE' })).status, 401);
  });

  // ---------------- conexão + catálogo ----------------
  const { c, tr } = await conectar(URL_MCP, admin);
  const LEIT = ['estoque_por_codigo', 'estoque_por_produto', 'vendas_do_dia', 'nfe_por_chave', 'produto_nuvemshop_status', 'propostas_pendentes', 'rastro_da_rede', 'painel_da_rede', 'medalhas_do_atleta'];
  await t('cliente oficial conecta com sessão; lista 12 ferramentas com annotations corretas', async () => {
    assert.ok(tr.sessionId, 'sessão criada'); assert.strictEqual(montado.sessoes.size, 1);
    const { tools } = await c.listTools();
    const nomes = tools.map((x) => x.name).sort();
    assert.deepStrictEqual(nomes, [...LEIT, 'perguntar_a_rede', 'criar_objetivo_rascunho', 'decidir_proposta'].sort());
    const by = Object.fromEntries(tools.map((x) => [x.name, x]));
    for (const n of LEIT) { assert.strictEqual(by[n].annotations.readOnlyHint, true, n); assert.strictEqual(by[n].annotations.destructiveHint, false, n); assert.ok(by[n].description.length > 60, n); }
    assert.strictEqual(by.decidir_proposta.annotations.destructiveHint, true);
    assert.strictEqual(by.decidir_proposta.annotations.readOnlyHint, false);
    assert.strictEqual(by.perguntar_a_rede.annotations.readOnlyHint, false);
    assert.strictEqual(by.perguntar_a_rede.annotations.destructiveHint, false);
    assert.ok(/confirmar=true/.test(by.decidir_proposta.description));
    assert.ok(!nomes.some((n) => /preco|whatsapp|publicar|enviar/.test(n)), 'nenhuma ferramenta de preço/WhatsApp/publicação');
  });
  await t('sessão presa ao usuário: outro admin com o mesmo Mcp-Session-Id → 403', async () => {
    const r = await rawPost(URL_MCP, { Authorization: 'Bearer ' + token(admin2), 'mcp-session-id': tr.sessionId, 'mcp-protocol-version': '2025-06-18' }, { jsonrpc: '2.0', id: 9, method: 'tools/list' });
    assert.strictEqual(r.status, 403);
  });

  // ---------------- leituras ----------------
  await t('estoque_por_codigo: produto, tamanho, comprado, localizado por loja e alerta', async () => {
    const { erro, j } = await chamar(c, 'estoque_por_codigo', { codigo: '7908341493884' });
    assert.ok(!erro); const r = j.resultados[0];
    assert.strictEqual(r.produto.ref, 'CK09090001'); assert.strictEqual(r.tamanho, '38'); assert.strictEqual(r.comprado, 3);
    assert.deepStrictEqual(r.localizado, { LOJA02: 1, LOJA04: 1 }); assert.strictEqual(r.faltaLocalizar, 1);
    assert.strictEqual(j.nfe.entrada.qtd, 3);
    const k39 = (await chamar(c, 'estoque_por_codigo', { codigo: '7908341493891' })).j.resultados[0];
    assert.ok(/conferir na loja/.test(k39.alerta));
  });
  await t('estoque_por_codigo: "SEM GTIN" recusado; código só em NF-e explica sem inventar', async () => {
    const a = await chamar(c, 'estoque_por_codigo', { codigo: 'SEM GTIN' });
    assert.ok(a.erro && a.j.proximoPasso);
    const b = await chamar(c, 'estoque_por_codigo', { codigo: '7890000000017' });
    assert.strictEqual(b.j.encontrado, false); assert.ok(/ENTRADA/.test(b.j.explicacao));
    const tr2 = await chamar(c, 'estoque_por_codigo', { codigo: '7890000000024' });
    assert.ok(/TRANSFER/.test(tr2.j.explicacao));
  });
  await t('estoque_por_produto: por referência e por nome; SEM GTIN não aparece como código', async () => {
    const a = await chamar(c, 'estoque_por_produto', { busca: 'CK09090001' });
    assert.strictEqual(a.j.produtos[0].totalComprado, 5); assert.strictEqual(a.j.produtos[0].tamanhos.length, 2);
    assert.strictEqual(a.j.produtos[0].cor, 'Azul Escuro/Laranja/Branco');
    const b = await chamar(c, 'estoque_por_produto', { busca: 'chuck side' });
    assert.strictEqual(b.j.produtos[0].ref, 'CK09090001');
    const d = await chamar(c, 'estoque_por_produto', { busca: 'camiseta treino' });
    assert.strictEqual(d.j.produtos[0].tamanhos[0].codigo, null);
    const e = await chamar(c, 'estoque_por_produto', { busca: 'nao-existe-xyz' });
    assert.ok(e.erro && /incluirInativos/.test(e.j.proximoPasso));
  });
  await t('vendas_do_dia: só concluídas, por loja, ticket e canceladas à parte (Fortaleza)', async () => {
    const { j } = await chamar(c, 'vendas_do_dia', {});
    assert.strictEqual(j.fuso, 'America/Fortaleza'); assert.strictEqual(j.totalRS, 599.9); assert.strictEqual(j.vendas, 2);
    const b = j.porLoja.find((x) => x.loja === 'LOJA02'); assert.strictEqual(b.pecas, 3); assert.strictEqual(b.ticketMedioRS, 299.95);
    assert.deepStrictEqual(j.naoConcluidas.map((x) => x.status), ['cancelled']);
    const f = await chamar(c, 'vendas_do_dia', { loja: 'Tambaú' }); assert.strictEqual(f.j.vendas, 0);
    const z = await chamar(c, 'vendas_do_dia', { data: '17/11/2026' }); assert.ok(z.erro && /AAAA-MM-DD/.test(z.j.erro));
    const ontem = await chamar(c, 'vendas_do_dia', { data: '2020-01-01' }); assert.strictEqual(ontem.j.vendas, 0);
  });
  await t('nfe_por_chave: entrada com loja pelo CNPJ; transferência gravada errada é sinalizada', async () => {
    const a = await chamar(c, 'nfe_por_chave', { chave: docE.accessKey });
    assert.strictEqual(a.j.loja, 'LOJA02'); assert.strictEqual(a.j.contaComoCompra, true); assert.strictEqual(a.j.tipoPelaRegra, 'entrada');
    assert.strictEqual(a.j.itens.linhas, 3); assert.strictEqual(a.j.itens.semGtin, 1); assert.strictEqual(a.j.itens.vinculados, 1);
    assert.strictEqual(a.j.cnpjEmitente, '12345678000190', 'CNPJ de empresa não é mascarado');
    const b = await chamar(c, 'nfe_por_chave', { chave: '2526 1044 0526 1700 0126 5500 2000 0000 0110 0000 0019' });
    assert.strictEqual(b.j.tipoPelaRegra, 'transferencia'); assert.ok(b.j.divergente); assert.strictEqual(b.j.loja, 'LOJA05');
    const cx = await chamar(c, 'nfe_por_chave', { chave: '9'.repeat(44) }); assert.ok(cx.erro && /disco/.test(cx.j.proximoPasso));
  });
  await t('produto_nuvemshop_status: a trava real do site explica sim/não', async () => {
    const a = await chamar(c, 'produto_nuvemshop_status', { produto: 'CK09090001' });
    assert.strictEqual(a.j.podeSubir, true, JSON.stringify(a.j.motivosQueBarram));
    assert.deepStrictEqual(a.j.checagem.tamanhosComEstoqueFisicoSite, [{ tam: '38', fisico: 1 }]);
    const b = await chamar(c, 'produto_nuvemshop_status', { produto: prodRuim.id });
    assert.strictEqual(b.j.podeSubir, false);
    for (const m of ['sem foto valida', 'sem descricao', 'preco de venda zerado', 'modalidade ausente ou indefinida']) assert.ok(b.j.motivosQueBarram.includes(m), m);
    const p3 = await chamar(c, 'produto_nuvemshop_status', { produto: '7908341493891' }); assert.strictEqual(p3.j.ref, 'CK09090001');
  });
  await t('propostas_pendentes: só da rede (rna_), com prévia/evidência', async () => {
    const { j } = await chamar(c, 'propostas_pendentes', {});
    assert.strictEqual(j.total, 2); assert.ok(j.propostas.every((p) => p.tipo.startsWith('rna_')));
    assert.strictEqual(j.propostas[0].evidencia[0], 'NF-e 12345 item 1');
  });
  await t('medalhas_do_atleta: badges públicas, sem CPF/telefone; @ inexistente orienta', async () => {
    const { j } = await chamar(c, 'medalhas_do_atleta', { handle: '@atletax' });
    assert.strictEqual(j.atleta.handle, '@atletax'); assert.strictEqual(j.conquistas[0].badge, '5k_club');
    const e = await chamar(c, 'medalhas_do_atleta', { handle: 'ninguem' }); assert.ok(e.erro);
  });

  // ---------------- propor ----------------
  let traceId;
  await t('perguntar_a_rede: emite dono.pergunta, devolve traceId; rastro_da_rede mostra sinal→ativação→proposta', async () => {
    const { j } = await chamar(c, 'perguntar_a_rede', { pergunta: 'Quanto tem de Chuck 38 no Bessa?', loja: 'loja02' });
    traceId = j.traceId; assert.ok(/^tr_/.test(traceId));
    await motor.ocioso(10000);
    const r = await chamar(c, 'rastro_da_rede', { traceId });
    assert.strictEqual(r.j.sinais[0].tipo, 'dono.pergunta'); assert.strictEqual(r.j.sinais[0].loja, 'LOJA02');
    assert.strictEqual(r.j.ativacoes[0].neuronio, 'teste.responde'); assert.strictEqual(r.j.ativacoes[0].status, 'ok');
    assert.strictEqual(r.j.propostas.length, 1);
    const sinal = await prisma.rnaSinal.findFirst({ where: { traceId } }); assert.strictEqual(sinal.dados.userId, admin.id);
    const x = await chamar(c, 'rastro_da_rede', { traceId: 'tr_inexistente' }); assert.ok(x.erro && x.j.proximoPasso);
  });
  await t('painel_da_rede: ligada, pendentes, neurônios e gasto', async () => {
    const { j } = await chamar(c, 'painel_da_rede', {});
    assert.strictEqual(j.ativa, true); assert.strictEqual(j.propostasPendentes, 3); assert.ok(j.neuronios.total >= 3);
    assert.strictEqual(j.neuronios.carregadosNoCodigo, 1);
  });
  await t('criar_objetivo_rascunho: compila e NÃO cria/ativa objetivo', async () => {
    const antes = await prisma.rnaObjetivo.count();
    const { j } = await chamar(c, 'criar_objetivo_rascunho', { texto: 'Girar o estoque parado de Converse no Bessa em 30 dias' });
    assert.strictEqual(j.ativado, false); assert.deepStrictEqual(j.rascunho.regiao, ['estoque.*']);
    assert.strictEqual(await prisma.rnaObjetivo.count(), antes);
  });

  // ---------------- decidir ----------------
  await t('decidir_proposta SEM confirmação não decide (cliente sem elicitation)', async () => {
    const { j } = await chamar(c, 'decidir_proposta', { propostaId: p1.id, decisao: 'approved' });
    assert.strictEqual(j.decidido, false); assert.strictEqual(j.aguardandoConfirmacao, true); assert.ok(/confirmar=true/.test(j.proximoPasso));
    assert.strictEqual((await prisma.aIApproval.findUnique({ where: { id: p1.id } })).status, 'pending');
  });
  await t('decidir_proposta: correção sem nota é recusada; proposta não-rede é recusada', async () => {
    const a = await chamar(c, 'decidir_proposta', { propostaId: p1.id, decisao: 'correction_requested', confirmar: true });
    assert.ok(a.erro && /nota/.test(a.j.erro));
    const naoRede = await prisma.aIApproval.findFirst({ where: { type: 'discount' } });
    const b = await chamar(c, 'decidir_proposta', { propostaId: naoRede.id, decisao: 'approved', confirmar: true });
    assert.ok(b.erro); assert.strictEqual((await prisma.aIApproval.findUnique({ where: { id: naoRede.id } })).status, 'pending');
  });
  await t('decidir_proposta com confirmar=true decide, grava quem e chama aprendizado.aoDecidir', async () => {
    const { j } = await chamar(c, 'decidir_proposta', { propostaId: p1.id, decisao: 'approved', nota: 'pode repor', confirmar: true });
    assert.strictEqual(j.decidido, true); assert.strictEqual(j.confirmadoPor, 'confirmar=true'); assert.ok(j.ajustesDeAprendizado >= 1);
    const ap = await prisma.aIApproval.findUnique({ where: { id: p1.id } });
    assert.strictEqual(ap.status, 'approved'); assert.strictEqual(ap.approvedById, admin.id); assert.ok(/via MCP/.test(ap.decisionNote));
    assert.ok(await prisma.rnaAjustePeso.count({ where: { aprovacaoId: p1.id } }) >= 1);
    const de2 = await chamar(c, 'decidir_proposta', { propostaId: p1.id, decisao: 'rejected', confirmar: true });
    assert.ok(de2.erro && /já decidida/.test(de2.j.erro));
  });

  const respostaElicit = { valor: { action: 'decline' } };
  const pedidos = [];
  const e = await conectar(URL_MCP, admin2, { elicitation: {} });
  e.c.setRequestHandler(ElicitRequestSchema, async (req) => { pedidos.push(req.params); return respostaElicit.valor; });
  await t('ELICITATION: dono recusa na tela → não decide, mesmo com confirmar=true', async () => {
    const { j } = await chamar(e.c, 'decidir_proposta', { propostaId: p2.id, decisao: 'rejected', confirmar: true });
    assert.strictEqual(j.decidido, false); assert.strictEqual(pedidos.length, 1); assert.ok(/REJEITAR/.test(pedidos[0].message));
    assert.strictEqual((await prisma.aIApproval.findUnique({ where: { id: p2.id } })).status, 'pending');
  });
  await t('ELICITATION: aceita mas sem marcar "confirmo" → não decide', async () => {
    respostaElicit.valor = { action: 'accept', content: { confirmo: false } };
    const { j } = await chamar(e.c, 'decidir_proposta', { propostaId: p2.id, decisao: 'rejected' });
    assert.strictEqual(j.decidido, false);
  });
  await t('ELICITATION: dono confirma na tela → decide (sem precisar de confirmar=true)', async () => {
    respostaElicit.valor = { action: 'accept', content: { confirmo: true } };
    const { j } = await chamar(e.c, 'decidir_proposta', { propostaId: p2.id, decisao: 'rejected', nota: 'não precisa' });
    assert.strictEqual(j.decidido, true); assert.strictEqual(j.confirmadoPor, 'elicitation');
    const ap = await prisma.aIApproval.findUnique({ where: { id: p2.id } });
    assert.strictEqual(ap.status, 'rejected'); assert.strictEqual(ap.approvedById, admin2.id);
  });

  // ---------------- sem estado ----------------
  await t('modo sem estado (MCP_SESSOES=0): cliente oficial conecta e chama; GET → 405', async () => {
    const s = await conectar(URL_SE, admin);
    assert.ok(!s.tr.sessionId, 'sem sessão'); assert.strictEqual(montadoSE.sessoes.size, 0);
    const { j } = await chamar(s.c, 'estoque_por_codigo', { codigo: '7908341493884' }); assert.strictEqual(j.resultados[0].comprado, 3);
    const d = await chamar(s.c, 'decidir_proposta', { propostaId: (await novaProposta('Outra')).id, decisao: 'approved' });
    assert.strictEqual(d.j.aguardandoConfirmacao, true, 'sem elicitation possível → exige confirmar=true');
    assert.strictEqual((await fetch(URL_SE, { headers: { Authorization: 'Bearer ' + token(admin), Accept: 'text/event-stream' } })).status, 405);
    await s.c.close();
  });
  await t('sessão desconhecida (servidor reiniciou) → atende sem estado em vez de quebrar', async () => {
    const r = await rawPost(URL_MCP, { Authorization: 'Bearer ' + token(admin), 'mcp-session-id': 'sessao-que-morreu', 'mcp-protocol-version': '2025-06-18' }, { jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'estoque_por_codigo', arguments: { codigo: '7908341493884' } } });
    assert.strictEqual(r.status, 200);
    const b = await r.json(); textos.push(b.result.content[0].text);
    assert.strictEqual(JSON.parse(b.result.content[0].text).resultados[0].tamanho, '38');
  });

  // ---------------- PII ----------------
  await t('nenhuma resposta vaza CPF, telefone ou e-mail (propostas têm PII na descrição)', async () => {
    const tudo = textos.join('\n');
    assert.ok(textos.length >= 30, 'respostas coletadas: ' + textos.length);
    for (const v of VAZAMENTOS) assert.ok(!tudo.includes(v), 'vazou ' + v);
    assert.ok(/\[cpf\]/.test(tudo) && /\[telefone\]/.test(tudo) && /\[email\]/.test(tudo), 'mascaramento aplicado');
  });

  await e.c.close(); await c.close();
  await montado.fechar(); await montadoSE.fechar();
  srv.close(); srvSE.close();
  await motor.ocioso(5000).catch(() => {});
  await prisma.$disconnect();
}

main()
  .catch((e) => { out.push('  ✗ falha geral: ' + (e && e.stack || e)); process.exitCode = 1; })
  .finally(() => {
    console.log('\nServidor MCP do TenisCash');
    console.log(out.join('\n'));
    console.log(`\n${pass} ok${process.exitCode ? ' — HÁ FALHAS' : ' — tudo verde'}`);
    setTimeout(() => process.exit(process.exitCode || 0), 200);
  });
