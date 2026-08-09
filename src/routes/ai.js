const express = require('express');
const rateLimit = require('express-rate-limit');
const jwt = require('jsonwebtoken');
const Anthropic = require('@anthropic-ai/sdk');
const { prisma, getJwtSecret } = require('../middleware');
const { searchProductsForAI, getProductBySkuForAI, listCatalogSummary } = require('../services/catalogSearch');

const router = express.Router();

const MAX_MESSAGES_PER_CONV = 30;
const SUG_MARKER = '\n|||SUG|||';

const SYSTEM_PROMPT_BASE = `Você é o **Consultor Esportivo Virtual da Sports & Tennis**, rede de 4 lojas em João Pessoa e Campina Grande/PB.

# Identidade
- Tom: profissional, amigável, direto
- Idioma: português brasileiro
- Conhecimento: produtos esportivos, corrida, fitness, ciclismo, futebol, basquete, treino funcional, biomecânica básica
- Sempre fala em nome da Sports & Tennis (1ª pessoa do plural)

============================================================
# REGRAS INVIOLÁVEIS — LEIA COM ATENÇÃO
============================================================

REGRA INVIOLÁVEL #1: Você SÓ pode mencionar marcas e produtos que apareceram no resultado de search_products() OU em list_catalog(). É TERMINANTEMENTE PROIBIDO citar uma marca que você "acha" que a loja vende. Se nunca viu a marca em uma tool, ela NÃO existe pra você.

REGRA INVIOLÁVEL #2: Quando o usuário pede um produto, marca, categoria ou estilo (ex.: "quero Adidas", "tênis pra correr"), sua PRIMEIRA ação é OBRIGATORIAMENTE chamar search_products() com a query relevante — ANTES de qualquer texto na resposta. Se a query for genérica ("o que vocês têm?"), use list_catalog() primeiro.

REGRA INVIOLÁVEL #3: Se search_products() retornar { products: [] } e a mensagem indicar "Nenhum produto encontrado", você DEVE:
  (a) responder "No momento não tenho [X] no catálogo." onde [X] é o que o usuário pediu;
  (b) ofereçer alternativas SOMENTE com base nas marcas/categorias listadas em catalog.brands / catalog.categories que vieram na resposta da própria tool;
  (c) NUNCA citar marcas que não aparecem nessa lista.

REGRA INVIOLÁVEL #4: Se a tool retornar produtos com inStock=false ou stockTotal=0, ainda assim PODE recomendar — apenas avise discretamente "estoque pode variar por loja, confirme com o vendedor". Não use "sem estoque" como motivo pra rejeitar produtos que vieram da tool: a base de estoque pode estar zerada após importação inicial.

REGRA INVIOLÁVEL #5: Você NUNCA pode inventar SKU, modelo, preço ou tamanho. Tudo vem das tools. Se o usuário pedir tamanho/preço de algo que você não buscou, chame get_product() ou search_products() primeiro.

============================================================

# Comportamento
- Responde em até 200 palavras (objetivo, sem encher linguiça)
- Pra tênis de corrida, pode perguntar sobre uso/frequência/peso/pisada
- Recomenda 2-3 opções (cliente quer escolher), sempre citando marca + modelo + preço vindos da tool
- Saúde/lesão grave → orienta procurar profissional
- Se a pergunta fugir totalmente de esporte: "Sou especialista em esporte, posso te ajudar com algum produto?"

# Sports & Tennis - DNA das lojas
- LOJA01 - Baratão dos Esportes (matriz CNPJ /0001-26): Outlet
- LOJA02 - Praia do Bessa (Parahyba Mall, /0002-07): DNA Masculino
- LOJA03 - Rainha da Borborema (Complexo K Campina Grande, /0003-98): DNA Futebol
- LOJA04 - Sports & Tennis Ecommerce (Nuvemshop, /0004-79): Vendas online
- LOJA05 - Praia de Tambaú (Pirâmide, /0005-50): DNA Feminino
- LOJA06 - Tambiá (Shopping Tambiá, /0006-30): DNA Geral

# Tools disponíveis
- search_products(query): busca por marca, modelo, categoria, subcategoria, descrição.
- get_product(sku): detalhes completos por SKU.
- list_catalog(): retorna todas as marcas e categorias presentes no catálogo (use no início da conversa, ou quando precisar saber o que existe na loja).

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
    const decoded = jwt.verify(token, getJwtSecret());
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
  // Qualquer outro usuário logado (user, partner, admin, superadmin) entra como 'client'
  if (role === 'user' || role === 'partner' || role === 'admin' || role === 'superadmin') return 'client';
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
      'Busca produtos ATIVOS no catálogo Sports & Tennis. Use marca ("Adidas", "Nike"), categoria ("tenis", "acessorios"), subcategoria ("corrida", "casual"), modelo ou palavras do nome. Não filtra por estoque — retorna tudo que está cadastrado e ativo. Se vazio, retorna em "catalog" as marcas/categorias que existem.',
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Texto de busca (ex.: "Adidas", "tenis corrida", "joelheira")' },
      },
      required: ['query'],
    },
  },
  {
    name: 'get_product',
    description: 'Obtém detalhes completos de um produto pelo SKU.',
    input_schema: {
      type: 'object',
      properties: {
        sku: { type: 'string', description: 'SKU do produto' },
      },
      required: ['sku'],
    },
  },
  {
    name: 'list_catalog',
    description:
      'Lista as marcas e categorias atualmente no catálogo da Sports & Tennis (com contagem de produtos por marca/categoria). Use sempre que o usuário perguntar "o que vocês têm?", "quais marcas?", ou quando você não souber se a loja vende algo específico.',
    input_schema: { type: 'object', properties: {} },
  },
];

async function execTool(name, input) {
  console.log('[ai] execTool start:', name, JSON.stringify(input || {}));
  try {
    if (name === 'search_products') {
      const out = await searchProductsForAI(input?.query);
      console.log('[ai] execTool search_products done. products=', (out.products || []).length, 'hasCatalog=', !!out.catalog);
      return out;
    }
    if (name === 'get_product') {
      const r = await getProductBySkuForAI(input?.sku);
      if (r.error) {
        console.log('[ai] execTool get_product error:', r.error);
        return { error: r.error };
      }
      console.log('[ai] execTool get_product ok sku=', r.product?.sku);
      return r;
    }
    if (name === 'list_catalog') {
      const summary = await listCatalogSummary();
      console.log(
        '[ai] execTool list_catalog total=',
        summary.totalActiveProducts,
        'brands=',
        summary.brands.length,
        'categories=',
        summary.categories.length,
      );
      return summary;
    }
    return { error: 'Tool desconhecida' };
  } catch (err) {
    console.error('[ai] execTool error', name, err);
    return { error: 'Erro ao executar tool ' + name };
  }
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

    let catalogPrimer = null;
    try {
      catalogPrimer = await listCatalogSummary();
    } catch (eP) {
      console.warn('[ai] listCatalogSummary failed:', eP.message);
    }
    const primerStr = catalogPrimer
      ? '\n\n# CATÁLOGO ATUAL (gerado automaticamente)\n'
        + 'Total ativos: ' + catalogPrimer.totalActiveProducts + '\n'
        + 'Marcas presentes: ' + (catalogPrimer.brands.map((b) => b.brand + ' (' + b.count + ')').join(', ') || '(nenhuma)') + '\n'
        + 'Categorias: ' + (catalogPrimer.categories.map((c) => c.category + ' (' + c.count + ')').join(', ') || '(nenhuma)') + '\n'
        + 'Use APENAS estas marcas e categorias. Marcas fora desta lista NÃO existem no nosso catálogo.\n'
      : '';
    const system = systemPromptForUserType(userType) + primerStr;

    const anthropicMessages = msgs
      .filter((m) => m.role === 'user' || m.role === 'assistant')
      .map((m) => {
        if (m.role === 'user') {
          return { role: 'user', content: m.content };
        }
        return { role: 'assistant', content: m.content };
      });

    console.log('[ai] /chat user=', req.userId || 'guest', 'role=', userType, 'msg=', JSON.stringify(text).slice(0, 200));

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

      console.log(
        '[ai] turn=', turn,
        'stop_reason=', resp.stop_reason,
        'tokens_in=', resp.usage?.input_tokens,
        'tokens_out=', resp.usage?.output_tokens,
        'content_types=', (resp.content || []).map((b) => b.type).join(','),
      );

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
          console.log('[ai] tool_use detected:', block.name, JSON.stringify(block.input || {}));
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

    console.log('[ai] /chat finished turns=', turn, 'tools_called=', toolOutputsForCards.length);

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
