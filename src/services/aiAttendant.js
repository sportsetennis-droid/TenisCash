// =====================================================================
// AI Attendant — atendente de WhatsApp (Claude), MULTI-PERFIL
// =====================================================================
// Responde AUTOMATICAMENTE no WhatsApp da loja (instancia Evolution).
// Usa ferramentas que leem DADOS REAIS (catalogo, estoque, cashback).
// REGRA DE OURO: nunca inventa preco/estoque/tamanho — so o que a tool traz.
//
// PERFIS (cada numero/instancia tem o seu):
//   'st'      -> Sports & Tennis (cliente NAO ve o estoque do Baratao; grupo de vendedores ve tudo)
//   'baratao' -> Baratao dos Esportes (ve SO o estoque da loja Baratao / LOJA01)
// O perfil chega em getAttendantReply({ profile }) — default 'st' (comportamento legado).
//
// Liga/desliga geral: env AI_ATTENDANT_ENABLED ('false' desliga). Default = ligado.
// Liga/desliga so o Baratao: env AI_ATTENDANT_BARATAO_ENABLED ('false' desliga so ele).
// Modelo: env AI_ATTENDANT_MODEL (default claude-sonnet-4-6 — rigor no cruzamento de estoque;
//   haiku afirmava tamanho fantasma que so existia no comprado/NFe).
// =====================================================================

const Anthropic = require('@anthropic-ai/sdk');
const { prisma } = require('../middleware');
const { formatPhoneBR } = require('../whatsapp');
const { searchProductsForAI, resolveProductLink } = require('./catalogSearch');
const { rateIntent } = require('./intentRater');

// ---------------------------------------------------------------------
// MODELO — provider-AGNOSTICO. O atendente NAO depende mais de API paga.
//   1) Se AI_ATTENDANT_BASE_URL estiver setado (nosso modelo proprio,
//      ex Ollama/vLLM numa maquina nossa com GPU, OpenAI-compativel) -> usa ele.
//   2) Senao, se houver ANTHROPIC_API_KEY com credito -> usa Anthropic.
//   3) Se nada responder (sem chave / sem credito / erro) -> cai no MOTOR
//      PROPRIO deterministico (localReply) que responde direto do BANCO,
//      sem nenhuma API. So formata o que a ferramenta traz (nunca inventa).
// ---------------------------------------------------------------------
const LLM_BASE_URL = (process.env.AI_ATTENDANT_BASE_URL || '').replace(/\/$/, ''); // ex http://nossa-gpu:11434/v1
const LLM_API_KEY = process.env.AI_ATTENDANT_API_KEY || process.env.OPENAI_API_KEY || 'sk-local';
const LLM_PROVIDER = process.env.AI_ATTENDANT_PROVIDER
  || (LLM_BASE_URL ? 'openai' : (process.env.ANTHROPIC_API_KEY ? 'anthropic' : 'none'));
const MODEL = process.env.AI_ATTENDANT_MODEL || (LLM_PROVIDER === 'openai' ? 'qwen2.5:7b-instruct' : 'claude-sonnet-4-6');
const HISTORY_TTL_MS = 30 * 60 * 1000; // 30 min de janela de conversa
const MAX_HISTORY = 12; // ultimas N mensagens (user+assistant) guardadas

function isEnabled() {
  return String(process.env.AI_ATTENDANT_ENABLED || 'true').toLowerCase() !== 'false';
}

// Kill switch so do Baratao (sobre o geral). Se o geral estiver off, tudo off.
function isProfileEnabled(profileKey) {
  if (!isEnabled()) return false;
  if (profileKey === 'baratao') {
    return String(process.env.AI_ATTENDANT_BARATAO_ENABLED || 'true').toLowerCase() !== 'false';
  }
  return true;
}

