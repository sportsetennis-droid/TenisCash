// =====================================================================
// extract-brand-and-cleanup.js — extrai marca do nome + marca insumos
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

// Marcas conhecidas em ordem de especificidade (mais específicas primeiro)
const BRAND_PATTERNS = [
  // Tênis / esportivos
  [/\bNB FUELCELL\b|\bNEW BALANCE\b|\bM \w+ \dTENIS/, 'NEW BALANCE'],
  [/\bASICS\b/, 'ASICS'],
  [/\bMIZUNO\b/, 'MIZUNO'],
  [/\bSALOMON\b/, 'SALOMON'],
  [/\bSKECHERS\b/, 'SKECHERS'],
  [/\bDIADORA\b/, 'DIADORA'],
  [/\bREEBOK\b/, 'REEBOK'],
  [/\bADIDAS\b/, 'ADIDAS'],
  [/\bNIKE\b/, 'NIKE'],
  [/\bPUMA\b/, 'PUMA'],
  [/\bUNDER ARMOUR\b/, 'UNDER ARMOUR'],
  [/\bCONVERSE\b|\bCHUCK TAYLOR\b/, 'CONVERSE'],
  [/\bFILA\b/, 'FILA'],
  [/\bOLYMPIKUS\b/, 'OLYMPIKUS'],
  [/\bSPEEDO\b|SPO\d+/, 'SPEEDO'],
  [/\bPENALTY\b/, 'PENALTY'],
  [/\bTOPPER\b/, 'TOPPER'],
  [/\bSALMING\b/, 'SALMING'],
  [/\bOAKLEY\b|\bOC HB\b/, 'OAKLEY'],
  [/\bMORMAII\b/, 'MORMAII'],
  [/\bHOKA\b/, 'HOKA'],
  [/\bON CLOUD\b|\bON RUNNING\b/, 'ON'],

  // Vestuário esportivo
  [/\bCAJU\s*BRASIL\b/, 'CAJU BRASIL'],
  [/\bHOPE RESORT\b/, 'HOPE RESORT'],
  [/\bLET[\s']*S?\s*GYM\b/, "LET'S GYM"],
  [/\bPATERSON\b/, 'PATERSON'],
  [/\bZERO AMERICAN\b/, 'ZERO AMERICAN'],
  [/\bKAPPA\b/, 'KAPPA'],
  [/\bBOTAFOGO\b/, 'BOTAFOGO'],

  // Skate / acessórios
  [/\bTHUNDER\b/, 'THUNDER'],
  [/\bELEMENT\b/, 'ELEMENT'],
  [/\bEVOKE\b/, 'EVOKE'],
  [/\bKINGFOAM\b/, 'POWELL PERALTA'],
  [/\bOTAKU\b/, 'OTAKU'],
  [/\bTERJE HAAKONSEN\b/, 'STANCE'],
  [/\bWUTANG\b/, 'WU-TANG'],

  // Outros
  [/\bDRB\b/, 'DRB'],
  [/\bBAGUN\b/, 'BAGUN'],
  [/\bQUENCHER\b|GARRAFA TERMICA QUICK FLIP/, 'STANLEY'],
  [/\bIMPULSE\b/, 'IMPULSE'],
  [/\bELGIN\b/, 'ELGIN'],
];

const INSUMO_RX = [
  /^ETIQ/i,
  /^EMBALAGEM/i,
  /TUBO DE COBRE/i,
  /PANQUECA \d/i,
  /MANEQ:\d/i,
  /CONJUNTO PE[ÇC]A/i,
  /CURVADOR DE TUBO/i,
  /CORTINA DE AR/i,
  /OUTRO SERVICO/i,
  /^FRETE\b/i,
  /\bLIXA\b/i,
  /^CHAVE SKATE/i,
  /^TRUCK VERTICAL/i,
  /^MODELO \d+ - SKATE/i,
  /^REFIL MACARICO/i,
  /^FITA PVC/i,
  /^ROLAMENTO VERTICAL/i,
  /^RODA VERTICAL/i,
  /^BANDEJA DE CALCADOS/i,
  /^PISO MODULAR/i,
  /^COND ECO\b|^AR.?CONDICIONADO/i,
  /^SACOLA TRATADA/i,
  /^EVOKE DISPLAY/i,
  /^SHT BOA VIAGEM/i,
  /^LIMPA TENIS/i,
  /^GENERICO\b/i,
  /USO COMUM/i, // "SAPATO CASUAL MASC. DE USO COMUM" = genérico revenda fiscal
];

function extractBrand(name) {
  const n = (name || '').toUpperCase();
  for (const [rx, brand] of BRAND_PATTERNS) {
    if (rx.test(n)) return brand;
  }
  return null;
}

function isInsumo(name) {
  const n = name || '';
  return INSUMO_RX.some(rx => rx.test(n));
}

(async () => {
  console.log('\n=== Extract Brand + Cleanup Insumos ===');
  console.log('Modo:', DRY ? 'DRY-RUN' : 'APPLY');

  // 1) Marcar insumos como inactive
  const allActive = await prisma.$queryRaw`SELECT id, name, brand FROM "Product" WHERE active=true`;
  let insumosMarcados = 0, marcasExtraidas = 0, jaTinhaMarca = 0;

  for (const p of allActive) {
    if (isInsumo(p.name)) {
      if (!DRY) await prisma.product.update({ where: { id: p.id }, data: { active: false, category: 'INSUMO' } });
      insumosMarcados++;
      continue;
    }
    const semMarca = !p.brand || p.brand === '' || p.brand === 'A DEFINIR';
    if (!semMarca) { jaTinhaMarca++; continue; }
    const inferred = extractBrand(p.name);
    if (inferred) {
      if (!DRY) await prisma.product.update({ where: { id: p.id }, data: { brand: inferred } });
      marcasExtraidas++;
    }
  }

  console.log('Total ativos verificados:', allActive.length);
  console.log('Marcados como INSUMO (active=false):', insumosMarcados);
  console.log('Marcas extraídas do nome:', marcasExtraidas);
  console.log('Já tinham marca:', jaTinhaMarca);

  const after = await prisma.$queryRaw`
    SELECT count(*)::int as ativos,
           sum(case when brand IS NULL OR brand='' OR brand='A DEFINIR' then 1 else 0 end)::int as sem_marca,
           sum(case when category IS NULL OR category='' OR category='A CLASSIFICAR' then 1 else 0 end)::int as sem_cat
    FROM "Product" WHERE active=true
  `;
  console.log('\nESTADO ATUAL (active=true):');
  console.log('  Ativos:', after[0].ativos);
  console.log('  Sem marca:', after[0].sem_marca);
  console.log('  Sem categoria:', after[0].sem_cat);

  await prisma.$disconnect();
})().catch(async e => { console.error('FATAL:', e); await prisma.$disconnect(); process.exit(1); });
