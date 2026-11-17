// NF-e: lê REFERÊNCIA, TAMANHO e COR **literais** do xProd/cProd do item órfão,
// no formato daquele fornecedor (exemplos reais já catalogados do mesmo emissor).
// A IA só aponta onde está escrito; o código CONFERE que cada valor está literal
// na NF-e. O que não estiver escrito sai como dado-faltante (nunca chuta).
// Adidas: tamanho NUNCA vem da NF-e (só da caixa) → sempre dado-faltante.
const c = require('../_comum-estoque');

const SCHEMA = {
  type: 'object',
  properties: {
    ref: { type: ['string', 'null'] },
    tamanho: { type: ['string', 'null'] },
    cor: { type: ['string', 'null'] },
    explicacao: { type: 'string' },
  },
  required: ['ref', 'tamanho', 'cor'],
};

async function exemplosDoFornecedor(ler, issuerCnpj, ignorar) {
  if (!issuerCnpj) return [];
  const itens = await ler.xmlFiscalItem.findMany({
    where: { id: { notIn: ignorar }, ean: { not: null }, fiscalDocument: { AND: [c.WHERE_DOC_ENTRADA, { issuerCnpj: { in: [issuerCnpj, c.soDigitos(issuerCnpj)] } }] } },
    select: { supplierCode: true, description: true, ean: true }, take: 40, orderBy: { createdAt: 'desc' },
  });
  const ex = [];
  for (const it of itens) {
    if (ex.length >= 8 || c.semGtin(it.ean)) continue;
    const ps = await ler.productSize.findFirst({ where: { barcode: { in: c.variantes(it.ean) } }, select: { size: true, product: { select: { sku: true } } } });
    if (ps && !c.placeholder(ps.size)) ex.push({ cProd: it.supplierCode, xProd: it.description, tamanhoNoCard: ps.size, refDoCard: ps.product && ps.product.sku });
  }
  return ex;
}

// Confere cada campo contra a FONTE. Retorna { valores, faltando:[{campo, motivo}] }.
function conferirLiteral(r, { cProd, xProd, adidas }) {
  const faltando = [];
  const C = c.semAcento(cProd), X = c.semAcento(xProd);
  let ref = r && r.ref ? String(r.ref).trim() : null;
  if (ref && !(C.includes(c.semAcento(ref)) || X.includes(c.semAcento(ref)))) { faltando.push({ campo: 'ref', motivo: `"${ref}" não está escrito no cProd/xProd` }); ref = null; }
  else if (!ref) faltando.push({ campo: 'ref', motivo: 'referência não identificada no texto da NF-e' });

  let tam = r && r.tamanho ? String(r.tamanho).trim().toUpperCase() : null;
  if (adidas) { faltando.push({ campo: 'tamanho', motivo: 'Adidas: tamanho só pela caixa física (NF-e traz a faixa)' }); tam = null; }
  else if (tam) {
    if (!c.tamanhoPlausivel(tam)) { faltando.push({ campo: 'tamanho', motivo: `"${tam}" não é tamanho plausível` }); tam = null; }
    else if (!(c.tamanhoNaDescricao(xProd, tam) || c.tamanhoNoCprod(cProd, tam))) { faltando.push({ campo: 'tamanho', motivo: `"${tam}" não está escrito como tamanho único no cProd/xProd` }); tam = null; }
  } else faltando.push({ campo: 'tamanho', motivo: 'tamanho não está escrito na NF-e' });

  let cor = r && r.cor ? String(r.cor).trim() : null;
  if (cor && !X.includes(c.semAcento(cor))) { faltando.push({ campo: 'cor', motivo: `"${cor}" não está escrita no xProd` }); cor = null; }
  else if (!cor) faltando.push({ campo: 'cor', motivo: 'cor não está escrita na NF-e' });
  return { valores: { ref, tamanho: tam, cor }, faltando };
}