function llmConfigured() {
  return LLM_PROVIDER === 'anthropic' || LLM_PROVIDER === 'openai';
}
let _anthropic = null;
function anthropicClient() {
  if (!process.env.ANTHROPIC_API_KEY) return null;
  if (!_anthropic) _anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  return _anthropic;
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
// LOJA — quem e o Baratao (LOJA01 / CNPJ 0001-26)
// O catalogo (Product) e COMPARTILHADO pelo grupo todo; a separacao entre
// Baratao e Sports & Tennis e por LOJA no StoreStock, nao por catalogo.
// ehBaratao casa pelo code canonico (LOJA01) e, por seguranca, pelo nome.
// ---------------------------------------------------------------------
function ehBaratao(st) {
  if (!st) return false;
  if (st.code === 'LOJA01') return true;
  return /barat/i.test(st.name || '') || /barat/i.test(st.neighborhood || '');
}

// ---------------------------------------------------------------------
// PERFIS — tudo que difere entre os robos (loja, persona, link, filtro)
// ---------------------------------------------------------------------
const PROFILES = {
  st: {
    key: 'st',
    brand: 'Sports & Tennis',
    linkPrefix: '/p/',
    hasGroup: true,
    hasCashback: true,
    // Cliente da S&T NAO ve o Baratao; no grupo de vendedores ve tudo.
    storeAllowed: (store, { isGroup } = {}) => isGroup || !ehBaratao(store),
    infoLoja: () => ({
      lojas_fisicas: ['Bessa', 'Tambau', 'Rainha da Borborema', 'Tambia'],
      cidade: 'Joao Pessoa - PB',
      site: 'https://www.sportsetennis.com.br',
      observacao: 'Para horario exato de cada loja, confirme com a equipe.',
    }),
  },
  baratao: {
    key: 'baratao',
    brand: 'Baratao dos Esportes',
    linkPrefix: '/b/',
    hasGroup: false,
    hasCashback: true,
    // Robo do Baratao ve SO o estoque da loja Baratao (LOJA01).
    storeAllowed: (store) => ehBaratao(store),
    infoLoja: () => ({
      loja: 'Baratao dos Esportes',
      cidade: 'Joao Pessoa - PB',
      // Endereco/horario NAO se inventa — vem de env quando o dono passar.
      endereco: process.env.BARATAO_ENDERECO || null,
      site: process.env.BARATAO_SITE || null,
      observacao: 'Para endereco exato e horario, confirme com a equipe.',
    }),
  },
};

function getProfile(profileKey) {
  return PROFILES[profileKey] || PROFILES.st;
}

// ---------------------------------------------------------------------
// FERRAMENTAS (Claude tool use) — todas leem dados REAIS do banco
// As tools sao montadas por perfil (texto da marca + cashback on/off).
// ---------------------------------------------------------------------
function buildTools(profile) {
  const tools = [
    {
      name: 'buscar_produtos',
      description:
        `Busca produtos no catalogo REAL da ${profile.brand} por nome, marca ou modelo. ` +
        'Retorna nome, marca, preco, e os tamanhos com a(s) LOJA(s) onde cada tamanho esta. ' +
        'Use SEMPRE que perguntarem sobre um produto, modelo, marca, tamanho ou loja. ' +
        'IMPORTANTE: se a tool retornar o produto, ele EXISTE — confira o tamanho pedido no campo "tamanhos" (cada um traz "lojas"). ' +
        'NUNCA diga que nao tem sem ter buscado. NUNCA invente produto/preco/tamanho/loja.',
      input_schema: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description:
              'SO o modelo/marca, SEM o numero do tamanho. Ex: "bondi 9", "tenis nike", "chuteira", "mizuno wave". ' +
              'Busque "bondi 9" e NUNCA "bondi 9 42" — o tamanho voce confere no resultado, nao na busca.',
          },
        },
        required: ['query'],
      },
    },
  ];

  if (profile.hasCashback) {
    tools.push({
      name: 'consultar_cashback',
      description:
        'Consulta o saldo de cashback do cliente que esta conversando, pelo telefone dele. ' +
        'Use quando o cliente perguntar do saldo/cashback/pontos, ou pra mencionar quanto ele tem ao falar de uma compra.',
      input_schema: { type: 'object', properties: {}, required: [] },
    });
  }

  tools.push({
    name: 'info_loja',
    description: 'Retorna informacoes fixas da loja (lojas fisicas, site, canais). Use pra duvidas de onde fica / como comprar.',
    input_schema: { type: 'object', properties: {}, required: [] },
  });

  return tools;
}

