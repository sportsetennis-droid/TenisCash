const express = require('express');
const rateLimit = require('express-rate-limit');
const jwt = require('jsonwebtoken');
const Anthropic = require('@anthropic-ai/sdk');
const { prisma, JWT_SECRET } = require('../middleware');
const { searchProductsForAI, getProductBySkuForAI } = require('../services/catalogSearch');

const router = express.Router();

const MAX_MESSAGES_PER_CONV = 30;
const SUG_MARKER = '\n|||SUG|||';

const SYSTEM_PROMPT_BASE = `Você é o **Consultor Esportivo Virtual da Sports & Tennis**, rede de 4 lojas em João Pessoa e Campina Grande/PB.

# Identidade
- Tom: profissional, amigável, direto
- Idioma: português brasileiro
- Conhecimento: produtos esportivos, técnicas de corrida, fitness, ciclismo, futebol, basquete, treino funcional, biomecânica básica
- Sempre fala em nome da Sports & Tennis (1ª pessoa do plural quando se referir à loja)

# Comportamento
- Responde em até 200 palavras (objetivo, sem encher linguiça)
- NUNCA inventa produtos - SEMPRE usa search_products() pra buscar no catálogo
- Se não tem o produto perfeito, sugere o mais próximo disponível
- Se cliente perguntar sobre saúde/lesão grave, orienta procurar profissional
- Se pergunta fugir totalmente de esporte, gentilmente recoloca: "Sou especialista em esporte, posso te ajudar com algum produto?"

# Recomendações
- Sempre pergunta sobre: tipo de uso, frequência, peso, pisada (se for tênis de corrida)
- Recomenda 2-3 opções, não só 1 (cliente quer escolher)
- Indica qual é melhor pra qual perfil
- Sempre cita marca + modelo + preço quando usar dados das tools

# Sports & Tennis - DNA das lojas
- LOJA01 - Bessa (Parahyba Mall): DNA Masculino
- LOJA02 - Tambaú (Pirâmide): DNA Feminino
- LOJA03 - Campina Grande (Complexo K): DNA Futebol
- LOJA04 - Tambiá: DNA Geral

# Conhecimento sobre João Pessoa
- JP é a capital do pedestrianismo do Nordeste (35+ provas/ano)
- Comunidade forte de corrida (orla, parques)
- Marcas mais procuradas: Asics, Olympikus, Mizuno (corrida); Nike, Adidas (casual)
- Ticket médio do corredor iniciante: R$ 400-700

# Tools disponíveis
- search_products(query): busca produtos no catálogo (somente com estoque)
- get_product(sku): retorna detalhes completos de um produto pelo SKU

Use as tools sempre que recomendar produto. Não invente nem fale de produtos que não estão no catálogo.

# Formato obrigatório ao final
Após a resposta principal, inclua UMA linha final exatamente neste formato (sem markdown):
|||SUG|||sugestão 1|||sugestão 2|||sugestão 3
As três sugestões são perguntas curtas que o cliente poderia fazer em seguida.`;

function systemPromptForUserType(userType) {
  const adapt =
    userType === 'seller'
      ? `\n# Usuário atual: VENDEDOR\n- Pode dar detalhes técnicos profundos (drop, peso, pisada, tecnologias). Use jargão quando útil.\n`
      : `\n# Usuário atual: CLIENTE ou CONVIDADO\n- Linguagem simples, didática, sem jargão. Explique termos quando necessário. Tom cordial.\n`;
  return SYSTEM_PROMPT_BASE + adapt;
}

function optionalAuth(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    req.userId = null;
    req.userRole = null;
    return next();
  }
  const token = authHeader.split(' ')[1];
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    req.userId = decoded.userId;
    req.userRole = decoded.role;
  } catch {
    req.userId = null;
    req.userRole = null;
  }
  next();
}

function requireAuth(req, res, next) {
  if (!req.userId) return res.status(401).json({ error: 'Faça login para continuar' });
  next();
}

function resolveUserType(role) {
  if (role === 'seller') return 'seller';
  if (role === 'user') return 'client';
  return 'guest';
}

function startOfTodayBrazil() {
  const offsetMin = -180;
  const now = new Date();
  const local = new Date(now.getTime() + offsetMin * 60000);
  const y = local.getUTCFullYear();
  const m = local.getUTCMonth();
  const d = local.getUTCDate();
  const startLocalAsUtc = Date.UTC(y, m, d, 0, 0, 0, 0);
  return new Date(startLocalAsUtc - offsetMin * 60000);
}

