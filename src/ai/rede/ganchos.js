// =====================================================================
// RNA — GANCHOS: o que os fluxos existentes chamam quando um evento real
// acontece. Cada função:
//   • nunca lança erro e nunca atrasa quem chamou (setImmediate + catch);
//   • só emite se a rede foi iniciada no servidor (scripts/batch não disparam);
//   • manda só IDs e dados mínimos — telefone vai como hash, nunca em claro.
// =====================================================================
const crypto = require('crypto');

function rede() {
  try { return require('./index'); } catch (_) { return null; }
}
function ligada() {
  const r = rede();
  return !!(r && r.estaIniciada && r.estaIniciada() && process.env.RNA_ATIVA !== '0');
}
function depois(fn) {
  if (!ligada()) return;
  setImmediate(() => { Promise.resolve().then(fn).catch((e) => console.error('[RNA gancho]', e.message)); });
}
const db = () => require('../../middleware').prisma;
async function codigoLoja(storeId) {
  if (!storeId) return null;
  const s = await db().store.findUnique({ where: { id: storeId }, select: { code: true } }).catch(() => null);
  return s ? s.code : null;
}

// NF-e importada (documento + itens já gravados)
function nfeImportada(documentId) {
  depois(async () => {
    const d = await db().xmlFiscalDocument.findUnique({ where: { id: documentId }, select: { id: true, accessKey: true, docType: true, issuerCnpj: true, recipientCnpj: true, _count: { select: { items: true } } } });
    if (!d) return;
    rede().sensor('nfe.importada', { documentId: d.id, accessKey: d.accessKey, docType: d.docType || null, issuerCnpj: d.issuerCnpj, recipientCnpj: d.recipientCnpj, itens: d._count.items });
  });
}

// Venda registrada (PDV, troca, pedido Nuvemshop)
function vendaRegistrada(saleId) {
  depois(async () => {
    const s = await db().sale.findUnique({ where: { id: saleId }, select: { id: true, storeId: true, totalAmount: true, items: { select: { productId: true, productSizeId: true, quantity: true, unitPrice: true } } } });
    if (!s) return;
    rede().sensor('venda.registrada', {
      saleId: s.id, storeCode: await codigoLoja(s.storeId), total: s.totalAmount,
      itens: s.items.map((i) => ({ productId: i.productId, sizeId: i.productSizeId, qty: i.quantity, price: i.unitPrice })),
    }, { loja: await codigoLoja(s.storeId) });
  });
}

// Bipe registrado (contagem)
function bipeRegistrado(bipeId) {
  depois(async () => {
    const b = await db().stocktakeBipe.findUnique({ where: { id: bipeId }, select: { id: true, storeId: true, barcode: true, productId: true, productSizeId: true, found: true, roundId: true } });
    if (!b) return;
    const loja = await codigoLoja(b.storeId);
    rede().sensor('bipe.registrado', { bipeId: b.id, storeCode: loja, barcode: b.barcode, productId: b.productId, sizeId: b.productSizeId, found: b.found, roundId: b.roundId }, { loja });
  });
}

// Webhook da Nuvemshop (já gravado em NuvemshopWebhookEvent)
function nuvemWebhook(evento, recursoId) {
  depois(async () => {
    const ev = String(evento || '');
    const dados = { evento: ev };
    if (/^product\//.test(ev)) dados.nuvemshopProductId = recursoId ? String(recursoId) : null;
    if (/^order\//.test(ev)) dados.orderId = recursoId ? String(recursoId) : null;
    rede().sensor('nuvem.webhook', dados);
  });
}

// Mensagem de cliente no WhatsApp (conteúdo é DADO externo, nunca instrução)
function whatsappMensagem({ empresa, telefone, texto }) {
  depois(async () => {
    const t = String(texto || '').trim();
    if (!t) return;
    const segredo = process.env.RNA_HASH_SALT || process.env.JWT_SECRET || 'rna';
    const telefoneHash = telefone ? crypto.createHmac('sha256', segredo).update(String(telefone).replace(/\D/g, '')).digest('hex').slice(0, 24) : null;
    rede().sensor('whatsapp.mensagem', { empresa: empresa || null, telefoneHash, texto: t.slice(0, 2000) });
  });
}

// Atalho para o webhook da Evolution: extrai remetente e texto, ignora o que é
// nosso (fromMe), status e grupos. O texto segue como DADO para a rede.
function whatsappEvolution(instance, body) {
  try {
    const d = Array.isArray(body && body.data) ? body.data[0] : ((body && body.data) || {});
    const key = d.key || {};
    const jid = String(key.remoteJid || '');
    if (key.fromMe || !jid || jid === 'status@broadcast' || jid.endsWith('@g.us')) return;
    const m = d.message || {};
    const texto = m.conversation || (m.extendedTextMessage && m.extendedTextMessage.text) || (m.imageMessage && m.imageMessage.caption) || '';
    const tel = String(key.remoteJidAlt || key.senderPn || d.senderPn || jid).replace(/[^0-9]/g, '');
    whatsappMensagem({ empresa: instance || null, telefone: tel, texto });
  } catch (_) { /* nunca atrapalha o atendimento */ }
}

// Jogo finalizado: se a categoria acabou (nenhum jogo pendente), o torneio/categoria fechou.
function jogoFinalizado(matchId) {
  depois(async () => {
    const m = await db().tournamentMatch.findUnique({ where: { id: matchId }, select: { tournamentId: true, categoryId: true } });
    if (!m) return;
    const pendentes = await db().tournamentMatch.count({ where: { categoryId: m.categoryId, status: { in: ['SCHEDULED', 'LIVE'] } } });
    if (pendentes > 0) return;
    rede().sensor('torneio.finalizado', { tournamentId: m.tournamentId, categoryId: m.categoryId });
  });
}

module.exports = { nfeImportada, vendaRegistrada, bipeRegistrado, nuvemWebhook, whatsappMensagem, whatsappEvolution, jogoFinalizado, _ligada: ligada };
