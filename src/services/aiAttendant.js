// =====================================================================
// AI Attendant — atendente de WhatsApp da Sports & Tennis (Claude)
// =====================================================================
// Responde AUTOMATICAMENTE no WhatsApp da loja (instancia Evolution).
// Usa ferramentas que leem DADOS REAIS (catalogo, estoque, cashback).
// REGRA DE OURO: nunca inventa preco/estoque/tamanho — so o que a tool traz.
//
// Liga/desliga: env AI_ATTENDANT_ENABLED ('false' desliga). Default = ligado.
// Modelo: env AI_ATTENDANT_MODEL (default claude-haiku-4-5-20251001).
// =====================================================================

const Anthropic = require('@anthropic-ai/sdk');
const { prisma } = require('../middleware');
const { formatPhoneBR } = require('../whatsapp');
const { searchProductsForAI } = require('./catalogSearch');

const MODEL = process.env.AI_ATTENDANT_MODEL || 'claude-haiku-4-5-20251001';
const HISTORY_TTL_MS = 30 * 60 * 1000; // 30 min de janela de conversa
const MAX_HISTORY = 12; // ultimas N mensagens (user+assistant) guardadas

function isEnabled() {
  return String(process.env.AI_ATTENDANT_ENABLED || 'true').toLowerCase() !== 'false';
}

function getClient() {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return null;
  return new Anthropic({ apiKey: key });
}

// Historico curto em memoria por telefone (sessao de conversa).
// Perde no restart — aceitavel p/ atendimento (conversa e curta). Persistir depois.
const sessions = new Map();

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

function clearSession(phone) {
  sessions.delete(phone);
}

// ---------------------------------------------------------------------
// FERRAMENTAS (Claude tool use) — todas leem dados REAIS do banco
// ---------------------------------------------------------------------
const TOOLS = [
  {
    name: 'buscar_produtos',
    description:
      'Busca produtos no catalogo REAL da Sports & Tennis por nome, marca, categoria ou modelo. ' +
      'Retorna nome, marca, preco, preco promocional e os tamanhos COM estoque. ' +
      'Use SEMPRE que o cliente perguntar sobre um produto, modelo, marca ou tamanho. ' +
      'NUNCA invente produto/preco/tamanho — so existe o que esta tool retornar.',
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'O que buscar. Ex: "tenis nike", "chuteira", "camisa do brasil", "mizuno wave"' },
      },
      required: ['query'],
    },
  },
  {
    name: 'consultar_cashback',
    description:
      'Consulta o saldo de TenisCash (cashback) do cliente que esta conversando, pelo telefone dele. ' +
      'Use quando o cliente perguntar do saldo/cashback/pontos, ou pra mencionar quanto ele tem ao falar de uma compra.',
    input_schema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'info_loja',
    description: 'Retorna informacoes fixas da loja (lojas fisicas, site, canais). Use pra duvidas de onde fica / como comprar.',
    input_schema: { type: 'object', properties: {}, required: [] },
  },
];

function resumoProdutos(result) {
  const prods = (result && result.products) || [];
  if (!prods.length) {
    return { encontrados: 0, mensagem: result?.message || 'Nenhum produto encontrado.', nota: result?.note || null };
  }
  const lista = prods.slice(0, 8).map((p) => ({
    nome: p.name,
    marca: p.brand,
    preco: p.price,
    preco_promocional: p.promoPrice || null,
    tamanhos_disponiveis: (p.availableSizes || []).map((s) => s.size),
    tem_estoque: p.inStock,
  }));
  return { encontrados: prods.length, produtos: lista, nota: result?.note || null };
}

