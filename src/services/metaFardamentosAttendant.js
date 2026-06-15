// =====================================================================
// Atendente de IA da META FARDAMENTOS (Claude) — WhatsApp
// =====================================================================
// Roda no MESMO servidor Evolution da S&T, mas numa INSTANCIA separada
// (numero proprio da Meta Fardamentos). NAO compartilha dado, persona
// nem catalogo com a Sports & Tennis. Isolamento total por instancia.
//
// MISSAO (definida pelo dono): atender no jeito dele, QUALIFICAR o lead
// (tipo de fardamento + quantidade + personalizacao) e ENTREGAR o lead
// pronto pra equipe fechar. NUNCA cita preco. NUNCA promete prazo.
//
// Liga/desliga: env METAFARD_ATTENDANT_ENABLED ('false' desliga).
// Modelo: env METAFARD_ATTENDANT_MODEL (default claude-sonnet-4-6).
// Cerebro editavel: ./metaFardamentosKB.js (o dono revisa la).
// =====================================================================

const Anthropic = require('@anthropic-ai/sdk');
const KB = require('./metaFardamentosKB');
const { sendEvolutionRaw, formatPhoneBR } = require('../whatsapp');

const MODEL = process.env.METAFARD_ATTENDANT_MODEL || 'claude-sonnet-4-6';
const INSTANCE = process.env.METAFARD_EVOLUTION_INSTANCE || 'metafardamentos';
const LEAD_NOTIFY = process.env.METAFARD_LEAD_NOTIFY || ''; // telefone OU jid de grupo p/ receber o lead

const HISTORY_TTL_MS = 30 * 60 * 1000; // 30 min de janela de conversa
const MAX_HISTORY = 12;
const HANDOFF_PAUSE_MS = 12 * 60 * 60 * 1000; // apos passar o lead, IA fica fora 12h
const TAKEOVER_PAUSE_MS = 6 * 60 * 60 * 1000; // se o dono respondeu pelo numero, IA fica fora 6h

function isEnabled() {
  return String(process.env.METAFARD_ATTENDANT_ENABLED || 'true').toLowerCase() !== 'false';
}

function getClient() {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return null;
  return new Anthropic({ apiKey: key });
}

// ---------------------------------------------------------------------
// Estado em memoria (perde no restart — aceitavel; conversa e curta)
// ---------------------------------------------------------------------
const sessions = new Map(); // phone -> { messages, expiresAt }
const paused = new Map(); // phone -> expiresAt (IA calada: humano assumiu / lead passado)

function getHistory(phone) {
  const s = sessions.get(phone);
  if (!s) return [];
  if (Date.now() > s.expiresAt) {
    sessions.delete(phone);
    return [];
  }
  return s.messages;
}

function pushHistory(phone, role, text) {
  const s = sessions.get(phone) || { messages: [] };
  s.messages.push({ role, content: text });
  if (s.messages.length > MAX_HISTORY) s.messages = s.messages.slice(-MAX_HISTORY);
  s.expiresAt = Date.now() + HISTORY_TTL_MS;
  sessions.set(phone, s);
}

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
// FERRAMENTAS (Claude tool use)
// ---------------------------------------------------------------------
const TOOLS = [
  {
    name: 'info_meta_fardamentos',
    description:
      'Retorna informacoes REAIS da Meta Fardamentos: o que produz (segmentos), tipos de personalizacao, ' +
      'como funciona o atendimento, localizacao, canais e perguntas frequentes. ' +
      'Use SEMPRE que o cliente perguntar o que voces fazem, se atendem o caso dele, onde ficam, ' +
      'como funciona, ou qualquer duvida de servico. NUNCA invente — so o que esta aqui.',
    input_schema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'encaminhar_para_equipe',
    description:
      'Registra o pedido qualificado e ENTREGA o lead pra equipe da Meta Fardamentos dar continuidade (orcamento). ' +
      'Chame esta ferramenta quando: (a) ja tiver o basico do pedido (tipo de fardamento + quantidade aproximada + se quer personalizacao), ' +
      'OU (b) o cliente pedir PRECO/ORCAMENTO/VALOR, OU (c) o cliente quiser falar com uma pessoa, OU (d) o cliente quiser fechar. ' +
      'Depois de chamar, avise o cliente de forma calorosa que um especialista vai assumir e dar sequencia. ' +
      'Preencha o que souber; o que nao souber, deixe "nao informado".',
    input_schema: {
      type: 'object',
      properties: {
        nome: { type: 'string', description: 'Nome do cliente, se ele disse.' },
        segmento: { type: 'string', description: 'corporativo, profissional/EPI, escolar, esportivo ou outro.' },
        tipo_fardamento: { type: 'string', description: 'O que o cliente quer. Ex: "camisa polo com logo", "uniforme escolar".' },
        quantidade: { type: 'string', description: 'Quantidade aproximada, ou "nao informado".' },
        personalizacao: { type: 'string', description: 'Logo / nome / numeracao / nenhuma / "nao informado".' },
        resumo: { type: 'string', description: 'Resumo curto do pedido em 1-2 linhas, pra equipe entender rapido.' },
      },
      required: ['resumo'],
    },
  },
];

