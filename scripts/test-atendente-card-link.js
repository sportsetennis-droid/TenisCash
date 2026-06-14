// Teste: (1) card vira LINK, (2) estoque = LOJA (StoreStock), nunca comprado (NFe).
require('dotenv').config();
const { searchProductsForAI, resolveProductLink } = require('../src/services/catalogSearch');
const { getAttendantReply } = require('../src/services/aiAttendant');

function lojasDoTamanho(s) {
  return (s.storeStocks || [])
    .filter((ss) => (ss.stock || 0) > 0)
    .map((ss) => {
      const st = ss.store || {};
      return { loja: st.neighborhood || st.name || st.code || 'loja', qtd: ss.stock };
    });
}
function tamanhosEmLoja(p) {
  return (p.sizes || [])
    .map((s) => ({ tamanho: s.size, lojas: lojasDoTamanho(s) }))
    .filter((t) => t.lojas.length > 0);
}

(async () => {
  const query = process.argv[2] || 'bondi 9';
  console.log('=== 1) DADOS (sem IA): comprado(NFe) x LOJA(bipado) + link p/ "' + query + '" ===\n');
  const r = await searchProductsForAI(query);
  const top = (r.products || []).slice(0, 3);
  if (!top.length) console.log('  (nenhum produto)', r.message || '');
  for (const p of top) {
    const link = await resolveProductLink(p.id, p.name);
    const tam = tamanhosEmLoja(p);
    const porTam = (p.sizes || []).map((s) => ({
      t: s.size,
      comprado_NFe: s.stock,
      loja_bipado: (s.storeStocks || []).reduce((a, x) => a + (x.stock || 0), 0),
    }));
    console.log('• ' + p.name + '  R$ ' + (p.promoPrice || p.price));
    console.log('  por_tamanho:', JSON.stringify(porTam));
    console.log('  tamanhos_disponiveis (SO LOJA):', JSON.stringify(tam));
    console.log('  tem_em_loja:', tam.length > 0);
    console.log('  link:', link);
    console.log('');
  }

  console.log('=== 2) IA REAL: "tem o bondi 9 no 42? me manda o link" ===\n');
  const reply = await getAttendantReply({
    phone: '558399999999',
    text: 'tem o ' + query + ' no 42? me manda o link',
    pushName: 'Teste',
  });
  console.log(JSON.stringify(reply, null, 2));
  process.exit(0);
})().catch((e) => {
  console.error('ERRO:', e);
  process.exit(1);
});