function parseMessages(json) {
  if (!json) return [];
  if (Array.isArray(json)) return json;
  try {
    const v = JSON.parse(JSON.stringify(json));
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

async function countUserMessagesSince(userId, sessionKey, userType, since) {
  const where =
    userId != null
      ? { userId, active: true }
      : { userId: null, sessionKey: sessionKey || '_none_', userType: 'guest', active: true };

  const convs = await prisma.aIConversation.findMany({
    where,
    select: { messages: true },
  });

  let n = 0;
  for (const c of convs) {
    const arr = parseMessages(c.messages);
    for (const m of arr) {
      if (m.role === 'user' && m.timestamp && new Date(m.timestamp) >= since) n += 1;
    }
  }
  return n;
}

function sanitizeUserMessage(text) {
  let s = String(text || '').trim();
  if (!s) return '';
  s = s.replace(/ignore (previous|all) instructions/gi, '[redacted]');
  if (s.length > 2000) s = s.slice(0, 2000);
  return s;
}

function parseSuggestionsFromReply(fullText) {
  const text = String(fullText || '');
  const idx = text.lastIndexOf(SUG_MARKER.trim());
  if (idx === -1) return { reply: text.trim(), suggestions: [] };
  const reply = text.slice(0, idx).trim();
  const rest = text.slice(idx + SUG_MARKER.trim().length);
  const parts = rest.split('|||').map((x) => x.trim()).filter(Boolean);
  return { reply, suggestions: parts.slice(0, 3) };
}

function collectProductsFromTools(toolResults) {
  const byId = new Map();
  for (const tr of toolResults) {
    try {
      const data = typeof tr === 'string' ? JSON.parse(tr) : tr;
      if (data.products && Array.isArray(data.products)) {
        for (const p of data.products) {
          if (p && p.id) byId.set(p.id, p);
        }
      }
      if (data.product && data.product.id) {
        byId.set(data.product.id, data.product);
      }
    } catch {
      /* ignore */
    }
  }
  return Array.from(byId.values());
}

const TOOLS = [
  {
    name: 'search_products',
    description:
      'Busca produtos ativos no catálogo Sports & Tennis que possuem estoque. Use termos como marca, modelo, categoria ou palavras do nome.',
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Texto de busca (ex: Asics corrida, tênis casual Nike)' },
      },
      required: ['query'],
    },
  },
  {
    name: 'get_product',
    description: 'Obtém detalhes completos de um produto pelo SKU exato ou código informado no catálogo.',
    input_schema: {
      type: 'object',
      properties: {
        sku: { type: 'string', description: 'SKU do produto' },
      },
      required: ['sku'],
    },
  },
];

async function execTool(name, input) {
  if (name === 'search_products') {
    return searchProductsForAI(input.query);
  }
  if (name === 'get_product') {
    const r = await getProductBySkuForAI(input.sku);
    if (r.error) return { error: r.error };
    return {
      product: r.product,
      longDescription: r.detail?.longDescription,
      features: r.detail?.features,
    };
  }
  return { error: 'Tool desconhecida' };
}

function anthropicClient() {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) throw new Error('ANTHROPIC_API_KEY não configurada');
  return new Anthropic({ apiKey: key });
}

function buildCostBRL(usage) {
  const inM = parseFloat(process.env.AI_PRICE_INPUT_PER_1M || '1');
  const outM = parseFloat(process.env.AI_PRICE_OUTPUT_PER_1M || '5');
  const brl = parseFloat(process.env.BRL_PER_USD || '5.5');
  const inT = usage?.input_tokens || 0;
  const outT = usage?.output_tokens || 0;
  const usd = (inT / 1e6) * inM + (outT / 1e6) * outM;
  return { usd, brl: usd * brl, inT, outT };
}

const chatMinuteLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => (req.userId ? `u:${req.userId}` : `ip:${req.ip}`),
  message: { error: 'Muitas mensagens por minuto. Aguarde um instante.' },
});

