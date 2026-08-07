// fiscal-diagnose.js — "POR QUE O CUPOM NAO ESTA SAINDO?" (READ-ONLY, nao muda NADA)
// Roda no PC do dono (precisa do .env com DATABASE_URL):
//   node scripts/fiscal-diagnose.js
// Varre: config das lojas/emissores, saude dos agentes, ultimo cupom autorizado,
// rejeicoes recentes (com o motivo literal da SEFAZ), docs travados em processing
// e vendas SEM cupom — e imprime o diagnostico provavel no final.
const fs = require('fs'); const path = require('path');
const envPath = path.join(__dirname, '..', '.env');
if (fs.existsSync(envPath)) for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) { const m = line.match(/^\s*([A-Za-z0-9_]+)\s*=\s*(.*)\s*$/); if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim().replace(/^["']|["']$/g, ''); }
const { PrismaClient } = require('@prisma/client'); const prisma = new PrismaClient();
const agentClient = require('../src/services/fiscalAgentClient');

const DIAS_PROBLEMAS = 7;   // janela pra rejeicoes/travados
const HORAS_VENDAS = 72;    // janela pra vendas sem cupom
const fmtDt = (d) => new Date(d).toLocaleString('pt-BR', { timeZone: 'America/Fortaleza' });
const achados = []; // alimenta o diagnostico final

(async () => {
  const stores = await prisma.store.findMany({
    where: { fiscalIssuerId: { not: null } },
    include: { fiscalIssuer: true },
    orderBy: { code: 'asc' },
  });

  // ---------- A) CONFIG + SAUDE DOS AGENTES ----------
  console.log('\n===== A) CONFIG + AGENTES (por loja) =====');
  console.log('LOJA   | agente                                   | saude       | issuer ativo | amb        | CSC | NFC-e');
  console.log('-'.repeat(120));
  const saudePorLoja = {};
  for (const s of stores) {
    const i = s.fiscalIssuer;
    let h; try { h = await agentClient.ping(s); } catch (e) { h = { ok: false, error: e.message }; }
    saudePorLoja[s.id] = h;
    const flags = [];
    if (!s.fiscalAgentEnabled) flags.push('AGENTE DESLIGADO NO BANCO');
    if (!s.fiscalAgentUrl) flags.push('SEM fiscalAgentUrl');
    if (!s.fiscalAgentToken) flags.push('SEM fiscalAgentToken');
    if (!i.active) flags.push('ISSUER INATIVO');
    if (!i.csc) flags.push('SEM CSC');
    if (i.environment !== 'production') flags.push('AMBIENTE=' + i.environment);
    if (!h.ok) flags.push('AGENTE FORA DO AR' + (h.error ? ' (' + String(h.error).slice(0, 60) + ')' : ''));
    if (flags.length) achados.push('[' + s.code + '] ' + flags.join(' + '));
    console.log(
      s.code.padEnd(6) + ' | ' +
      String(s.fiscalAgentUrl || '(sem)').padEnd(40).slice(0, 40) + ' | ' +
      (h.ok ? ('OK v' + (h.version || '?')) : 'FORA DO AR').padEnd(11) + ' | ' +
      (i.active ? 'sim' : 'NAO').padEnd(12) + ' | ' +
      String(i.environment).padEnd(10) + ' | ' +
      (i.csc ? 'sim' : 'NAO') + ' | ' +
      's' + i.nfceSerie + ' prox ' + i.nfceNextNumber
    );
  }

  // ---------- B) ULTIMO CUPOM AUTORIZADO POR LOJA ----------
  console.log('\n===== B) ULTIMO CUPOM AUTORIZADO (quando cada loja emitiu pela ultima vez) =====');
  for (const s of stores) {
    const last = await prisma.fiscalDocument.findFirst({
      where: { issuerId: s.fiscalIssuerId, docType: 'NFCE', status: 'authorized' },
      orderBy: { createdAt: 'desc' },
      select: { number: true, serie: true, createdAt: true, totalValue: true },
    });
    if (!last) { console.log(s.code + ': NUNCA emitiu cupom autorizado'); continue; }
    const horas = Math.round((Date.now() - new Date(last.createdAt).getTime()) / 36e5);
    console.log(s.code + ': #' + last.number + ' (s' + last.serie + ') em ' + fmtDt(last.createdAt) + '  — ha ' + horas + 'h' + (horas > 48 ? '  << PARADA HA ' + Math.round(horas / 24) + ' DIAS' : ''));
    if (horas > 48) achados.push('[' + s.code + '] sem cupom autorizado ha ' + Math.round(horas / 24) + ' dias');
  }

  // ---------- C) REJEICOES + TRAVADOS (ultimos dias) ----------
  const desde = new Date(Date.now() - DIAS_PROBLEMAS * 864e5);
  console.log('\n===== C) PROBLEMAS DOS ULTIMOS ' + DIAS_PROBLEMAS + ' DIAS =====');
  const ruins = await prisma.fiscalDocument.findMany({
    where: { createdAt: { gte: desde }, status: { in: ['rejected', 'error', 'processing'] } },
    orderBy: { createdAt: 'desc' },
    include: { issuer: { select: { fantasyName: true, cnpj: true } } },
    take: 60,
  });
  if (!ruins.length) console.log('(nenhum doc rejeitado/erro/travado no periodo — se nao ha emissao, o problema e ANTES da SEFAZ: agente/config/PDV)');
  const motivos = {};
  for (const d of ruins) {
    const travado = d.status === 'processing' && (Date.now() - new Date(d.createdAt).getTime()) > 5 * 6e4;
    const motivo = d.rejectReason || (d.response && (d.response.motivo || d.response.error)) || (travado ? 'TRAVADO em processing' : d.status);
    motivos[motivo] = (motivos[motivo] || 0) + 1;
    console.log(fmtDt(d.createdAt) + ' | ' + (d.issuer.fantasyName || d.issuer.cnpj) + ' | ' + d.docType + ' #' + d.number + ' | ' + d.status.toUpperCase() + ' | ' + String(motivo).slice(0, 90));
  }
  for (const [m, n] of Object.entries(motivos).sort((a, b) => b[1] - a[1])) {
    if (n >= 2) achados.push('Motivo repetido (' + n + 'x): "' + String(m).slice(0, 80) + '"');
  }

  // ---------- D) VENDAS SEM CUPOM (ultimas horas) ----------
  const desdeVendas = new Date(Date.now() - HORAS_VENDAS * 36e5);
  console.log('\n===== D) VENDAS SEM NENHUM CUPOM — ULTIMAS ' + HORAS_VENDAS + 'H =====');
  const vendas = await prisma.sale.findMany({
    where: { createdAt: { gte: desdeVendas }, storeId: { not: null }, status: { not: 'cancelled' } },
    select: { id: true, storeId: true, totalAmount: true, paymentMethod: true, status: true, createdAt: true },
    orderBy: { createdAt: 'desc' },
  });
  const docsDasVendas = await prisma.fiscalDocument.findMany({
    where: { saleId: { in: vendas.map(v => v.id) }, docType: 'NFCE' },
    select: { saleId: true, status: true },
  });
  const temDoc = new Set(docsDasVendas.map(d => d.saleId));
  const lojaPorId = Object.fromEntries(stores.map(s => [s.id, s.code]));
  const semCupom = vendas.filter(v => !temDoc.has(v.id));
  const porLoja = {};
  for (const v of semCupom) (porLoja[lojaPorId[v.storeId] || v.storeId] ||= []).push(v);
  if (!semCupom.length) console.log('(toda venda do periodo tem cupom ou tentativa — bom sinal)');
  for (const [loja, vs] of Object.entries(porLoja)) {
    console.log('\n' + loja + ': ' + vs.length + ' venda(s) SEM cupom nem tentativa:');
    for (const v of vs.slice(0, 6)) console.log('  ' + fmtDt(v.createdAt) + ' | R$ ' + Number(v.totalAmount).toFixed(2) + ' | pgto ' + (v.paymentMethod || '?') + ' | status ' + v.status + (v.status === 'pending_payment' ? ' (PIX aguardando cair — normal)' : ''));
    const reais = vs.filter(v => v.status !== 'pending_payment').length;
    if (reais) achados.push('[' + loja + '] ' + reais + ' venda(s) sem NENHUMA tentativa de cupom — emissao nem chegou no servidor (agente desligado no banco, PDV travando, ou auto-emit pulou)');
  }

  // ---------- E) DIAGNOSTICO ----------
  console.log('\n===== E) DIAGNOSTICO PROVAVEL =====');
  if (!achados.length) {
    console.log('Nenhum problema estrutural achado. Se o caixa ve erro na tela, o texto do alert e o proximo passo.');
  } else {
    for (const a of [...new Set(achados)]) console.log('• ' + a);
    console.log('\nComo ler:');
    console.log('  AGENTE FORA DO AR       -> na maquina da loja: Stop-ScheduledTask TenisCashFiscalAgent; Start-ScheduledTask TenisCashFiscalAgent');
    console.log('  AGENTE DESLIGADO/SEM URL/TOKEN -> config da Store no banco foi mexida; reconfigurar fiscalAgentUrl/Token/Enabled');
    console.log('  SEM CSC / ISSUER INATIVO -> cadastro do emissor (admin > fiscal > emissores)');
    console.log('  Motivo repetido da SEFAZ -> e a causa literal; certificado vencido/CPF/numeracao aparecem aqui');
    console.log('  Vendas sem tentativa     -> problema ANTES do servidor: veja o alert/console (F12) no PDV da loja');
  }
  await prisma.$disconnect();
})().catch(e => { console.error('ERRO:', e.message); process.exit(1); });
