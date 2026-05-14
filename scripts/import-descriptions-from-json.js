// =====================================================================
// Lê o JSON preenchido pela outra IA e atualiza as descrições no banco.
// Se o produto já está na Nuvemshop, dispara auto-sync.
// =====================================================================
// Uso:
//   node scripts/import-descriptions-from-json.js <arquivo.json> [--dry-run] [--skip-sync]
//
// Formato esperado do JSON (array com objetos):
//   { id, sku, descricao_html, url_da_pagina_oficial?, observacao? }
//
// Só importa descricao_html não vazio.
// =====================================================================

const fs = require('fs');
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

function parseArgs() {
  const args = process.argv.slice(2);
  const out = { file: null, dryRun: false, skipSync: false };
  for (const a of args) {
    if (a === '--dry-run') out.dryRun = true;
    else if (a === '--skip-sync') out.skipSync = true;
    else if (!a.startsWith('--') && !out.file) out.file = a;
  }
  return out;
}

async function syncToNuvemshopIfMapped(productId, handlers) {
  try {
    const mapping = await prisma.nuvemshopProductMapping.findUnique({ where: { localProductId: productId } });
    if (!mapping) return { synced: false, reason: 'sem mapping' };
    const connection = await prisma.nuvemshopConnection.findFirst({ where: { status: 'active' } });
    if (!connection) return { synced: false, reason: 'sem conexão' };
    const result = await handlers.pushProductToNuvemshop(productId, connection);
    return { synced: true, action: result.action };
  } catch (err) {
    return { synced: false, error: err.message };
  }
}

async function main() {
  const { file, dryRun, skipSync } = parseArgs();
  if (!file) {
    console.error('Uso: node scripts/import-descriptions-from-json.js <arquivo.json> [--dry-run] [--skip-sync]');
    process.exit(1);
  }
  if (!fs.existsSync(file)) {
    console.error(`Arquivo não encontrado: ${file}`);
    process.exit(1);
  }

  console.log(`\n=== Import descrições do JSON ===`);
  console.log(`Arquivo:   ${file}`);
  console.log(`Modo:      ${dryRun ? 'DRY-RUN' : 'WRITE'}`);
  console.log(`Sync NS:   ${skipSync ? 'NÃO' : 'sim (se mapping existe)'}\n`);

  const raw = fs.readFileSync(file, 'utf8');
  const rows = JSON.parse(raw);
  if (!Array.isArray(rows)) {
    console.error('JSON deve ser um array');
    process.exit(1);
  }

  let updated = 0, skipped = 0, notFound = 0, synced = 0;
  const errors = [];

  // Carrega handlers só se vai fazer sync
  const handlers = !skipSync ? require('../src/services/nuvemshopHandlers') : null;

  for (const row of rows) {
    const desc = (row.descricao_html || '').trim();
    if (!desc) { skipped++; continue; }
    if (!row.id) { errors.push({ sku: row.sku, error: 'sem id' }); continue; }

    const exists = await prisma.product.findUnique({ where: { id: row.id }, select: { id: true } });
    if (!exists) { notFound++; errors.push({ sku: row.sku, error: 'produto não encontrado' }); continue; }

    const shortBase = desc.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    const data = {
      longDescription: desc,
      shortDescription: shortBase ? (shortBase.length > 200 ? shortBase.slice(0, 200) + '…' : shortBase) : null,
    };

    if (!dryRun) {
      await prisma.product.update({ where: { id: row.id }, data });
      if (!skipSync) {
        const r = await syncToNuvemshopIfMapped(row.id, handlers);
        if (r.synced) synced++;
        await new Promise((res) => setTimeout(res, 250));
      }
    }
    updated++;
    if (updated % 10 === 0) process.stdout.write(`\r  ${updated} atualizados...`);
  }

  console.log(`\n\n✅ Resultado:`);
  console.log(`   Atualizados:      ${updated}`);
  console.log(`   Pulados (vazio):  ${skipped}`);
  console.log(`   Não encontrados:  ${notFound}`);
  if (!skipSync) console.log(`   Sincronizados Nuvemshop: ${synced}`);
  if (errors.length) {
    console.log(`\nErros:`);
    errors.slice(0, 10).forEach((e) => console.log('  -', e));
  }

  await prisma.$disconnect();
}

main().catch((err) => {
  console.error('ERRO:', err);
  process.exit(1);
});
