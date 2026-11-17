// Estoque: grade quebrada. Tamanho-CHAVE (= tamanho que vendeu nos últimos 90 dias
// na rede) de um card com venda que está ZERADO no estoque físico da loja
// (StoreStock = localização/bipe). Nunca olha o comprado (ProductSize.stock).
const c = require('../_comum-estoque');

const DIAS_CHAVE = 90;
const MAX_SINAIS = 200;

async function avaliar(ler, { productId, store, agora }) {
  const p = await ler.product.findUnique({
    where: { id: productId },
    select: { id: true, sku: true, name: true, brand: true, price: true, active: true,
      sizes: { select: { id: true, size: true, barcode: true, storeStocks: { where: { storeId: store.id }, select: { stock: true } } } } },
  });
  if (!p || !p.active) return null;
  const tams = p.sizes.filter((s) => !c.placeholder(s.size));
  const vendasRede = await c.vendasPorTamanho(ler, tams.map((s) => s.id), { dias: DIAS_CHAVE, agora });
  const vendasLoja = await c.vendasPorTamanho(ler, tams.map((s) => s.id), { dias: DIAS_CHAVE, agora, storeId: store.id });
  const faltando = tams
    .filter((s) => (vendasRede.get(s.id) || 0) > 0)
    .filter((s) => s.storeStocks.reduce((a, x) => a + x.stock, 0) <= 0)
    .map((s) => ({ sizeId: s.id, size: s.size, vendas90dRede: vendasRede.get(s.id) || 0, vendas90dLoja: vendasLoja.get(s.id) || 0 }));
  if (!faltando.length) return null;
  const unidadesMes = faltando.reduce((a, f) => a + f.vendas90dRede, 0) / 3;
  return {
    tipo: 'estoque.ruptura', forca: 0.85, loja: store.code,
    impactoRS: p.price ? Math.round(unidadesMes * p.price) : null, // estimativa: venda/mês dos tamanhos zerados
    dados: {
      chave: 'ruptura|' + p.id + '|' + store.code + '|' + c.diaISO(agora),
      productId: p.id, sku: p.sku, nome: p.name, marca: p.brand, loja: store.code, storeId: store.id,
      tamanhosFaltando: faltando,
      regra: 'tamanho-chave = vendeu na rede nos últimos ' + DIAS_CHAVE + ' dias; zerado = Σ StoreStock da loja ≤ 0 (estoque físico localizado)',
    },
  };
}

module.exports = {
  id: 'estoque.ruptura-grade',
  camada: 'detector',
  missao: 'Detectar tamanho-chave zerado no estoque físico da loja num card que vende.',
  escuta: ['venda.registrada', 'relogio.diario'],
  emite: ['estoque.ruptura'],
  limiar: 0,
  custo: { tipo: 'regra' },
  permissao: 'ler',
  regras: ['estoque-fisico-storestock', 'comprado-nunca-recalcula'],
  tempoMax: 60000,
  async disparar({ sinal, ler, agora }) {
    const d = sinal.dados || {};
    const lojas = await c.mapaLojas(ler);
    const pares = new Map(); // productId|storeId
    if (sinal.tipo === 'venda.registrada') {
      let store = d.storeCode ? lojas.porCodigo.get(d.storeCode) : null;
      if (!store && d.saleId) {
        const s = await ler.sale.findUnique({ where: { id: d.saleId }, select: { storeId: true } });
        store = s && s.storeId ? lojas.porId.get(s.storeId) : null;
      }
      if (!store) return [];
      let itens = Array.isArray(d.itens) ? d.itens : [];
      if (!itens.length && d.saleId) itens = await ler.saleItem.findMany({ where: { saleId: d.saleId }, select: { productId: true } });
      for (const it of itens) if (it.productId) pares.set(it.productId + '|' + store.id, { productId: it.productId, store });
    } else {
      // varredura diária: cards que venderam nos últimos 7 dias, por loja
      const rows = await ler.saleItem.findMany({
        where: { productId: { not: null }, sale: { status: 'completed', storeId: { not: null }, createdAt: { gte: new Date(agora.getTime() - 7 * c.DIA) } } },
        select: { productId: true, sale: { select: { storeId: true } } }, take: 5000,
      });
      for (const r of rows) {
        const store = lojas.porId.get(r.sale.storeId);
        if (store) pares.set(r.productId + '|' + store.id, { productId: r.productId, store });
      }
    }
    const out = [];
    for (const par of pares.values()) {
      const s = await avaliar(ler, Object.assign({ agora }, par));
      if (s) out.push(s);
    }
    out.sort((a, b) => (b.impactoRS || 0) - (a.impactoRS || 0));
    return out.slice(0, MAX_SINAIS);
  },
};
