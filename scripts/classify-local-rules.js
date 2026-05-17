// =====================================================================
// Classificador LOCAL por regras (zero custo, sem IA)
// =====================================================================
// Usa padrões no nome/marca/categoria pra preencher a classificação
// Sports & Tennis (tipo + gênero + modalidade). Tier é deixado em
// branco pra revisão manual (é mais subjetivo).
//
// Roda em produtos:
//   - ainda NÃO classificados, OU
//   - classificação anterior sem confidence (rótulos antigos)
//
// Marca: confidence=0.7, classifiedBy='local-rules'
//
// Uso:
//   node scripts/classify-local-rules.js              → todos os pendentes
//   node scripts/classify-local-rules.js --all        → reprocessa TUDO
//   node scripts/classify-local-rules.js --sample=20  → testa em 20
// =====================================================================

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

const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

const argv = process.argv.slice(2);
const isAll = argv.includes('--all');
const sampleSize = (argv.find(a => a.startsWith('--sample=')) || '').split('=')[1];

function log(m) { console.log(`[${new Date().toISOString().slice(11, 19)}] ${m}`); }

function classifyByText(name, brand, category, subcategory) {
  // TIPO usa SÓ o nome (category/subcategory tá sempre "tenis" no banco e quebra regra)
  const nameLower = String(name || '').toLowerCase();
  // Texto completo só pra GÊNERO/MODALIDADE/TIER
  const fullText = [name, brand, category, subcategory].filter(Boolean).join(' ').toLowerCase();

  // === TIPO === (estrita, baseada SÓ no nome)
  let type = null;

  // OUTROS primeiro (mais específico - roupas, acessórios, sandálias)
  if (/\b(camiseta|regata|short|bermuda|cal[çc]a|moletom|jaqueta|blusa|polo|legging|conjunto|agasalho|colete|cropped|top|sutia|biquini|sutiã)\b/i.test(nameLower) ||
      /\b(meia|bon[ée]|mochila|bolsa|garrafa|toalha|joelheira|tornozeleira|cotoveleira|mun[hh]eca|mun?hequeira|caneleira|perneira)\b/i.test(nameLower) ||
      /\b(necessaire|pochete|carteira|chinelo|sand[aá]lia|sandalia|sungas?|sunga|maio|fralda|fraldinha)\b/i.test(nameLower) ||
      /\b(bola|raquete|peso|halter|barra|colchonete|tatame|corda|el[áa]stico|cone|escadinha|kettlebell)\b/i.test(nameLower) ||
      /\b(perfume|essencia|ess[êe]ncia|creme|hidratante|repelente|protetor)\b/i.test(nameLower) ||
      /\b(suporte|flex[ãa]o|fita|cinta|abdominal|step|disco|massagem|massageador)\b/i.test(nameLower) ||
      /\b(perna|coxa|brace|protetora|protecao|prote[çc][ãa]o)\b/i.test(nameLower) ||
      /\b(compress[aã]o|compression|fitness|gym|crossfit|treino|training)\s+(?!shoe)/i.test(nameLower)) {
    type = 'Outro';
  }
  // Chuteira (palavras específicas no nome)
  else if (/\bchuteira\b/i.test(nameLower) ||
           /\b(futsal|society|fts\b|sct\b)\b/i.test(nameLower) ||
           /\b(magic[\s-]?soccer|trava[\s-]?campo)\b/i.test(nameLower)) {
    type = 'Chuteira';
  }
  // Tênis — STRICT: tem que ter "TÊNIS" ou "TENIS" no nome
  else if (/\b(t[êe]nis|sapatilha)\b/i.test(nameLower)) {
    type = 'Tênis';
  }
  // Não classifica — vai pra revisão manual

  // === GÊNERO (só faz sentido pra Tênis e algumas Chuteiras) ===
  let gender = null;
  if (type === 'Tênis') {
    // Infantil PRIMEIRO (palavras específicas)
    if (/\binf[\.\s]?[mf]\b/i.test(fullText) || /\binfantil/i.test(fullText) || /\bkids\b/i.test(fullText) ||
        /\bmenin[oa]s?\b/i.test(fullText) || /\bcrian[çc]a/i.test(fullText) || /\bbebe\b/i.test(fullText)) {
      if (/\binf[\.\s]?f\b/i.test(fullText) || /\bmenina/i.test(fullText) || /\bfeminin/i.test(fullText)) gender = 'Inf. F';
      else gender = 'Inf. M';
    }
    // Feminino
    else if (/\bfemin/i.test(fullText) || /\bmulher/i.test(fullText) || /\bwomen/i.test(fullText) ||
             /\bwmn\b/i.test(fullText) || /\bfem\b/i.test(fullText) || /\bw\.|wlk\.|wmns\b/i.test(fullText)) {
      gender = 'Feminino';
    }
    // Masculino (explícito)
    else if (/\bmascul/i.test(fullText) || /\bhomem\b/i.test(fullText) || /\bmen[\b\s]|\bmens\b/i.test(fullText) ||
             /\bm\.|h\b|masc/i.test(fullText)) {
      gender = 'Masculino';
    }
    // Sem indicação clara → deixa null (revisar)
  }

  // === MODALIDADE ===
  let modality = null;
  if (type === 'Tênis') {
    if (/\bcorrida|running|run\b/i.test(fullText)) modality = 'Corrida';
    else if (/\bcaminhada|walking|walk\b/i.test(fullText)) modality = 'Caminhada / Treino leve';
    else if (/\b(casual|lifestyle|sportstyle|life[\s-]?style|estilo de vida)\b/i.test(fullText)) modality = 'LifeStyle';
    else if (/\b(recovery|recuper)/i.test(fullText)) modality = 'Recuperação';
    else if (/\b(cross[\s-]?fit|musc[uí]l|hyrox|hiit|training|treino pesado)/i.test(fullText)) modality = 'Musculação / CrossFit / Hyrox';
    else if (/\bsapatilha\b/i.test(fullText)) modality = 'Sapatilha';
    else if (/\bstreet/i.test(fullText)) modality = 'Streetwear';
  } else if (type === 'Chuteira') {
    if (/\bfutsal|fts\b/i.test(fullText)) modality = 'Futsal';
    else if (/\bsociety|sct\b/i.test(fullText)) modality = 'Society';
    else if (/\b(campo|fg|firm[\s-]?ground)\b/i.test(fullText)) modality = 'Campo';
  }

  // === TIER ===
  // Algumas regras simples (a maioria precisa revisão humana)
  let tier = null;
  if (modality === 'Corrida') {
    if (/\b(maratona|marathon)\b/i.test(fullText)) tier = 'maratona';
    else if (/\b(velocidade|speed|fast|race|racing)\b/i.test(fullText)) tier = 'velocidade';
    else if (/\b(max(\s|i?)conforto|cushion|cushy|cumulus|nimbus|cloud|max\s?cushion)\b/i.test(fullText)) tier = 'máximo conforto';
  } else if (modality === 'LifeStyle') {
    if (/\bpremium|premium\b/i.test(fullText)) tier = 'premium';
    else if (/\bcasual\b/i.test(fullText)) tier = 'casual';
    else if (/\bcl[áa]ssico|classic\b/i.test(fullText)) tier = 'clássico';
  }

  return { type, gender, modality, tier };
}