function lojasDoTamanho(s, { isGroup, profile } = {}) {
  return (s.storeStocks || [])
    .filter((ss) => (ss.stock || 0) > 0)
    .filter((ss) => profile.storeAllowed(ss.store, { isGroup })) // filtro por perfil de loja
    .map((ss) => {
      const st = ss.store || {};
      const nome = st.neighborhood || st.name || st.code || 'loja';
      return { loja: nome, qtd: ss.stock };
    });
}

// REGRA DO DONO: estoque que vale e o que ESTA NA LOJA (StoreStock = localizado/bipado).
// NUNCA o comprado (ProductSize.stock = NFe de compra). So entra tamanho com loja > 0.
function tamanhosEmLoja(p, opts) {
  return (p.sizes || [])
    .map((s) => ({ tamanho: s.size, lojas: lojasDoTamanho(s, opts) }))
    .filter((t) => t.lojas.length > 0);
}

function resumoProdutos(result, opts = {}) {
  const { profile } = opts;
  const prods = (result && result.products) || [];
  if (!prods.length) {
    return { encontrados: 0, mensagem: result?.message || 'Nenhum produto encontrado.' };
  }
  const lista = prods.slice(0, 8).map((p) => {
    const tamanhos = tamanhosEmLoja(p, opts);
    return {
      nome: p.name,
      marca: p.brand,
      preco: p.price,
      preco_promocional: p.promoPrice || null,
      link: resolveProductLink(p.id, p.name, profile.linkPrefix), // pagina do produto (card) p/ mandar pro cliente
      tamanhos_em_loja: tamanhos.map((t) => t.tamanho), // lista simples p/ cruzar o tamanho pedido
      tamanhos_disponiveis: tamanhos, // detalhe: cada tamanho com loja(s) + qtd (SO o que tem NA LOJA)
      tem_em_loja: tamanhos.length > 0,
    };
  });
  return { encontrados: prods.length, produtos: lista };
}

