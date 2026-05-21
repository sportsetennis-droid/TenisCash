// =====================================================================
// auto-classify-products.js — auto-classifica produtos sem categoria
// =====================================================================
// Aplica Product.category (Tênis/Chuteiras/Vestuário/Acessórios/Dropper)
// baseado em keywords no nome. Pula ambíguos.
//
// Idempotente: só atualiza quem ainda está sem categoria.
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

function classify(name, brand) {
  const n = (name || '').toUpperCase();
  if (!n) return null;

  // INSUMO / LIXO — descartar (etiqueta, embalagem, cobre, peças)
  if (/^ETIQ|^EMBALAGEM|TUBO DE COBRE|PANQUECA \d|MANEQ:\d|CONJUNTO PE[ÇC]A/.test(n)) return null;

  // CHUTEIRAS (campo / futsal / society)
  if (/CHUTEIRA|FUTSAL|SOCIETY[^A-Z]|TRAVA\b|CRAVOS|CAMPO\b|GRAMA/.test(n)) return 'Chuteiras';

  // CHINELO / SLIDE / SANDÁLIA — Acessórios
  if (/CHINELO|SLIDE\b|SANDALI|SAND[ÁA]LI|CROCS|PALMILHA/.test(n)) return 'Acessórios';

  // TÊNIS / CALÇADOS esportivos
  if (/TENIS|T[ÊE]NIS|SNEAKER|RUNNING|RUNNER|CORRIDA\b|JOGGING|CALCADO|CAL[ÇC]ADO|SAPATILHA|SCARPIN/.test(n)) return 'Tênis';

  // VESTUÁRIO
  if (/CAMISETA|CAMISA\b|POLO\b|CROPPED|REGATA|BLUSA|TOP\b|SAIA\b|SHORT|CAL[ÇC]A\b|BERMUDA|MACAQUI|MACAC[ÃA]O|VESTIDO|LEGGING|AGASALHO|JAQUETA|MOLETOM|SUTI[ÃA]|MAIO\b|BIQUINI|BIQUÍNI|PIJAMA|COLETE|CAS[AA]CO|SUNGA|CUECA|CALCINHA|FARDAMENTO|UNIFORME/.test(n)) return 'Vestuário';

  // ACESSÓRIOS (proteção / esporte)
  if (/COTOVELEIRA|JOELHEIRA|TORNOZELEIRA|CANELEIRA|BOLA\b|RAQUETE|BON[ÉE]|MOCHILA|BOLSA|FAIXA|MUNHEQUEIRA|TOUCA|[ÓO]CULOS|CORDA|HALTER|PROTETOR|MEI[AÃ]\b|MEIAS|LUVA\b|CINTA\b|GARRAFA|SQUEEZE|SACOLA|NECESSAIRE|SHAMPOO|DESODORANTE|PERFUME/.test(n)) return 'Acessórios';

  return null;
}

(async () => {
  console.log('\n=== Auto-classificar Products ===');
  console.log('Modo:', DRY ? 'DRY-RUN' : 'APPLY');

  const targets = await prisma.$queryRaw`
    SELECT id, name, brand FROM "Product"
    WHERE active=true AND (category IS NULL OR category='' OR category='A CLASSIFICAR')
  `;
  console.log('Produtos sem categoria:', targets.length);

  const stats = { 'Tênis': 0, 'Chuteiras': 0, 'Vestuário': 0, 'Acessórios': 0, 'ambíguo': 0 };
  const updates = [];

  for (const p of targets) {
    const cat = classify(p.name, p.brand);
    if (cat) {
      stats[cat] = (stats[cat] || 0) + 1;
      updates.push({ id: p.id, category: cat });
    } else {
      stats['ambíguo']++;
    }
  }

  console.log('\nDistribuição:');
  Object.entries(stats).forEach(([k, v]) => {
    const pct = ((v / targets.length) * 100).toFixed(1);
    console.log('  ' + k.padEnd(15) + ':', v.toString().padStart(5), '(' + pct + '%)');
  });
  console.log('  TOTAL CLASSIFICÁVEL:', updates.length, '(' + ((updates.length / targets.length) * 100).toFixed(1) + '%)');

  if (!DRY && updates.length) {
    console.log('\nAplicando...');
    let done = 0;
    for (const u of updates) {
      await prisma.product.update({ where: { id: u.id }, data: { category: u.category } });
      done++;
      if (done % 500 === 0) console.log('  ' + done + '/' + updates.length);
    }
    console.log('  Atualizados:', done);
  }

  await prisma.$disconnect();
})().catch(async e => { console.error('FATAL:', e); await prisma.$disconnect(); process.exit(1); });
