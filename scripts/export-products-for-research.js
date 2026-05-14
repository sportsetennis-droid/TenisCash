// =====================================================================
// Export produtos pra pesquisa externa de descrição.
// Gera um JSON com 1 entrada por produto, contendo:
//   id, sku, referencia (cProd), nome, marca, cor, url_sugerida (no
//   converse.com.br), descricao_html (vazio — você preenche).
// =====================================================================
// Uso:
//   node scripts/export-products-for-research.js [--cnpj=02675611000750] [--only-missing] [--out=caminho.json]
// Defaults:
//   --cnpj: vazio = todos
//   --only-missing: só produtos sem longDescription
//   --out: ./products-research.json
// =====================================================================

const fs = require('fs');
const path = require('path');
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

function parseArgs() {
  const args = process.argv.slice(2);
  const out = {};
  for (const a of args) {
    if (a.startsWith('--cnpj=')) out.cnpj = a.split('=')[1];
    else if (a === '--only-missing') out.onlyMissing = true;
    else if (a === '--all') out.onlyMissing = false;
    else if (a.startsWith('--out=')) out.out = a.split('=')[1];
  }
  return out;
}

async function main() {
  const args = parseArgs();
  const cnpj = args.cnpj || null;
  // Default: só sem descrição. Use --all pra incluir os já preenchidos.
  const onlyMissing = args.onlyMissing !== false;
  const outPath = args.out || path.join(process.cwd(), 'products-research.json');

  console.log(`\n=== Export produtos pra pesquisa de descrição ===`);
  console.log(`CNPJ:         ${cnpj || '(todos)'}`);
  console.log(`Só sem desc:  ${onlyMissing ? 'sim' : 'não (exporta todos)'}`);
  console.log(`Arquivo out:  ${outPath}\n`);

  const where = { active: true };
  if (cnpj) where.aiContext = { path: ['supplierCnpj'], equals: cnpj };
  if (onlyMissing) where.longDescription = null;

  const products = await prisma.product.findMany({
    where,
    orderBy: { name: 'asc' },
    select: {
      id: true, sku: true, name: true, brand: true, aiContext: true, imageUrl: true,
    },
  });

  console.log(`Encontrados: ${products.length} produtos`);

  const rows = products.map((p) => {
    const ctx = (() => {
      try { return typeof p.aiContext === 'string' ? JSON.parse(p.aiContext) : (p.aiContext || {}); }
      catch (_) { return {}; }
    })();
    const ref = ctx.supplierRef || null;
    const cor = ctx.color || null;
    // Sugestões de URL pra pesquisa
    const urlsSugeridas = [];
    if (ref) {
      urlsSugeridas.push(`https://www.converse.com.br/catalogsearch/result/?q=${encodeURIComponent(ref)}`);
      urlsSugeridas.push(`https://www.google.com/search?q=site%3Aconverse.com.br+%22${encodeURIComponent(ref)}%22`);
    }
    // Busca pelo nome
    const nomeBusca = (p.name || '').replace(/^t[eê]nis\s+/i, '').trim();
    if (nomeBusca) {
      urlsSugeridas.push(`https://www.google.com/search?q=site%3Aconverse.com.br+${encodeURIComponent(nomeBusca)}`);
    }
    return {
      id: p.id,
      sku: p.sku,
      referencia: ref,
      nome: p.name,
      marca: p.brand,
      cor,
      imagem: p.imageUrl,
      urls_sugeridas: urlsSugeridas,
      // === PREENCHER ABAIXO ===
      url_da_pagina_oficial: '',
      descricao_html: '',
      observacao: '',
    };
  });

  fs.writeFileSync(outPath, JSON.stringify(rows, null, 2), 'utf8');
  console.log(`\n✓ Arquivo gerado: ${outPath}`);
  console.log(`   Linhas: ${rows.length}`);
  console.log(`\nProximo passo: passa esse JSON pra outra IA preencher`);
  console.log(`os campos "url_da_pagina_oficial" e "descricao_html" de cada item.`);
  console.log(`Depois roda: node scripts/import-descriptions-from-json.js <arquivo>`);
  await prisma.$disconnect();
}

main().catch((err) => {
  console.error('ERRO:', err);
  process.exit(1);
});
