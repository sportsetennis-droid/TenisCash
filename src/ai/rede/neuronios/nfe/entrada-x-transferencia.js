// NF-e: classifica ENTRADA (compra de fornecedor) × TRANSFERÊNCIA (mesmo grupo).
// Regra do CLAUDE.md: transferência = CNPJ raiz do emissor == raiz do destinatário
// OU algum item com CFOP 5152/6152. Usa o docType gravado se houver; se o cálculo
// discordar, sinaliza a divergência e NÃO trata como entrada (transferência nunca vira compra).
const c = require('../_comum-estoque');

const calcular = c.classificarNfe;

module.exports = {
  id: 'nfe.entrada-x-transferencia',
  camada: 'detector',
  missao: 'Classificar a NF-e importada como entrada (compra) ou transferência pelo CNPJ raiz e pelo CFOP.',
  escuta: ['nfe.importada'],
  emite: ['nfe.classificada', 'dono.pendencia', 'dado-faltante'],
  limiar: 0,
  custo: { tipo: 'regra' },
  permissao: 'ler',
  regras: ['nfe-entrada-vs-transferencia'],
  tempoMax: 15000,
  calcular,
  async disparar({ sinal, ler }) {
    const d = sinal.dados || {};
    let doc = null;
    if (d.documentId) doc = await ler.xmlFiscalDocument.findUnique({ where: { id: d.documentId }, include: { items: { select: { cfop: true } } } });
    if (!doc && d.accessKey) doc = await ler.xmlFiscalDocument.findUnique({ where: { accessKey: String(d.accessKey) }, include: { items: { select: { cfop: true } } } });
    if (!doc) {
      if (!d.issuerCnpj || !d.recipientCnpj) return [c.dadoFaltante('nfe|' + (d.documentId || d.accessKey || '?'), 'nfe', 'NF-e não encontrada no banco e o sinal não traz os CNPJs')];
      doc = { id: d.documentId || null, accessKey: d.accessKey || null, issuerCnpj: d.issuerCnpj, recipientCnpj: d.recipientCnpj, docType: d.docType || null, items: Array.isArray(d.itens) ? d.itens : [] };
    }
    const calc = calcular(doc, doc.items || []);
    if (!calc.docType && !doc.docType) return [c.dadoFaltante('nfe|' + doc.id, 'cnpj', calc.motivos[0], { documentId: doc.id, accessKey: doc.accessKey })];
    const gravado = doc.docType || null;
    const divergente = !!(gravado && calc.docType && gravado !== calc.docType);
    const docType = gravado || calc.docType;
    // Só é ENTRADA quando ninguém discorda: na dúvida, não vira compra.
    const entrada = docType === 'entrada' && (!calc.docType || calc.docType === 'entrada');
    const base = { documentId: doc.id, accessKey: doc.accessKey, issuerCnpj: c.soDigitos(doc.issuerCnpj), recipientCnpj: c.soDigitos(doc.recipientCnpj) };
    const out = [{
      tipo: 'nfe.classificada', forca: divergente ? 0.7 : 1,
      dados: Object.assign({ chave: 'classif|' + (doc.id || doc.accessKey), docType, entrada, calculado: calc.docType, motivos: calc.motivos, divergente }, base),
    }];
    if (divergente) {
      out.push({ tipo: 'dono.pendencia', forca: 0.8, dados: Object.assign({
        chave: 'nfe-tipo|' + (doc.id || doc.accessKey), tipo: 'nfe-tipo-divergente',
        texto: `NF-e ${doc.accessKey || doc.id}: gravada como "${gravado}", mas o cálculo dá "${calc.docType}" (${calc.motivos.join('; ')}). Tratada como NÃO-entrada até conferir.`,
        gravado, calculado: calc.docType,
      }, base) });
    }
    return out;
  },
};
