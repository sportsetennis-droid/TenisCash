// =====================================================================
// MONITOR DE WHATSAPP — captura toda mensagem que passa pelo webhook da
// Evolution (todas as instâncias) pra o dono acompanhar no admin.
// NUNCA lança erro: é chamado fire-and-forget no webhook e NÃO pode
// atrapalhar o atendente de IA. Captura daqui pra frente (a Evolution
// não guarda histórico).
// =====================================================================
const { prisma } = require('../middleware');

// instância Evolution -> nome amigável da empresa/loja
const INSTANCE_LABELS = {
  teniscash: 'Sports & Tennis',
  baratao: 'Baratão dos Esportes',
  metafardamentos: 'Meta Fardamentos',
  metaaps: 'Meta APS',
};

// Extrai texto + tipo legível de uma mensagem do WhatsApp (formato Baileys/Evolution).
function extractContent(message, messageType) {
  const m = message || {};
  if (m.conversation) return { text: m.conversation, type: 'text' };
  if (m.extendedTextMessage && m.extendedTextMessage.text) return { text: m.extendedTextMessage.text, type: 'text' };
  if (m.imageMessage) return { text: m.imageMessage.caption || '📷 (imagem)', type: 'image' };
  if (m.videoMessage) return { text: m.videoMessage.caption || '🎥 (vídeo)', type: 'video' };
  if (m.audioMessage) return { text: '🎤 (áudio)', type: 'audio' };
  if (m.documentMessage) return { text: '📎 (documento) ' + (m.documentMessage.fileName || ''), type: 'document' };
  if (m.stickerMessage) return { text: '(figurinha)', type: 'sticker' };
  if (m.locationMessage) return { text: '📍 (localização)', type: 'location' };
  if (m.contactMessage || m.contactsArrayMessage) return { text: '👤 (contato)', type: 'contact' };
  if (m.buttonsResponseMessage) return { text: m.buttonsResponseMessage.selectedDisplayText || '(resposta de botão)', type: 'button' };
  if (m.listResponseMessage) return { text: (m.listResponseMessage.title || '(resposta de lista)'), type: 'list' };
  if (m.templateButtonReplyMessage) return { text: m.templateButtonReplyMessage.selectedDisplayText || '(botão)', type: 'button' };
  if (m.reactionMessage) return { text: (m.reactionMessage.text || '👍') + ' (reação)', type: 'reaction' };
  return { text: '(mídia/outro tipo)', type: messageType || 'unknown' };
}

// Grava todas as mensagens de um payload messages.upsert da Evolution.
async function captureEvolutionMessages(body) {
  try {
    const instance = (body && (body.instance || body.instanceName) || '').toString().trim();
    if (!instance) return;
    const arr = Array.isArray(body.data) ? body.data : (body.data ? [body.data] : []);
    for (const data of arr) {
      try {
        const key = (data && data.key) || {};
        const jid = key.remoteJid || '';
        if (!jid || jid === 'status@broadcast') continue;
        const isGroup = jid.endsWith('@g.us');
        const fromMe = !!key.fromMe;
        const senderJid = isGroup ? (key.participant || '') : jid;
        const phone = (senderJid || jid).replace(/[^0-9]/g, '') || null;
        const { text, type } = extractContent(data.message, data.messageType);
        const tsSec = Number(data.messageTimestamp) || 0;
        const ts = tsSec > 0 ? new Date(tsSec * 1000) : new Date();
        const messageId = key.id || null;
        const contactName = data.pushName || null;

        const record = { instance, chatJid: jid, isGroup, contactName, phone, fromMe, text, msgType: type, messageId, ts };

        if (messageId) {
          await prisma.whatsappMessage.upsert({
            where: { instance_messageId: { instance, messageId } },
            update: {}, // re-entrega do webhook: não duplica
            create: record,
          }).catch(() => {});
        } else {
          await prisma.whatsappMessage.create({ data: record }).catch(() => {});
        }
      } catch (e) { /* uma msg ruim não derruba as outras nem o atendente */ }
    }
  } catch (e) { /* silencioso por design */ }
}

module.exports = { captureEvolutionMessages, extractContent, INSTANCE_LABELS };