module.exports = {
  id: 'nfe.formato-fornecedor',
  camada: 'analista',
  missao: 'Ler referência, tamanho e cor literais do item da NF-e no formato do fornecedor, sem inventar.',
  escuta: ['nfe.item-orfao'],
  emite: ['nfe.leitura-ref', 'proposta.vincular-codigo', 'dado-faltante'],
  limiar: 0,
  custo: { tipo: 'ia-barata' },
  permissao: 'propor',
  regras: ['leitura-literal-nfe', 'nunca-chutar-tamanho', 'adidas-tamanho-pela-caixa', 'sem-gtin'],
  tempoMax: 45000,
  conferirLiteral,
  async disparar({ sinal, ler, pensar }) {
    const d = sinal.dados || {};
    if (d.excedente || !Array.isArray(d.itemIds) || !d.itemIds.length) return [];
    const it = await ler.xmlFiscalItem.findUnique({ where: { id: d.itemIds[0] }, include: { fiscalDocument: { select: { accessKey: true, docType: true, issuerCnpj: true, issuerName: true, recipientCnpj: true } } } });
    if (!it) return [c.dadoFaltante(d.chave + '|item', 'item', 'item da NF-e não encontrado')];
    if (!c.docEhEntrada(it.fiscalDocument, [it]) || c.cfopTransf(it.cfop)) return []; // nunca lê transferência
    const cProd = it.supplierCode || '', xProd = it.description || '';
    const adidas = c.ehAdidas(it.fiscalDocument.issuerName, xProd, d.cardExistente && d.cardExistente.brand);
    const exemplos = await exemplosDoFornecedor(ler, it.fiscalDocument.issuerCnpj, d.itemIds);
    const r = await pensar({
      instrucao: 'Aponte a REFERÊNCIA do modelo (cProd sem o tamanho, ou a ref escrita no xProd), o TAMANHO e a COR exatamente como ESTÃO ESCRITOS. ' +
        'Use os exemplos do mesmo fornecedor para entender onde cada campo fica. Faixa como "38/43" ou "P/GG" NÃO é tamanho. Se não estiver escrito, devolva null. Não traduza e não complete nada.',
      entrada: { fornecedor: it.fiscalDocument.issuerName, item: { cProd, xProd }, exemplos },
      schema: SCHEMA,
    });
    const { valores, faltando } = conferirLiteral(r && r.ok ? r.json : null, { cProd, xProd, adidas });
    const evid = `NF-e ${it.fiscalDocument.accessKey} item ${d.nItem}: cProd="${cProd}" xProd="${xProd}"`;
    const out = [{ tipo: 'nfe.leitura-ref', forca: faltando.length ? 0.6 : 0.9, dados: {
      chave: d.chave, accessKey: it.fiscalDocument.accessKey, nItem: d.nItem, itemIds: d.itemIds, ean: d.ean,
      ref: valores.ref, tamanho: valores.tamanho, cor: valores.cor, faltando: faltando.map((f) => f.campo), ia: !!(r && r.ok), evidencia: [evid],
    } }];
    for (const f of faltando) out.push(c.dadoFaltante(d.chave + '|' + f.campo, f.campo, f.motivo, { accessKey: it.fiscalDocument.accessKey, nItem: d.nItem, itemIds: d.itemIds }));
    if (!d.cardExistente) {
      out.push(c.dadoFaltante(d.chave + '|card', 'card', d.candidatos && d.candidatos.length ? 'mais de um card possível — conferência humana' : 'nenhum card existente para este código (não se cria card pela rede)', { accessKey: it.fiscalDocument.accessKey, nItem: d.nItem, candidatos: d.candidatos || [] }));
      return out;
    }
    if (!d.ean) return out; // SEM GTIN não vira código de tamanho
    const card = d.cardExistente;
    const tam = valores.tamanho;
    out.push({ tipo: 'proposta.vincular-codigo', forca: tam ? 0.85 : 0.6, dados: {
      chave: 'vinc|' + c.identidade(d.ean),
      titulo: `Cadastrar o código ${d.ean} no card ${card.sku} ${tam ? 'como tamanho ' + tam : 'com tamanho PENDENTE (T-' + d.ean + ')'}`,
      descricao: `A NF-e de entrada traz o código ${d.ean} (${d.quantidade || '?'} un) que não existe em nenhum tamanho. O card ${card.sku} — ${card.name} já existe. ` +
        (tam ? `O tamanho ${tam} está escrito na NF-e.` : 'O tamanho NÃO está escrito na NF-e: entra como placeholder e a caixa decide no bipe.') +
        ' Comprado = soma do qCom das NF-e de entrada desse código (sem "SEM GTIN"). Não mexe em estoque físico.',
      risco: 'baixo',
      evidencia: [evid, `card ${card.id} sku=${card.sku} (${card.como || 'encontrado'})`].concat(tam ? [`tamanho "${tam}" literal no ${c.tamanhoNoCprod(cProd, tam) ? 'cProd' : 'xProd'}`] : []),
      previa: { productId: card.id, barcode: d.ean, tamanho: tam || 'T-' + d.ean, ref: valores.ref, cor: valores.cor },
      acao: { nome: 'estoque.vincular-codigo', args: { productId: card.id, barcode: d.ean, size: tam || null, itemIds: d.itemIds } },
    } });
    return out;
  },
};
