// =====================================================================
// Importa em sequência todos os fornecedores ainda não importados.
// Pula os que já existem no banco com produtos.
// =====================================================================

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { PrismaClient } = require('@prisma/client');
const { parseNfeXml } = require('../src/services/xmlNfeParser');

const prisma = new PrismaClient();
const ROOT = 'C:/Users/sport/Downloads/nfe-analysis';
const MIN_ITEMS = 50; // só importa fornecedores com >= 50 itens (pula ruído)

function findXmlFiles(rootDir) {
  const out = [];
  function walk(dir) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.isFile() && /^NFE_.*\.xml$/i.test(e.name)) out.push(full);
    }
  }
  walk(rootDir);
  return out;
}

async function runImport(cnpj) {
  return new Promise((resolve) => {
    const child = spawn('node', ['scripts/import-supplier.js', cnpj, ROOT], { stdio: 'inherit', shell: true });
    child.on('exit', (code) => resolve(code));
  });
}

async function main() {
  // 1. Lista fornecedores nos XMLs
  console.log('Escaneando XMLs...');
  const files = findXmlFiles(ROOT);
  const bySupplier = new Map();
  for (const f of files) {
    try {
      const xml = fs.readFileSync(f, 'utf8');
      const parsed = await parseNfeXml(xml);
      const key = parsed.issuerCnpj;
      if (!key) continue;
      const entry = bySupplier.get(key) || { cnpj: key, name: parsed.issuerName, count: 0, items: 0 };
      entry.count++;
      entry.items += (parsed.items || []).length;
      bySupplier.set(key, entry);
    } catch (_) {}
  }

  // 2. Quais já têm produtos no banco?
  const allCnpjs = [...bySupplier.keys()];
  const existingProducts = await prisma.product.findMany({
    where: { active: true, aiContext: { not: null } },
    select: { aiContext: true },
  });
  const existingCnpjs = new Set();
  for (const p of existingProducts) {
    const ctx = typeof p.aiContext === 'string' ? JSON.parse(p.aiContext) : (p.aiContext || {});
    if (ctx.supplierCnpj) existingCnpjs.add(ctx.supplierCnpj);
  }

  // 3. Filtra os que faltam, com tamanho mínimo
  const toImport = [...bySupplier.values()]
    .filter((s) => !existingCnpjs.has(s.cnpj) && s.items >= MIN_ITEMS)
    .sort((a, b) => b.items - a.items);

  console.log(`\n${toImport.length} fornecedores a importar (>= ${MIN_ITEMS} itens, ainda não no banco):`);
  console.log('CNPJ              | Itens | NF-es | Fornecedor');
  toImport.forEach((s) => {
    console.log(`${s.cnpj.padEnd(17)} | ${String(s.items).padStart(5)} | ${String(s.count).padStart(5)} | ${(s.name||'').slice(0,55)}`);
  });
  await prisma.$disconnect();

  // 4. Importa cada um
  console.log('\n=== Iniciando imports sequenciais ===\n');
  for (let i = 0; i < toImport.length; i++) {
    const s = toImport[i];
    console.log(`\n>>> [${i + 1}/${toImport.length}] ${s.name} (${s.cnpj})`);
    const code = await runImport(s.cnpj);
    console.log(`<<< exit code: ${code}`);
  }
  console.log('\n=== TUDO IMPORTADO ===');
}

main().catch((err) => { console.error('ERRO:', err); process.exit(1); });
