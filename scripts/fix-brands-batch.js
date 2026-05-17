// =====================================================================
// Aplica MARCA em massa em produtos sem marca, baseado no fornecedor
// (e em palavras-chave pro DRASTOSA que mistura PUMA/ASICS).
// Custo: ZERO (sem IA, só SQL)
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

const dryRun = !process.argv.includes('--execute');

// Mapeamento CNPJ → marca
const CNPJ_TO_BRAND = {
  '01287588000845': 'UMBRO',           // DASS NORDESTE
  '41923935000208': 'FILA',            // FILA BRASIL
  '04896434000504': 'ADIDAS',          // ALPAR
  '26664189000100': 'ARMY',            // ARMY FITNESS
  '07019231000358': 'EVOKE',           // KENERSON (óculos)
  '61088894002909': 'PENALTY',         // CAMBUCI BA30
  '01992041000174': 'NIKE',            // HAF
  '26153970000110': 'FIBER',           // FIBER COMPANY
  '23593619000152': 'EVERLAST',        // NESK
  '45790447000140': 'PROGNE',          // CHX
  '28836099000185': 'SPALDING',        // FIRST SPORTS
  '37082029000170': 'AURA',            // AURA
  '14136671000270': 'HURLEY',          // MALLEI
  '08762826000280': 'HIDROLIGHT',      // HIDROLIGHT
  '41923935000127': 'FILA',            // FILA BRASIL (outra filial)
  '52129774000110': 'REFLEXX',         // Vistho
  '02566698000132': 'VOLLO',           // Cauduro
  '06864107000164': 'KINDAI',          // Kindai (kimono)
  '04639828000226': 'TOPPER',          // TOPSHOES
  '08877135000222': 'VOLLO',           // VOLLO
  '00954394000117': 'MIZUNO',          // VULCABRAS CE
  '04244823000113': 'TOPPER',          // BETEL
  '05748131000256': 'KAPPA',           // SPR INDUSTRIA
  '51815303000101': 'BOTAFOGO',        // RR VESTUARIO
  '28675159000125': 'SPEEDO',          // HIPERFLEX
  '15836348000190': 'DILLY',           // DILLY
  '18565468001322': 'MIZUNO',          // VULCABRAS SP
  '15315817000207': 'SALOMON',         // WINNERS
  '00733658000102': 'UNDER ARMOUR',    // VULCABRAS BA (UA)
  '02585378000120': 'KAPPA',           // VECTRON
  '43948405000169': 'LUPO',            // LUPO S/A
  '24808018000182': 'DIADORA',         // BRANDS BRASIL
  '12400169000622': 'BROOKS',          // MACROPORT
  '13911740000393': 'OXN',             // VIESS
  '08562929000469': 'SKECHERS',        // SKECHERS
  '61088894002402': 'PENALTY',         // CAMBUCI PB15
  '09130858000145': 'KENNER',          // TESS
  '11098433000733': 'REEBOK',          // RB BRASIL
  '01933349000572': 'LUPO',            // LUPO NORDESTE
  '11098433000148': 'REEBOK',          // RB BRASIL
  '00465813000319': 'KOLOSH',          // DAKOTA NORDESTE
};

const DRASTOSA_CNPJ = '61088936002820';

// DRASTOSA = PUMA ou ASICS. Detecta por palavra no nome.
// PUMA é dominante neste fornecedor (Brasil é distribuidor)
function detectDrastosaBrand(name) {
  const n = (name || '').toLowerCase();
  // Keywords ASICS específicas (sempre tem ASICS no nome ou modelo específico)
  if (/\b(asics|gel-?|kayano|cumulus|nimbus|gt-?1000|novablast|patriot|excite|dynaflyte|contend|metaracer)\b/i.test(n)) return 'ASICS';
  // Tudo o resto da DRASTOSA é PUMA (eles distribuem majoritariamente PUMA)
  return 'PUMA';
}

function log(m) { console.log(`[${new Date().toISOString().slice(11, 19)}] ${m}`); }

async function main() {
  log(`=== APLICAR MARCAS EM MASSA ===`);
  log(`Modo: ${dryRun ? 'DRY-RUN' : 'EXECUTE'}\n`);

  const totals = {};
  let totalUpdated = 0;

  // 1. Fornecedores com marca única (40 CNPJs)
  for (const [cnpj, brand] of Object.entries(CNPJ_TO_BRAND)) {
    const products = await prisma.$queryRaw`
      SELECT id FROM "Product"
      WHERE active = true
        AND (brand IS NULL OR brand = 'A DEFINIR' OR brand = '')
        AND "aiContext"->>'supplierCnpj' = ${cnpj}
    `;
    if (!products.length) continue;
    if (!dryRun) {
      const ids = products.map(p => p.id);
      await prisma.product.updateMany({ where: { id: { in: ids } }, data: { brand } });
    }
    totals[brand] = (totals[brand] || 0) + products.length;
    totalUpdated += products.length;
    log(`  ${cnpj} → ${brand}: ${products.length} produtos`);
  }

  // 2. DRASTOSA: PUMA ou ASICS
  log(`\n--- DRASTOSA ${DRASTOSA_CNPJ} (PUMA/ASICS por keyword) ---`);
  const drastosaProducts = await prisma.$queryRaw`
    SELECT id, name FROM "Product"
    WHERE active = true
      AND (brand IS NULL OR brand = 'A DEFINIR' OR brand = '')
      AND "aiContext"->>'supplierCnpj' = ${DRASTOSA_CNPJ}
  `;
  const pumaIds = [], asicsIds = [];
  drastosaProducts.forEach(p => {
    if (detectDrastosaBrand(p.name) === 'ASICS') asicsIds.push(p.id);
    else pumaIds.push(p.id);
  });
  if (!dryRun) {
    if (pumaIds.length) await prisma.product.updateMany({ where: { id: { in: pumaIds } }, data: { brand: 'PUMA' } });
    if (asicsIds.length) await prisma.product.updateMany({ where: { id: { in: asicsIds } }, data: { brand: 'ASICS' } });
  }
  totals['PUMA'] = (totals['PUMA'] || 0) + pumaIds.length;
  totals['ASICS'] = (totals['ASICS'] || 0) + asicsIds.length;
  totalUpdated += drastosaProducts.length;
  log(`  PUMA:  ${pumaIds.length}`);
  log(`  ASICS: ${asicsIds.length}`);

  log(`\n=== RESULTADO ${dryRun ? '(SIMULADO)' : 'APLICADO'} ===`);
  log(`Total produtos atualizados: ${totalUpdated}`);
  log(`\nDistribuição por marca:`);
  Object.entries(totals).sort((a, b) => b[1] - a[1]).forEach(([brand, cnt]) => {
    log(`  ${brand.padEnd(18)} ${cnt}`);
  });

  // Estado final
  const semMarca = await prisma.$queryRaw`SELECT COUNT(*) as cnt FROM "Product" WHERE active = true AND (brand IS NULL OR brand = 'A DEFINIR' OR brand = '')`;
  log(`\nAtivos AINDA sem marca: ${Number(semMarca[0].cnt)}`);
}

main().catch(e => { console.error('FATAL:', e); process.exit(1); }).finally(() => prisma.$disconnect());