router.post('/chat', optionalAuth, chatMinuteLimiter, async (req, res) => {
  try {
    const { message, conversationId, sessionKey: bodySessionKey, context: _ctx } = req.body || {};
    const text = sanitizeUserMessage(message);
    if (!text) return res.status(400).json({ error: 'Mensagem é obrigatória' });

    const userType = resolveUserType(req.userRole);
    const sessionKey =
      userType === 'guest' ? String(bodySessionKey || '').trim() || null : null;

    if (userType === 'guest' && !sessionKey) {
      return res.status(400).json({ error: 'Envie sessionKey (UUID) para usar o consultor como convidado' });
    }

    const dailyLimit =
      userType === 'seller'
        ? parseInt(process.env.AI_DAILY_LIMIT_SELLER || '50', 10)
        : parseInt(process.env.AI_DAILY_LIMIT_CLIENT || '20', 10);

    const t0 = startOfTodayBrazil();
    const usedToday = await countUserMessagesSince(req.userId, sessionKey, userType, t0);
    if (usedToday >= dailyLimit) {
      return res.status(429).json({ error: 'Limite diário de mensagens da IA atingido. Tente amanhã.' });
    }

    let conv = null;
    if (conversationId) {
      conv = await prisma.aIConversation.findFirst({
        where: {
          id: String(conversationId),
          active: true,
          ...(req.userId ? { userId: req.userId } : { sessionKey, userType: 'guest' }),
        },
      });
      if (!conv) return res.status(404).json({ error: 'Conversa não encontrada' });
    } else {
      conv = await prisma.aIConversation.create({
        data: {
          userId: req.userId,
          userType,
          sessionKey,
          title: text.slice(0, 80),
        },
      });
    }

    let msgs = parseMessages(conv.messages);
    if (msgs.length >= MAX_MESSAGES_PER_CONV) {
      return res.status(400).json({ error: 'Esta conversa atingiu o limite de mensagens. Inicie uma nova.' });
    }

    const userEntry = { role: 'user', content: text, timestamp: new Date().toISOString() };
    msgs.push(userEntry);
    await prisma.aIConversation.update({
      where: { id: conv.id },
      data: { messages: msgs, updatedAt: new Date() },
    });

    const model = process.env.AI_MODEL || 'claude-haiku-4-5-20251001';
    const maxTokens = parseInt(process.env.AI_MAX_TOKENS || '400', 10);
    const system = systemPromptForUserType(userType);

    const anthropicMessages = msgs
      .filter((m) => m.role === 'user' || m.role === 'assistant')
      .map((m) => {
        if (m.role === 'user') {
          return { role: 'user', content: m.content };
        }
        return { role: 'assistant', content: m.content };
      });

    const client = anthropicClient();
    let totalIn = 0;
    let totalOut = 0;
    const toolOutputsForCards = [];

    let currentMessages = anthropicMessages.map((m) => ({ ...m }));
    let turn = 0;
    let finalText = '';

    while (turn < 8) {
      turn += 1;
      const resp = await client.messages.create({
        model,
        max_tokens: maxTokens,
        system,
        tools: TOOLS,
        messages: currentMessages,
      });

      totalIn += resp.usage?.input_tokens || 0;
      totalOut += resp.usage?.output_tokens || 0;

      if (resp.stop_reason === 'end_turn' || resp.stop_reason === 'max_tokens') {
        const blocks = resp.content || [];
        const textBlocks = blocks.filter((b) => b.type === 'text').map((b) => b.text);
        finalText = textBlocks.join('\n').trim();
        break;
      }

      if (resp.stop_reason === 'tool_use') {
        const assistantContent = resp.content;
        currentMessages.push({ role: 'assistant', content: assistantContent });

        const toolResults = [];
        for (const block of assistantContent) {
          if (block.type !== 'tool_use') continue;
          const out = await execTool(block.name, block.input);
          toolOutputsForCards.push(out);
          toolResults.push({
            type: 'tool_result',
            tool_use_id: block.id,
            content: JSON.stringify(out),
          });
        }
        currentMessages.push({ role: 'user', content: toolResults });
        continue;
      }

      finalText = 'Não foi possível concluir a resposta. Tente de novo.';
      break;
    }

    const { reply, suggestions } = parseSuggestionsFromReply(finalText);
    const products = collectProductsFromTools(toolOutputsForCards);

    const assistantPersistContent =
      finalText ||
      reply ||
      '(resposta vazia)';

    const fresh = await prisma.aIConversation.findUnique({
      where: { id: conv.id },
      select: { messages: true },
    });
    msgs = parseMessages(fresh.messages);
    msgs.push({
      role: 'assistant',
      content: assistantPersistContent,
      timestamp: new Date().toISOString(),
      products,
    });

    const cost = buildCostBRL({ input_tokens: totalIn, output_tokens: totalOut });

    await prisma.aIConversation.update({
      where: { id: conv.id },
      data: {
        messages: msgs,
        totalTokensIn: { increment: totalIn },
        totalTokensOut: { increment: totalOut },
        totalCostBRL: { increment: cost.brl },
        updatedAt: new Date(),
      },
    });

    res.json({
      conversationId: conv.id,
      reply,
      products,
      suggestions,
    });
  } catch (err) {
    console.error('Erro /api/ai/chat:', err);
    if (err.message && String(err.message).includes('ANTHROPIC_API_KEY')) {
      return res.status(503).json({ error: 'Serviço de IA indisponível (chave não configurada)' });
    }
    res.status(500).json({ error: 'Erro ao processar mensagem. Tente novamente.' });
  }
});

router.get('/conversations', optionalAuth, requireAuth, async (req, res) => {
  try {
    const list = await prisma.aIConversation.findMany({
      where: { userId: req.userId, active: true },
      orderBy: { updatedAt: 'desc' },
      take: 50,
      select: {
        id: true,
        title: true,
        userType: true,
        totalCostBRL: true,
        createdAt: true,
        updatedAt: true,
      },
    });
    res.json({ conversations: list });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Erro ao listar conversas' });
  }
});

router.get('/conversations/:id', optionalAuth, requireAuth, async (req, res) => {
  try {
    const c = await prisma.aIConversation.findFirst({
      where: { id: req.params.id, userId: req.userId, active: true },
    });
    if (!c) return res.status(404).json({ error: 'Conversa não encontrada' });
    res.json({ conversation: c });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Erro ao carregar conversa' });
  }
});

router.delete('/conversations/:id', optionalAuth, requireAuth, async (req, res) => {
  try {
    await prisma.aIConversation.updateMany({
      where: { id: req.params.id, userId: req.userId },
      data: { active: false },
    });
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Erro ao remover conversa' });
  }
});

module.exports = router;
