// =====================================================================
// nuvem.estoque-divergente — DETECTOR (regra, custo zero)
// Missão única: achar produto publicado cujo estoque na Nuvemshop pode não
// bater com o ESTOQUE FÍSICO (Σ StoreStock das lojas que valem pra loja
// online — mesma função do push: nuvemshopEligibility.physicalStock).
// Só compara o que o sistema REGISTROU localmente (não chama a API):
//   (a) assinatura do último estoque verificado/enviado
//       (aiContext.nsPhysicalStockVerifiedSig = 'physical-v1|tam:qtd|…',
//        gravada pelo cron de reconciliação) × estoque físico de agora;
//   (b) tamanho com estoque físico > 0 sem variante mapeada
//       (NuvemshopVariantMapping) → a loja não tem como vender esse tamanho.
// Sem assinatura gravada → não dá pra afirmar o estoque publicado:
// emite `dado-faltante` (nunca chuta divergência).
// =====================================================================
const { nuvemshopStockStoreIds, physicalStock, contextOf } = require('../../../../services/nuvemshopEligibility');

const MAX = () => Math.max(1, Number(process.env.RNA_NUVEM_MAX_POR_PULSO || 100));

// Mesmo formato do nuvemshopStockCron.physicalSig (só lojas permitidas).
function assinatura(sizes, permitidas) {
  return 'physical-v1|' + (sizes || [])
    .map((s) => `${s.size}:${(s.storeStocks || []).filter((r) => permitidas.has(r.storeId)).reduce((a, r) => a + (r.stock || 0), 0)}`)
    .sort().join('|');
}
function parseAssinatura(sig) {
  const m = new Map();
  String(sig || '').replace(/^physical-v1\|?/, '').split('|').filter(Boolean).forEach((p) => {
    const i = p.lastIndexOf(':');
    if (i > 0) m.set(p.slice(0, i), Number(p.slice(i + 1)));
  });
  return m;
}

module.exports = {
  id: 'nuvem.estoque-divergente',
  camada: 'detector',
  missao: 'Achar produto publicado com estoque na Nuvemshop diferente do estoque físico das lojas.',
  escuta: ['relogio.hora'],
  emite: ['nuvem.divergente'],
  limiar: 0,
  custo: { tipo: 'regra' },
  permissao: 'ler',
  regras: ['nuvemshop-estoque-fisico'],
  tempoMax: 90000,
  async disparar({ ler }) {
    const maps = await ler.nuvemshopProductMapping.findMany({
      where: { NOT: { syncStatus: 'hidden-invalid' } }, select: { localProductId: true, nuvemshopProductId: true }, take: 20000,
    });
    if (!maps.length) return [];
    const nsDe = new Map(maps.map((m) => [m.localProductId, String(m.nuvemshopProductId)]));
    const lojas = nuvemshopStockStoreIds();
    const permitidas = new Set(lojas);
    const produtos = await ler.product.findMany({
      where: { id: { in: [...nsDe.keys()] }, active: true },
      select: {
        id: true, sku: true, name: true, brand: true, aiContext: true,
        sizes: { select: { id: true, size: true, barcode: true, storeStocks: { where: { storeId: { in: lojas } }, select: { stock: true, storeId: true } } } },
      },
    });
    const varMaps = await ler.nuvemshopVariantMapping.findMany({
      where: { localProductId: { in: produtos.map((p) => p.id) } }, select: { localProductId: true, localInventoryId: true, barcode: true },
    });
    const varDe = new Map();
    for (const v of varMaps) {
      if (!varDe.has(v.localProductId)) varDe.set(v.localProductId, []);
      varDe.get(v.localProductId).push(v);
    }

    const saida = [];
    const semRegistro = [];
    for (const p of produtos) {
      const ctx = contextOf(p);
      const atual = assinatura(p.sizes, permitidas);
      const salvo = ctx.nsPhysicalStockVerifiedSig || null;
      const diferencas = [];
      if (salvo && salvo !== atual) {
        const antes = parseAssinatura(salvo);
        const agora = parseAssinatura(atual);
        for (const tam of new Set([...antes.keys(), ...agora.keys()])) {
          const a = antes.has(tam) ? antes.get(tam) : null;
          const b = agora.has(tam) ? agora.get(tam) : 0;
          if (a !== b) diferencas.push({ tamanho: tam, publicado: a, fisico: b, fonte: 'assinatura' });
        }
      }
      const vs = varDe.get(p.id) || [];
      for (const s of p.sizes) {
        const fis = physicalStock(s);
        if (fis <= 0) continue;
        const temVariante = vs.some((v) => v.localInventoryId === s.id || (s.barcode && v.barcode === s.barcode));
        if (!temVariante && vs.length) diferencas.push({ tamanho: s.size, publicado: 'sem variante', fisico: fis, fonte: 'variante' });
      }
      if (!salvo) semRegistro.push(p.id);
      if (!diferencas.length) continue;
      saida.push({
        tipo: 'nuvem.divergente',
        forca: salvo ? 0.85 : 0.6,
        dados: {
          chave: 'divergente:' + p.id + ':' + atual,
          productId: p.id,
          nuvemshopProductId: nsDe.get(p.id),
          produto: { sku: p.sku, nome: p.name, marca: p.brand },
          diferencas,
          estoqueFisico: atual,
          estoquePublicadoRegistrado: salvo,
          dadoFaltante: salvo ? [] : ['estoque-publicado'],
          lojasConsideradas: lojas,
          evidencia: [
            'Σ StoreStock (lojas ' + lojas.join(',') + ') = ' + atual,
            salvo ? 'aiContext.nsPhysicalStockVerifiedSig = ' + salvo : 'estoque publicado não registrado localmente',
          ].concat(diferencas.filter((x) => x.fonte === 'variante').map((x) => 'tamanho ' + x.tamanho + ' tem ' + x.fisico + ' no físico e nenhuma NuvemshopVariantMapping')),
        },
      });
      if (saida.length >= MAX()) break;
    }
    if (semRegistro.length) {
      saida.push({
        tipo: 'dado-faltante',
        forca: 0.5,
        dados: {
          chave: 'divergente:sem-registro:' + semRegistro.length,
          campo: 'estoque-publicado',
          motivo: 'Sem estoque publicado gravado localmente (aiContext.nsPhysicalStockVerifiedSig); divergência não pode ser afirmada sem ler a Nuvemshop.',
          produtos: semRegistro.slice(0, 200),
          total: semRegistro.length,
        },
      });
    }
    return saida;
  },
};