async function runTool(name, input, ctx) {
  const { profile } = ctx;
  try {
    if (name === 'buscar_produtos') {
      const r = await searchProductsForAI(input?.query || '');
      return resumoProdutos(r, { isGroup: ctx.isGroup, profile });
    }
    if (name === 'consultar_cashback') {
      const phoneFmt = formatPhoneBR(ctx.phone);
      let user = null;
      if (phoneFmt) {
        user = await prisma.user.findUnique({ where: { phone: phoneFmt }, select: { name: true, balance: true } });
      }
      if (!user) return { cadastrado: false, mensagem: 'Cliente ainda nao tem cadastro por este numero.' };
      return { cadastrado: true, nome: user.name, saldo_cashback: user.balance || 0 };
    }
    if (name === 'info_loja') {
      return profile.infoLoja();
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
// Prompt para o GRUPO de vendedores (modo vendedor + regra de silencio) — SO Sports & Tennis
function buildGroupSystem(senderName) {
  return `Voce e a inteligencia artificial da SPORTS & TENNIS, presente num GRUPO DE WHATSAPP de vendedores e gerencia (lojas Sports & Tennis e Baratao dos Esportes).

Voce LE todas as mensagens do grupo, mas SO RESPONDE quando a mensagem for DIRECIONADA A VOCE: uma pergunta sobre produto, estoque, preco ou tamanho da Sports & Tennis, OU quando te chamarem/mencionarem diretamente.

REGRA DE SILENCIO (CRITICA): se a mensagem for conversa entre os vendedores que NAO precisa de voce (bate-papo, "bom dia", combinacao de horario, piada, recado interno, conversa entre eles), responda EXATAMENTE com [SILENCIO] e mais NADA. Na duvida, fique em [SILENCIO]. E MUITO melhor ficar quieto do que responder o que nao era pra voce e poluir o grupo.

QUANDO VOCE RESPONDE (modo vendedor, NAO cliente):
- Seja DIRETO e operacional. Eles sao a equipe, nao clientes. SEM papo de venda, SEM "quer que eu separe?", SEM oferecer cashback pra eles.
- De a info pedida: estoque por tamanho, preco, modelos disponiveis — usando SEMPRE a ferramenta buscar_produtos. NUNCA invente preco, tamanho ou estoque.
- ESTOQUE = LOJA. O que vale e a lista "tamanhos_em_loja" (so o que TEM FISICAMENTE NA LOJA, por bipe). O "comprado"/NFe NAO conta. Se te perguntarem por um tamanho especifico, confira se ele esta em "tamanhos_em_loja": se nao estiver, diga que NAO tem em loja (nunca cite o comprado como se fosse disponivel). SEMPRE diga em QUAL LOJA esta cada tamanho (campo "lojas": Bessa, Tambau, Rainha da Borborema, Tambia + a quantidade).
- LINK: cada produto traz o campo "link" (pagina do produto com foto/preco/lojas). Ao passar um produto, mande tambem esse link, exatamente como veio.
- Resposta curta e objetiva, como um colega que sabe o sistema de cor.
- Formato WhatsApp: NUNCA use tabela nem markdown de titulo (nao renderizam no zap) — use linhas curtas e *negrito*.
- Voce SO tem o catalogo da SPORTS & TENNIS. Se perguntarem de produto do BARATAO, diga que ainda nao tem o catalogo do Baratao no sistema.
- Quem falou no grupo se chama "${senderName || 'colega'}".`;
}

// Prompt do CLIENTE — Sports & Tennis (texto legado, mantido)
function buildClientSystemST(pushName) {
  return `Voce e o atendente virtual da SPORTS & TENNIS, uma rede de lojas de tenis e artigos esportivos em Joao Pessoa - PB (lojas no Bessa, Tambau, Rainha da Borborema e Tambia) com loja online e o programa de cashback TenisCash.

Voce atende clientes no WhatsApp. Seja simpatico, direto e prestativo, como um bom vendedor de loja — sem ser chato nem prolixo.

REGRAS INQUEBRAVEIS:
1. NUNCA invente preco, estoque, tamanho, prazo, cor ou qualquer dado. Use SEMPRE a ferramenta buscar_produtos para falar de produto/preco/tamanho. Se a ferramenta nao retornar o que o cliente quer, diga com honestidade que vai confirmar com a equipe — NUNCA chute.
2. NUNCA prometa desconto, frete gratis, brinde ou condicao especial por conta propria. Se o cliente pedir desconto, fale das vantagens do cashback TenisCash e diga que condicoes especiais voce confirma com a equipe.
3. Para FECHAR a compra: oriente o cliente a finalizar pela loja online (https://www.sportsetennis.com.br) OU a passar numa loja fisica. Se for algo que precisa de uma pessoa (negociar, problema com pedido, troca/devolucao, reclamacao), diga que vai chamar um atendente da equipe.
4. ESTOQUE = LOJA (A REGRA MAIS IMPORTANTE). O UNICO estoque que vale e o campo "tamanhos_em_loja" (a lista dos tamanhos que TEM FISICAMENTE NA LOJA, por bipe). O "comprado"/NFe NAO conta — ignore. Quando o cliente pedir um tamanho especifico, siga este processo SEM EXCECAO:
   a) Olhe a lista "tamanhos_em_loja" do produto.
   b) O numero que o cliente pediu esta nessa lista? Se SIM: confirme ("temos sim, o 42") e diga a loja. Se NAO (mesmo que o produto exista no catalogo): diga claramente "no momento nao temos o [tamanho] disponivel nas lojas" e ofereca os tamanhos que ESTAO em tamanhos_em_loja.
   NUNCA diga "temos o [tamanho]" se esse numero NAO esta em "tamanhos_em_loja". Na duvida, diga que confirma com a equipe — nunca afirme por otimismo.
5. Mencione o cashback TenisCash quando fizer sentido (o cliente ganha cashback comprando).
6. LOJA — cada tamanho em "tamanhos_disponiveis" traz "lojas" (em qual loja tem e quanto). Quando o cliente perguntar onde encontra / em qual loja, ou ao confirmar que tem, DIGA a loja (ex: "tem no Bessa e no Tambau"). NUNCA invente a loja.
7. LINK — cada produto traz o campo "link" (a pagina do produto: foto, preco e em quais lojas tem). Quando recomendar ou confirmar um produto, MANDE esse link pro cliente ver os detalhes. Mande o link EXATAMENTE como veio (nao encurte, nao troque, nao invente).
8. Voce atende SO as lojas Sports & Tennis (Bessa, Tambau, Rainha da Borborema, Tambia e a loja online). NUNCA cite "Baratao dos Esportes" pro cliente — e OUTRA empresa, com OUTRO WhatsApp de atendimento. Os dados ja chegam sem o Baratao; se um produto so tiver estoque la, pra voce ele esta INDISPONIVEL (trate como sem estoque e ofereca alternativa real).

ESTILO:
- Respostas CURTAS, de WhatsApp (2 a 5 linhas no maximo). Nada de textao.
- PT-BR informal. Pode usar *negrito* do WhatsApp e no maximo 1-2 emojis por mensagem.
- Nunca use tabelas nem markdown de titulo. E uma conversa de WhatsApp.
- Trate o cliente pelo nome quando souber (o nome no WhatsApp e "${pushName || 'cliente'}").
- Se a pergunta nao tiver nada a ver com a loja, responda educadamente que voce e o atendimento da Sports & Tennis.

Hoje voce so consegue responder texto. Se o cliente mandar audio/foto, peca gentilmente para escrever.`;
}

// Prompt do CLIENTE — Baratao dos Esportes (loja popular, foco em preco)
function buildClientSystemBaratao(pushName) {
  return `Voce e o atendente virtual do BARATAO DOS ESPORTES, uma loja de artigos esportivos em Joao Pessoa - PB, conhecida pelo PRECO BAIXO e bom custo-beneficio. Tem programa de cashback (o cliente ganha cashback comprando).

Voce atende clientes no WhatsApp. Seja simpatico, animado e direto, como um bom vendedor de loja popular — sem ser chato nem prolixo. O foco do Baratao e PRECO BOM.

REGRAS INQUEBRAVEIS:
1. NUNCA invente preco, estoque, tamanho, prazo, cor ou qualquer dado. Use SEMPRE a ferramenta buscar_produtos para falar de produto/preco/tamanho. Se a ferramenta nao retornar o que o cliente quer, diga com honestidade que vai confirmar com a equipe — NUNCA chute.
2. NUNCA prometa desconto, frete gratis, brinde ou condicao especial por conta propria. Se o cliente pedir desconto, fale do cashback e diga que condicoes especiais voce confirma com a equipe.
3. Para FECHAR a compra: oriente o cliente a ver os detalhes no LINK do produto e a passar na loja Baratao dos Esportes. Se for algo que precisa de uma pessoa (negociar, problema com pedido, troca/devolucao, reclamacao), diga que vai chamar um atendente da equipe.
4. ESTOQUE = LOJA (A REGRA MAIS IMPORTANTE). O UNICO estoque que vale e o campo "tamanhos_em_loja" (a lista dos tamanhos que TEM FISICAMENTE NA LOJA BARATAO, por bipe). O "comprado"/NFe NAO conta — ignore. Quando o cliente pedir um tamanho especifico, siga este processo SEM EXCECAO:
   a) Olhe a lista "tamanhos_em_loja" do produto.
   b) O numero que o cliente pediu esta nessa lista? Se SIM: confirme ("temos sim, o 42"). Se NAO (mesmo que o produto exista no catalogo): diga claramente "no momento nao temos o [tamanho]" e ofereca os tamanhos que ESTAO em tamanhos_em_loja.
   NUNCA diga "temos o [tamanho]" se esse numero NAO esta em "tamanhos_em_loja". Na duvida, diga que confirma com a equipe — nunca afirme por otimismo.
5. Mencione o cashback quando fizer sentido (o cliente ganha cashback comprando no Baratao).
6. LINK — cada produto traz o campo "link" (a pagina do produto: foto, preco e disponibilidade no Baratao). Quando recomendar ou confirmar um produto, MANDE esse link pro cliente ver os detalhes. Mande o link EXATAMENTE como veio (nao encurte, nao troque, nao invente).
7. Voce atende SO o BARATAO DOS ESPORTES. NUNCA cite "Sports & Tennis" pro cliente — e OUTRA empresa. Os dados ja chegam so com o estoque do Baratao.

ESTILO:
- Respostas CURTAS, de WhatsApp (2 a 5 linhas no maximo). Nada de textao.
- PT-BR informal e animado. Pode usar *negrito* do WhatsApp e no maximo 1-2 emojis por mensagem.
- Nunca use tabelas nem markdown de titulo. E uma conversa de WhatsApp.
- Trate o cliente pelo nome quando souber (o nome no WhatsApp e "${pushName || 'cliente'}").
- Se a pergunta nao tiver nada a ver com a loja, responda educadamente que voce e o atendimento do Baratao dos Esportes.

Hoje voce so consegue responder texto. Se o cliente mandar audio/foto, peca gentilmente para escrever.`;
}

function buildSystem(profile, name, isGroup) {
  if (isGroup && profile.hasGroup) return buildGroupSystem(name);
  if (profile.key === 'baratao') return buildClientSystemBaratao(name);
  return buildClientSystemST(name);
}

// ---------------------------------------------------------------------
// DRIVER ANTHROPIC — loop de tool-use (so roda se houver chave+credito)
// ---------------------------------------------------------------------
async function runAnthropic(system, messages, tools, ctx) {
  const client = anthropicClient();
  if (!client) throw new Error('sem ANTHROPIC_API_KEY');
  let working = messages;
  for (let hop = 0; hop < 5; hop++) {
    const resp = await client.messages.create({ model: MODEL, max_tokens: 700, system, tools, messages: working });
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
    return (resp.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim();
  }
  return '';
}

// ---------------------------------------------------------------------
// DRIVER OPENAI-COMPATIVEL — NOSSO modelo proprio (Ollama/vLLM/etc).
// So liga quando AI_ATTENDANT_BASE_URL aponta pra uma maquina nossa.
// ---------------------------------------------------------------------
async function runOpenAI(system, messages, tools, ctx) {
  const oaTools = tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.input_schema } }));
  const msgs = [{ role: 'system', content: system },
    ...messages.map((m) => ({ role: m.role, content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content) }))];
  for (let hop = 0; hop < 5; hop++) {
    const r = await fetch(LLM_BASE_URL + '/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + LLM_API_KEY },
      body: JSON.stringify({ model: MODEL, max_tokens: 700, temperature: 0.3, messages: msgs, tools: oaTools, tool_choice: 'auto' }),
    });
    if (!r.ok) throw new Error('LLM ' + r.status + ' ' + (await r.text().catch(() => '')).slice(0, 160));
    const j = await r.json();
    const m = j.choices && j.choices[0] && j.choices[0].message;
    if (!m) throw new Error('LLM sem choices');
    if (m.tool_calls && m.tool_calls.length) {
      msgs.push(m);
      for (const tc of m.tool_calls) {
        let args = {};
        try { args = JSON.parse(tc.function.arguments || '{}'); } catch { /* ignore */ }
        const out = await runTool(tc.function.name, args, ctx);
        msgs.push({ role: 'tool', tool_call_id: tc.id, content: JSON.stringify(out) });
      }
      continue;
    }
    return (m.content || '').trim();
  }
  return '';
}

