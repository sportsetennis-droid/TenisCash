// venda.intervencao — analista (IA barata)
// Loja abaixo da meta às 15h → propõe AÇÃO PRÁTICA do dia (vitrine, abordagem,
// produto pra puxar) com base no estoque físico e no que a loja vendeu nos
// últimos 14 dias. Nunca propõe desconto/preço (isso é do pricing + dono).
const { fortaleza, DIA, reais, VENDA_INVALIDA, revisarTexto } = require('../../regras/comercial');

const SCHEMA = {
  type: 'object',
  properties: {
    acoes: { type: 'array', items: { type: 'object', properties: { acao: { type: 'string' }, porque: { type: 'string' }, productIds: { type: 'array', items: { type: 'string' } } }, required: ['acao', 'porque'] } },
    resumo: { type: 'string' },
  },
  required: ['acoes', 'resumo'],
};

module.exports = {
  id: 'venda.intervencao',
  camada: 'analista',
  missao: 'Propor a ação prática do dia para uma loja que está abaixo da meta.',
  escuta: ['venda.abaixo-meta'],
  emite: ['proposta.acao-loja'],
  limiar: 0,
  custo: { tipo: 'ia-barata' },
  permissao: 'propor',
  regras: ['sem-desconto-sem-pricing', 'vendedor-nao-consultor', 'dados-reais'],
  tempoMax: 45000,
  async disparar({ sinal, ler, pensar, agora }) {
    const d = sinal.dados || {};
    const loja = await ler.store.findFirst({ where: { code: d.loja }, select: { id: true, code: true, name: true } });
    if (!loja) return [{ tipo: 'dado-faltante', dados: { motivo: 'loja não encontrada', loja: d.loja } }];
    const f = fortaleza(agora);
    // o que a loja vendeu nos últimos 14 dias (marca/categoria)
    const itens = await ler.saleItem.findMany({
      where: { sale: { storeId: loja.id, createdAt: { gte: new Date(f.inicio.getTime() - 14 * DIA) }, status: { notIn: VENDA_INVALIDA } } },
      select: { brand: true, category: true, quantity: true, totalPrice: true }, take: 2000,
    });
    const porMarca = {};
    for (const i of itens) { const k = i.brand || '—'; porMarca[k] = (porMarca[k] || 0) + Number(i.totalPrice || 0); }
    const topMarcas = Object.entries(porMarca).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([marca, total]) => ({ marca, total: Math.round(total) }));
    // estoque físico da loja (StoreStock) — produtos com mais peças
    const estoque = await ler.$queryRaw`
      SELECT p.id, p.name, p.brand, p.category, p.price, SUM(ss.stock)::int AS fisico
      FROM "StoreStock" ss JOIN "ProductSize" ps ON ps.id = ss."productSizeId" JOIN "Product" p ON p.id = ps."productId"
      WHERE ss."storeId" = ${loja.id} AND ss.stock > 0 AND p.active = true AND p.price > 0
      GROUP BY p.id, p.name, p.brand, p.category, p.price ORDER BY fisico DESC LIMIT 15`;
    const produtos = estoque.map((p) => ({ productId: p.id, nome: p.name, marca: p.brand, categoria: p.category, preco: Number(p.price), fisico: Number(p.fisico) }));
    const r = await pensar({
      instrucao: 'Proponha até 3 ações práticas que a equipe da loja consegue fazer HOJE, até o fechamento, para recuperar a venda: vitrine/exposição, abordagem do vendedor, produto para puxar, contato com clientes já atendidos. PROIBIDO propor desconto, mudança de preço ou promoção (isso depende do dono e do pricing). Só cite produtos da lista de estoque (use o productId dela). Funcionário é "vendedor", nunca "consultor".',
      entrada: { loja: loja.code, vendidoHoje: d.vendido, metaHoje: d.meta, atingido: d.pct, maisVendidasUltimos14Dias: topMarcas, estoqueFisicoDaLoja: produtos },
      schema: SCHEMA,
    });
    if (!r.ok || !r.json || !Array.isArray(r.json.acoes)) return [];
    const validos = new Set(produtos.map((p) => p.productId));
    const acoes = r.json.acoes.slice(0, 3).map((a) => ({
      acao: revisarTexto(a.acao).texto,
      porque: revisarTexto(a.porque).texto,
      productIds: (a.productIds || []).filter((id) => validos.has(id)), // anti-chute: só produto que existe no estoque da loja
    })).filter((a) => a.acao && !/desconto|pre[cç]o|promo[cç][aã]o|\d+\s*%/i.test(a.acao));
    if (!acoes.length) return [];
    return [{
      tipo: 'proposta.acao-loja',
      impactoRS: sinal.impactoRS,
      loja: loja.code,
      dados: {
        titulo: `${loja.code}: ação do dia (${Math.round((d.pct || 0) * 100)}% da meta às ${d.hora || 15}h)`,
        descricao: revisarTexto(r.json.resumo || '').texto,
        risco: 'baixo',
        chave: `acao-loja-${loja.code}-${d.data}`,
        previa: { loja: loja.code, acoes },
        acao: { nome: 'rna.registrar' },
        evidencia: (d.evidencia || []).concat([
          `Marcas mais vendidas na loja nos últimos 14 dias: ${topMarcas.map((m) => m.marca + ' ' + reais(m.total)).join(', ') || 'sem vendas'}`,
          `Estoque físico (StoreStock) da loja: ${produtos.length} produtos com peça`,
        ]),
      },
    }];
  },
};
