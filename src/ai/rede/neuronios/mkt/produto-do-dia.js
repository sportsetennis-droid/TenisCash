// mkt.produto-do-dia — detector (regra, custo zero)
// Todo dia: candidatos a virar conteúdo = estoque FÍSICO alto (Σ StoreStock
// por loja) + foto + preço de venda com margem ok sobre o custo. Nada é
// publicado: só vira mkt.candidatos para a campanha (que passa no safety).
const { fortaleza, reais, pct } = require('../../regras/comercial');

const MIN_PECAS = () => Number(process.env.RNA_MKT_MIN_PECAS || 6);
const MARGEM_MIN = () => Number(process.env.RNA_MKT_MARGEM_MIN || 0.35);

module.exports = {
  id: 'mkt.produto-do-dia',
  camada: 'detector',
  missao: 'Achar produtos com estoque físico alto, foto e margem ok para virar conteúdo do dia.',
  escuta: ['relogio.diario'],
  emite: ['mkt.candidatos'],
  limiar: 0,
  custo: { tipo: 'regra' },
  permissao: 'ler',
  regras: ['estoque-fisico-storestock', 'preco-com-markup', 'dados-reais'],
  tempoMax: 30000,
  async disparar({ sinal, ler, agora }) {
    const f = fortaleza((sinal.dados && sinal.dados.quando) || agora);
    const min = MIN_PECAS();
    const rows = await ler.$queryRaw`
      SELECT p.id, p.name, p.brand, p.category, p.price, p."costPrice" AS custo, s.code AS loja, SUM(ss.stock)::int AS fisico
      FROM "StoreStock" ss
      JOIN "ProductSize" ps ON ps.id = ss."productSizeId"
      JOIN "Product" p ON p.id = ps."productId"
      JOIN "Store" s ON s.id = ss."storeId"
      WHERE p.active = true AND ss.stock > 0 AND p.price > 0 AND p."costPrice" > 0 AND p.price > p."costPrice"
        AND ((p."imageUrl" IS NOT NULL AND p."imageUrl" <> '') OR (p."imageUrls" IS NOT NULL AND p."imageUrls"::text NOT IN ('null', '[]', '""')))
      GROUP BY p.id, p.name, p.brand, p.category, p.price, p."costPrice", s.code
      HAVING SUM(ss.stock) >= ${min}
      ORDER BY SUM(ss.stock) DESC
      LIMIT 60`;
    const candidatos = rows
      .map((r) => ({ productId: r.id, nome: r.name, marca: r.brand, categoria: r.category, loja: r.loja, fisico: Number(r.fisico), preco: Number(r.price), margem: (Number(r.price) - Number(r.custo)) / Number(r.price) }))
      .filter((c) => c.margem >= MARGEM_MIN())
      .slice(0, 20)
      .map((c) => Object.assign(c, { margem: Math.round(c.margem * 1000) / 1000 }));
    if (!candidatos.length) return [];
    const potencial = candidatos.reduce((s, c) => s + c.fisico * c.preco, 0);
    return [{
      tipo: 'mkt.candidatos',
      forca: 0.7,
      impactoRS: Math.round(potencial),
      dados: {
        data: f.ymd,
        candidatos,
        chave: `candidatos-${f.ymd}`,
        evidencia: [
          `${candidatos.length} produto(s) com ≥ ${min} peças físicas numa loja (Σ StoreStock), foto cadastrada e margem ≥ ${pct(MARGEM_MIN())} (preço × costPrice)`,
          `Maior: ${candidatos[0].nome} — ${candidatos[0].fisico} peças na ${candidatos[0].loja}, ${reais(candidatos[0].preco)}`,
        ],
      },
    }];
  },
};
