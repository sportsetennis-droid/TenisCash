// =====================================================================
// nuvem.ghost — DETECTOR (regra, custo zero)
// Missão única: achar CARD-FANTASMA criado pelo eco do webhook
// product/created (CLAUDE.md, regra permanente 2026-06-08):
//   FORTE: o mesmo NS# (nuvemshopProductId) tem >1 mapping e um dos cards é
//          source='nuvemshop' enquanto o irmão é o card curado (não-nuvemshop).
//   MÉDIO: card source='nuvemshop', ≤1 tamanho, sem classificação, cujo
//          código de barras já existe em OUTRO card (o produto nasceu no
//          TenisCash; o webhook só ecoou).
// Só lê. Quem propõe a limpeza é nuvem.correcao.
// =====================================================================
const { contextOf } = require('../../../../services/nuvemshopEligibility');

const MAX = () => Math.max(1, Number(process.env.RNA_NUVEM_MAX_POR_PULSO || 100));
const semClassificacao = (p) => {
  const c = contextOf(p).classification || {};
  return !c.modality && !c.tier && (!p.subcategory || !String(p.subcategory).trim());
};
const codigoReal = (b) => b && /^\d{8,14}$/.test(String(b).trim());

module.exports = {
  id: 'nuvem.ghost',
  camada: 'detector',
  missao: 'Achar card-fantasma criado pelo eco do webhook da Nuvemshop.',
  escuta: ['nuvem.webhook', 'relogio.diario'],
  emite: ['nuvem.ghost'],
  limiar: 0,
  custo: { tipo: 'regra' },
  permissao: 'ler',
  regras: ['nuvemshop-ghost-webhook'],
  tempoMax: 90000,
  async disparar({ sinal, ler }) {
    const d = sinal.dados || {};
    const porWebhook = sinal.tipo === 'nuvem.webhook';
    if (porWebhook && !d.nuvemshopProductId) return [];
    const saida = [];
    const jaVisto = new Set();

    // ---- FORTE: NS# com mais de um mapping ----
    let nsIds;
    if (porWebhook) nsIds = [String(d.nuvemshopProductId)];
    else {
      const grupos = await ler.nuvemshopProductMapping.groupBy({ by: ['nuvemshopProductId'], _count: { _all: true } });
      nsIds = grupos.filter((g) => g._count._all > 1).map((g) => String(g.nuvemshopProductId));
    }
    if (nsIds.length) {
      const maps = await ler.nuvemshopProductMapping.findMany({ where: { nuvemshopProductId: { in: nsIds } }, select: { localProductId: true, nuvemshopProductId: true } });
      const prods = await ler.product.findMany({
        where: { id: { in: maps.map((m) => m.localProductId) } },
        select: { id: true, sku: true, name: true, brand: true, source: true, active: true, subcategory: true, aiContext: true, createdAt: true, _count: { select: { sizes: true } } },
      });
      const pDe = new Map(prods.map((p) => [p.id, p]));
      const porNs = new Map();
      for (const m of maps) {
        if (!porNs.has(String(m.nuvemshopProductId))) porNs.set(String(m.nuvemshopProductId), []);
        const p = pDe.get(m.localProductId);
        if (p) porNs.get(String(m.nuvemshopProductId)).push(p);
      }
      for (const [ns, cards] of porNs) {
        if (cards.length < 2) continue;
        const curados = cards.filter((c) => c.source !== 'nuvemshop');
        const fantasmas = cards.filter((c) => c.source === 'nuvemshop');
        if (!curados.length || !fantasmas.length) continue; // sem irmão curado: não é eco, não afirma
        const curado = curados.find((c) => c.active) || curados[0];
        for (const g of fantasmas) {
          jaVisto.add(g.id);
          saida.push({
            tipo: 'nuvem.ghost', forca: 0.95,
            dados: {
              chave: 'ghost:' + g.id, confianca: 'forte', ghostId: g.id, curadoId: curado.id, nuvemshopProductId: ns,
              ghost: { sku: g.sku, nome: g.name, marca: g.brand, tamanhos: g._count.sizes, ativo: g.active },
              curado: { sku: curado.sku, nome: curado.name, marca: curado.brand },
              evidencia: [
                'NS#' + ns + ' tem ' + cards.length + ' mappings (NuvemshopProductMapping)',
                'card ' + g.id + ' source=nuvemshop, ' + g._count.sizes + ' tamanho(s)' + (semClassificacao(g) ? ', sem classificação' : ''),
                'irmão curado ' + curado.id + ' source=' + curado.source + ' no mesmo NS#',
              ],
            },
          });
          if (saida.length >= MAX()) return saida;
        }
      }
    }

    // ---- MÉDIO: eco sem mapping duplicado (código já existe em outro card) ----
    const whereG = { source: 'nuvemshop', active: true };
    if (porWebhook) {
      const ms = await ler.nuvemshopProductMapping.findMany({ where: { nuvemshopProductId: String(d.nuvemshopProductId) }, select: { localProductId: true } });
      whereG.id = { in: ms.map((m) => m.localProductId) };
    }
    const candidatos = await ler.product.findMany({
      where: whereG,
      select: { id: true, sku: true, name: true, brand: true, subcategory: true, aiContext: true, sizes: { select: { barcode: true, size: true } } },
      take: 5000,
    });
    for (const g of candidatos) {
      if (jaVisto.has(g.id) || g.sizes.length > 1 || !semClassificacao(g)) continue;
      const codigos = g.sizes.map((s) => s.barcode).filter(codigoReal);
      if (!codigos.length) continue; // sem código real não dá pra provar o eco
      const irmao = await ler.productSize.findFirst({
        where: { barcode: { in: codigos }, productId: { not: g.id }, product: { source: { not: 'nuvemshop' } } },
        select: { barcode: true, size: true, productId: true },
      });
      if (!irmao) continue;
      const map = await ler.nuvemshopProductMapping.findUnique({ where: { localProductId: g.id }, select: { nuvemshopProductId: true } });
      saida.push({
        tipo: 'nuvem.ghost', forca: 0.7,
        dados: {
          chave: 'ghost:' + g.id, confianca: 'media', ghostId: g.id, curadoId: irmao.productId, nuvemshopProductId: map ? String(map.nuvemshopProductId) : null,
          ghost: { sku: g.sku, nome: g.name, marca: g.brand, tamanhos: g.sizes.length },
          evidencia: [
            'card ' + g.id + ' source=nuvemshop, ' + g.sizes.length + ' tamanho, sem classificação',
            'código ' + irmao.barcode + ' já é do card ' + irmao.productId + ' (tamanho ' + irmao.size + ')',
          ],
        },
      });
      if (saida.length >= MAX()) break;
    }
    return saida;
  },
};
