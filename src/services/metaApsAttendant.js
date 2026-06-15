// =====================================================================
// Atendente de IA do META APS (Claude) — WhatsApp
// =====================================================================
// Roda no MESMO servidor Evolution da S&T, numa INSTANCIA separada
// ('metaaps' = numero proprio do Meta APS). NAO compartilha dado, persona
// nem catalogo com a Sports & Tennis. Isolamento total por instancia.
//
// PAPEL: assistente de saude publica (Atencao Primaria). ACOLHE o cidadao,
// ORIENTA de forma geral e ENCAMINHA o pedido pra equipe da UBS. NUNCA
// diagnostica, NUNCA le dado pessoal de saude, EMERGENCIA -> 192/188.
//
// Liga/desliga: env METAAPS_ATTENDANT_ENABLED ('false' desliga).
// Modelo: env METAAPS_ATTENDANT_MODEL (default claude-sonnet-4-6).
// Cerebro editavel: ./metaApsKB.js (o dono revisa la).
//
// Fase 2 (quando o Meta APS no EC2 expuser API): registrar pre-cadastro/
// agendamento/ACS direto no banco do Meta APS. Por ora, encaminha pra
// equipe via WhatsApp (METAAPS_NOTIFY) — mesmo padrao do Meta Fardamentos.
// =====================================================================

const Anthropic = require('@anthropic-ai/sdk');
const KB = require('./metaApsKB');
const { sendEvolutionRaw, formatPhoneBR } = require('../whatsapp');

const MODEL = process.env.METAAPS_ATTENDANT_MODEL || 'claude-sonnet-4-6';
const INSTANCE = process.env.METAAPS_EVOLUTION_INSTANCE || 'metaaps';
const NOTIFY = process.env.METAAPS_NOTIFY || ''; // telefone OU jid de grupo p/ receber o encaminhamento

const HISTORY_TTL_MS = 30 * 60 * 1000; // 30 min de janela de conversa
const MAX_HISTORY = 12;
const HANDOFF_PAUSE_MS = 6 * 60 * 60 * 1000; // apos encaminhar, IA fica fora 6h
const TAKEOVER_PAUSE_MS = 6 * 60 * 60 * 1000; // se a equipe respondeu pelo numero, IA fica fora 6h

function isEnabled() {
  return String(process.env.METAAPS_ATTENDANT_ENABLED || 'true').toLowerCase() !== 'false';
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
const paused = new Map(); // phone -> expiresAt (IA calada: humano assumiu / encaminhado)

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
    name: 'info_meta_aps',
    description:
      'Retorna informacoes REAIS e verificadas do Meta APS / Atencao Primaria: o que e, servicos da UBS, ' +
      'como funciona o atendimento, documentos, orientacao de emergencia e perguntas frequentes. ' +
      'Use SEMPRE que o cidadao perguntar o que voces fazem, como funciona a UBS, o que levar, como agendar ' +
      'ou tirar duvida de servico. NUNCA invente — so o que esta aqui. Se faltar, diga que confirma com a equipe.',
    input_schema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'encaminhar_para_equipe',
    description:
      'Registra e ENTREGA o pedido do cidadao pra equipe da UBS dar sequencia. ' +
      'Chame quando: (a) a pessoa quer marcar/solicitar consulta ou atendimento, OU (b) quer visita/contato do ACS, ' +
      'OU (c) quer falar com uma pessoa de verdade, OU (d) tem uma reclamacao/elogio/sugestao sobre a unidade, ' +
      'OU (e) o caso foge do que voce pode orientar. NAO use pra emergencia (emergencia = oriente 192 na hora). ' +
      'Depois de chamar, avise a pessoa de forma acolhedora que a equipe da UBS vai dar sequencia. ' +
      'Preencha o que souber; o que nao souber, deixe "nao informado".',
    input_schema: {
      type: 'object',
      properties: {
        nome: { type: 'string', description: 'Nome do cidadao, se ele disse.' },
        assunto: {
          type: 'string',
          description: 'Tipo do pedido: agendamento, visita_acs, falar_com_atendente, avaliacao, duvida ou outro.',
        },
        bairro: { type: 'string', description: 'Bairro/regiao do cidadao, se disse (ajuda a achar a UBS).' },
        resumo: { type: 'string', description: 'Resumo curto do pedido em 1-2 linhas, sem detalhe clinico intimo, pra equipe entender.' },
      },
      required: ['resumo'],
    },
  },
];

