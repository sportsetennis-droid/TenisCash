// =====================================================================
// Testes dos GANCHOS da rede (os pontos onde o sistema real avisa a rede).
//   RNA_TEST_DATABASE_URL=postgres://…/rede_ganchos node scripts/test-rede-ganchos.js
// ⚠ Escreve no banco informado: use SÓ banco DESCARTÁVEL.
// Prova: antes de iniciar a rede nada é emitido; depois cada gancho vira o
// sinal certo; telefone vai como hash; fim de categoria só com 0 jogos pendentes.
// =====================================================================
if (!process.env.RNA_TEST_DATABASE_URL) { console.log('defina RNA_TEST_DATABASE_URL (banco descartável)'); process.exit(0); }
process.env.DATABASE_URL = process.env.RNA_TEST_DATABASE_URL;
process.env.RNA_RELOGIO = '0';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'teste';
const assert = require('assert');
const { prisma } = require('../src/middleware');
const ganchos = require('../src/ai/rede/ganchos');
const rede = require('../src/ai/rede');

let pass = 0; const out = [];
async function t(nome, fn) {
  try { await fn(); pass++; out.push('  ✓ ' + nome); } catch (e) { out.push('  ✗ ' + nome + '\n      ' + (e && e.stack ? e.stack.split('\n').slice(0, 3).join('\n      ') : e)); process.exitCode = 1; }
}
const espera = (ms) => new Promise((r) => setTimeout(r, ms));
async function sinal(tipo) {
  for (let i = 0; i < 40; i++) {
    const s = await prisma.rnaSinal.findFirst({ where: { tipo, profundidade: 0 }, orderBy: { criadoEm: 'desc' } });
    if (s) return s;
    await espera(50);
  }
  return null;
}

async function limpar() {
  await prisma.rnaAtivacao.deleteMany({});
  await prisma.rnaSinal.deleteMany({});
}

