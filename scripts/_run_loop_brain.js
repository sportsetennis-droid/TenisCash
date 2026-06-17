// Teste local do cérebro do loop de marketing (contra DB de prod + Anthropic).
// Roda a estação 1 (PAUTA) e imprime a pauta enriquecida. NÃO publica.
require('dotenv').config();
const loop = require('../src/services/marketingLoop');

(async () => {
  console.log('Cérebro:', loop.BRAIN_MODEL, '| rodando runBrain()...\n');
  const t0 = Date.now();
  const slate = await loop.runBrain({ ctx: 'Copa do Mundo 2026 em andamento. Conferir agenda esportiva real antes de cravar evento.' });
  console.log(`OK em ${((Date.now() - t0) / 1000).toFixed(1)}s | ${slate.total} itens | usou aprendizado: ${slate.usouAprendizado}`);
  if (slate.errors.length) console.log('Erros:', slate.errors.join(' | '));
  for (const it of slate.itens) {
    console.log(`\n── ${it.conta} [${it.tipo}] ${it.produto || it.tema || ''} ${it.preco || ''}`);
    console.log(`   gancho: ${it.gancho}`);
    console.log(`   pra quem: ${it.pra_quem} | resolve: ${it.resolve}`);
    console.log(`   🎙️ voz: ${it.voz} | 🎨 skin: ${it.skin} | 📐 ${it.formato} | ⏰ ${it.horario}`);
    console.log(`   💡 porque: ${it.porque}`);
    if (it.fato_a_verificar && it.fato_a_verificar.length) console.log(`   ⚠️ verificar: ${it.fato_a_verificar.join('; ')}`);
  }
  process.exit(0);
})().catch((e) => { console.error('FALHOU:', e.message); process.exit(1); });