function kbForModel() {
  return {
    programa: KB.programa,
    emergencia: KB.emergencia,
    servicos_aps: KB.servicos_aps,
    como_funciona: KB.como_funciona,
    // FAQ: so as perguntas COM resposta preenchida (vazio = dono ainda nao confirmou -> nao afirmar)
    faq: (KB.faq || []).filter((f) => f.r && String(f.r).trim()),
    fatos_confirmados: Object.fromEntries(
      Object.entries(KB.revisar_com_dono || {}).filter(([, v]) => v !== null && v !== undefined && v !== '')
    ),
  };
}

async function runTool(name, input, ctx) {
  try {
    if (name === 'info_meta_aps') {
      return kbForModel();
    }
    if (name === 'encaminhar_para_equipe') {
      ctx.handoff = {
        nome: input?.nome || ctx.pushName || '',
        assunto: input?.assunto || 'nao informado',
        bairro: input?.bairro || 'nao informado',
        resumo: input?.resumo || '',
      };
      return { ok: true, mensagem: 'Pedido registrado. Avise a pessoa, de forma acolhedora, que a equipe da UBS vai dar sequencia. Se for algo de saude urgente, lembre o 192.' };
    }
    return { erro: 'ferramenta desconhecida' };
  } catch (err) {
    console.error('[metaApsAttendant] erro na tool', name, err.message);
    return { erro: 'Nao consegui registrar agora.' };
  }
}

// ---------------------------------------------------------------------
// SYSTEM PROMPT — persona + regras duras de saude
// ---------------------------------------------------------------------
function buildSystem(pushName) {
  return `Voce e o assistente virtual do META APS, o apoio digital da Atencao Primaria a Saude (a saude da UBS / posto de saude) de um municipio. Voce atende o cidadao no WhatsApp. Voce NAO e profissional de saude.

SEU PAPEL: ACOLHER, ORIENTAR de forma geral e ENCAMINHAR o pedido pra equipe da UBS. Use a ferramenta "info_meta_aps" pra falar de servicos/como funciona/documentos (nunca invente). Use "encaminhar_para_equipe" quando a pessoa quiser marcar consulta, pedir visita do ACS, falar com uma pessoa, fazer reclamacao/elogio, ou quando o caso fugir do que voce pode orientar.

REGRAS INQUEBRAVEIS:
1. NUNCA de diagnostico, nao interprete sintomas, exames ou laudos, nao indique remedio, dose, tratamento ou conduta clinica. Quem avalia e o profissional de saude — ajude a pessoa a buscar atendimento na UBS.
2. EMERGENCIA: se a pessoa relatar sinais graves (dor forte no peito, falta de ar, desmaio, sangramento intenso, sinais de AVC, convulsao, reacao alergica grave, acidente grave, trabalho de parto, ou pensamento de se machucar) oriente IMEDIATAMENTE a ligar 192 (SAMU) ou ir a emergencia/UPA mais proxima AGORA. Em risco de suicidio, oriente tambem o 188 (CVV). Nao tente resolver pelo chat.
3. NUNCA informe dado pessoal de saude (resultado de exame, prontuario, se alguem tem consulta marcada) — pelo WhatsApp nao da pra confirmar a identidade da pessoa (LGPD, dado sensivel). Diga que esse tipo de informacao e so presencial na UBS, com documento.
4. NUNCA invente horario, endereco, telefone, nome de profissional, data de consulta ou regra. Se nao tem certeza, diga que a equipe da UBS confirma — nunca chute.
5. Nao prometa vaga, prazo nem prioridade. Voce registra o pedido; quem confirma e a equipe.

ESTILO:
- Portugues do Brasil, simples, gentil e respeitoso. Mensagens CURTAS de WhatsApp (2 a 5 linhas), COM ACENTUACAO. Pode usar *negrito* do WhatsApp e no maximo 1 emoji.
- Sem jargao medico. Trate por "voce". Pergunte uma coisa de cada vez.
- Nunca use tabela nem titulo markdown (nao renderiza no zap).
- O nome da pessoa no WhatsApp e "${pushName || 'visitante'}" — use quando fizer sentido.
- Deixe sempre claro quando algo e uma SOLICITACAO que a equipe ainda vai confirmar.

Hoje voce so responde texto. Se mandarem audio/foto, peca gentilmente pra escrever.`;
}

