// Bipe: o código bipado caiu num tamanho SEM confirmação de caixa.
//  - Adidas: todo tamanho sem sizeConfirmedAt é pendente (a NF-e só traz a faixa).
//  - Qualquer marca: tamanho placeholder (T-<EAN>, '?', vazio) é pendente.
// Vira pendência pro dono/loja ler o número NA CAIXA. Nunca sugere um número.
const c = require('../_comum-estoque');

module.exports = {
  id: 'bipe.tamanho-pendente',
  camada: 'detector',
  missao: 'Avisar quando o bipe cai num tamanho que ainda não foi confirmado pela caixa.',
  escuta: ['bipe.registrado'],
  emite: ['dono.pendencia'],
  limiar: 0,
  custo: { tipo: 'regra' },
  permissao: 'ler',
  regras: ['adidas-tamanho-pela-caixa', 'caixa-vence-numeracao', 'nunca-chutar-tamanho'],
  tempoMax: 10000,
  async disparar({ sinal, ler }) {
    const d = sinal.dados || {};
    const b = d.bipeId ? await ler.stocktakeBipe.findUnique({ where: { id: d.bipeId }, select: { id: true, productSizeId: true, barcode: true, roundId: true, excludedAt: true, storeId: true } }) : null;
    const sizeId = (b && b.productSizeId) || d.sizeId;
    if (!sizeId || (b && b.excludedAt)) return [];
    const ps = await ler.productSize.findUnique({ where: { id: sizeId }, select: { id: true, size: true, sizeConfirmedAt: true, barcode: true, product: { select: { id: true, sku: true, name: true, brand: true } } } });
    if (!ps || ps.sizeConfirmedAt) return [];
    const adidas = c.ehAdidas(ps.product.brand);
    const pend = c.placeholder(ps.size);
    if (!adidas && !pend) return [];
    return [{
      tipo: 'dono.pendencia', forca: 0.8, loja: d.storeCode || null,
      dados: {
        chave: 'tam-pend|' + ps.id, tipo: 'tamanho-pendente',
        texto: `${ps.product.sku} — ${ps.product.name}: o código ${ps.barcode || (b && b.barcode)} ${pend ? 'está sem número de tamanho' : `está como "${ps.size}" sem confirmação de caixa (${ps.product.brand})`}. Ler o tamanho NA CAIXA e confirmar no bipe.`,
        productId: ps.product.id, sizeId: ps.id, tamanhoAtual: pend ? null : ps.size, barcode: ps.barcode || (b && b.barcode) || null,
        bipeId: b ? b.id : d.bipeId || null, roundId: b ? b.roundId : d.roundId || null, motivo: adidas ? 'adidas-sem-confirmacao' : 'placeholder',
      },
    }];
  },
};
