// =====================================================================
// Leitor de MIDIA do WhatsApp (via Evolution) — pro modo observacao do
// Meta APS "ler" tudo, nao so texto.
//   - audio  -> transcricao (Groq whisper-large-v3-turbo OU OpenAI whisper-1).
//               Sem chave -> marca "[audio ... transcricao nao configurada]".
//   - imagem -> descricao/transcricao via Claude vision (ANTHROPIC_API_KEY).
//   - outros -> marca o tipo (NUNCA grava vazio).
// Tudo em try/catch: se falhar, devolve uma marca, nunca quebra a captura.
// =====================================================================

const Anthropic = require('@anthropic-ai/sdk');

const EVOLUTION_API_URL = process.env.EVOLUTION_API_URL || '';
const EVOLUTION_API_KEY = process.env.EVOLUTION_API_KEY || '';
const VISION_MODEL = process.env.METAAPS_VISION_MODEL || 'claude-haiku-4-5-20251001';

async function downloadMedia(instance, data) {
  const res = await fetch(`${EVOLUTION_API_URL}/chat/getBase64FromMediaMessage/${encodeURIComponent(instance)}`, {
    method: 'POST',
    headers: { apikey: EVOLUTION_API_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ message: data, convertToMp4: false }),
  });
  if (!res.ok) throw new Error(`getBase64 ${res.status}`);
  const j = await res.json().catch(() => ({}));
  return { base64: j.base64 || j.media || null, mimetype: j.mimetype || j.mimeType || '' };
}

async function transcribeAudio(base64, mimetype) {
  const groq = process.env.GROQ_API_KEY;
  const openai = process.env.OPENAI_API_KEY;
  if (!groq && !openai) return { ok: false, reason: 'no_key' };
  const buf = Buffer.from(base64, 'base64');
  const type = mimetype || 'audio/ogg';
  const name = type.includes('mp4') || type.includes('m4a')
    ? 'audio.m4a'
    : type.includes('mpeg') || type.includes('mp3')
      ? 'audio.mp3'
      : 'audio.ogg';
  const form = new FormData();
  form.append('file', new Blob([buf], { type }), name);
  form.append('model', groq ? 'whisper-large-v3-turbo' : 'whisper-1');
  form.append('language', 'pt');
  const url = groq
    ? 'https://api.groq.com/openai/v1/audio/transcriptions'
    : 'https://api.openai.com/v1/audio/transcriptions';
  const res = await fetch(url, { method: 'POST', headers: { Authorization: `Bearer ${groq || openai}` }, body: form });
  if (!res.ok) {
    const t = await res.text().catch(() => '');
    throw new Error(`STT ${res.status} ${t.slice(0, 120)}`);
  }
  const j = await res.json().catch(() => ({}));
  return { ok: true, text: (j.text || '').trim() };
}

async function describeImage(base64, mimetype) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key || !base64) return null;
  const allowed = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];
  const mt = allowed.includes((mimetype || '').toLowerCase()) ? mimetype.toLowerCase() : 'image/jpeg';
  const client = new Anthropic({ apiKey: key });
  const resp = await client.messages.create({
    model: VISION_MODEL,
    max_tokens: 250,
    messages: [
      {
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: mt, data: base64 } },
          {
            type: 'text',
            text: 'Descreva objetivamente em 1-2 frases o que esta imagem mostra. Se for print de tela, sistema ou lista, transcreva os numeros e dados relevantes (nomes, quantidades).',
          },
        ],
      },
    ],
  });
  return (resp.content || []).filter((b) => b.type === 'text').map((b) => b.text).join(' ').trim() || null;
}

async function readMedia({ instance, data }) {
  const m = (data && data.message) || {};
  try {
    if (m.audioMessage) {
      const { base64, mimetype } = await downloadMedia(instance, data);
      if (!base64) return { kind: 'audio', text: '[audio recebido - nao consegui baixar]' };
      const r = await transcribeAudio(base64, mimetype);
      if (r.ok) return { kind: 'audio', text: r.text ? `[audio] ${r.text}` : '[audio sem fala detectada]' };
      return { kind: 'audio', text: '[audio recebido - transcricao nao configurada (falta chave Groq/OpenAI)]' };
    }
    if (m.imageMessage) {
      const cap = (m.imageMessage.caption || '').trim();
      const { base64, mimetype } = await downloadMedia(instance, data);
      const desc = base64 ? await describeImage(base64, mimetype) : null;
      return { kind: 'image', text: `[imagem]${cap ? ' legenda: ' + cap : ''}${desc ? ' - ' + desc : ''}`.trim() };
    }
    if (m.videoMessage) {
      return { kind: 'video', text: `[video]${m.videoMessage.caption ? ' legenda: ' + m.videoMessage.caption : ''}` };
    }
    if (m.documentMessage) {
      return { kind: 'document', text: `[documento: ${m.documentMessage.fileName || m.documentMessage.title || 'arquivo'}]` };
    }
    if (m.stickerMessage) return { kind: 'sticker', text: '[figurinha]' };
    if (m.locationMessage) {
      return { kind: 'location', text: `[localizacao ${m.locationMessage.degreesLatitude || ''},${m.locationMessage.degreesLongitude || ''}]` };
    }
    if (m.contactMessage || m.contactsArrayMessage) return { kind: 'contact', text: '[contato compartilhado]' };
  } catch (err) {
    console.error('[waMediaReader] erro:', err.message);
    if (m.audioMessage) return { kind: 'audio', text: '[audio recebido - falha ao ler]' };
    if (m.imageMessage) return { kind: 'image', text: '[imagem recebida - falha ao ler]' };
  }
  return { kind: 'other', text: '[mensagem nao-texto]' };
}

module.exports = { readMedia };
