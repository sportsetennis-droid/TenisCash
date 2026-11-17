// =====================================================================
// RNA — SENSORES: a borda da rede. O código existente chama
// `rede.sensor(TIPO, dados)` onde o evento já acontece. Nunca bloqueia
// nem lança erro para quem chamou (fire-and-forget).
//
// Tipos de sinal emitidos pelos sensores (contrato para os neurônios):
//   nfe.importada        { documentId, accessKey, docType, issuerCnpj, recipientCnpj, itens }
//   venda.registrada     { saleId, storeCode, total, itens:[{productId, sizeId, qty, price}] }
//   bipe.registrado      { bipeId, storeCode, barcode, productId?, sizeId?, found, roundId? }
//   nuvem.webhook        { evento, nuvemshopProductId?, orderId? }
//   whatsapp.mensagem    { empresa, telefoneHash, texto }            (externo: true)
//   torneio.finalizado   { tournamentId, categoryId }
//   dono.pergunta        { texto, userId }
//   relogio.hora | relogio.diario | relogio.semanal | relogio.mensal  { quando }
//   relogio.objetivo     { objetivoId }   (emitido por objetivos.pulsar)
// =====================================================================
const motor = require('./motor');

const SENSORES = {
  'nfe.importada': { origem: 's.nfe', forca: 1 },
  'venda.registrada': { origem: 's.venda', forca: 1 },
  'bipe.registrado': { origem: 's.bipe', forca: 1 },
  'nuvem.webhook': { origem: 's.nuvem', forca: 1 },
  'whatsapp.mensagem': { origem: 's.whatsapp', forca: 1, externo: true },
  'torneio.finalizado': { origem: 's.club', forca: 1 },
  'dono.pergunta': { origem: 's.dono', forca: 1 },
  'relogio.hora': { origem: 's.relogio', forca: 0.6 },
  'relogio.diario': { origem: 's.relogio', forca: 0.8 },
  'relogio.semanal': { origem: 's.relogio', forca: 0.9 },
  'relogio.mensal': { origem: 's.relogio', forca: 0.9 },
};

function sensor(tipo, dados = {}, extra = {}) {
  const cfg = SENSORES[tipo];
  if (!cfg) { console.error('[RNA] sensor desconhecido:', tipo); return; }
  setImmediate(() => {
    motor.emitir(Object.assign({ tipo, dados }, cfg, extra)).catch(() => {});
  });
}

module.exports = { sensor, SENSORES };
