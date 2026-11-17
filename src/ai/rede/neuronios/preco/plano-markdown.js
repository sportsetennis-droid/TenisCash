// =====================================================================
// preco.plano-markdown — ESPECIALISTA (ia-forte; só acende com impacto alto)
// Missão única: montar um plano de remarcação para estoque PARADO sem
// furar a margem mínima. Os limites são calculados por regra (custo real do
// card); a IA só escolhe o desconto DENTRO do limite e explica. Nada muda
// sozinho: sai proposta.preco de risco ALTO (preço só com ordem do dono).
// Desconto > 15% nunca entra no plano: vira sinal preco.desconto-proposto
// (o detector preco.desconto-acima-15 bloqueia até o pricing validar).
// Sem custo gravado → produto fica fora (dado-faltante), nunca chuta margem.
// =====================================================================
const TETO = 15; // % sem validação do pricing

const r2 = (v) => Math.round(v * 100) / 100;
const reais = (v) => 'R$ ' + Number(v || 0).toFixed(2).replace('.', ',');

function margemMinima(objetivo) {
  const k = objetivo && Array.isArray(objetivo.kpis) ? objetivo.kpis.find((x) => /margem/i.test(String(x.nome || '')) && x.min != null) : null;
  if (k) { const v = Number(k.min); if (v > 0 && v < 1) return { valor: v, fonte: 'objetivo ' + objetivo.id }; if (v >= 1 && v < 100) return { valor: v / 100, fonte: 'objetivo ' + objetivo.id }; }
  return { valor: Number(process.env.RNA_MARGEM_MINIMA || 0.35), fonte: process.env.RNA_MARGEM_MINIMA ? 'RNA_MARGEM_MINIMA' : 'padrão 35% (ajuste pelo objetivo)' };
}

function itensDoSinal(d) {
  const lista = Array.isArray(d.produtos) ? d.produtos : Array.isArray(d.itens) ? d.itens : d.productId ? [d] : [];
  return lista.filter((x) => x && x.productId).slice(0, 30);
}

// preço novo que respeita a margem: arredonda pra cima no centavo se o arredondamento furar
function precoComMargem(preco, custo, pctDesc, m) {
  let novo = r2(preco * (1 - pctDesc / 100));
  const piso = custo / (1 - m);
  if (novo < piso) novo = Math.ceil(piso * 100) / 100;
  return novo;
}

