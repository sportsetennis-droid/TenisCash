// =====================================================================
// nuvem.sem-classificacao — DETECTOR (regra, custo zero)
// Missão única: achar produto PUBLICADO na Nuvemshop que perdeu/nunca teve
// alguma das 4 classificações (Categoria + Sub + Modalidade + Especialidade).
// Regra inquebrável: sem as 4, não fica na loja.
// Mesmo critério de "indefinido" do gate oficial (nuvemshopEligibility).
// =====================================================================
const { contextOf } = require('../../../../services/nuvemshopEligibility');

const MAX = () => Math.max(1, Number(process.env.RNA_NUVEM_MAX_POR_PULSO || 100));
const INVALIDOS = new Set(['', 'A CLASSIFICAR', 'A DEFINIR', 'SEM MARCA', 'NAO DEFINIDO', 'NÃO DEFINIDO']);
const invalido = (v) => INVALIDOS.has(v == null ? '' : String(v).trim().toLocaleUpperCase('pt-BR'));

function faltando(p) {
  const c = contextOf(p).classification || {};
  const f = [];
  if (invalido(p.category)) f.push('categoria');
  if (invalido(p.subcategory)) f.push('subcategoria');
  if (invalido(c.modality)) f.push('modalidade');
  if (invalido(c.tier)) f.push('especialidade');
  return f;
}

module.exports = {
  id: 'nuvem.sem-classificacao',
  camada: 'detector',
  missao: 'Achar produto publicado na Nuvemshop sem alguma das 4 classificações.',
  escuta: ['nuvem.webhook', 'relogio.diario'],
  emite: ['nuvem.incompleto'],
  limiar: 0,
  custo: { tipo: 'regra' },
  permissao: 'ler',
  regras: ['nuvemshop-4-classificacoes'],
  tempoMax: 60000,
  async disparar({ sinal, ler }) {
    const d = sinal.dados || {};
    if (sinal.tipo === 'nuvem.webhook' && !d.nuvemshopProductId) return [];
    const where = { NOT: { syncStatus: 'hidden-invalid' } };
    if (sinal.tipo === 'nuvem.webhook') where.nuvemshopProductId = String(d.nuvemshopProductId);
    const maps = await ler.nuvemshopProductMapping.findMany({ where, select: { localProductId: true, nuvemshopProductId: true }, take: 20000 });
    if (!maps.length) return [];
    const nsDe = new Map(maps.map((m) => [m.localProductId, String(m.nuvemshopProductId)]));
    // NS# com mais de um card = eco do webhook (card-fantasma): quem trata é nuvem.ghost.
    // Despublicar aqui esconderia também o card curado que divide o mesmo NS#.
    const grupos = await ler.nuvemshopProductMapping.groupBy({ by: ['nuvemshopProductId'], where: { nuvemshopProductId: { in: [...new Set(nsDe.values())] } }, _count: { _all: true } });
    const compartilhado = new Set(grupos.filter((g) => g._count._all > 1).map((g) => String(g.nuvemshopProductId)));
    for (const [pid, ns] of [...nsDe]) if (compartilhado.has(ns)) nsDe.delete(pid);
    if (!nsDe.size) return [];
    const produtos = await ler.product.findMany({
      where: { id: { in: [...nsDe.keys()] }, active: true },
      select: { id: true, sku: true, name: true, brand: true, category: true, subcategory: true, aiContext: true },
    });
    const saida = [];
    for (const p of produtos) {
      const quais = faltando(p);
      if (!quais.length) continue;
      saida.push({
        tipo: 'nuvem.incompleto',
        forca: 0.95,
        dados: {
          chave: 'incompleto:' + p.id + ':classificacao',
          productId: p.id,
          nuvemshopProductId: nsDe.get(p.id),
          falta: ['classificacao'],
          classificacoesFaltando: quais,
          produto: { sku: p.sku, nome: p.name, marca: p.brand },
          evidencia: quais.map((q) => q + ' ausente/indefinida no card (' + ({ categoria: 'Product.category', subcategoria: 'Product.subcategory', modalidade: 'aiContext.classification.modality', especialidade: 'aiContext.classification.tier' })[q] + ')')
            .concat('NuvemshopProductMapping publicado → NS#' + nsDe.get(p.id)),
        },
      });
      if (saida.length >= MAX()) break;
    }
    return saida;
  },
};
