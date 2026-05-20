// =====================================================================
// recount-nfe-vs-db.js — recontagem de produtos via XMLs vs banco
// =====================================================================
// Lê todos XMLs de 2 pastas (matriz + filial 02), filtra fora as NFes
// de transferência interna do grupo Meta Esportes (raiz CNPJ 44052617)
// e compara com o banco de produtos atual.
//
// Uso:
//   node scripts/recount-nfe-vs-db.js \
//     --dirs /c/tmp/nfe-recount/matriz,/c/tmp/nfe-recount/filial02 \
//     --root-cnpj 44052617
// =====================================================================
try {
  const env = require('fs').readFileSync('.env', 'utf8');
  env.split('\n').forEach(l => {
    const m = l.match(/^([^=#]+)=(.*)$/);
    if (m) process.env[m[1].trim()] = m[2].trim().replace(/^["']|["']$/g, '');
  });
} catch {}

const fs = require('fs');
const path = require('path');
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

const args = Object.fromEntries(process.argv.slice(2).reduce((acc, v, i, a) => {
  if (v.startsWith('--')) acc.push([v.slice(2), a[i + 1] && !a[i + 1].startsWith('--') ? a[i + 1] : true]);
  return acc;
}, []));
const DIRS = (args.dirs || '/c/tmp/nfe-recount/matriz,/c/tmp/nfe-recount/filial02').split(',');
const ROOT_CNPJ = args['root-cnpj'] || '44052617';

function listXMLs(dir) {
  const out = [];
  function walk(p) {
    if (!fs.existsSync(p)) return;
    const st = fs.statSync(p);
    if (st.isDirectory()) {
      fs.readdirSync(p).forEach(c => walk(path.join(p, c)));
    } else if (/\.xml$/i.test(p)) {
      out.push(p);
    }
  }
  walk(dir);
  return out;
}

function extract(xml, tag) {
  const m = xml.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`));
  return m ? m[1].trim() : null;
}

function parseNFe(xmlText) {
  const emitBlock = extract(xmlText, 'emit') || '';
  const destBlock = extract(xmlText, 'dest') || '';
  const ideBlock  = extract(xmlText, 'ide') || '';
  // Regex direto pra CNPJ dentro de emit/dest — mais robusto que extract aninhado
  const emitCnpjMatch = xmlText.match(/<emit>[\s\S]*?<CNPJ>(\d+)<\/CNPJ>/);
  const destCnpjMatch = xmlText.match(/<dest>[\s\S]*?<CNPJ>(\d+)<\/CNPJ>/);
  const emitCnpj = emitCnpjMatch ? emitCnpjMatch[1] : null;
  const destCnpj = destCnpjMatch ? destCnpjMatch[1] : null;
  const nNF      = extract(ideBlock, 'nNF');
  const serie    = extract(ideBlock, 'serie');
  const natOp    = extract(ideBlock, 'natOp') || '';
  const emitName = extract(emitBlock, 'xNome') || '';
  const destName = extract(destBlock, 'xNome') || '';
  // Itens
  const items = [];
  const detRe = /<det[^>]*>([\s\S]*?)<\/det>/g;
  let dm;
  while ((dm = detRe.exec(xmlText)) !== null) {
    const det = dm[1];
    const prod = extract(det, 'prod') || '';
    items.push({
      cProd: extract(prod, 'cProd'),
      cEAN: extract(prod, 'cEAN'),
      xProd: extract(prod, 'xProd'),
      ncm: extract(prod, 'NCM'),
      cfop: extract(prod, 'CFOP'),
      uCom: extract(prod, 'uCom'),
      qCom: parseFloat(extract(prod, 'qCom') || '0'),
      vUnCom: parseFloat(extract(prod, 'vUnCom') || '0'),
      vProd: parseFloat(extract(prod, 'vProd') || '0'),
    });
  }
  return { emitCnpj, destCnpj, emitName, destName, nNF, serie, natOp, items };
}

(async () => {
  const allFiles = DIRS.flatMap(d => listXMLs(d));
  console.log('XMLs encontrados:', allFiles.length);
  console.log('Raiz Meta Esportes (descarta transferência interna):', ROOT_CNPJ);
  console.log('');

  let purchaseNFes = 0;
  let transferNFes = 0;
  let skipped = 0;
  const buyByEmit = {};
  const allItems = [];
  const cProdSet = new Set();
  const eanSet = new Set();
  const namesSet = new Set();
  const supplierStats = {};

  for (const f of allFiles) {
    let xml;
    try { xml = fs.readFileSync(f, 'utf8'); } catch { skipped++; continue; }
    // Aceita NFe, nfeProc (NFe + protocolo) — descarta eventos/CCe/cancelamento
    if (!xml.includes('<infNFe') && !xml.includes('<NFe ') && !xml.includes('<NFe>') && !xml.includes('<nfeProc')) { skipped++; continue; }
    // Descarta eventos (cancelamento, CCe, manifestação)
    if (xml.includes('<procEventoNFe') || xml.includes('<envEvento') || xml.includes('<eventoNFe')) { skipped++; continue; }
    let p;
    try { p = parseNFe(xml); } catch { skipped++; continue; }
    if (!p.emitCnpj || !p.destCnpj) { skipped++; continue; }
    const emitRoot = p.emitCnpj.slice(0, 8);
    const destRoot = p.destCnpj.slice(0, 8);
    const isTransfer = emitRoot === ROOT_CNPJ && destRoot === ROOT_CNPJ;
    if (isTransfer) { transferNFes++; continue; }
    purchaseNFes++;
    buyByEmit[p.emitCnpj] = buyByEmit[p.emitCnpj] || { name: p.emitName, nfeCount: 0, items: 0, value: 0 };
    buyByEmit[p.emitCnpj].nfeCount++;
    p.items.forEach(it => {
      buyByEmit[p.emitCnpj].items++;
      buyByEmit[p.emitCnpj].value += it.vProd;
      allItems.push({ supplierCnpj: p.emitCnpj, ...it });
      if (it.cProd) cProdSet.add(p.emitCnpj + '||' + it.cProd);
      if (it.cEAN && /^\d{12,14}$/.test(it.cEAN)) eanSet.add(it.cEAN);
      if (it.xProd) namesSet.add(it.xProd.toUpperCase().trim());
    });
  }

  console.log('=== NFes processadas ===');
  console.log('  Compra (de fornecedor):  ', purchaseNFes);
  console.log('  Transferência interna:   ', transferNFes, '(DESCARTADAS)');
  console.log('  Skipped/inválidos:       ', skipped);
  console.log('  Total items compra:      ', allItems.length);
  console.log('  cProd únicos (sup+cProd):', cProdSet.size);
  console.log('  EANs únicos:             ', eanSet.size);
  console.log('  Nomes (xProd) únicos:    ', namesSet.size);
  console.log('');

  console.log('=== Top 15 fornecedores por # itens ===');
  Object.entries(buyByEmit)
    .sort((a, b) => b[1].items - a[1].items)
    .slice(0, 15)
    .forEach(([cnpj, s]) => console.log(`  ${cnpj} | NFes:${s.nfeCount.toString().padStart(4)} | itens:${s.items.toString().padStart(5)} | R$${s.value.toFixed(0).padStart(8)} | ${s.name.slice(0, 40)}`));
  console.log('');

  // Compara com banco
  console.log('=== Comparando com banco ===');
  const dbTotal = await prisma.product.count();
  const dbActive = await prisma.product.count({ where: { active: true } });
  const dbInactive = await prisma.product.count({ where: { active: false } });
  const dbMaster = await prisma.product.count({ where: { active: true, sku: { startsWith: 'UNI-' } } });
  console.log('  Produtos banco TOTAL:    ', dbTotal);
  console.log('  Produtos ativos:         ', dbActive);
  console.log('  Inativos (unif):         ', dbInactive);
  console.log('  Mestres unificados:      ', dbMaster);
  console.log('');

  // Match por EAN: quantos EAN dos XMLs estão no banco?
  const eanList = Array.from(eanSet).slice(0, 5000);
  let inBank = 0;
  if (eanList.length) {
    const rows = await prisma.$queryRaw`
      SELECT COUNT(DISTINCT id)::int qty FROM "Product"
      WHERE EXISTS (
        SELECT 1 FROM unnest(${eanList}::text[]) e WHERE sku LIKE '%' || e || '%'
      )`;
    inBank = rows[0]?.qty || 0;
  }
  console.log('  EANs dos XMLs encontrados no banco (via sku contém EAN):', inBank, '/', eanSet.size);
  console.log('');

  // Salva relatório
  const out = 'C:/tmp/nfe-recount/report.json';
  fs.writeFileSync(out, JSON.stringify({
    summary: { purchaseNFes, transferNFes, skipped, items: allItems.length, uniqueCProd: cProdSet.size, uniqueEAN: eanSet.size, uniqueNames: namesSet.size },
    bank: { total: dbTotal, active: dbActive, inactive: dbInactive, masters: dbMaster },
    eanMatchInBank: inBank,
    suppliers: buyByEmit,
  }, null, 2));
  console.log('Relatório salvo em', out);

  await prisma.$disconnect();
})().catch(async (e) => { console.error('ERRO:', e); await prisma.$disconnect(); process.exit(1); });
