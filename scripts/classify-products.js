// =====================================================================
// Classificador IA — Sports & Tennis
// =====================================================================
// Lê produtos do banco e classifica em: tipo / gênero / modalidade / tier
// conforme a árvore oficial (Tênis com 4 gêneros e 7 modalidades + tiers,
// Chuteira com 3 modalidades + tiers).
//
// Resultado salvo em Product.aiContext.classification:
//   { type, gender, modality, tier, isSportsShoe, classifiedAt }
//
// Modo:
//   node scripts/classify-products.js --sample=5     → testa 5 e mostra
//   node scripts/classify-products.js --all          → roda em todos
//   node scripts/classify-products.js --reset        → limpa e re-classifica
// =====================================================================

// Carrega .env manualmente
const fs = require('fs');
const path = require('path');
try {
  const envPath = path.join(__dirname, '..', '.env');
  if (fs.existsSync(envPath)) {
    fs.readFileSync(envPath, 'utf8').split('\n').forEach(line => {
      const m = line.match(/^([^#=][^=]*)=(.*)$/);
      if (m) process.env[m[1].trim()] = m[2].trim().replace(/^["']|["']$/g, '');
    });
  }
} catch {}
const Anthropic = require('@anthropic-ai/sdk');
const { PrismaClient } = require('@prisma/client');

const prisma = new PrismaClient();
const PROGRESS_FILE = path.join(__dirname, '.classify-progress.json');
const MODEL = process.env.CLASSIFIER_MODEL || 'claude-haiku-4-5';
const CONCURRENCY = parseInt(process.env.CLASSIFIER_CONCURRENCY || '2', 10);
const DELAY_MS = parseInt(process.env.CLASSIFIER_DELAY_MS || '400', 10);
const MAX_RETRIES = 5;

const argv = process.argv.slice(2);
const isSample = argv.find(a => a.startsWith('--sample='));
const isAll = argv.includes('--all');
const isReset = argv.includes('--reset');
const sampleSize = isSample ? parseInt(isSample.split('=')[1], 10) : null;

const TREE = `
TÊNIS (Tenis) — produtos pra prática esportiva, caminhada, lifestyle
  Gêneros:
    - Feminino (mulher adulta)
    - Masculino (homem adulto)
    - Inf. M (infantil masculino, tam 18-32)
    - Inf. F (infantil feminino, tam 18-32)
  Modalidades (após gênero):
    - Corrida → tiers: "máximo conforto" | "confortável" | "velocidade" | "custo benefício" | "super treino" | "pau pra toda obra" | "maratona"
    - Caminhada / Treino leve
    - LifeStyle → tiers: "premium" | "clássico" | "casual"
    - Recuperação
    - Musculação / CrossFit / Hyrox → tiers: "pro" | "intermediário" | "custo benefício"
    - Streetwear
    - Sapatilha
  Infantil só tem LifeStyle → tiers: "clássico" | "casual"

CHUTEIRA — produtos pra futebol/futsal/society
  Modalidades:
    - Futsal → tiers: "entrada" | "custo benefício" | "treino" | "pro"
    - Society → tiers: "entrada" | "custo benefício" | "treino" | "pro"
    - Campo → tiers: "entrada" | "custo benefício" | "treino" | "pro"

OUTROS (acessórios, roupas, bolas, etc) → type=OUTRO sem gênero/modalidade
`;

const SYSTEM = `Você é classificador de produtos da rede Sports & Tennis (varejo esportivo BR).
Você RECEBE um produto e DEVOLVE um JSON com a classificação na árvore abaixo.

ÁRVORE OFICIAL:
${TREE}

REGRAS:
1. Se for tênis e NÃO for chuteira → type="Tênis"
2. Se for chuteira (futebol/futsal/society/campo) → type="Chuteira"
3. Se for outra coisa (camiseta, bermuda, meia, bone, mochila, bola etc) → type="Outro" e gender/modality/tier=null
4. Pra Tênis: SEMPRE preencher gender. Se for adulto e indistinto, usar "Masculino" como default mais conservador, MAS prefira identificar por palavras-chave (femin, masc, infantil, kids)
5. Pra Tênis: SEMPRE tentar modality baseado no nome/marca. Quando ambíguo, "LifeStyle"
6. Tier: opcional, só preenche se identificar claramente. Senão null.
7. Use o mesmo texto EXATO dos nomes acima (case-sensitive).

OUTPUT: SOMENTE JSON válido, sem markdown, sem explicações:
{"type":"Tênis|Chuteira|Outro","gender":"...","modality":"...","tier":"...","confidence":0-1}

Onde confidence é seu grau de certeza (0=adivinhei, 1=tenho certeza).`;

function loadProgress() {
  try { return JSON.parse(fs.readFileSync(PROGRESS_FILE, 'utf8')); }
  catch { return { processed: [], failed: [], startedAt: new Date().toISOString() }; }
}
function saveProgress(p) { fs.writeFileSync(PROGRESS_FILE, JSON.stringify(p, null, 2)); }
function log(m) { console.log(`[${new Date().toISOString().replace('T', ' ').slice(0, 19)}] ${m}`); }

async function classify(client, p, attempt = 1) {
  const desc = (p.shortDescription || p.longDescription || '').slice(0, 300);
  const userMsg = `Produto:
- Nome: ${p.name}
- Marca: ${p.brand || '?'}
- Categoria atual: ${p.category || '?'}
- Subcategoria: ${p.subcategory || '?'}
- Descrição: ${desc || '(sem descrição)'}

Classifique:`;

  try {
    const resp = await client.messages.create({
      model: MODEL,
      max_tokens: 200,
      system: [{ type: 'text', text: SYSTEM, cache_control: { type: 'ephemeral' } }],
      messages: [{ role: 'user', content: userMsg }],
    });
    const text = resp.content[0]?.text || '';
    const m = text.match(/\{[\s\S]*\}/);
    if (!m) throw new Error('Sem JSON na resposta: ' + text.slice(0, 100));
    const obj = JSON.parse(m[0]);
    return { ...obj, usage: resp.usage };
  } catch (err) {
    // Retry exponencial pra rate limit / overload
    const is429 = err.status === 429 || (err.message || '').includes('429') || (err.message || '').includes('rate_limit');
    const is529 = err.status === 529 || (err.message || '').includes('529') || (err.message || '').includes('overloaded');
    if ((is429 || is529) && attempt < MAX_RETRIES) {
      const backoff = Math.min(2 ** attempt * 1000 + Math.random() * 500, 30000);
      await new Promise(r => setTimeout(r, backoff));
      return classify(client, p, attempt + 1);
    }
    throw err;
  }
}

async function processProduct(client, p, progress) {
  try {
    const r = await classify(client, p);
    const existingCtx = (() => {
      try { return typeof p.aiContext === 'string' ? JSON.parse(p.aiContext) : (p.aiContext || {}); }
      catch { return {}; }
    })();
    const newCtx = {
      ...existingCtx,
      classification: {
        type: r.type,
        gender: r.gender || null,
        modality: r.modality || null,
        tier: r.tier || null,
        confidence: r.confidence,
        classifiedAt: new Date().toISOString(),
      },
    };
    await prisma.product.update({
      where: { id: p.id },
      data: { aiContext: newCtx },
    });
    progress.processed.push(p.id);
    return { ok: true, ...r };
  } catch (err) {
    progress.failed.push({ id: p.id, sku: p.sku, name: p.name, error: err.message, at: new Date().toISOString() });
    return { ok: false, error: err.message };
  }
}

async function main() {
  if (!process.env.ANTHROPIC_API_KEY) { log('FALTA ANTHROPIC_API_KEY'); process.exit(1); }
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

  if (isReset) {
    log('RESET — limpando arquivo de progresso');
    try { fs.unlinkSync(PROGRESS_FILE); } catch {}
  }

  const progress = loadProgress();
  log(`Progresso anterior: ${progress.processed.length} ok, ${progress.failed.length} falhas`);

  // Pega produtos pra classificar
  let products;
  if (sampleSize) {
    products = await prisma.product.findMany({
      where: { active: true, NOT: { id: { in: progress.processed } } },
      take: sampleSize,
      orderBy: { createdAt: 'asc' },
      select: { id: true, sku: true, name: true, brand: true, category: true, subcategory: true, shortDescription: true, longDescription: true, aiContext: true },
    });
  } else if (isAll) {
    products = await prisma.product.findMany({
      where: { active: true, NOT: { id: { in: progress.processed } } },
      orderBy: { createdAt: 'asc' },
      select: { id: true, sku: true, name: true, brand: true, category: true, subcategory: true, shortDescription: true, longDescription: true, aiContext: true },
    });
  } else {
    log('Use --sample=N ou --all');
    process.exit(0);
  }
  log(`A classificar: ${products.length} produtos`);
  if (!products.length) { log('Nada a fazer.'); return; }

  const start = Date.now();
  let done = 0, ok = 0, fail = 0;
  const typeBreakdown = { Tênis: 0, Chuteira: 0, Outro: 0 };

  // Worker pool concorrente
  let idx = 0;
  async function worker() {
    while (idx < products.length) {
      const i = idx++;
      const p = products[i];
      const r = await processProduct(client, p, progress);
      done++;
      if (r.ok) {
        ok++;
        typeBreakdown[r.type] = (typeBreakdown[r.type] || 0) + 1;
        if (sampleSize) {
          console.log(`  ✓ ${p.sku.padEnd(20)} ${p.name.slice(0, 50).padEnd(50)} → ${r.type}/${r.gender || '-'}/${r.modality || '-'}/${r.tier || '-'} [conf=${r.confidence}]`);
        }
      } else {
        fail++;
        console.log(`  ✗ ${p.sku}: ${r.error.slice(0, 80)}`);
      }
      if (done % 50 === 0 && !sampleSize) {
        const elapsed = (Date.now() - start) / 1000;
        const rate = done / elapsed;
        const eta = (products.length - done) / rate;
        log(`  Progresso: ${done}/${products.length} (${ok} ok / ${fail} fail) · ${rate.toFixed(1)}/s · ETA ${Math.round(eta / 60)}min`);
        log(`  Tipos: Tênis=${typeBreakdown.Tênis || 0} · Chuteira=${typeBreakdown.Chuteira || 0} · Outro=${typeBreakdown.Outro || 0}`);
        saveProgress(progress);
      }
      if (DELAY_MS) await new Promise(r => setTimeout(r, DELAY_MS));
    }
  }

  await Promise.all(Array(CONCURRENCY).fill(0).map(() => worker()));
  saveProgress(progress);

  const totalMin = ((Date.now() - start) / 1000 / 60).toFixed(1);
  log('=== FINAL ===');
  log(`Total: ${done} · OK: ${ok} · Falhas: ${fail} · Tempo: ${totalMin}min`);
  log(`Distribuição: Tênis=${typeBreakdown.Tênis || 0} · Chuteira=${typeBreakdown.Chuteira || 0} · Outro=${typeBreakdown.Outro || 0}`);
}

main().catch(e => { console.error('FATAL:', e); process.exit(1); }).finally(() => prisma.$disconnect());