// ---------------------------------------------------------------------
// PRINCIPAL — gera a resposta do atendente
// ---------------------------------------------------------------------
async function getApsReply({ phone, text, pushName }) {
  if (!isEnabled()) return { ok: false, skip: 'disabled' };
  const client = getClient();
  if (!client) return { ok: false, error: 'ANTHROPIC_API_KEY ausente' };

  const history = getHistory(phone);
  const messages = [...history.map((m) => ({ role: m.role, content: m.content })), { role: 'user', content: text }];
  const ctx = { phone, pushName, handoff: null };

  try {
    let working = messages;
    let finalText = '';
    for (let hop = 0; hop < 5; hop++) {
      const resp = await client.messages.create({
        model: MODEL,
        max_tokens: 600,
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
      finalText = 'Recebi sua mensagem! Vou encaminhar pra equipe da sua UBS dar sequencia. Se for uma emergencia, ligue 192 (SAMU). 🙂';
    }

    pushHistory(phone, 'user', text);
    pushHistory(phone, 'assistant', finalText);
    return { ok: true, reply: finalText, handoff: ctx.handoff || null };
  } catch (err) {
    console.error('[metaApsAttendant] erro ao gerar resposta:', err.message);
    return { ok: false, error: err.message };
  }
}

// ---------------------------------------------------------------------
// Notificacao do encaminhamento pra equipe da UBS
// ---------------------------------------------------------------------
async function notifyEquipe(customerPhone, handoff) {
  if (!NOTIFY) {
    console.log('[metaApsAttendant] METAAPS_NOTIFY nao configurado — encaminhamento nao enviado:', handoff && handoff.resumo);
    return;
  }
  const tel = formatPhoneBR(customerPhone) || customerPhone;
  const linhas = [
    '🏥 *Novo contato — Meta APS*',
    '',
    `*Cidadao:* ${handoff.nome || 'não informado'}`,
    `*Contato:* wa.me/${tel}`,
    `*Assunto:* ${handoff.assunto}`,
    `*Bairro:* ${handoff.bairro}`,
    '',
    `*Resumo:* ${handoff.resumo}`,
    '',
    '_O atendente virtual já avisou o cidadão que a equipe da UBS vai dar sequência._',
  ];
  const r = await sendEvolutionRaw(NOTIFY, linhas.join('\n'), INSTANCE);
  console.log(`[metaApsAttendant] encaminhamento -> ${NOTIFY}: ${r.ok ? 'OK' : 'FAIL ' + r.error}`);
}

// ---------------------------------------------------------------------
// WEBHOOK — processa um payload da Evolution (instancia do Meta APS)
// Chamado pela rota /api/whatsapp/evolution quando body.instance == INSTANCE.
// ---------------------------------------------------------------------
async function handleMetaApsWebhook(body) {
  const data = Array.isArray(body.data) ? body.data[0] : (body.data || {});
  const key = data.key || {};
  const jid = key.remoteJid || '';
  if (!jid || jid === 'status@broadcast') return;

  // MVP: so atendimento privado (1:1). Grupo e ignorado.
  if (jid.endsWith('@g.us')) return;

  const phone = jid.replace(/[^0-9]/g, '');
  if (!phone) return;

  // Equipe respondeu pelo proprio numero do Meta APS -> humano assumiu, IA sai de cena.
  if (key.fromMe) {
    pauseThread(phone, TAKEOVER_PAUSE_MS);
    console.log(`[metaApsAttendant] humano assumiu ${phone} — IA pausada ${TAKEOVER_PAUSE_MS / 3600000}h`);
    return;
  }

  if (!isEnabled()) {
    console.log(`[metaApsAttendant] IA desligada — ignorando msg de ${phone}`);
    return;
  }
  if (isPaused(phone)) {
    console.log(`[metaApsAttendant] thread ${phone} pausada (humano/encaminhado) — IA em silencio`);
    return;
  }

  const pushName = data.pushName || 'visitante';
  const m = data.message || {};
  const text = (m.conversation || (m.extendedTextMessage && m.extendedTextMessage.text) || '').trim();

  if (!text) {
    await sendEvolutionRaw(phone, 'Oi! No momento consigo te atender por *texto*. Pode escrever sua dúvida? 🙂', INSTANCE).catch(() => {});
    return;
  }

  console.log(`[metaApsAttendant] ${phone} (${pushName}): "${text.slice(0, 120)}"`);
  const result = await getApsReply({ phone, text, pushName });

  if (result.ok && result.reply) {
    const r = await sendEvolutionRaw(phone, result.reply, INSTANCE);
    console.log(`[metaApsAttendant] resposta -> ${phone}: ${r.ok ? 'OK' : 'FAIL ' + r.error}`);
    if (result.handoff) {
      await notifyEquipe(phone, result.handoff);
      pauseThread(phone, HANDOFF_PAUSE_MS); // encaminhado: IA sai, equipe assume
    }
  } else if (!result.skip) {
    console.warn(`[metaApsAttendant] sem resposta p/ ${phone}:`, result.error || 'desconhecido');
  }
}

module.exports = { getApsReply, handleMetaApsWebhook, isEnabled, INSTANCE };