function kbForModel() {
  return {
    empresa: KB.empresa,
    segmentos: KB.segmentos,
    personalizacao: KB.personalizacao,
    como_funciona: KB.como_funciona,
    canais: KB.canais,
    // FAQ: so as perguntas COM resposta preenchida (vazio = dono ainda nao confirmou -> nao afirmar)
    faq: (KB.faq || []).filter((f) => f.r && String(f.r).trim()),
    fatos_confirmados: Object.fromEntries(
      Object.entries(KB.revisar_com_dono || {}).filter(([, v]) => v !== null && v !== undefined && v !== '')
    ),
  };
}

async function runTool(name, input, ctx) {
  try {
    if (name === 'info_meta_fardamentos') {
      return kbForModel();
    }
    if (name === 'encaminhar_para_equipe') {
      ctx.lead = {
        nome: input?.nome || ctx.pushName || '',
        segmento: input?.segmento || 'nao informado',
        tipo_fardamento: input?.tipo_fardamento || 'nao informado',
        quantidade: input?.quantidade || 'nao informado',
        personalizacao: input?.personalizacao || 'nao informado',
        resumo: input?.resumo || '',
      };
      return { ok: true, mensagem: 'Lead registrado. Avise o cliente, de forma calorosa, que um especialista vai assumir e dar sequencia ao orcamento.' };
    }
    return { erro: 'ferramenta desconhecida' };
  } catch (err) {
    console.error('[metaFardAttendant] erro na tool', name, err.message);
    return { erro: 'Nao consegui consultar agora.' };
  }
}

// ---------------------------------------------------------------------
// SYSTEM PROMPT — persona + regras duras
// ---------------------------------------------------------------------
function buildSystem(pushName) {
  return `Voce e o atendente virtual da META FARDAMENTOS, um centro de criacao e producao de uniformes em Joao Pessoa - PB. Tagline: "${KB.empresa.tagline}". Voce atende clientes no WhatsApp.

SEU OBJETIVO: atender bem, entender o que o cliente precisa e QUALIFICAR o pedido (tipo de uniforme + quantidade aproximada + se quer personalizacao como logo/nome). Quando tiver o basico — ou quando o cliente pedir preco, quiser falar com uma pessoa, ou quiser fechar — use a ferramenta "encaminhar_para_equipe" pra entregar o lead pro time fechar o orcamento.

REGRAS INQUEBRAVEIS:
1. NUNCA invente nada. Para falar do que a empresa faz, segmentos, personalizacao, localizacao ou tirar duvidas, use a ferramenta "info_meta_fardamentos". Se a informacao nao estiver la, diga com naturalidade que confirma com a equipe — NUNCA chute.
2. NUNCA cite preco, valor ou faixa de preco. Fardamento e sob medida — o orcamento certo vem da equipe. Se perguntarem preco, colete o pedido (tipo, quantidade, personalizacao) e use "encaminhar_para_equipe".
3. NUNCA prometa prazo nem data de entrega. Se perguntarem, diga que a equipe confirma o prazo no orcamento, conforme o pedido. Nao invente dias.
4. NUNCA fale de falta de demanda, agenda vazia, "vagas" ou capacidade. Isso e interno e nunca aparece pro cliente.
5. Sempre escreva "Meta Fardamentos" por extenso — nunca abrevie pra "Meta".

ESTILO (a voz da marca):
- Assertivo, mas SUTIL e acolhedor. Sem esfregar na cara, sem CTA agressivo, sem lecionar.
- O eixo e qualidade, confianca e prova social — quando fizer sentido, convide a ver trabalhos no Instagram @metafardamentos.
- Mensagens CURTAS de WhatsApp (2 a 5 linhas). Portugues correto e COM ACENTUACAO. Pode usar *negrito* do WhatsApp e no maximo 1-2 emojis.
- Nunca use tabela nem markdown de titulo (nao renderiza no zap).
- Trate o cliente pelo nome quando souber (o nome no WhatsApp e "${pushName || 'cliente'}").
- Seja proativo pra qualificar: se faltar tipo, quantidade ou personalizacao, pergunte de forma leve, uma coisa de cada vez.

Hoje voce so responde texto. Se mandarem audio/foto, peca gentilmente pra escrever (o orcamento depois pode receber as artes).`;
}

