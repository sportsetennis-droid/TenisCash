// =====================================================================
// nuvem.sem-foto — DETECTOR (regra, custo zero)
// Missão única: achar produto PUBLICADO na Nuvemshop sem FOTO ou sem
// DESCRIÇÃO (regra inquebrável do dono 2026-07-04: vitrine só com foto E
// descrição; publicado sem os dois deve ser despublicado).
// "Publicado" = tem NuvemshopProductMapping com syncStatus ≠ 'hidden-invalid'.
// Só lê. Não corrige nada: emite nuvem.incompleto pra quem propõe.
// =====================================================================
const { hasUsableImage } = require('../../../../services/nuvemshopEligibility');

const MAX = () => Math.max(1, Number(process.env.RNA_NUVEM_MAX_POR_PULSO || 100));
const temTexto = (v) => v != null && String(v).trim() !== '';

async function publicados(ler, nuvemshopProductId) {
  const where = { NOT: { syncStatus: 'hidden-invalid' } };
  if (nuvemshopProductId) where.nuvemshopProductId = String(nuvemshopProductId);
  return ler.nuvemshopProductMapping.findMany({ where, select: { localProductId: true, nuvemshopProductId: true }, take: 20000 });
}

module.exports = {
  id: 'nuvem.sem-foto',
  camada: 'detector',
  missao: 'Achar produto publicado na Nuvemshop sem foto ou sem descrição.',
  escuta: ['nuvem.webhook', 'relogio.diario'],
  emite: ['nuvem.incompleto'],
  limiar: 0,
  custo: { tipo: 'regra' },
  permissao: 'ler',
  regras: ['nuvemshop-foto-descricao'],
  tempoMax: 60000,
  async disparar({ sinal, ler }) {
    const d = sinal.dados || {};
    if (sinal.tipo === 'nuvem.webhook' && !d.nuvemshopProductId) return [];
    const maps = await publicados(ler, sinal.tipo === 'nuvem.webhook' ? d.nuvemshopProductId : null);
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
      select: { id: true, sku: true, name: true, brand: true, imageUrl: true, imageUrls: true, longDescription: true, shortDescription: true },
    });
    const saida = [];
    for (const p of produtos) {
      const falta = [];
      if (!hasUsableImage(p)) falta.push('foto');
      if (!temTexto(p.longDescription) && !temTexto(p.shortDescription)) falta.push('descricao');
      if (!falta.length) continue;
      saida.push({
        tipo: 'nuvem.incompleto',
        forca: 0.95,
        dados: {
          chave: 'incompleto:' + p.id + ':' + falta.join('+'),
          productId: p.id,
          nuvemshopProductId: nsDe.get(p.id),
          falta,
          produto: { sku: p.sku, nome: p.name, marca: p.brand },
          evidencia: falta.map((f) => (f === 'foto' ? 'Product.imageUrl vazio e imageUrls sem URL válida' : 'Product.longDescription e shortDescription vazios'))
            .concat('NuvemshopProductMapping publicado → NS#' + nsDe.get(p.id)),
        },
      });
      if (saida.length >= MAX()) break;
    }
    return saida;
  },
};
