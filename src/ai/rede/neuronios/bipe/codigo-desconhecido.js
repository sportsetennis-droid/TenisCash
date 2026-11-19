// Bipe: código bipado que NÃO casou com nenhum tamanho (found=false). Procura o
// código (variantes UPC/EAN) nos tamanhos, nos aliases do scanner e nas NF-e de
// ENTRADA. Achou com prova → propõe vincular (no card que JÁ existe, nunca card novo).
// Só transferência / nada achado → dado-faltante (a NF-e de entrada resolve depois).
const c = require('../_comum-estoque');

module.exports = {
  id: 'bipe.codigo-desconhecido',
  camada: 'detector',
  missao: 'Resolver código bipado desconhecido pelas NF-e de entrada e aliases, com prova.',
  escuta: ['bipe.registrado'],
  emite: ['proposta.vincular-codigo', 'dado-faltante'],
  limiar: 0,
  custo: { tipo: 'regra' },
  permissao: 'propor',
  regras: ['codigo-escaneado-obrigatorio', 'transferencia-nao-cria-card', 'nunca-chutar-tamanho', 'adidas-tamanho-pela-caixa', 'sem-gtin'],
  tempoMax: 20000,
  async disparar({ sinal, ler }) {
    const d = sinal.dados || {};
    if (d.found === true) return [];
    const b = d.bipeId ? await ler.stocktakeBipe.findUnique({ where: { id: d.bipeId } }) : null;
    if (!b || b.found || b.excludedAt) return [];
    const k = 'bipe|' + b.id;
    if (c.semGtin(b.barcode)) return [c.dadoFaltante(k + '|codigo', 'codigo', `"${b.barcode}" não é código de barras legível: precisa nova leitura física`, { bipeId: b.id })];
    const vs = c.variantes(b.barcode);
    const evidBipe = `bipe ${b.id} código ${b.barcode} em ${new Date(b.bipedAt).toISOString()}${b.roundId ? ' rodada ' + b.roundId : ''}`;

    // 1) já existe tamanho com esse código (criado depois do bipe) ou alias revisado do scanner
    let ps = await ler.productSize.findFirst({ where: { barcode: { in: vs } }, select: { id: true, size: true, barcode: true, product: { select: { id: true, sku: true, name: true, active: true } } } });
    let via = ps ? 'tamanho com o mesmo código' : null;
    if (!ps) {
      const rows = await ler.$queryRawUnsafe(`SELECT id FROM "Product" WHERE active = true AND jsonb_exists(COALESCE("aiContext"->'scannerBarcodeAliases', '{}'::jsonb), $1) LIMIT 2`, c.identidade(b.barcode));
      if (rows.length === 1) {
        const p = await ler.product.findUnique({ where: { id: rows[0].id }, select: { id: true, sku: true, name: true, active: true, aiContext: true, sizes: { select: { id: true, size: true, barcode: true } } } });
        const al = p && p.aiContext && p.aiContext.scannerBarcodeAliases && p.aiContext.scannerBarcodeAliases[c.identidade(b.barcode)];
        const s = al && p.sizes.find((x) => x.size === al.size);
        if (s) { ps = Object.assign({}, s, { product: p }); via = 'alias revisado do scanner'; }
      }
    }
    if (ps) {
      return [{ tipo: 'proposta.vincular-codigo', forca: 0.9, loja: d.storeCode || null, dados: {
        chave: 'vinc-bipe|' + b.id,
        titulo: `Religar bipe ${b.barcode} ao ${ps.product.sku} tam ${ps.size}`,
        descricao: `O bipe ficou "não achado", mas o código já pertence ao tamanho ${ps.size} do card ${ps.product.sku} (${via}). Proposta: religar o bipe; não mexe em comprado nem estoque.`,
        risco: 'baixo',
        evidencia: [evidBipe, `ProductSize ${ps.id} (${via}) barcode=${ps.barcode || '-'}`],
        previa: { bipeId: b.id, productSizeId: ps.id, tamanho: ps.size },
        acao: { nome: 'estoque.vincular-codigo', args: { bipeId: b.id, productSizeId: ps.id, barcode: b.barcode } },
      } }];
    }

    // 2) NF-e: entrada vale como prova; transferência sozinha NÃO (falta a entrada original)
    const itens = await ler.xmlFiscalItem.findMany({
      where: { ean: { in: vs } },
      select: { id: true, supplierCode: true, description: true, quantity: true, cfop: true, productId: true, ean: true,
        fiscalDocument: { select: { accessKey: true, docType: true, issuerName: true, issuerCnpj: true, recipientCnpj: true } } },
      orderBy: { createdAt: 'asc' },
    });
    const entrada = itens.filter((i) => c.docEhEntrada(i.fiscalDocument, [i]) && !c.cfopTransf(i.cfop));
    if (!entrada.length) {
      return [c.dadoFaltante(k + '|nfe', 'nfe-entrada', itens.length ? 'código só aparece em NF-e de transferência: falta a NF-e de entrada original' : 'código não está em nenhuma NF-e nem no catálogo', { bipeId: b.id, barcode: b.barcode })];
    }
    // card: o ligado na NF-e (seguindo consolidação) ou o que já existe pelo cProd/sku
    const cards = new Map();
    for (const it of entrada) {
      if (it.productId) {
        const p = await ler.product.findUnique({ where: { id: it.productId }, select: { id: true, sku: true, name: true, brand: true, active: true, aiContext: true } });
        if (p) { const k2 = await c.seguirConsolidacao(ler, p); cards.set(k2.id, Object.assign({ como: 'item da NF-e ligado ao card' }, k2)); }
      } else for (const p of await c.buscarCardExistente(ler, it, b.barcode)) cards.set(p.id, p);
    }
    const base = entrada[0];
    const evidNfe = entrada.slice(0, 3).map((i) => `NF-e ${i.fiscalDocument.accessKey}: cProd="${i.supplierCode || '-'}" xProd="${i.description}" qCom=${i.quantity}`);
    if (cards.size !== 1) {
      return [c.dadoFaltante(k + '|card', 'card', cards.size ? 'mais de um card possível para o código — conferência humana' : 'código está na NF-e de entrada, mas não existe card (a rede não cria card)', { bipeId: b.id, barcode: b.barcode, candidatos: [...cards.values()].map((p) => ({ id: p.id, sku: p.sku })), evidencia: evidNfe })];
    }
    const card = [...cards.values()][0];
    const adidas = c.ehAdidas(card.brand, base.fiscalDocument.issuerName, base.description);
    // tamanho: só se TODAS as linhas de entrada concordarem no mesmo valor literal
    const lidos = [...new Set(entrada.map((i) => c.tamanhoLiteralRegra(i.supplierCode, i.description)))];
    const tam = !adidas && lidos.length === 1 && lidos[0] ? lidos[0] : null;
    const out = [];
    if (!tam) out.push(c.dadoFaltante(k + '|tamanho', 'tamanho', adidas ? 'Adidas: tamanho só pela caixa física' : 'tamanho não está escrito de forma única no cProd + xProd: entra como placeholder e a caixa decide', { bipeId: b.id, barcode: b.barcode }));
    out.push({ tipo: 'proposta.vincular-codigo', forca: tam ? 0.85 : 0.65, loja: d.storeCode || null, dados: {
      chave: 'vinc|' + c.identidade(b.barcode),
      titulo: `Cadastrar o código ${b.barcode} no card ${card.sku} ${tam ? 'tam ' + tam : 'com tamanho PENDENTE'} e religar o bipe`,
      descricao: `O código bipado está na NF-e de ENTRADA (${entrada.length} linha(s)) e o card ${card.sku} — ${card.name} já existe (${card.como}). ` +
        (tam ? `Tamanho ${tam} escrito no cProd e na descrição.` : 'Tamanho fica placeholder até a caixa confirmar.') + ' Comprado = Σ qCom das entradas (sem "SEM GTIN"). Não mexe em estoque físico.',
      risco: 'baixo',
      evidencia: [evidBipe].concat(evidNfe, [`card ${card.id} sku=${card.sku}`]),
      previa: { productId: card.id, barcode: b.barcode, tamanho: tam || 'T-' + b.barcode, bipeId: b.id },
      acao: { nome: 'estoque.vincular-codigo', args: { productId: card.id, barcode: b.barcode, size: tam, itemIds: entrada.map((i) => i.id), bipeId: b.id } },
    } });
    return out;
  },
};
