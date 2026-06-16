// =====================================================================
// cupomDelivery.js — entrega o cupom fiscal pro WhatsApp do cliente.
// Manda o PDF (documento) com legenda; se o PDF falhar, cai pro texto+link.
// Idempotente: grava response.waSent no FiscalDocument pra não mandar 2x no
// disparo automático (o botão manual do PDV força e ignora o flag).
// =====================================================================

const { sendEvolutionMedia, sendCustomMessage } = require('../whatsapp');

function baseUrl() {
  return (process.env.PUBLIC_BASE_URL || 'https://teniscash.com.br').replace(/\/+$/, '');
}

function buildCaption(doc) {
  const loja = (doc.issuer && (doc.issuer.fantasyName || doc.issuer.companyName)) || 'Sports & Tennis';
  const data = new Date(doc.createdAt).toLocaleDateString('pt-BR', { timeZone: 'America/Fortaleza' });
  const total = Number(doc.totalValue || 0).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const link = baseUrl() + '/nota/' + doc.accessKey;
  return '🧾 *' + loja + '* — seu cupom fiscal\n' +
    'Nº ' + doc.number + ' · ' + data + ' · R$ ' + total + '\n\n' +
    'Ver/baixar a nota:\n' + link + '\n\nObrigado pela compra! 💚';
}

// doc precisa de issuer + accessKey + status authorized. phone = WhatsApp do cliente.
// opts.prisma p/ gravar o flag; opts.force ignora o flag (botão manual).
async function deliverCupom(doc, phone, opts = {}) {
  if (!doc || doc.status !== 'authorized' || !doc.accessKey) return { ok: false, error: 'cupom nao autorizado' };
  const ph = String(phone || '').replace(/\D/g, '');
  if (ph.length < 10 || ph.length > 13) return { ok: false, error: 'telefone invalido' };
  if (!opts.force && doc.response && doc.response.waSent) return { ok: true, already: true };

  const caption = buildCaption(doc);
  const pdfUrl = baseUrl() + '/nota/' + doc.accessKey + '/pdf';

  // 1) tenta PDF como documento
  let res = await sendEvolutionMedia(ph, pdfUrl, 'cupom-' + doc.number + '.pdf', caption);
  let via = 'pdf';
  // 2) se o PDF falhar, manda texto+link (não deixa o cliente sem nota)
  if (!res.ok) { res = await sendCustomMessage(ph, caption); via = 'link'; }

  if (res.ok && opts.prisma) {
    try {
      await opts.prisma.fiscalDocument.update({
        where: { id: doc.id },
        data: { response: { ...(doc.response || {}), waSent: true, waTo: ph, waVia: via, waAt: new Date().toISOString() } },
      });
    } catch (e) { /* flag é best-effort */ }
  }
  return res.ok ? { ok: true, via, provider: res.provider || 'evolution', phone: ph } : { ok: false, error: res.error || 'falha no envio' };
}

module.exports = { deliverCupom, buildCaption };