(async () => {
  await limpar();
  const loja = await prisma.store.upsert({ where: { code: 'LOJA02' }, update: {}, create: { name: 'Bessa', code: 'LOJA02' } });

  await t('rede desligada (scripts/batch): gancho não emite nada', async () => {
    assert.strictEqual(ganchos._ligada(), false);
    const b = await prisma.stocktakeBipe.create({ data: { barcode: '7890000000017', storeId: loja.id, found: false } });
    ganchos.bipeRegistrado(b.id);
    await espera(300);
    assert.strictEqual(await prisma.rnaSinal.count(), 0);
  });

  await rede.iniciar();

  await t('bipe vira bipe.registrado com loja e found', async () => {
    const b = await prisma.stocktakeBipe.create({ data: { barcode: '7890000000024', storeId: loja.id, found: false } });
    ganchos.bipeRegistrado(b.id);
    const s = await sinal('bipe.registrado');
    assert.ok(s, 'sem sinal');
    assert.strictEqual(s.dados.bipeId, b.id);
    assert.strictEqual(s.dados.storeCode, 'LOJA02');
    assert.strictEqual(s.dados.found, false);
    assert.strictEqual(s.loja, 'LOJA02');
  });

  await t('NF-e vira nfe.importada com docType e nº de itens', async () => {
    const job = await prisma.xmlImportJob.create({ data: { name: 'teste', type: 'NFE_ENTRY' } });
    const d = await prisma.xmlFiscalDocument.create({ data: { importJobId: job.id, accessKey: 'K' + Date.now(), issuerCnpj: '11111111000111', recipientCnpj: '44052617000207', docType: 'entrada' } });
    ganchos.nfeImportada(d.id);
    const s = await sinal('nfe.importada');
    assert.ok(s, 'sem sinal');
    assert.strictEqual(s.dados.documentId, d.id);
    assert.strictEqual(s.dados.docType, 'entrada');
    assert.strictEqual(s.dados.itens, 0);
  });

  await t('venda vira venda.registrada com itens e loja', async () => {
    const u = await prisma.user.create({ data: { name: 'Vendedor Teste', pin: 'x', phone: 'v' + Date.now() } });
    const v = await prisma.sale.create({ data: { sellerId: u.id, storeId: loja.id, totalAmount: 299.9 } });
    ganchos.vendaRegistrada(v.id);
    const s = await sinal('venda.registrada');
    assert.ok(s, 'sem sinal');
    assert.strictEqual(s.dados.saleId, v.id);
    assert.strictEqual(s.dados.total, 299.9);
    assert.strictEqual(s.dados.storeCode, 'LOJA02');
    assert.ok(Array.isArray(s.dados.itens));
  });

  await t('webhook Nuvemshop de produto leva o id; de pedido leva orderId', async () => {
    ganchos.nuvemWebhook('product/updated', 123);
    const s = await sinal('nuvem.webhook');
    assert.ok(s, 'sem sinal');
    assert.strictEqual(s.dados.nuvemshopProductId, '123');
    assert.ok(!s.dados.orderId);
  });

  await t('WhatsApp: telefone vira hash, texto segue como dado externo', async () => {
    ganchos.whatsappEvolution('loja-bessa', { data: { key: { remoteJid: '5583996713153@s.whatsapp.net', fromMe: false, id: 'X1' }, message: { conversation: 'Tem o Megaride 41?' } } });
    const s = await sinal('whatsapp.mensagem');
    assert.ok(s, 'sem sinal');
    const txt = JSON.stringify(s);
    assert.ok(!/996713153|5583996713153/.test(txt), 'telefone vazou: ' + txt);
    assert.ok(/^[0-9a-f]{24}$/.test(s.dados.telefoneHash));
    assert.strictEqual(s.dados.texto, 'Tem o Megaride 41?');
    assert.strictEqual(s.externo, true);
  });

  await t('WhatsApp: mensagem nossa (fromMe) e de grupo não entram', async () => {
    await prisma.rnaSinal.deleteMany({ where: { tipo: 'whatsapp.mensagem' } });
    ganchos.whatsappEvolution('loja', { data: { key: { remoteJid: '5583999999999@s.whatsapp.net', fromMe: true }, message: { conversation: 'oi' } } });
    ganchos.whatsappEvolution('loja', { data: { key: { remoteJid: '120363@g.us', fromMe: false }, message: { conversation: 'oi grupo' } } });
    await espera(400);
    assert.strictEqual(await prisma.rnaSinal.count({ where: { tipo: 'whatsapp.mensagem' } }), 0);
  });

  await t('jogo finalizado: só emite torneio.finalizado quando a categoria não tem jogo pendente', async () => {
    const dono = await prisma.user.create({ data: { name: 'Org', pin: 'x', phone: 'o' + Date.now() } });
    const tor = await prisma.tournament.create({ data: { name: 'Teste RNA', slug: 'teste-rna-' + Date.now(), sport: 'BEACH_TENNIS', ownerId: dono.id } });
    const cat = await prisma.tournamentCategory.create({ data: { tournamentId: tor.id, name: 'Livre' } });
    const j1 = await prisma.tournamentMatch.create({ data: { tournamentId: tor.id, categoryId: cat.id, status: 'FINISHED' } });
    const j2 = await prisma.tournamentMatch.create({ data: { tournamentId: tor.id, categoryId: cat.id, status: 'SCHEDULED' } });
    ganchos.jogoFinalizado(j1.id);
    await espera(400);
    assert.strictEqual(await prisma.rnaSinal.count({ where: { tipo: 'torneio.finalizado' } }), 0, 'emitiu com jogo pendente');
    await prisma.tournamentMatch.update({ where: { id: j2.id }, data: { status: 'FINISHED' } });
    ganchos.jogoFinalizado(j2.id);
    const s = await sinal('torneio.finalizado');
    assert.ok(s, 'sem sinal');
    assert.strictEqual(s.dados.categoryId, cat.id);
  });

  await espera(500);
  console.log('Ganchos da rede:\n' + out.join('\n'));
  console.log(`\n${pass}/${out.length} ok`);
  await prisma.$disconnect();
  process.exit(process.exitCode || 0);
})().catch(async (e) => { console.error(e); await prisma.$disconnect(); process.exit(1); });