module.exports = {
  id: 'preco.plano-markdown',
  camada: 'especialista',
  missao: 'Montar plano de remarcação para estoque parado respeitando a margem mínima.',
  escuta: ['estoque.parado'],
  emite: ['proposta.preco', 'preco.desconto-proposto'],
  limiar: 0.5,
  custo: { tipo: 'ia-forte' },
  permissao: 'propor',
  regras: ['pricing-governance', 'desconto-15-pricing-margin', 'preco-so-com-ordem-do-dono', 'nunca-inventar-dado'],
  tempoMax: 90000,
  async disparar({ sinal, ler, pensar, objetivo }) {
    const d = sinal.dados || {};
    const itens = itensDoSinal(d);
    if (!itens.length) return [];
    const m = margemMinima(objetivo);
    const prods = await ler.product.findMany({
      where: { id: { in: itens.map((i) => String(i.productId)) }, active: true },
      select: { id: true, sku: true, name: true, brand: true, price: true, costPrice: true, promoPrice: true },
    });
    const pDe = new Map(prods.map((p) => [p.id, p]));
    const base = []; const fora = [];
    for (const it of itens) {
      const p = pDe.get(String(it.productId));
      if (!p) { fora.push({ productId: it.productId, motivo: 'produto inativo/inexistente' }); continue; }
      const preco = Number(p.price || 0); const custo = Number(p.costPrice || 0);
      if (!(custo > 0)) { fora.push({ productId: p.id, motivo: 'sem custo gravado (margem não verificável)' }); continue; }
      if (!(preco > custo)) { fora.push({ productId: p.id, motivo: 'preço já ≤ custo (ver preco.abaixo-custo)' }); continue; }
      const piso = custo / (1 - m.valor);
      const maxPct = Math.max(0, Math.min(TETO, (1 - piso / preco) * 100));
      if (maxPct < 1) { fora.push({ productId: p.id, motivo: 'sem espaço: margem já está no mínimo ' + Math.round(m.valor * 100) + '%' }); continue; }
      base.push({ productId: p.id, sku: p.sku, nome: [p.brand, p.name].filter(Boolean).join(' '), preco, custo, margemAtual: r2((preco - custo) / preco), maxDescontoPct: Math.floor(maxPct * 10) / 10, diasSemVenda: it.diasSemVenda ?? null, estoque: it.estoque ?? it.qtd ?? null, loja: it.loja || sinal.loja || null });
    }
    const saida = [];
    if (fora.length) saida.push({ tipo: 'dado-faltante', dados: { chave: 'markdown-fora:' + sinal.id, motivo: 'itens fora do plano de remarcação', itens: fora } });
    if (!base.length) return saida;

    // IA forte escolhe o desconto dentro do limite + justificativa (sem ela: regra simples por idade do estoque)
    let escolha = null; let origem = 'regra-padrao'; let resumo = null;
    if (pensar) {
      const r = await pensar({
        instrucao: 'Monte um plano de remarcação para girar o estoque parado. Para cada produto escolha descontoPct entre 0 e maxDescontoPct (NUNCA acima). '
          + 'Use só os números da entrada. Priorize maior capital parado e mais dias sem venda. JSON {"itens":[{"productId","descontoPct","motivo"}],"resumo"}.',
        entrada: { margemMinima: m.valor, itens: base },
        schema: { type: 'object', properties: { itens: { type: 'array', items: { type: 'object', properties: { productId: { type: 'string' }, descontoPct: { type: 'number' }, motivo: { type: 'string' } }, required: ['productId', 'descontoPct'] } }, resumo: { type: 'string' } }, required: ['itens'] },
      }).catch(() => null);
      if (r && r.ok && r.json && Array.isArray(r.json.itens)) { escolha = new Map(r.json.itens.filter((x) => x && x.productId).map((x) => [String(x.productId), x])); origem = 'ia-forte'; resumo = r.json.resumo || null; }
    }

    const plano = [];
    const pedidosAcima = [];
    for (const b of base) {
      let pct; let motivo;
      const e = escolha && escolha.get(b.productId);
      if (e && Number.isFinite(Number(e.descontoPct))) {
        pct = Number(e.descontoPct); motivo = e.motivo ? String(e.motivo).slice(0, 300) : null;
        if (pct > TETO) pedidosAcima.push({ productId: b.productId, descontoPct: pct, precoAtual: b.preco, precoNovo: r2(b.preco * (1 - pct / 100)) });
        if (pct > b.maxDescontoPct) { motivo = (motivo ? motivo + ' — ' : '') + 'pedido ' + pct + '% reduzido ao limite de margem/teto ' + b.maxDescontoPct + '%'; pct = b.maxDescontoPct; }
      } else {
        const dias = Number(b.diasSemVenda || 0);
        pct = Math.min(b.maxDescontoPct, dias >= 180 ? TETO : dias >= 90 ? 10 : 5);
        motivo = 'regra padrão por dias sem venda' + (b.diasSemVenda != null ? ' (' + dias + ' dias)' : ' (dias sem venda não informados)');
      }
      if (!(pct > 0)) continue;
      const novo = precoComMargem(b.preco, b.custo, pct, m.valor);
      plano.push({ productId: b.productId, sku: b.sku, nome: b.nome, loja: b.loja, precoAtual: b.preco, precoProposto: novo, descontoPct: r2((1 - novo / b.preco) * 100), custo: b.custo, margemNova: r2((novo - b.custo) / novo), motivo });
    }
    for (const x of pedidosAcima) saida.push({ tipo: 'preco.desconto-proposto', forca: 1, dados: Object.assign({ chave: 'markdown-acima:' + x.productId, origemPlano: sinal.id }, x) });
    if (!plano.length) return saida;

    const impacto = plano.reduce((a, x) => a + (x.precoAtual - x.precoProposto) * Math.max(1, Number((base.find((b) => b.productId === x.productId) || {}).estoque || 1)), 0);
    saida.push({
      tipo: 'proposta.preco',
      impactoRS: r2(impacto),
      dados: {
        chave: 'markdown:' + plano.map((x) => x.productId).sort().join(','),
        titulo: 'Plano de remarcação: ' + plano.length + ' produto(s) parado(s)' + (sinal.loja ? ' — ' + sinal.loja : ''),
        descricao: (resumo ? resumo + ' ' : '') + 'Margem mínima ' + Math.round(m.valor * 100) + '% (' + m.fonte + '); desconto máximo ' + TETO + '% sem validação do pricing. '
          + 'Nenhum preço muda sem a sua ordem.' + (pedidosAcima.length ? ' ' + pedidosAcima.length + ' pedido(s) acima de 15% foram barrados.' : ''),
        risco: 'alto',
        acao: { nome: 'rna.registrar', args: {} },
        previa: { margemMinima: m.valor, origem, itens: plano.map((x) => Object.assign({}, x, { de: reais(x.precoAtual), para: reais(x.precoProposto) })), fora },
        evidencia: plano.map((x) => x.sku + ': preço ' + x.precoAtual + ' / custo ' + x.custo + ' (Product ' + x.productId + ')').concat('sinal estoque.parado ' + sinal.id),
      },
    });
    return saida;
  },
};
