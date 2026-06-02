// =====================================================================
// seed-memory.js — carrega a Memória da Empresa com os FATOS fundadores
// da Sports & Tennis (o que a empresa É). Fonte: CLAUDE.md (autoritativo).
//
// Idempotente: se um fato com o MESMO título já existe, pula (não duplica).
// Só grava kind="fact" pinned=true → a IA SEMPRE lê isto antes de agir.
//
// Uso: node scripts/seed-memory.js
// =====================================================================
const fs = require('fs');
const path = require('path');
(function loadEnv() {
  const p = path.join(__dirname, '..', '.env');
  if (!fs.existsSync(p)) return;
  for (const l of fs.readFileSync(p, 'utf8').split(/\r?\n/)) {
    const t = l.trim(); if (!t || t.startsWith('#')) continue;
    const e = t.indexOf('='); if (e < 0) continue;
    const k = t.slice(0, e).trim(); let v = t.slice(e + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    if (!(k in process.env)) process.env[k] = v;
  }
})();

const mem = require('../src/ai/memory/memory.service');
const { prisma } = require('../src/middleware');

// Cada item: { category, title, detail, importance }. pinned=true (addFact).
const FACTS = [
  // --- Identidade ---
  { category: 'empresa', importance: 3,
    title: 'Sports & Tennis é uma rede de varejo esportivo com 4 lojas físicas em João Pessoa/PB + e-commerce',
    detail: 'Dono: Douglas Bernardo. Mix: tênis esportivo, calçados, roupas técnicas e acessórios. Clientes: atletas amadores, clubes, escolas e consumidor final.' },
  { category: 'empresa', importance: 3,
    title: 'Ecossistema unificado: Varejo + TenisCash (cashback/loyalty) + Central IA (18 agentes) + app APEX (esportivo, em construção)',
    detail: 'TUDO é um só projeto: mesmo banco, mesmo backend, mesmo cliente. Compra na loja gera cashback; treina no APEX ganha badge e cashback; volta na loja usa cashback. Loop fechado.' },
  { category: 'empresa', importance: 2,
    title: 'O grupo opera sob a razão social Meta Esportes LTDA (CNPJ raiz 44.052.617)',
    detail: 'Cada loja tem seu próprio CNPJ (sufixo). NUNCA misturar movimento entre CNPJs de lojas diferentes.' },
  { category: 'empresa', importance: 2,
    title: 'Diferencial vs Strava/Nike Run Club: loja física própria + cashback real',
    detail: 'Concorrentes dependem de patrocínio; a Sports & Tennis tem canal de venda próprio. Esse é o trunfo do APEX.' },

  // --- Lojas ---
  { category: 'loja', importance: 2, title: 'LOJA02 — Sports & Tennis Bessa', detail: 'CNPJ destinatário 44.052.617/0002-07.' },
  { category: 'loja', importance: 2, title: 'LOJA03 — Sports & Tennis Rainha da Borborema', detail: 'CNPJ destinatário 44.052.617/0003-98.' },
  { category: 'loja', importance: 2, title: 'LOJA05 — Sports & Tennis Tambaú', detail: 'CNPJ destinatário 44.052.617/0005-50.' },
  { category: 'loja', importance: 2, title: 'LOJA06 — Sports & Tennis Tambiá', detail: 'CNPJ destinatário 44.052.617/0006-30.' },
  { category: 'loja', importance: 2, title: 'LOJA04 — Sports & Tennis E-commerce (Nuvemshop)', detail: 'CNPJ destinatário 44.052.617/0004-79. Loja: sportstennis2.lojavirtualnuvem.com.br.' },
  { category: 'loja', importance: 1, title: 'LOJA01 — Baratão dos Esportes (empresa irmã do mesmo grupo)', detail: 'CNPJ 44.052.617/0001-26. É outra empresa, não somar com as lojas Sports & Tennis.' },

  // --- Canais ---
  { category: 'empresa', importance: 2,
    title: 'Canais de venda: 4 lojas físicas + Nuvemshop + WhatsApp + Instagram @sportsetennis',
    detail: 'Instagram @sportsetennis com 5.866 seguidores. WhatsApp Business +55 83 9671-3153.' },

  // --- Marcas ---
  { category: 'marca', importance: 2,
    title: 'Marcas trabalhadas (29)',
    detail: 'Nike, Adidas, Puma, Asics, Mizuno, Reebok, Fila, Umbro, Converse, Skechers, Diadora, Topper, Salomon, Speedo, Spalding, Kappa, Caju Brasil, Alto Giro, Army, Lupo, Vollo, Hidrolight, Let\'s Gym, Hope Resort, Fiber, Evoke, Progne, Botafogo, Body for Sure.' },

  // --- Metas / KPIs ---
  { category: 'meta', importance: 2,
    title: 'KPIs prioritários do varejo: margem bruta, giro de estoque, NPS, ticket médio e conversão online',
    detail: 'KPIs futuros do APEX: DAU, retenção D7/D30, conversão premium e % de atletas que viram compradores na loja (loop fechado).' },

  // --- Regras inquebráveis ---
  { category: 'regra', importance: 3, title: 'PREÇO: nunca mudar preço ou markup de produto sem ordem explícita do dono', detail: null },
  { category: 'regra', importance: 3, title: 'CLIENTE: nunca enviar mensagem ao cliente sem aprovação humana', detail: 'Exceção: crm-whatsapp-agent em modo rascunho.' },
  { category: 'regra', importance: 3, title: 'DESCONTO: nunca aprovar desconto acima de 15% sem o pricing-margin-agent validar', detail: null },
  { category: 'regra', importance: 3, title: 'MARKETING: nunca publicar conteúdo sem o safety-agent revisar', detail: null },
  { category: 'regra', importance: 3,
    title: 'ESTOQUE: ProductSize.stock = COMPRADO (total da NFe de entrada); StoreStock = LOCALIZAÇÃO (bipe por loja)',
    detail: 'Os dois divergem DE PROPÓSITO durante a contagem. NUNCA recalcular o comprado a partir do StoreStock (corrompe o total).' },
  { category: 'regra', importance: 3,
    title: 'NFe de TRANSFERÊNCIA não cria Product e não conta como compra',
    detail: 'Transferência = CNPJ raiz igual entre emissor/destinatário OU CFOP 5152/6152. Só NFe de ENTRADA (fornecedor) cria Product e soma ao custo.' },
  { category: 'regra', importance: 2,
    title: 'NUVEMSHOP: só sobe produto classificado nas 4 (Categoria + Sub + Modalidade + Especialidade)',
    detail: 'Sem as 4 classificações, não cria nem atualiza no Nuvemshop.' },
  { category: 'regra', importance: 2,
    title: 'CARD de produto = 1 modelo+cor. Chave: REFERÊNCIA + DESCRIÇÃO + COR. SKU é do TAMANHO, não do card',
    detail: 'Product.sku = referência do fornecedor; Product.name = descrição; aiContext.color = cor; ProductSize.barcode = SKU/EAN de cada tamanho.' },

  // --- Estado do catálogo (snapshot) ---
  { category: 'produto', importance: 1,
    title: 'Catálogo: ~7.093 produtos cadastrados, 6.170 já curados pela IA',
    detail: 'Número aproximado (muda conforme entram NFes e curadoria avança).' },
];

(async () => {
  let added = 0, skipped = 0, failed = 0;
  for (const f of FACTS) {
    try {
      const exists = await prisma.companyMemory.findFirst({ where: { kind: 'fact', title: f.title } });
      if (exists) { skipped++; console.log('· já existe:', f.title.slice(0, 60)); continue; }
      const created = await mem.addFact(f);
      if (created) { added++; console.log('✅ gravado:', f.title.slice(0, 60)); }
      else { failed++; console.log('❌ falhou:', f.title.slice(0, 60)); }
    } catch (err) {
      failed++; console.log('❌ erro:', f.title.slice(0, 50), '→', err.message);
    }
  }
  const total = await prisma.companyMemory.count({ where: { kind: 'fact' } });
  console.log(`${'─'.repeat(56)}`);
  console.log(`${added} gravado(s), ${skipped} já existia(m), ${failed} falhou. Total de fatos na memória: ${total}.`);
  await prisma.$disconnect();
  process.exit(failed === 0 ? 0 : 1);
})().catch(async (e) => { console.error('fatal:', e); try { await prisma.$disconnect(); } catch (_) {} process.exit(1); });
