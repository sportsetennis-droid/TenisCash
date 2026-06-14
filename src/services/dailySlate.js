// =====================================================================
// Máquina de Marketing — gera o MOLDE do dia (pauta + copy) e salva no Config.
// Molde travado (dono 14/06): 4 produtos/loja do PRÓPRIO estoque (= DNA, SEM
// collab) + 5 temas diários. SÓ FATO: tudo factível vira "fato_a_verificar".
// NÃO publica, NÃO renderiza. Consumido por /api/admin/reels-agency/slate.
// =====================================================================
const { prisma } = require('../middleware');
const { callAI } = require('../ai/ai-client');

const MODEL = 'claude-sonnet-4-6';
const SLATE_KEY = 'daily_slate';

// DNA definitivo (dono 14/06). Cada loja puxa do próprio StoreStock, que já é do DNA dela.
const LOJAS = [
  { handle: '@sportsetennisbessa', loja: 'Praia do Bessa', dna: 'MASCULINA — corrida, lifestyle, treino masculino' },
  { handle: '@sportsetenniscg', loja: 'Rainha da Borborema', dna: 'SÓ FUTEBOL — chuteira, society, várzea (Campina Grande)' },
  { handle: '@sportsetennistambau', loja: 'Praia de Tambaú', dna: 'FEMININA — LUXO MINIMALISTA com verde+amarelo, elegante e legível; NUNCA rosa-clichê' },
  { handle: '@sportsetennistambia', loja: 'Tambiá', dna: 'MASCULINA E FEMININA — produto de homem E de mulher' },
];

const RULES = 'Regras DURAS: SÓ FATO VERIFICADO (todo dado factível vai em "fato_a_verificar", a copy não crava número não confirmado). Sem citar fornecedor/malha. Respeitar o DNA da conta. INFO é a estrela, gancho de 3s, cada reel uma skin/conceito diferente. Não inventar preço/estoque (usar só o que for passado).';

async function topStock(lojaName) {
  const store = await prisma.store.findFirst({ where: { name: { contains: lojaName }, active: true }, select: { id: true } });
  if (!store) return [];
  return prisma.$queryRawUnsafe(`
    SELECT p.brand, p.name, p.price FROM "StoreStock" ss
    JOIN "ProductSize" psz ON psz.id=ss."productSizeId" JOIN "Product" p ON p.id=psz."productId"
    WHERE ss."storeId"=$1 AND ss.stock>0 AND p.active=true AND p."imageUrl" IS NOT NULL AND p.price>0
    GROUP BY p.id HAVING SUM(ss.stock)>=2 ORDER BY SUM(ss.stock) DESC LIMIT 14`, store.id);
}

async function geraProdutos(l, stock) {
  if (!stock.length) return [];
  const sys = `Você é o estrategista de conteúdo da Sports & Tennis. ${RULES}`;
  const up = `Conta ${l.handle} [DNA: ${l.dna}]. Hoje a loja vai postar 4 REELS de PRODUTO (do estoque real abaixo, sem colaboração com outra loja). Escolha 4 produtos e crie um reel pra cada.
ESTOQUE REAL:\n${stock.map((s, i) => `${i + 1}. ${s.brand} ${String(s.name).replace(/REF:.*?-\s*/, '').slice(0, 50)} — R$${s.price}`).join('\n')}
JSON: {"produtos":[{"produto":"marca+modelo","preco":"R$x","gancho":"frase 3s","skin":"conceito visual","fato_a_verificar":["..."]}]}`;
  const r = await callAI({ systemPrompt: sys, userPrompt: up, jsonMode: true, maxTokens: 1800, model: MODEL });
  return r.ok && r.json ? (r.json.produtos || []).slice(0, 4) : [];
}

async function geraTemas(hoje, ctx) {
  const sys = `Você é o estrategista de conteúdo da Sports & Tennis (rede de 5 contas). ${RULES}\nDNA: master @sportsetennis = "O Reinado é da Massa" (Copa/futebol/povo); Bessa masc; CG futebol; Tambaú fem-luxo; Tambiá masc+fem.`;
  const up = `DATA ${hoje}. Contexto de hoje: ${ctx}. Gere os 5 TEMAS diários (1 reel cada), escolhendo a conta certa por DNA.
USE SOMENTE estes handles EXATOS (NUNCA invente outro): @sportsetennis (master/Copa), @sportsetennisbessa (masc), @sportsetenniscg (Rainha da Borborema, CAMPINA GRANDE — futebol; nunca "Campo Grande"), @sportsetennistambau (fem-luxo), @sportsetennistambia (masc+fem).
Temas: 1) Esporte do dia  2) Bem-estar  3) Começa agora (pra quem vai começar no esporte)  4) Agenda (evento que vem)  5) Oportunidade (oferta/cashback).
JSON: {"temas":[{"tema":"...","conta":"@...","gancho":"frase 3s","legenda":"legenda curta","skin":"conceito","fato_a_verificar":["..."]}]}`;
  const r = await callAI({ systemPrompt: sys, userPrompt: up, jsonMode: true, maxTokens: 2600, model: MODEL });
  return r.ok && r.json ? (r.json.temas || []) : [];
}

// ctx neutro por padrão: a máquina NÃO crava evento (fica em fato_a_verificar). Quem rodar com
// agenda esportiva real passa ctx específico. Assim o cron nunca afirma fato velho.
const CTX_DEFAULT = 'Copa do Mundo 2026 em andamento. Conferir a agenda esportiva real do dia (jogos do Brasil, UFC, NBA, etc.) antes de cravar qualquer evento.';

async function generateDailySlate({ date, ctx } = {}) {
  const hoje = date || new Date().toISOString().slice(0, 10);
  const contexto = ctx || CTX_DEFAULT;
  const slate = { data: hoje, generatedAt: new Date().toISOString(), produtos: [], temas: [], errors: [] };

  for (const l of LOJAS) {
    try {
      const stock = await topStock(l.loja);
      const prods = await geraProdutos(l, stock);
      prods.forEach((p) => slate.produtos.push({ conta: l.handle, loja: l.loja, ...p }));
    } catch (e) {
      slate.errors.push(`produtos ${l.handle}: ${e.message}`);
    }
  }
  try {
    slate.temas = await geraTemas(hoje, contexto);
  } catch (e) {
    slate.errors.push(`temas: ${e.message}`);
  }

  slate.totalPosts = slate.produtos.length + slate.temas.length;
  await prisma.config.upsert({
    where: { key: SLATE_KEY },
    create: { id: SLATE_KEY, key: SLATE_KEY, value: JSON.stringify(slate) },
    update: { value: JSON.stringify(slate) },
  });
  return slate;
}

async function getSavedSlate() {
  const row = await prisma.config.findUnique({ where: { key: SLATE_KEY } });
  if (!row) return null;
  try { return JSON.parse(row.value); } catch { return null; }
}

module.exports = { generateDailySlate, getSavedSlate, LOJAS, SLATE_KEY };