// ---------------------------------------------------------------------
// MOTOR PROPRIO (sem API) — responde direto do BANCO usando as mesmas
// ferramentas. So formata o que a tool traz; NUNCA inventa preco/tamanho.
// Cobre o grosso do atendimento de WhatsApp de loja: "tem o bondi 9 no 42?",
// "preco do mizuno X", "meu cashback", "onde fica". Fora disso -> handoff.
// ---------------------------------------------------------------------
function _norm(s) { return String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, ''); }
function _money(v) { return 'R$ ' + Number(v || 0).toFixed(2).replace('.', ','); }
function _sizeKey(s) { return _norm(s).replace(',', '.').replace(/\s/g, ''); }
function _extractSize(norm) {
  const m = norm.match(/\b(3[3-9]|4[0-8])([.,]5)?\b/); // numeracao de calcado 33-48 (+ meia)
  return m ? m[1] + (m[2] ? '.5' : '') : null;
}
const _STOP = new Set('tem teem oi ola opa eai salve quero queria gostaria de do da dos das no na nas nos um uma uns o a os as pra para por favor vc voce voces ai aih me ver tamanho tam numero num preco valor quanto custa ta tao disponivel tem loja lojas comprar par pares meu minha esse essa esta este isso aqui sobre qual quais ter teria voce gostaria oii bom dia tarde noite'.split(/\s+/));
function _cleanQuery(norm) {
  return norm
    .replace(/\b(3[3-9]|4[0-8])([.,]5)?\b/g, ' ')
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/).filter((w) => w && w.length > 1 && !_STOP.has(w))
    .join(' ').trim();
}
function _greeting(profile, name) {
  const oi = name ? `Oi, ${name}!` : 'Oi!';
  if (profile.key === 'baratao') {
    return `${oi} 👋 Aqui é o atendimento do *Baratão dos Esportes*. Me diz o que você procura (marca, modelo ou tipo) que eu vejo preço e disponibilidade na hora. 🛒`;
  }
  return `${oi} 👋 Aqui é o atendimento da *Sports & Tennis*. Me diz o que você procura (marca, modelo, tamanho) que eu confiro o preço e em qual loja tem. 👟`;
}
function _formatProdutos(profile, produtos, size) {
  const top = produtos.slice(0, 3);
  const blocos = top.map((p) => {
    const preco = p.preco_promocional
      ? `~${_money(p.preco)}~ *${_money(p.preco_promocional)}*`
      : `*${_money(p.preco)}*`;
    let l = `👟 *${p.nome}*${p.marca ? ` (${p.marca})` : ''} — ${preco}`;
    if (size) {
      const achou = (p.tamanhos_disponiveis || []).find((t) => _sizeKey(t.tamanho) === _sizeKey(size));
      if (achou) {
        const lojas = (achou.lojas || []).map((x) => x.loja).join(', ');
        l += `\n✅ Tem o *${size}*${lojas ? ` — ${lojas}` : ''}`;
      } else {
        const disp = (p.tamanhos_em_loja || []).join(', ');
        l += `\n❌ O *${size}* tá indisponível agora.${disp ? ` Tenho nesses: ${disp}` : ''}`;
      }
    } else {
      const disp = (p.tamanhos_em_loja || []).join(', ');
      l += disp ? `\nTamanhos na loja: ${disp}` : '\nSem tamanho em loja no momento.';
    }
    if (p.link) l += `\n${p.link}`;
    return l;
  });
  let txt = blocos.join('\n\n');
  if (profile.hasCashback) txt += '\n\n💰 E você ainda ganha cashback comprando.';
  return txt;
}
async function localReply(profile, { text, pushName, isGroup }, ctx) {
  const norm = _norm(text).trim();
  const words = norm.split(/\s+/).filter(Boolean);

  // saudacao curta (so privado)
  if (!isGroup && words.length <= 3 && /\b(oi|ola|opa|eai|salve|menu|bom dia|boa tarde|boa noite|tudo bem|bora)\b/.test(norm) && !_extractSize(norm)) {
    return { ok: true, reply: _greeting(profile, pushName) };
  }
  // cashback
  if (profile.hasCashback && /\b(cashback|saldo|pontos|tenis ?cash|meus pontos)\b/.test(norm)) {
    const cb = await runTool('consultar_cashback', {}, ctx);
    if (cb && cb.cadastrado) return { ok: true, reply: `${cb.nome ? cb.nome + ', você' : 'Você'} tem *${_money(cb.saldo_cashback)}* de cashback TenisCash pra usar nas compras. 💰` };
    return { ok: true, reply: 'Não achei cadastro nesse número ainda. Quando você compra identificado, o cashback fica salvo aqui. 🙂' };
  }
  // onde fica / horario / canais
  const ehInfo = /\b(onde|endereco|fica|localiza|horario|abre|fecha|funciona|telefone|site|qual loja|quais lojas)\b/.test(norm);
  if (ehInfo && !_extractSize(norm)) {
    const info = await runTool('info_loja', {}, ctx);
    if (profile.key === 'baratao') {
      const e = info.endereco ? `Estamos em ${info.endereco}. ` : '';
      return { ok: true, reply: `${e}Qualquer dúvida de produto é só mandar a marca/modelo que eu confiro pra você. 🛒` };
    }
    return { ok: true, reply: `Temos loja em *Bessa, Tambaú, Rainha da Borborema e Tambiá* (João Pessoa-PB) e a loja online: ${info.site || 'https://www.sportsetennis.com.br'} 🙂\nQuer que eu veja um produto pra você?` };
  }

  // PRODUTO (default) — busca no catalogo real
  const size = _extractSize(norm);
  const query = _cleanQuery(norm);
  if (!query) {
    if (isGroup) return { ok: true, silent: true };
    return { ok: true, reply: _greeting(profile, pushName) };
  }
  const res = await runTool('buscar_produtos', { query }, ctx);
  if (!res || res.erro || !res.produtos || !res.produtos.length) {
    if (isGroup) return { ok: true, silent: true };
    return { ok: true, reply: `Não achei *${query}* no nosso catálogo agora 😕 Me diz a marca/modelo certinho que eu procuro de novo, ou já chamo um atendente da equipe.` };
  }
  return { ok: true, reply: _formatProdutos(profile, res.produtos, size) };
}

