// =====================================================================
// auto-classify-products.js — auto-classifica produtos sem categoria/marca
// =====================================================================
// 1. Aplica Product.category baseado em keywords (Tênis/Chuteiras/Vestuário/Acessórios)
// 2. Tambem inclui inferência por MARCA (SKECHERS/DIADORA → Tênis)
// 3. Inferência de marca pelo fornecedor (suppliedBrands[0])
// 4. Detecta INSUMOS e marca active=false
//
// Idempotente.
// =====================================================================
try {
  const env = require('fs').readFileSync('.env', 'utf8');
  env.split(/\r?\n/).forEach(l => {
    const m = l.match(/^([^=#]+)=(.*)$/);
    if (m) process.env[m[1].trim()] = m[2].trim().replace(/^["']|["']$/g, '');
  });
} catch {}

const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

const args = Object.fromEntries(process.argv.slice(2).reduce((acc, v, i, a) => {
  if (v.startsWith('--')) acc.push([v.slice(2), a[i + 1] && !a[i + 1].startsWith('--') ? a[i + 1] : true]);
  return acc;
}, []));
const DRY = args.dry || (!args.apply);

// Marcas cujo catálogo é dominantemente CALÇADO esportivo → default categoria Tênis
const FOOTWEAR_BRANDS = new Set([
  'SKECHERS', 'DIADORA', 'REEBOK', 'SALOMON', 'ASICS', 'MIZUNO', 'OLYMPIKUS',
  'OAKLEY', 'NIKE', 'PUMA', 'ADIDAS', 'NEW BALANCE', 'UNDER ARMOUR', 'FILA',
  'CONVERSE', 'VANS', 'JORDAN', 'BROOKS', 'HOKA', 'ON', 'ALTRA',
]);

const APPAREL_BRANDS = new Set([
  'CAJU BRASIL', 'CAJUBRASIL', 'HOPE RESORT', 'LET\'S GYM', 'LETS GYM',
  'KAPPA', 'BOTAFOGO', 'PATERSON',
]);

const INSUMO_RX = /^ETIQ|^EMBALAGEM|TUBO DE COBRE|PANQUECA \d|MANEQ:\d|CONJUNTO PE[ÇC]A|CURVADOR DE TUBO|CORTINA DE AR|OUTRO SERVICO|FRETE|LIXA(?: LX)?$|CHAVE SKATE|TRUCK VERTICAL|MODELO \d+ - SKATE/i;

function classify(name, brand) {
  const n = (name || '').toUpperCase();
  const b = (brand || '').toUpperCase().trim();
  if (!n) return null;

  // INSUMO / SERVIÇO
  if (INSUMO_RX.test(n)) return { category: '__INSUMO__' };

  // CHUTEIRAS
  if (/CHUTEIRA|FUTSAL|SOCIETY[^A-Z]|TRAVA\b|CRAVOS|CAMPO\b|GRAMA/.test(n)) return { category: 'Chuteiras' };

  // CHINELO / SLIDE / SANDÁLIA — Acessórios
  if (/CHINELO|SLIDE\b|SANDALI|SAND[ÁA]LI|CROCS|PALMILHA/.test(n)) return { category: 'Acessórios' };

  // BOTAS → Tênis (calçado fechado esportivo)
  if (/^BOTA\b|\bBOTA\b/.test(n)) return { category: 'Tênis' };

  // TÊNIS / CALÇADOS esportivos
  if (/TENIS|T[ÊE]NIS|SNEAKER|RUNNING|RUNNER|CORRIDA\b|JOGGING|CALCADO|CAL[ÇC]ADO|SAPATILHA|SCARPIN|SAPATO\b/.test(n)) return { category: 'Tênis' };

  // VESTUÁRIO
  if (/CAMISETA|CAMISA\b|POLO\b|CROPPED|REGATA|BLUSA|TOP\b|SAIA\b|SHORT|CAL[ÇC]A\b|BERMUDA|MACAQUI|MACAC[ÃA]O|VESTIDO|LEGGING|AGASALHO|JAQUETA|MOLETOM|SUTI[ÃA]|MAIO\b|BIQUINI|BIQUÍNI|PIJAMA|COLETE|CAS[AA]CO|SUNGA|CUECA|CALCINHA|FARDAMENTO|UNIFORME|KIMONO|JIU\s*-?\s*JITSU|T-SHIRT|TSHIRT|VESTUARIO|VESTUÁRIO|HOODIE/.test(n)) return { category: 'Vestuário' };

  // ACESSÓRIOS
  if (/COTOVELEIRA|JOELHEIRA|TORNOZELEIRA|CANELEIRA|BOLA\b|RAQUETE|BON[ÉE]|MOCHILA|BOLSA|FAIXA|MUNHEQUEIRA|TOUCA|[ÓO]CULOS|CORDA|HALTER|PROTETOR|MEI[AÃ]\b|MEIAS|LUVA\b|CINTA\b|GARRAFA|SQUEEZE|SACOLA|NECESSAIRE|SHAMPOO|DESODORANTE|PERFUME|REDE\b|PRANCHA|BODYBOARD|BOLINHA|OC HB SPINNER|GAMECHANGER|ORTHOTICS|KIT PROTECAO|CAPACETE|JOELHEIRA|PROTETOR/i.test(n)) return { category: 'Acessórios' };

  // MODELOS CONHECIDOS DE TÊNIS (sem palavra "tenis" explícita)
  if (/\bGO RUN\b|\bGO WALK\b|\bARCH FIT\b|\bMAX CUSHIONING\b|\bBOBS\b|\bEDGERIDE\b|\bROYAL\b|\bENERGEN\b|\bDURAMO\b|\bGALAXY\b|\bBRAVADA\b|\bCOURTBLOCK\b|\bSTREETRIDE\b|\bDEPORTIVO\b|\bILLUSIONE\b|\bPLAYMAKER\b|\bGIOVE\b/.test(n)) return { category: 'Tênis' };

  // FALLBACK por marca (marcas dominantemente de calçado)
  if (FOOTWEAR_BRANDS.has(b)) return { category: 'Tênis', confidence: 'low' };
  if (APPAREL_BRANDS.has(b)) return { category: 'Vestuário', confidence: 'low' };

  return null;
}

(async () => {
  console.log('\n=== Auto-classificar Products (v2) ===');
  console.log('Modo:', DRY ? 'DRY-RUN' : 'APPLY');

  // 1) CATEGORIA
  const targets = await prisma.$queryRaw`
    SELECT id, name, brand FROM "Product"
    WHERE active=true AND (category IS NULL OR category='' OR category='A CLASSIFICAR')
  `;
  console.log('\nProdutos sem categoria:', targets.length);

  const stats = { 'Tênis': 0, 'Chuteiras': 0, 'Vestuário': 0, 'Acessórios': 0, '__INSUMO__': 0, 'ambíguo': 0 };
  const updates = [];

  for (const p of targets) {
    const r = classify(p.name, p.brand);
    if (r?.category) {
      stats[r.category]++;
      updates.push({ id: p.id, category: r.category });
    } else {
      stats['ambíguo']++;
    }
  }

  console.log('\nDistribuição:');
  Object.entries(stats).forEach(([k, v]) => {
    console.log('  ' + k.padEnd(15) + ':', v.toString().padStart(5));
  });
  console.log('  TOTAL CLASSIFICÁVEL:', updates.length, '(' + ((updates.length / targets.length) * 100).toFixed(1) + '%)');

  if (!DRY && updates.length) {
    console.log('\nAplicando categoria...');
    let done = 0;
    for (const u of updates) {
      if (u.category === '__INSUMO__') {
        await prisma.product.update({ where: { id: u.id }, data: { active: false, category: 'INSUMO' } });
      } else {
        await prisma.product.update({ where: { id: u.id }, data: { category: u.category } });
      }
      done++;
      if (done % 500 === 0) console.log('  ' + done + '/' + updates.length);
    }
    console.log('  Atualizados:', done);
  }

  // 2) MARCA via supplier.suppliedBrands[0]
  console.log('\n=== INFERÊNCIA DE MARCA ===');
  const semMarca = await prisma.$queryRaw`
    SELECT id, name, brand, "aiContext"::jsonb as ctx FROM "Product"
    WHERE active=true AND (brand IS NULL OR brand='' OR brand='A DEFINIR')
  `;
  console.log('Produtos sem marca:', semMarca.length);

  // Pré-cache de suppliers
  const suppliers = await prisma.supplier.findMany({ select: { cnpj: true, suppliedBrands: true } });
  const supByCnpj = Object.fromEntries(
    suppliers
      .filter(s => s.cnpj && Array.isArray(s.suppliedBrands) && s.suppliedBrands.length === 1)
      .map(s => [s.cnpj, s.suppliedBrands[0]])
  );
  console.log('Suppliers com 1 marca única:', Object.keys(supByCnpj).length);

  let updMarca = 0;
  for (const p of semMarca) {
    const cnpj = p.ctx?.supplierCnpj;
    const inferred = cnpj && supByCnpj[cnpj];
    if (inferred) {
      if (!DRY) await prisma.product.update({ where: { id: p.id }, data: { brand: inferred } });
      updMarca++;
    }
  }
  console.log('Marcas inferidas (via supplier.suppliedBrands[0]):', updMarca);

  // Stats finais
  const final = await prisma.$queryRaw`
    SELECT category, count(*)::int as c FROM "Product"
    WHERE active=true GROUP BY category ORDER BY count(*) DESC
  `;
  console.log('\nDistribuição final (active=true):');
  final.forEach(x => console.log('  ' + (x.category || '(null)').padEnd(20) + ': ' + x.c));

  await prisma.$disconnect();
})().catch(async e => { console.error('FATAL:', e); await prisma.$disconnect(); process.exit(1); });