async function main() {
  log(`=== CLASSIFICADOR LOCAL POR REGRAS (zero custo) ===`);

  // Pega todos ativos e filtra no código (Prisma JSON filter é ruim pra "não existe")
  const take = sampleSize ? parseInt(sampleSize, 10) : undefined;
  const allProducts = await prisma.product.findMany({
    where: { active: true },
    select: { id: true, sku: true, name: true, brand: true, category: true, subcategory: true, aiContext: true },
    take: isAll ? take : undefined, // se --all, usa take. Senão pega todos pra filtrar
  });

  const products = isAll ? allProducts : allProducts.filter(p => {
    try {
      const ctx = typeof p.aiContext === 'string' ? JSON.parse(p.aiContext) : p.aiContext;
      return !ctx?.classification?.classifiedAt;
    } catch { return true; }
  }).slice(0, take);

  log(`Produtos a classificar: ${products.length}`);

  let updated = 0, skipped = 0;
  const stats = { 'Tênis': 0, 'Chuteira': 0, 'Outro': 0, 'null': 0 };
  const start = Date.now();

  for (let i = 0; i < products.length; i++) {
    const p = products[i];
    const r = classifyByText(p.name, p.brand, p.category, p.subcategory);

    if (!r.type) { skipped++; stats.null++; continue; }
    stats[r.type] = (stats[r.type] || 0) + 1;

    const existingCtx = (() => {
      try { return typeof p.aiContext === 'string' ? JSON.parse(p.aiContext) : (p.aiContext || {}); }
      catch { return {}; }
    })();

    await prisma.product.update({
      where: { id: p.id },
      data: {
        aiContext: {
          ...existingCtx,
          classification: {
            type: r.type,
            gender: r.gender || null,
            modality: r.modality || null,
            tier: r.tier || null,
            confidence: 0.7,
            classifiedAt: new Date().toISOString(),
            classifiedBy: 'local-rules',
          },
        },
      },
    });
    updated++;

    if (sampleSize && i < 20) {
      console.log(`  ${p.sku.padEnd(22)} | ${(p.name || '').slice(0, 50).padEnd(50)} → ${r.type}/${r.gender || '-'}/${r.modality || '-'}/${r.tier || '-'}`);
    }
    if (!sampleSize && (i + 1) % 500 === 0) {
      log(`  ${i + 1}/${products.length} (${stats['Tênis']} tênis · ${stats['Chuteira']} chut · ${stats['Outro']} outro · ${stats.null} sem match)`);
    }
  }

  const elapsed = ((Date.now() - start) / 1000).toFixed(1);
  log('\n=== RESULTADO ===');
  log(`Classificados:        ${updated}`);
  log(`Sem match (revisar):  ${skipped}`);
  log(`Tempo:                ${elapsed}s`);
  log(`Distribuição: Tênis=${stats['Tênis']} · Chuteira=${stats['Chuteira']} · Outro=${stats['Outro']}`);
}

main().catch(e => { console.error('FATAL:', e); process.exit(1); }).finally(() => prisma.$disconnect());
