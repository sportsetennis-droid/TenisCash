'use strict';
// Estoque "conferido": a aba Estoque só mostra saldo de lojas cuja contagem ATUAL
// (última rodada não cancelada) já tem pares aplicados. Loja sem contagem aplicada
// aparece zerada; saldo negativo (venda sobre loja zerada) nunca aparece. Ordem do
// dono 10/11/2026: "se for aparecer coisa que não está conferida, não vai dar certo".
let cache = { at: 0, ids: null };
async function countedStoreIds(db) {
  if (cache.ids && Date.now() - cache.at < 30000) return cache.ids;
  const rows = await db.$queryRaw`
    SELECT r."storeId" AS "storeId"
    FROM "StocktakeRound" r
    WHERE r.status <> 'cancelled'
      AND r."startedAt" = (SELECT max(x."startedAt") FROM "StocktakeRound" x WHERE x."storeId" = r."storeId" AND x.status <> 'cancelled')
      AND EXISTS (SELECT 1 FROM "StockReplacementCheck" k JOIN "StocktakeBipe" b ON b.id = k."bipeId"
                  WHERE b."roundId" = r.id AND b."excludedAt" IS NULL AND k."appliedAt" IS NOT NULL AND k."reversedAt" IS NULL)`;
  cache = { at: Date.now(), ids: rows.map(r => r.storeId) };
  return cache.ids;
}
module.exports = { countedStoreIds };
