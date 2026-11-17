// Estoque: SOBRA numa loja + FALTA em outra (mesmo card, mesmo tamanho) → propõe
// transferência. Os números (de, para, tamanho, quantidade) saem das regras sobre
// o estoque físico (StoreStock) e as vendas; a IA barata só escreve a justificativa.
// Nada se move sem o "sim" do dono (a ação aprovada só registra a decisão).
const c = require('../_comum-estoque');

const DIAS = 90;

async function estoqueDoTamanho(ler, sizeId) {
  const rows = await ler.storeStock.findMany({ where: { productSizeId: sizeId }, select: { storeId: true, stock: true, store: { select: { code: true } } } });
  return rows.map((r) => ({ storeId: r.storeId, loja: r.store.code, stock: r.stock }));
}

// Quanto a loja pode ceder sem quebrar a própria grade: guarda 1 se o tamanho vende lá.
async function sobra(ler, sizeId, storeId, stock, agora) {
  const v = (await c.vendasPorTamanho(ler, [sizeId], { dias: DIAS, storeId, agora })).get(sizeId) || 0;
  return { cede: Math.max(0, stock - (v > 0 ? 1 : 0)), vendas90d: v };
}

async function deRuptura(ler, d, agora) {
  const cands = [];
  for (const f of d.tamanhosFaltando || []) {
    const est = (await estoqueDoTamanho(ler, f.sizeId)).filter((e) => e.storeId !== d.storeId && e.stock > 0);
    let melhor = null;
    for (const e of est) {
      const s = await sobra(ler, f.sizeId, e.storeId, e.stock, agora);
      if (s.cede <= 0) continue;
      if (!melhor || s.cede > melhor.cede || (s.cede === melhor.cede && s.vendas90d < melhor.vendas90d)) melhor = Object.assign({}, e, s);
    }
    if (!melhor) continue;
    const qtd = Math.min(melhor.cede, Math.max(1, Math.ceil((f.vendas90dLoja || 0) / 3)));
    cands.push({ sizeId: f.sizeId, size: f.size, de: melhor.loja, deStoreId: melhor.storeId, para: d.loja, paraStoreId: d.storeId, qtd,
      porque: `${d.loja} zerou o ${f.size} (vendeu ${f.vendas90dRede} na rede em 90d); ${melhor.loja} tem ${melhor.stock} e vendeu ${melhor.vendas90d} desse tamanho em 90d` });
  }
  return cands;
}

async function deParado(ler, d, agora) {
  const sizes = await ler.productSize.findMany({ where: { productId: d.productId }, select: { id: true, size: true } });
  const cands = [];
  for (const s of sizes) {
    if (c.placeholder(s.size)) continue;
    const est = await estoqueDoTamanho(ler, s.id);
    const aqui = est.filter((e) => e.storeId === d.storeId).reduce((a, e) => a + e.stock, 0);
    if (aqui <= 0) continue;
    const lojas = await ler.store.findMany({ where: { active: true, id: { not: d.storeId } }, select: { id: true, code: true } });
    let melhor = null;
    for (const l of lojas) {
      const tem = est.filter((e) => e.storeId === l.id).reduce((a, e) => a + e.stock, 0);
      if (tem > 0) continue;
      const v = (await c.vendasPorTamanho(ler, [s.id], { dias: DIAS, storeId: l.id, agora })).get(s.id) || 0;
      if (v <= 0) continue;
      if (!melhor || v > melhor.v) melhor = { l, v };
    }
    if (!melhor) continue;
    cands.push({ sizeId: s.id, size: s.size, de: d.loja, deStoreId: d.storeId, para: melhor.l.code, paraStoreId: melhor.l.id, qtd: Math.min(aqui, Math.max(1, Math.ceil(melhor.v / 3))),
      porque: `${d.loja} tem ${aqui} parado(s) há ${d.dias} dias; ${melhor.l.code} vendeu ${melhor.v} desse tamanho em 90d e está zerada` });
  }
  return cands;
}

module.exports = {
  id: 'estoque.transferencia-sugerida',
  camada: 'analista',
  missao: 'Propor transferência de um tamanho que sobra numa loja para outra loja onde ele falta.',
  escuta: ['estoque.ruptura', 'estoque.parado'],
  emite: ['proposta.transferencia'],
  limiar: 0,
  custo: { tipo: 'ia-barata' },
  permissao: 'propor',
  regras: ['estoque-fisico-storestock', 'nada-move-sem-aprovacao'],
  tempoMax: 45000,
  async disparar({ sinal, ler, agora, pensar }) {
    const d = sinal.dados || {};
    if (!d.productId || !d.storeId) return [];
    const cands = sinal.tipo === 'estoque.ruptura' ? await deRuptura(ler, d, agora) : await deParado(ler, d, agora);
    if (!cands.length) return [];
    const p = await ler.product.findUnique({ where: { id: d.productId }, select: { sku: true, name: true, price: true, costPrice: true } });
    let textos = new Map();
    if (pensar) {
      const r = await pensar({
        instrucao: 'Para cada movimento, escreva 1 frase curta (máx. 25 palavras) explicando ao dono por que transferir. Use só os números dados; não invente.',
        entrada: { produto: p && p.name, motivo: sinal.tipo, movimentos: cands.map((x, i) => ({ i, tamanho: x.size, de: x.de, para: x.para, qtd: x.qtd, fatos: x.porque })) },
        schema: { type: 'object', properties: { justificativas: { type: 'array', items: { type: 'object', properties: { i: { type: 'integer' }, texto: { type: 'string' } }, required: ['i', 'texto'] } } }, required: ['justificativas'] },
      }).catch(() => null);
      if (r && r.ok && r.json && Array.isArray(r.json.justificativas)) textos = new Map(r.json.justificativas.map((j) => [j.i, String(j.texto).slice(0, 300)]));
    }
    return cands.map((x, i) => ({
      tipo: 'proposta.transferencia', forca: 0.75, loja: x.para,
      impactoRS: p && p.price ? Math.round(x.qtd * p.price) : null,
      dados: {
        chave: `transf|${x.sizeId}|${x.de}|${x.para}`,
        titulo: `Transferir ${x.qtd} un do ${p ? p.sku : d.productId} tam ${x.size}: ${x.de} → ${x.para}`,
        descricao: (textos.get(i) || x.porque) + ' (Números do estoque físico; nada é movido sem aprovação.)',
        risco: 'baixo',
        evidencia: [x.porque, `origem: sinal ${sinal.tipo} ${d.chave || ''}`.trim()],
        previa: { productId: d.productId, sizeId: x.sizeId, tamanho: x.size, de: x.de, para: x.para, quantidade: x.qtd },
        acao: { nome: 'rna.registrar', args: {} },
      },
    }));
  },
};