async function runTool(name, input, ctx) {
  try {
    if (name === 'buscar_produtos') {
      const r = await searchProductsForAI(input?.query || '');
      return resumoProdutos(r);
    }
    if (name === 'consultar_cashback') {
      const phoneFmt = formatPhoneBR(ctx.phone);
      let user = null;
      if (phoneFmt) {
        user = await prisma.user.findUnique({ where: { phone: phoneFmt }, select: { name: true, balance: true } });
      }
      if (!user) return { cadastrado: false, mensagem: 'Cliente ainda nao tem cadastro no TenisCash por este numero.' };
      return { cadastrado: true, nome: user.name, saldo_teniscash: user.balance || 0 };
    }
    if (name === 'info_loja') {
      return {
        lojas_fisicas: ['Bessa', 'Tambau', 'Rainha da Borborema', 'Tambia'],
        cidade: 'Joao Pessoa - PB',
        site: 'https://www.sportsetennis.com.br',
        observacao: 'Para horario exato de cada loja, confirme com a equipe.',
      };
    }
    return { erro: 'ferramenta desconhecida' };
  } catch (err) {
    console.error('[aiAttendant] erro na tool', name, err.message);
    return { erro: 'Nao consegui consultar agora. Tente de novo em instantes.' };
  }
}

// ---------------------------------------------------------------------
// SYSTEM PROMPT — persona + regras duras (anti-erro)
// ---------------------------------------------------------------------
function buildSystem(pushName) {
  return `Voce e o atendente virtual da SPORTS & TENNIS, uma rede de lojas de tenis e artigos esportivos em Joao Pessoa - PB (lojas no Bessa, Tambau, Rainha da Borborema e Tambia) com loja online e o programa de cashback TenisCash.

Voce atende clientes no WhatsApp. Seja simpatico, direto e prestativo, como um bom vendedor de loja — sem ser chato nem prolixo.

REGRAS INQUEBRAVEIS:
1. NUNCA invente preco, estoque, tamanho, prazo, cor ou qualquer dado. Use SEMPRE a ferramenta buscar_produtos para falar de produto/preco/tamanho. Se a ferramenta nao retornar o que o cliente quer, diga com honestidade que vai confirmar com a equipe — NUNCA chute.
2. NUNCA prometa desconto, frete gratis, brinde ou condicao especial por conta propria. Se o cliente pedir desconto, fale das vantagens do cashback TenisCash e diga que condicoes especiais voce confirma com a equipe.
3. Para FECHAR a compra: oriente o cliente a finalizar pela loja online (https://www.sportsetennis.com.br) OU a passar numa loja fisica. Se for algo que precisa de uma pessoa (negociar, problema com pedido, troca/devolucao, reclamacao), diga que vai chamar um atendente da equipe.
4. So fale de tamanho que aparece como DISPONIVEL na ferramenta. Se o tamanho que o cliente quer nao esta disponivel, diga isso e ofereca alternativas reais.
5. Mencione o cashback TenisCash quando fizer sentido (o cliente ganha cashback comprando).

ESTILO:
- Respostas CURTAS, de WhatsApp (2 a 5 linhas no maximo). Nada de textao.
- PT-BR informal. Pode usar *negrito* do WhatsApp e no maximo 1-2 emojis por mensagem.
- Nunca use tabelas nem markdown de titulo. E uma conversa de WhatsApp.
- Trate o cliente pelo nome quando souber (o nome no WhatsApp e "${pushName || 'cliente'}").
- Se a pergunta nao tiver nada a ver com a loja, responda educadamente que voce e o atendimento da Sports & Tennis.

Hoje voce so consegue responder texto. Se o cliente mandar audio/foto, peca gentilmente para escrever.`;
}

// ---------------------------------------------------------------------
// PRINCIPAL — gera a resposta do atendente para uma mensagem recebida
// ---------------------------------------------------------------------
async function getAttendantReply({ phone, text, pushName }) {
  if (!isEnabled()) return { ok: false, skip: 'disabled' };
  const client = getClient();
  if (!client) return { ok: false, error: 'ANTHROPIC_API_KEY ausente' };

  const history = getHistory(phone);
  const messages = [...history.map((m) => ({ role: m.role, content: m.content })), { role: 'user', content: text }];
  const ctx = { phone, pushName };

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
      finalText = 'Recebi sua mensagem! Em instantes um atendente da Sports & Tennis te responde. 🙂';
    }

    pushHistory(phone, 'user', text);
    pushHistory(phone, 'assistant', finalText);
    return { ok: true, reply: finalText };
  } catch (err) {
    console.error('[aiAttendant] erro ao gerar resposta:', err.message);
    return { ok: false, error: err.message };
  }
}

module.exports = { getAttendantReply, isEnabled, clearSession };
