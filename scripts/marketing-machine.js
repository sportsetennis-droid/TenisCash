// =====================================================================
// MÁQUINA DE MARKETING — molde do dia (dono 14/06): 4 produtos/loja (estoque
// próprio = DNA, SEM collab) + 5 temas diários. Gera pauta+copy, marca fato a
// verificar. NÃO publica. Saída: tmp/daily-slate.json
// =====================================================================
const fs = require('fs'); const path = require('path');
const ROOT = path.join(__dirname, '..');
for (const line of fs.readFileSync(path.join(ROOT, '.env'), 'utf8').split(/\r?\n/)) {
  const m = line.match(/^\s*([A-Za-z0-9_]+)\s*=(.*)$/); if (!m) continue;
  let v = m[2].trim(); if ((v[0] === '"' && v.endsWith('"')) || (v[0] === "'" && v.endsWith("'"))) v = v.slice(1, -1);
  if (!process.env[m[1]]) process.env[m[1]] = v;
}
const { PrismaClient } = require('@prisma/client'); const prisma = new PrismaClient();
const { callAI } = require(path.join(ROOT, 'src/ai/ai-client'));
const MODEL = 'claude-sonnet-4-6';

const LOJAS = [
  { handle: '@sportsetennisbessa', loja: 'Praia do Bessa', dna: 'MASCULINA — corrida, lifestyle, treino masculino' },
  { handle: '@sportsetenniscg', loja: 'Rainha da Borborema', dna: 'SÓ FUTEBOL — chuteira, society, várzea (Campina Grande)' },
  { handle: '@sportsetennistambau', loja: 'Praia de Tambaú', dna: 'FEMININA — LUXO MINIMALISTA com verde+amarelo, elegante e legível; NUNCA rosa-clichê' },
  { handle: '@sportsetennistambia', loja: 'Tambiá', dna: 'MASCULINA E FEMININA — produto de homem E de mulher' },
];

async function topStock(lojaName) {
  const store = await prisma.store.findFirst({ where: { name: { contains: lojaName }, active: true }, select: { id: true } });
  if (!store) return [];
  return prisma.$queryRawUnsafe(`
    SELECT p.brand, p.name, p.price FROM "StoreStock" ss
    JOIN "ProductSize" psz ON psz.id=ss."productSizeId" JOIN "Product" p ON p.id=psz."productId"
    WHERE ss."storeId"=$1 AND ss.stock>0 AND p.active=true AND p."imageUrl" IS NOT NULL AND p.price>0
    GROUP BY p.id HAVING SUM(ss.stock)>=2 ORDER BY SUM(ss.stock) DESC LIMIT 14`, store.id);
}

const RULES = `Regras DURAS: SÓ FATO VERIFICADO (todo dado factível vai em "fato_a_verificar", a copy não crava número não confirmado). Sem citar fornecedor/malha. Respeitar o DNA da conta. INFO é a estrela, gancho de 3s, cada reel uma skin/conceito diferente. Não inventar preço/estoque (usar só o que for passado).`;

async function geraProdutos(l, stock) {
  const sys = `Você é o estrategista de conteúdo da Sports & Tennis. ${RULES}`;
  const up = `Conta ${l.handle} [DNA: ${l.dna}]. Hoje a loja vai postar 4 REELS de PRODUTO (do estoque real abaixo, sem colaboração com outra loja). Escolha 4 produtos e crie um reel pra cada.
ESTOQUE REAL:\n${stock.map((s, i) => `${i + 1}. ${s.brand} ${String(s.name).replace(/REF:.*?-\s*/, '').slice(0, 50)} — R$${s.price}`).join('\n')}
JSON: {"produtos":[{"produto":"marca+modelo","preco":"R$x","gancho":"frase 3s","skin":"conceito visual","fato_a_verificar":["..."]}]}`;
  const r = await callAI({ systemPrompt: sys, userPrompt: up, jsonMode: true, maxTokens: 1800, model: MODEL });
  return r.ok && r.json ? (r.json.produtos || []).slice(0, 4) : [];
}

async function geraTemas(hoje, ctx) {
  const sys = `Você é o estrategista de conteúdo da Sports & Tennis (rede de 5 contas). ${RULES}\nDNA: master @sportsetennis = "O Reinado é da Massa" (Copa/futebol/povo); Bessa masc; CG futebol; Tambaú fem-luxo; Tambiá masc+fem.`;
  const up = `DATA ${hoje}. Contexto verificado de hoje: ${ctx}. Gere os 5 TEMAS diários (1 reel cada), escolhendo a conta certa por DNA.
USE SOMENTE estes handles EXATOS (NUNCA invente outro): @sportsetennis (master/Copa), @sportsetennisbessa (masc), @sportsetenniscg (Rainha da Borborema, CAMPINA GRANDE — futebol; nunca "Campo Grande"), @sportsetennistambau (fem-luxo), @sportsetennistambia (masc+fem).
Temas: 1) Esporte do dia  2) Bem-estar  3) Começa agora (pra quem vai começar no esporte)  4) Agenda (evento que vem)  5) Oportunidade (oferta/cashback).
JSON: {"temas":[{"tema":"...","conta":"@...","gancho":"frase 3s","legenda":"legenda curta","skin":"conceito","fato_a_verificar":["..."]}]}`;
  const r = await callAI({ systemPrompt: sys, userPrompt: up, jsonMode: true, maxTokens: 2600, model: MODEL });
  return r.ok && r.json ? (r.json.temas || []) : [];
}

(async () => {
  const hoje = process.argv[2] || new Date().toISOString().slice(0, 10);
  const ctx = 'Copa do Mundo 2026 em andamento (Brasil empatou na última rodada); HOJE UFC Freedom 250 na Casa Branca com 3 brasileiros (Poatan, Mauricio Ruffy, Diego Lopes), card principal 21h.';
  const slate = { data: hoje, produtos: [], temas: [] };
  for (const l of LOJAS) {
    const stock = await topStock(l.loja);
    const prods = await geraProdutos(l, stock);
    prods.forEach((p) => slate.produtos.push({ conta: l.handle, ...p }));
    console.log(`\n▶ ${l.handle}  [${l.dna.split('—')[0].trim()}]`);
    prods.forEach((p) => console.log(`   👟 ${p.produto} (${p.preco}) — "${p.gancho}"  · skin: ${p.skin}`));
  }
  slate.temas = await geraTemas(hoje, ctx);
  console.log('\n=== TEMAS DO DIA ===');
  slate.temas.forEach((t) => console.log(`   ${t.tema} → ${t.conta}: "${t.gancho}"${(t.fato_a_verificar || []).length ? '  ⚠ ' + t.fato_a_verificar.join('; ') : ''}`));
  fs.writeFileSync(path.join(ROOT, 'tmp', 'daily-slate.json'), JSON.stringify(slate, null, 2));
  console.log(`\nMOLDE: ${slate.produtos.length} produtos + ${slate.temas.length} temas = ${slate.produtos.length + slate.temas.length} posts. salvo tmp/daily-slate.json`);
  await prisma.$disconnect();
})().catch((e) => { console.error(e.message); process.exit(1); });
