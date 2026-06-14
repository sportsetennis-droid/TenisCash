// =====================================================================
// AI Attendant — atendente de WhatsApp da Sports & Tennis (Claude)
// =====================================================================
// Responde AUTOMATICAMENTE no WhatsApp da loja (instancia Evolution).
// Usa ferramentas que leem DADOS REAIS (catalogo, estoque, cashback).
// REGRA DE OURO: nunca inventa preco/estoque/tamanho — so o que a tool traz.
//
// Liga/desliga: env AI_ATTENDANT_ENABLED ('false' desliga). Default = ligado.
// Modelo: env AI_ATTENDANT_MODEL (default claude-sonnet-4-6 — rigor no cruzamento de estoque;
//   haiku afirmava tamanho fantasma que so existia no comprado/NFe).
// =====================================================================

const Anthropic = require('@anthropic-ai/sdk');
const { prisma } = require('../middleware');
const { formatPhoneBR } = require('../whatsapp');
const { searchProductsForAI, resolveProductLink } = require('./catalogSearch');

const MODEL = process.env.AI_ATTENDANT_MODEL || 'claude-sonnet-4-6';
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
      'Busca produtos no catalogo REAL da Sports & Tennis por nome, marca ou modelo. ' +
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

// Baratao dos Esportes (LOJA01) e OUTRA empresa, com OUTRO WhatsApp de atendimento ao
// cliente. Por isso o estoque do Baratao SO aparece no GRUPO de vendedores; no
// atendimento ao CLIENTE da S&T ele e invisivel (filtrado). Regra do dono 2026-06-14.
function ehBaratao(st) {
  return /barat/i.test((st && st.name) || '') || /barat/i.test((st && st.neighborhood) || '');
}

function lojasDoTamanho(s, { isGroup } = {}) {
  return (s.storeStocks || [])
    .filter((ss) => (ss.stock || 0) > 0)
    .filter((ss) => isGroup || !ehBaratao(ss.store)) // cliente NAO ve o Baratao
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
      link: resolveProductLink(p.id, p.name), // pagina do produto (card) p/ mandar pro cliente
      tamanhos_em_loja: tamanhos.map((t) => t.tamanho), // lista simples p/ cruzar o tamanho pedido
      tamanhos_disponiveis: tamanhos, // detalhe: cada tamanho com loja(s) + qtd (SO o que tem NA LOJA)
      tem_em_loja: tamanhos.length > 0,
    };
  });
  return { encontrados: prods.length, produtos: lista };
}

async function runTool(name, input, ctx) {
  try {
    if (name === 'buscar_produtos') {
      const r = await searchProductsForAI(input?.query || '');
      return resumoProdutos(r, { isGroup: ctx.isGroup });
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
// Prompt para o GRUPO de vendedores (modo vendedor + regra de silencio)
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

function buildSystem(pushName, isGroup) {
  if (isGroup) return buildGroupSystem(pushName);
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

// ---------------------------------------------------------------------
// PRINCIPAL — gera a resposta do atendente para uma mensagem recebida
// ---------------------------------------------------------------------
async function getAttendantReply({ phone, text, pushName, isGroup = false, senderName, sessionKey }) {
  if (!isEnabled()) return { ok: false, skip: 'disabled' };
  const client = getClient();
  if (!client) return { ok: false, error: 'ANTHROPIC_API_KEY ausente' };

  const histKey = sessionKey || phone;
  const history = getHistory(histKey);
  const messages = [...history.map((m) => ({ role: m.role, content: m.content })), { role: 'user', content: text }];
  const ctx = { phone, pushName, isGroup };

  try {
    let working = messages;
    let finalText = '';
    for (let hop = 0; hop < 5; hop++) {
      const resp = await client.messages.create({
        model: MODEL,
        max_tokens: 700,
        system: buildSystem(isGroup ? senderName : pushName, isGroup),
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

    // Modo grupo: a IA pode decidir ficar calada (mensagem nao era pra ela)
    if (isGroup && /\[?\s*SIL[EÊ]NCIO\s*\]?/i.test(finalText)) {
      return { ok: true, silent: true };
    }

    if (!finalText) {
      if (isGroup) return { ok: true, silent: true };
      finalText = 'Recebi sua mensagem! Em instantes um atendente da Sports & Tennis te responde. 🙂';
    }

    pushHistory(histKey, 'user', text);
    pushHistory(histKey, 'assistant', finalText);
    return { ok: true, reply: finalText };
  } catch (err) {
    console.error('[aiAttendant] erro ao gerar resposta:', err.message);
    return { ok: false, error: err.message };
  }
}

module.exports = { getAttendantReply, isEnabled, clearSession };
