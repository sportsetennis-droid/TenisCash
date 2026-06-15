// =====================================================================
// Atendente de IA do BARATAO DOS ESPORTES (Claude) — WhatsApp
// =====================================================================
// Roda no MESMO servidor Evolution da S&T, mas numa INSTANCIA separada
// (numero proprio do Baratao). Isolamento de TRANSPORTE por instancia.
//
// CEREBRO: reusa o atendente compartilhado (aiAttendant) no perfil 'baratao'
// — MESMO catalogo/estoque/cashback da S&T, porem filtrado pra ver SO a
// loja Baratao (LOJA01) e com persona do Baratao. (Diferente da Meta
// Fardamentos, que e um dominio proprio e standalone.)
//
// Este modulo cuida so do TRANSPORTE: parse do webhook, takeover humano,
// e envio pela instancia certa. A regra anti-invencao (preco/estoque/
// tamanho) vive no aiAttendant e vale igual aqui.
//
// Liga/desliga: env AI_ATTENDANT_BARATAO_ENABLED ('false' desliga so o Baratao);
//   o kill switch geral AI_ATTENDANT_ENABLED tambem desliga.
// Instancia Evolution: env BARATAO_EVOLUTION_INSTANCE (default 'baratao').
// =====================================================================

const { getAttendantReply, isProfileEnabled } = require('./aiAttendant');
const { sendEvolutionRaw } = require('../whatsapp');

const INSTANCE = process.env.BARATAO_EVOLUTION_INSTANCE || 'baratao';
const TAKEOVER_PAUSE_MS = 6 * 60 * 60 * 1000; // se um humano responder pelo numero, IA fica fora 6h

function isEnabled() {
  return isProfileEnabled('baratao');
}

// Threads onde um humano assumiu (IA calada). Perde no restart — aceitavel.
const paused = new Map(); // phone -> expiresAt

function pauseThread(phone, ms) {
  paused.set(phone, Date.now() + ms);
}

function isPaused(phone) {
  const until = paused.get(phone);
  if (!until) return false;
  if (Date.now() > until) {
    paused.delete(phone);
    return false;
  }
  return true;
}

// ---------------------------------------------------------------------
// WEBHOOK — processa um payload da Evolution (instancia do Baratao).
// Chamado pela rota /api/whatsapp/evolution quando body.instance == INSTANCE.
// ---------------------------------------------------------------------
async function handleBarataoWebhook(body) {
  const data = Array.isArray(body.data) ? body.data[0] : (body.data || {});
  const key = data.key || {};
  const jid = key.remoteJid || '';
  if (!jid || jid === 'status@broadcast') return;

  // MVP: so atendimento privado (1:1). Grupo e ignorado.
  if (jid.endsWith('@g.us')) return;

  const phone = jid.replace(/[^0-9]/g, '');
  if (!phone) return;

  // Humano respondeu pelo proprio numero do Baratao -> assumiu, IA sai de cena.
  if (key.fromMe) {
    pauseThread(phone, TAKEOVER_PAUSE_MS);
    console.log(`[barataoAttendant] humano assumiu ${phone} — IA pausada ${TAKEOVER_PAUSE_MS / 3600000}h`);
    return;
  }

  if (!isEnabled()) {
    console.log(`[barataoAttendant] IA desligada — ignorando msg de ${phone}`);
    return;
  }
  if (isPaused(phone)) {
    console.log(`[barataoAttendant] thread ${phone} pausada (humano assumiu) — IA em silencio`);
    return;
  }

  const pushName = data.pushName || 'cliente';
  const m = data.message || {};
  const text = (m.conversation || (m.extendedTextMessage && m.extendedTextMessage.text) || '').trim();

  if (!text) {
    await sendEvolutionRaw(phone, 'Oi! No momento consigo te atender por *texto*. Pode escrever o que você procura? 🙂', INSTANCE).catch(() => {});
    return;
  }

  console.log(`[barataoAttendant] ${phone} (${pushName}): "${text.slice(0, 120)}"`);
  const result = await getAttendantReply({ phone, text, pushName, profile: 'baratao' });

  if (result.ok && result.reply) {
    const r = await sendEvolutionRaw(phone, result.reply, INSTANCE);
    console.log(`[barataoAttendant] resposta -> ${phone}: ${r.ok ? 'OK' : 'FAIL ' + r.error}`);
  } else if (!result.skip) {
    console.warn(`[barataoAttendant] sem resposta p/ ${phone}:`, result.error || 'desconhecido');
  }
}

module.exports = { handleBarataoWebhook, isEnabled, INSTANCE };