// ---------------------------------------------------------------------
// PRINCIPAL — gera a resposta do atendente para uma mensagem recebida
// Tenta o modelo (proprio -> Anthropic); se nao houver/der erro, cai no
// motor proprio (banco). Nunca fica "fora do ar" por falta de API.
// ---------------------------------------------------------------------
async function getAttendantReply({ phone, text, pushName, isGroup = false, senderName, sessionKey, profile: profileKey = 'st' }) {
  if (!isProfileEnabled(profileKey)) return { ok: false, skip: 'disabled' };

  const profile = getProfile(profileKey);
  const histKey = sessionKey || phone;
  const history = getHistory(histKey);
  const messages = [...history.map((m) => ({ role: m.role, content: m.content })), { role: 'user', content: text }];
  const ctx = { phone, pushName, isGroup, profile };
  const tools = buildTools(profile);
  const system = buildSystem(profile, isGroup ? senderName : pushName, isGroup);

  let finalText = '';
  let usedLLM = false;
  if (llmConfigured()) {
    try {
      finalText = LLM_PROVIDER === 'openai'
        ? await runOpenAI(system, messages, tools, ctx)
        : await runAnthropic(system, messages, tools, ctx);
      usedLLM = !!finalText;
    } catch (err) {
      console.warn(`[aiAttendant] modelo (${LLM_PROVIDER}) indisponivel, usando motor proprio:`, err.message);
    }
  }

  // Grupo: a IA pode decidir ficar calada (mensagem nao era pra ela)
  if (usedLLM && isGroup && /\[?\s*SIL[EÊ]NCIO\s*\]?/i.test(finalText)) {
    return { ok: true, silent: true };
  }

  // Sem resposta do modelo (sem chave / sem credito / erro) -> MOTOR PROPRIO
  if (!finalText) {
    try {
      const local = await localReply(profile, { text, phone, pushName, isGroup }, ctx);
      if (local.silent) return { ok: true, silent: true };
      finalText = local.reply || '';
    } catch (err) {
      console.error('[aiAttendant] motor proprio falhou:', err.message);
    }
  }

  if (!finalText) {
    if (isGroup) return { ok: true, silent: true };
    finalText = `Recebi sua mensagem! Em instantes um atendente do ${profile.brand} te responde. 🙂`;
  }

  pushHistory(histKey, 'user', text);
  pushHistory(histKey, 'assistant', finalText);

  // Classifica intenção de compra async (não bloqueia a resposta)
  if (!isGroup) {
    const s = sessions.get(histKey);
    if (s) {
      rateIntent(s.messages).then((rating) => {
        if (rating && s === sessions.get(histKey)) {
          s.intentScore = rating.score;
          s.intentSignal = rating.signal;
          s.intentProduto = rating.produto;
          s.intentAt = Date.now();
          s.phone = phone;
          s.pushName = pushName;
          s.profileKey = profileKey;
        }
      }).catch(() => {});
    }
  }

  return { ok: true, reply: finalText };
}

// Retorna leads ativos com intenção >= minScore, ordenados por score desc
function getHotLeads(minScore = 3) {
  const now = Date.now();
  const leads = [];
  for (const [key, s] of sessions.entries()) {
    if (s.expiresAt < now) continue;
    if (!s.intentScore || s.intentScore < minScore) continue;
    leads.push({
      sessionKey: key,
      phone: s.phone || key,
      pushName: s.pushName || null,
      profileKey: s.profileKey || 'st',
      score: s.intentScore,
      signal: s.intentSignal || '',
      produto: s.intentProduto || null,
      ratedAt: s.intentAt || null,
      expiresAt: s.expiresAt,
      turns: Math.floor(s.messages.length / 2),
    });
  }
  return leads.sort((a, b) => b.score - a.score || b.ratedAt - a.ratedAt);
}

module.exports = { getAttendantReply, isEnabled, isProfileEnabled, clearSession, ehBaratao, PROFILES, getHotLeads };
