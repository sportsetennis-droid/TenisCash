// fiscalDiagnose.js — relatório READ-ONLY "por que o cupom não está saindo?"
// Usado pelo endpoint temporário GET /api/_fiscaldiag (index.js) e pelo
// scripts/fiscal-diagnose.js. Não escreve NADA no banco.
const agentClient = require('./fiscalAgentClient');

const DIAS_PROBLEMAS = 7; // janela pra rejeições/travados
const HORAS_VENDAS = 72; // janela pra vendas sem cupom
const fmtDt = (d) => new Date(d).toLocaleString('pt-BR', { timeZone: 'America/Fortaleza' });

async function buildFiscalDiagnoseReport(prisma) {
  const out = [];
  const achados = [];
  const log = (s) => out.push(s);

  const stores = await prisma.store.findMany({
    where: { fiscalIssuerId: { not: null } },
    include: { fiscalIssuer: true },
    orderBy: { code: 'asc' },
  });

  // ---------- A) CONFIG + SAÚDE DOS AGENTES (pings em paralelo, 10s timeout cada) ----------
  log('[diag v2]');
  log('===== A) CONFIG + AGENTES (por loja) =====');
  const pings = await Promise.all(stores.map((s) => agentClient.ping(s).catch((e) => ({ ok: false, error: e.message }))));
  stores.forEach((s, idx) => {
    const i = s.fiscalIssuer;
    const h = pings[idx];
    const flags = [];
    if (!s.fiscalAgentEnabled) flags.push('AGENTE DESLIGADO NO BANCO');
    if (!s.fiscalAgentUrl) flags.push('SEM fiscalAgentUrl');
    if (!s.fiscalAgentToken) flags.push('SEM fiscalAgentToken');
    if (!i.active) flags.push('ISSUER INATIVO');
    if (!i.csc) flags.push('SEM CSC');
    if (i.environment !== 'production') flags.push('AMBIENTE=' + i.environment);
    if (s.fiscalAgentUrl && !h.ok) flags.push('AGENTE FORA DO AR' + (h.error ? ' (' + String(h.error).slice(0, 60) + ')' : ''));
    if (flags.length) achados.push('[' + s.code + '] ' + flags.join(' + '));
    log(
      s.code + ' | agente ' + (s.fiscalAgentUrl ? (h.ok ? 'OK v' + (h.version || '?') : 'FORA DO AR') : '(sem URL)') +
      ' | issuer ' + (i.active ? 'ativo' : 'INATIVO') +
      ' | amb ' + i.environment +
      ' | CSC ' + (i.csc ? 'sim' : 'NAO') +
      ' | NFC-e s' + i.nfceSerie + ' prox ' + i.nfceNextNumber
    );
  });

  // ---------- B) ÚLTIMO CUPOM AUTORIZADO POR LOJA ----------
  log('');
  log('===== B) ULTIMO CUPOM AUTORIZADO (quando cada loja emitiu pela ultima vez) =====');
  for (const s of stores) {
    const last = await prisma.fiscalDocument.findFirst({
      where: { issuerId: s.fiscalIssuerId, docType: 'NFCE', status: 'authorized' },
      orderBy: { createdAt: 'desc' },
      select: { number: true, serie: true, createdAt: true },
    });
    if (!last) { log(s.code + ': NUNCA emitiu cupom autorizado'); continue; }
    const horas = Math.round((Date.now() - new Date(last.createdAt).getTime()) / 36e5);
    log(s.code + ': #' + last.number + ' (s' + last.serie + ') em ' + fmtDt(last.createdAt) + ' — ha ' + horas + 'h' + (horas > 48 ? '  << PARADA HA ' + Math.round(horas / 24) + ' DIAS' : ''));
    if (horas > 48) achados.push('[' + s.code + '] sem cupom autorizado ha ' + Math.round(horas / 24) + ' dias');
  }

  // ---------- C) REJEIÇÕES + TRAVADOS ----------
  const desde = new Date(Date.now() - DIAS_PROBLEMAS * 864e5);
  log('');
  log('===== C) PROBLEMAS DOS ULTIMOS ' + DIAS_PROBLEMAS + ' DIAS =====');
  const ruins = await prisma.fiscalDocument.findMany({
    where: { createdAt: { gte: desde }, status: { in: ['rejected', 'error', 'processing'] } },
    orderBy: { createdAt: 'desc' },
    include: { issuer: { select: { fantasyName: true, cnpj: true } } },
    take: 60,
  });
  if (!ruins.length) log('(nenhum doc rejeitado/erro/travado no periodo — se nao ha emissao, o problema e ANTES da SEFAZ: agente/config/PDV)');
  const motivos = {};
  for (const d of ruins) {
    const travado = d.status === 'processing' && (Date.now() - new Date(d.createdAt).getTime()) > 5 * 6e4;
    const resp = d.response || {};
    // O motivo REAL da SEFAZ (cStat + xMotivo) mora no response; rejectReason
    // costuma ser o fallback generico 'Rejeitada' — nunca deixar ele mascarar.
    const rawStr = typeof resp.raw === 'string' ? resp.raw : '';
    const xMotivo = (rawStr.match(/<xMotivo>([^<]{1,200})<\/xMotivo>/) || [])[1] || null;
    const cStat = resp.status || (rawStr.match(/<cStat>(\d+)<\/cStat>/) || [])[1] || null;
    const motivo = [cStat, resp.motivo || xMotivo || resp.error || d.rejectReason || (travado ? 'TRAVADO em processing' : d.status)].filter(Boolean).join(' ');
    motivos[motivo] = (motivos[motivo] || 0) + 1;
    log(fmtDt(d.createdAt) + ' | ' + (d.issuer.fantasyName || d.issuer.cnpj) + ' | ' + d.docType + ' #' + d.number + ' | ' + d.status.toUpperCase() + ' | ' + String(motivo).slice(0, 140));
  }
  if (ruins.length) {
    // Dump integral do response do doc ruim mais recente — garante ver o erro
    // literal mesmo quando o regex nao casa (erro de transporte/agente, JSON, etc).
    log('');
    log('--- DETALHE COMPLETO do mais recente (' + ruins[0].docType + ' #' + ruins[0].number + ') ---');
    log(JSON.stringify(ruins[0].response || { rejectReason: ruins[0].rejectReason }).slice(0, 900));
  }
  for (const [m, n] of Object.entries(motivos).sort((a, b) => b[1] - a[1])) {
    if (n >= 2) achados.push('Motivo repetido (' + n + 'x): "' + String(m).slice(0, 120) + '"');
  }

  // ---------- D) VENDAS SEM CUPOM ----------
  const desdeVendas = new Date(Date.now() - HORAS_VENDAS * 36e5);
  log('');
  log('===== D) VENDAS SEM NENHUM CUPOM — ULTIMAS ' + HORAS_VENDAS + 'H =====');
  const vendas = await prisma.sale.findMany({
    where: { createdAt: { gte: desdeVendas }, storeId: { not: null }, status: { notIn: ['cancelled', 'canceled'] } },
    select: { id: true, storeId: true, totalAmount: true, paymentMethod: true, status: true, createdAt: true },
    orderBy: { createdAt: 'desc' },
  });
  const docsDasVendas = vendas.length ? await prisma.fiscalDocument.findMany({
    where: { saleId: { in: vendas.map((v) => v.id) }, docType: 'NFCE' },
    select: { saleId: true },
  }) : [];
  const temDoc = new Set(docsDasVendas.map((d) => d.saleId));
  const lojaPorId = Object.fromEntries(stores.map((s) => [s.id, s.code]));
  const semCupom = vendas.filter((v) => !temDoc.has(v.id));
  const porLoja = {};
  for (const v of semCupom) (porLoja[lojaPorId[v.storeId] || v.storeId] ||= []).push(v);
  if (!semCupom.length) log('(toda venda do periodo tem cupom ou tentativa — bom sinal)');
  for (const [loja, vs] of Object.entries(porLoja)) {
    log('');
    log(loja + ': ' + vs.length + ' venda(s) SEM cupom nem tentativa:');
    for (const v of vs.slice(0, 6)) log('  ' + fmtDt(v.createdAt) + ' | R$ ' + Number(v.totalAmount).toFixed(2) + ' | pgto ' + (v.paymentMethod || '?') + ' | status ' + v.status + (v.status === 'pending_payment' ? ' (PIX aguardando cair — normal)' : ''));
    const reais = vs.filter((v) => v.status !== 'pending_payment').length;
    if (reais) achados.push('[' + loja + '] ' + reais + ' venda(s) sem NENHUMA tentativa de cupom — emissao nem chegou no servidor (agente desligado no banco, PDV travando, ou auto-emit pulou)');
  }

  // ---------- E) DIAGNÓSTICO ----------
  log('');
  log('===== E) DIAGNOSTICO PROVAVEL =====');
  if (!achados.length) {
    log('Nenhum problema estrutural achado. Se o caixa ve erro na tela, o texto do alert e o proximo passo.');
  } else {
    for (const a of [...new Set(achados)]) log('* ' + a);
    log('');
    log('Como ler:');
    log('  AGENTE FORA DO AR        -> na maquina da loja: Stop-ScheduledTask TenisCashFiscalAgent; Start-ScheduledTask TenisCashFiscalAgent');
    log('  AGENTE DESLIGADO/SEM URL/TOKEN -> config da Store no banco foi mexida; reconfigurar fiscalAgentUrl/Token/Enabled');
    log('  SEM CSC / ISSUER INATIVO -> cadastro do emissor (admin > fiscal > emissores)');
    log('  Motivo repetido da SEFAZ -> e a causa literal; certificado vencido/CPF/numeracao aparecem aqui');
    log('  Vendas sem tentativa     -> problema ANTES do servidor: veja o alert/console (F12) no PDV da loja');
  }
  return out.join('\n');
}

module.exports = { buildFiscalDiagnoseReport };