// ---------------------------------------------------------------------
// PRINCIPAL — gera a resposta do atendente
// ---------------------------------------------------------------------
async function getMetaReply({ phone, text, pushName }) {
  if (!isEnabled()) return { ok: false, skip: 'disabled' };
  const client = getClient();
  if (!client) return { ok: false, error: 'ANTHROPIC_API_KEY ausente' };

  const history = getHistory(phone);
  const messages = [...history.map((m) => ({ role: m.role, content: m.content })), { role: 'user', content: text }];
  const ctx = { phone, pushName, lead: null };

  try {
    let working = messages;
    let finalText = '';
    for (let hop = 0; hop < 5; hop++) {
      const resp = await client.messages.create({
        model: MODEL,
        max_tokens: 700,
        system: buildSystem(pushName),
        tools: TOOLS,
        messages: working,
      });

      if (resp.stop_reason === 'tool_use') {
        working = working.concat([{ role: 'assistant', content: resp.content }]);
        const toolResults = [];
        for (const block of resp.content) {
          if (block.type === 'tool_use') {
            const out = await runTool(block.name, block.input, ctx);
            toolResults.push({ type: 'tool_result', tool_use_id: block.id, content: JSON.stringify(out) });
          }
        }
        working = working.concat([{ role: 'user', content: toolResults }]);
        continue;
      }

      finalText = (resp.content || [])
        .filter((b) => b.type === 'text')
        .map((b) => b.text)
        .join('\n')
        .trim();
      break;
    }

    if (!finalText) {
      finalText = 'Recebi sua mensagem! Em instantes a equipe da Meta Fardamentos te responde. 🙂';
    }

    pushHistory(phone, 'user', text);
    pushHistory(phone, 'assistant', finalText);
    return { ok: true, reply: finalText, handoff: ctx.lead || null };
  } catch (err) {
    console.error('[metaFardAttendant] erro ao gerar resposta:', err.message);
    return { ok: false, error: err.message };
  }
}

// ---------------------------------------------------------------------
// Notificacao de lead pro dono/equipe
// ---------------------------------------------------------------------
async function notifyLead(customerPhone, lead) {
  if (!LEAD_NOTIFY) {
    console.log('[metaFardAttendant] METAFARD_LEAD_NOTIFY nao configurado — lead nao foi encaminhado:', lead && lead.resumo);
    return;
  }
  const tel = formatPhoneBR(customerPhone) || customerPhone;
  const linhas = [
    '🧵 *Novo lead — Meta Fardamentos*',
    '',
    `*Cliente:* ${lead.nome || 'não informado'}`,
    `*Contato:* wa.me/${tel}`,
    `*Segmento:* ${lead.segmento}`,
    `*Pedido:* ${lead.tipo_fardamento}`,
    `*Quantidade:* ${lead.quantidade}`,
    `*Personalização:* ${lead.personalizacao}`,
    '',
    `*Resumo:* ${lead.resumo}`,
    '',
    '_O atendente já avisou o cliente que um especialista vai assumir._',
  ];
  const r = await sendEvolutionRaw(LEAD_NOTIFY, linhas.join('\n'), INSTANCE);
  console.log(`[metaFardAttendant] lead -> ${LEAD_NOTIFY}: ${r.ok ? 'OK' : 'FAIL ' + r.error}`);
}

// ---------------------------------------------------------------------
// WEBHOOK — processa um payload da Evolution (instancia da Meta Fardamentos)
// Chamado pela rota /api/whatsapp/evolution quando body.instance == INSTANCE.
// ---------------------------------------------------------------------
async function handleMetaWebhook(body) {
  const data = Array.isArray(body.data) ? body.data[0] : (body.data || {});
  const key = data.key || {};
  const jid = key.remoteJid || '';
  if (!jid || jid === 'status@broadcast') return;

  // MVP: so atendimento privado (1:1). Grupo e ignorado.
  if (jid.endsWith('@g.us')) return;

  const phone = jid.replace(/[^0-9]/g, '');
  if (!phone) return;

  // Dono respondeu pelo proprio numero da Meta -> humano assumiu, IA sai de cena.
  if (key.fromMe) {
    pauseThread(phone, TAKEOVER_PAUSE_MS);
    console.log(`[metaFardAttendant] humano assumiu ${phone} — IA pausada ${TAKEOVER_PAUSE_MS / 3600000}h`);
    return;
  }

  if (!isEnabled()) {
    console.log(`[metaFardAttendant] IA desligada — ignorando msg de ${phone}`);
    return;
  }
  if (isPaused(phone)) {
    console.log(`[metaFardAttendant] thread ${phone} pausada (humano/lead) — IA em silencio`);
    return;
  }

  const pushName = data.pushName || 'cliente';
  const m = data.message || {};
  const text = (m.conversation || (m.extendedTextMessage && m.extendedTextMessage.text) || '').trim();

  if (!text) {
    await sendEvolutionRaw(phone, 'Oi! No momento consigo te atender por *texto*. Pode escrever o que você procura? 🙂', INSTANCE).catch(() => {});
    return;
  }

  console.log(`[metaFardAttendant] ${phone} (${pushName}): "${text.slice(0, 120)}"`);
  const result = await getMetaReply({ phone, text, pushName });

  if (result.ok && result.reply) {
    const r = await sendEvolutionRaw(phone, result.reply, INSTANCE);
    console.log(`[metaFardAttendant] resposta -> ${phone}: ${r.ok ? 'OK' : 'FAIL ' + r.error}`);
    if (result.handoff) {
      await notifyLead(phone, result.handoff);
      pauseThread(phone, HANDOFF_PAUSE_MS); // lead passado: IA sai, humano fecha
    }
  } else if (!result.skip) {
    console.warn(`[metaFardAttendant] sem resposta p/ ${phone}:`, result.error || 'desconhecido');
  }
}

module.exports = { getMetaReply, handleMetaWebhook, isEnabled, INSTANCE };
