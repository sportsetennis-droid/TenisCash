// Estoque: card PARADO na loja = tem estoque físico (Σ StoreStock > 0) e não vende
// ali há N dias (padrão 90; RNA_PARADO_DIAS). A contagem começa na última venda da
// loja, ou na última entrada (NF-e) do card, ou no cadastro — o que for mais recente.
// impactoRS = valor parado a CUSTO (sem custo gravado: fica sem valor e avisa).
const c = require('../_comum-estoque');

const MAX_SINAIS = 100;

module.exports = {
  id: 'estoque.parado',
  camada: 'detector',
  missao: 'Achar card com estoque físico na loja e sem venda ali há muitos dias.',
  escuta: ['relogio.semanal', 'relogio.objetivo'],
  emite: ['estoque.parado'],
  limiar: 0,
  custo: { tipo: 'regra' },
  permissao: 'ler',
  regras: ['estoque-fisico-storestock'],
  tempoMax: 60000,
  async disparar({ sinal, ler, agora, objetivo }) {
    let lojaFiltro = null;
    if (sinal.tipo === 'relogio.objetivo') {
      const reg = (objetivo && objetivo.regiao) || (sinal.dados && sinal.dados.regiao) || [];
      if (!reg.some((r) => r === 'estoque.*' || r === 'estoque.parado' || r === '*')) return [];
      lojaFiltro = (objetivo && objetivo.loja) || sinal.loja || null;
    }
    const dias = Number(process.env.RNA_PARADO_DIAS || 90);
    const params = [];
    let sql = 'SELECT ss."storeId" AS "storeId", st.code AS loja, ps."productId" AS "productId", SUM(ss.stock)::int AS un ' +
      'FROM "StoreStock" ss JOIN "ProductSize" ps ON ps.id = ss."productSizeId" JOIN "Store" st ON st.id = ss."storeId" WHERE ss.stock > 0';
    if (lojaFiltro) { params.push(lojaFiltro); sql += ' AND st.code = $1'; }
    sql += ' GROUP BY 1, 2, 3';
    const linhas = await ler.$queryRawUnsafe(sql, ...params);
    if (!linhas.length) return [];
    const pids = [...new Set(linhas.map((l) => l.productId))];
    const ultVenda = await ler.$queryRawUnsafe(
      'SELECT si."productId" AS "productId", s."storeId" AS "storeId", MAX(s."createdAt") AS ult FROM "SaleItem" si JOIN "Sale" s ON s.id = si."saleId" ' +
      "WHERE s.status = 'completed' AND si.\"productId\" = ANY($1::text[]) GROUP BY 1, 2", pids);
    const ultEntrada = await ler.$queryRawUnsafe(
      'SELECT xi."productId" AS "productId", MAX(d."issueDate") AS ult FROM "XmlFiscalItem" xi JOIN "XmlFiscalDocument" d ON d.id = xi."fiscalDocumentId" ' +
      "WHERE d.\"docType\" = 'entrada' AND xi.\"productId\" = ANY($1::text[]) GROUP BY 1", pids);
    const prods = await ler.product.findMany({ where: { id: { in: pids } }, select: { id: true, sku: true, name: true, brand: true, costPrice: true, createdAt: true } });
    const P = new Map(prods.map((p) => [p.id, p]));
    const V = new Map(ultVenda.map((r) => [r.productId + '|' + r.storeId, new Date(r.ult)]));
    const E = new Map(ultEntrada.map((r) => [r.productId, r.ult ? new Date(r.ult) : null]));
    const out = [];
    for (const l of linhas) {
      const p = P.get(l.productId);
      if (!p) continue;
      const refs = [V.get(l.productId + '|' + l.storeId), E.get(l.productId), p.createdAt].filter(Boolean);
      const desde = new Date(Math.max(...refs.map((x) => x.getTime())));
      const d = Math.floor((agora.getTime() - desde.getTime()) / c.DIA);
      if (d < dias) continue;
      const custo = p.costPrice && p.costPrice > 0 ? p.costPrice : null;
      const valor = custo ? Math.round(l.un * custo * 100) / 100 : null;
      out.push({
        tipo: 'estoque.parado', forca: Math.min(1, 0.6 + d / 365), loja: l.loja, impactoRS: valor,
        dados: {
          chave: 'parado|' + p.id + '|' + l.loja, productId: p.id, sku: p.sku, nome: p.name, marca: p.brand, loja: l.loja, storeId: l.storeId,
          dias: d, unidades: l.un, valorCustoRS: valor, custoFaltante: !custo,
          desde: desde.toISOString(), base: V.get(l.productId + '|' + l.storeId) ? 'última venda na loja' : E.get(l.productId) ? 'última entrada (NF-e)' : 'cadastro do card',
        },
      });
    }
    out.sort((a, b) => (b.impactoRS || 0) - (a.impactoRS || 0) || b.dados.dias - a.dados.dias);
    return out.slice(0, Number(process.env.RNA_PARADO_MAX || MAX_SINAIS));
  },
};
