'use strict';
// =====================================================================
// RECEBIMENTO ATIVO AUTOMÁTICO (dono, 18/11/2026)
// "Todos os produtos que tiverem recebimento precisam estar ativos
//  automaticamente."
//
// Cada peça bipada no modo Recebimento (ScanActionLot mode='receipt') entra no
// estoque da loja que recebeu NA HORA (StoreStock +1, com movimento no
// histórico), sem esperar alguém ligar a remessa e confirmar.
//
// Regras:
// - Só vale a partir de 18/11/2026 00:00 (horário de João Pessoa) — o dono pediu
//   "hoje" — e nunca antes do início da contagem nova da loja. O que foi recebido
//   antes fica como está.
// - Só peça reconhecida, com variante e tamanho resolvidos (Adidas: tamanho
//   confirmado na caixa). Leitura removida, trocada ou lote arquivado = desfaz.
// - Uma leitura soma uma vez só (idempotente pelo clientScanId).
// - SEM SOMA DUPLA com a contagem: a contagem nova é uma recontagem completa;
//   quando ela bipa uma peça do mesmo tamanho que JÁ entrou pelo Recebimento
//   (recebida antes do bipe), o bipe confirma aquela peça em vez de somar outra
//   ("pareamento"). Recebeu 2 e contou 3 → 3; recebeu 2 e contou 2 → 2.
// - Remessa confirmada depois soma só o que ainda não entrou sozinho.
// O comprado (ProductSize.stock) nunca é tocado.
// =====================================================================
const { applyStoreStockDelta } = require('./storeStockLedger');

const SOURCE = 'camera-receipt-auto';
const SOURCE_REVERSE = 'camera-receipt-auto-reverse';
const SOURCE_PAIR = 'receipt-count-pairing';
const SOURCE_UNPAIR = 'receipt-count-unpairing';
const ROUND_OPEN = ['counting', 'review'];

// Ponto de partida pedido pelo dono ("eu falei de hoje", 18/11/2026). Ajustável sem deploy.
function desde() {
  const v = Date.parse(process.env.RECEBIMENTO_AUTOMATICO_DESDE || '2026-11-18T00:00:00-03:00');
  return Number.isFinite(v) ? v : Date.parse('2026-11-18T00:00:00-03:00');
}

function ctxOf(v) { return v && typeof v === 'object' && !Array.isArray(v) ? v : {}; }

// Início da contagem nova da loja (rodada de substituição ativa ou a última fechada).
async function replacementRound(tx, storeId) {
  const active = await tx.stocktakeRound.findFirst({
    where: { storeId, operationType: 'replacement', status: { in: ROUND_OPEN } },
    orderBy: { startedAt: 'desc' }, select: { id: true, number: true, startedAt: true, status: true },
  });
  if (active) return { ...active, open: true };
  const closed = await tx.stocktakeRound.findFirst({
    where: { storeId, operationType: 'replacement', status: 'closed' },
    orderBy: { startedAt: 'desc' }, select: { id: true, number: true, startedAt: true, status: true },
  });
  return closed ? { ...closed, open: false } : null;
}

// Leitura que deve estar no estoque agora.
function deveEntrar(read, lot, round) {
  if (!lot || lot.mode !== 'receipt' || lot.status === 'archived' || !round) return false;
  if (read.removed || !read.recognized || !read.productSizeId) return false;
  if (read.requiresSizeConfirmation && !String(read.confirmedSize || '').trim()) return false;
  const t = new Date(read.scannedAt).getTime();
  return t >= new Date(round.startedAt).getTime() && t >= desde();
}

// Situação atual de cada leitura do lote no histórico: { clientScanId: { productSizeId, net } }
async function aplicadoPorLeitura(tx, lotId) {
  const rows = await tx.$queryRawUnsafe(
    'SELECT metadata->>\'clientScanId\' AS cs, "productSizeId" AS ps, SUM(quantity)::int AS net FROM "StoreStockMovement" ' +
    'WHERE source IN ($1, $2) AND metadata->>\'lotId\' = $3 GROUP BY 1, 2', SOURCE, SOURCE_REVERSE, lotId);
  const out = new Map();
  for (const r of rows) if (r.net) out.set(r.cs, { productSizeId: r.ps, net: r.net });
  return out;
}

async function lockSize(tx, storeId, productSizeId) {
  await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${'receipt-stock:' + storeId + ':' + productSizeId}))::text`;
}

// Reaplica o lote: soma o que deve entrar e ainda não entrou; desfaz o que não deve mais estar.
async function aplicarLote(tx, lotId) {
  const lot = await tx.scanActionLot.findUnique({ where: { sessionId: lotId }, include: { scans: true } });
  if (!lot || lot.mode !== 'receipt') return { aplicadas: 0, desfeitas: 0 };
  const round = await replacementRound(tx, lot.toStoreId);
  const atual = await aplicadoPorLeitura(tx, lotId);
  let aplicadas = 0, desfeitas = 0;
  const tocados = new Set();
  for (const read of lot.scans) {
    const ja = atual.get(read.clientScanId);
    const deve = deveEntrar(read, lot, round);
    // desfaz: não deve mais entrar, ou mudou de variante
    if (ja && ja.net > 0 && (!deve || ja.productSizeId !== read.productSizeId)) {
      await lockSize(tx, lot.toStoreId, ja.productSizeId);
      await applyStoreStockDelta(tx, { storeId: lot.toStoreId, productSizeId: ja.productSizeId, quantity: -ja.net, type: 'receipt_reverse', source: SOURCE_REVERSE,
        reason: 'Recebimento desfeito (leitura removida, trocada ou lote arquivado)', metadata: { lotId, clientScanId: read.clientScanId } });
      desfeitas++; tocados.add(ja.productSizeId);
      atual.delete(read.clientScanId);
    }
    if (deve && !(atual.get(read.clientScanId)?.net > 0)) {
      await lockSize(tx, lot.toStoreId, read.productSizeId);
      await applyStoreStockDelta(tx, { storeId: lot.toStoreId, productSizeId: read.productSizeId, quantity: 1, type: 'receipt', source: SOURCE,
        reason: 'Recebimento bipado (entra automático no estoque da loja)', metadata: { lotId, clientScanId: read.clientScanId, scannedAt: new Date(read.scannedAt).toISOString() } });
      aplicadas++; tocados.add(read.productSizeId);
    }
  }
  if (round && round.open) for (const ps of tocados) await parear(tx, lot.toStoreId, ps, round);
  return { aplicadas, desfeitas };
}

// Leituras de recebimento ativas (net>0) da loja/tamanho, desde o início da rodada, em ordem de horário.
async function recebimentosAtivos(tx, storeId, productSizeId, round) {
  const rows = await tx.$queryRawUnsafe(
    'SELECT metadata->>\'clientScanId\' AS cs, MIN(metadata->>\'scannedAt\') AS em, SUM(quantity)::int AS net FROM "StoreStockMovement" ' +
    'WHERE source IN ($1, $2) AND "storeId" = $3 AND "productSizeId" = $4 GROUP BY 1', SOURCE, SOURCE_REVERSE, storeId, productSizeId);
  const inicio = new Date(round.startedAt).getTime();
  return rows.filter((r) => r.net > 0 && r.em && new Date(r.em).getTime() >= inicio)
    .map((r) => ({ cs: r.cs, em: new Date(r.em).getTime() }))
    .sort((a, b) => a.em - b.em || String(a.cs).localeCompare(String(b.cs)));
}

// Recalcula o pareamento contagem × recebimento de UMA loja/tamanho na rodada aberta e
// acerta o estoque com movimentos (nunca escreve saldo direto). Cada bipe da contagem
// pareia com um recebimento ANTERIOR ainda livre; bipe pareado não soma (-1 de pareamento).
async function parear(tx, storeId, productSizeId, roundIn) {
  const round = roundIn || await replacementRound(tx, storeId);
  if (!round || !round.open) return { pareados: 0 };
  await lockSize(tx, storeId, productSizeId);
  const recebidos = await recebimentosAtivos(tx, storeId, productSizeId, round);
  const checks = await tx.stockReplacementCheck.findMany({
    where: { roundId: round.id, status: 'applied', appliedAt: { not: null }, reversedAt: null, appliedProductSizeId: productSizeId },
    include: { bipe: { select: { id: true, bipedAt: true, storeId: true, excludedAt: true } } },
  });
  const contagem = checks.filter((c) => c.bipe && c.bipe.storeId === storeId && !c.bipe.excludedAt)
    .sort((a, b) => new Date(a.bipe.bipedAt) - new Date(b.bipe.bipedAt) || a.bipeId.localeCompare(b.bipeId));
  // pareamento guloso: cada bipe da contagem pega o recebimento livre mais antigo feito ANTES dele
  const livres = recebidos.slice();
  const alvo = new Map(); // bipeId -> clientScanId
  for (const c of contagem) {
    const t = new Date(c.bipe.bipedAt).getTime();
    const i = livres.findIndex((r) => r.em <= t);
    if (i >= 0) { alvo.set(c.bipeId, livres[i].cs); livres.splice(i, 1); }
  }
  let pareados = 0;
  for (const c of contagem) {
    const ev = ctxOf(c.evidence);
    const agora = ev.pareadoComRecebimento || null;
    const deve = alvo.get(c.bipeId) || null;
    if (!!agora === !!deve) {
      if (agora && agora !== deve) await tx.stockReplacementCheck.update({ where: { bipeId: c.bipeId }, data: { evidence: { ...ev, pareadoComRecebimento: deve } } });
      if (deve) pareados++;
      continue;
    }
    if (deve) {
      await applyStoreStockDelta(tx, { storeId, productSizeId, quantity: -1, type: 'inventory_adjustment', source: SOURCE_PAIR,
        reason: 'Bipe da contagem confirmou peça que já tinha entrado pelo Recebimento (não soma duas vezes)', metadata: { roundId: round.id, bipeId: c.bipeId, clientScanId: deve } });
      await tx.stockReplacementCheck.update({ where: { bipeId: c.bipeId }, data: { evidence: { ...ev, pareadoComRecebimento: deve } } });
      pareados++;
    } else {
      await applyStoreStockDelta(tx, { storeId, productSizeId, quantity: 1, type: 'inventory_adjustment', source: SOURCE_UNPAIR,
        reason: 'Recebimento pareado saiu: o bipe da contagem volta a valer a peça', metadata: { roundId: round.id, bipeId: c.bipeId, clientScanId: agora } });
      const { pareadoComRecebimento, ...resto } = ev;
      await tx.stockReplacementCheck.update({ where: { bipeId: c.bipeId }, data: { evidence: { ...resto, despareadoEm: new Date().toISOString() } } });
    }
  }
  return { pareados };
}

// Antes de excluir um bipe da contagem: se ele estava pareado, devolve o +1 do pareamento
// (o -1 da exclusão desfaz o +1 do bipe) — o recebimento continua valendo a peça.
async function antesDeExcluirBipe(tx, check, storeId) {
  const ev = ctxOf(check && check.evidence);
  if (!check || !ev.pareadoComRecebimento || !check.appliedAt || check.reversedAt) return;
  await applyStoreStockDelta(tx, { storeId, productSizeId: check.appliedProductSizeId, quantity: 1, type: 'inventory_adjustment', source: SOURCE_UNPAIR,
    reason: 'Bipe da contagem excluído: o recebimento pareado continua valendo a peça', metadata: { roundId: check.roundId, bipeId: check.bipeId, clientScanId: ev.pareadoComRecebimento } });
  const { pareadoComRecebimento, ...resto } = ev;
  await tx.stockReplacementCheck.update({ where: { bipeId: check.bipeId }, data: { evidence: { ...resto, despareadoEm: new Date().toISOString() } } });
}

// Quantas leituras deste lote já entraram sozinhas, por tamanho (para a remessa não somar de novo).
async function jaEntrouPorTamanho(tx, lotId) {
  const atual = await aplicadoPorLeitura(tx, lotId);
  const out = new Map();
  for (const v of atual.values()) if (v.net > 0) out.set(v.productSizeId, (out.get(v.productSizeId) || 0) + v.net);
  return out;
}

// Mesma conta, pelas leituras (a remessa pode ser confirmada sem o id do lote).
async function jaEntrouPorLeituras(tx, storeId, clientScanIds) {
  const ids = [...new Set((clientScanIds || []).map(String))];
  const out = new Map();
  if (!ids.length) return out;
  const rows = await tx.$queryRawUnsafe(
    'SELECT "productSizeId" AS ps, SUM(quantity)::int AS net FROM "StoreStockMovement" WHERE source IN ($1, $2) AND "storeId" = $3 AND metadata->>\'clientScanId\' = ANY($4::text[]) GROUP BY 1',
    SOURCE, SOURCE_REVERSE, storeId, ids);
  for (const r of rows) if (r.net > 0) out.set(r.ps, r.net);
  return out;
}

// Varredura: aplica todos os lotes de recebimento (inclui leituras que ganharam tamanho depois).
async function aplicarTodos(db, { limite = 500 } = {}) {
  const lots = await db.scanActionLot.findMany({ where: { mode: 'receipt' }, select: { sessionId: true }, orderBy: { updatedAt: 'desc' }, take: limite });
  let aplicadas = 0, desfeitas = 0, erros = 0;
  for (const l of lots) {
    try {
      const r = await db.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${'scan-action-lot:' + l.sessionId}))::text`;
        return aplicarLote(tx, l.sessionId);
      }, { timeout: 60000 });
      aplicadas += r.aplicadas; desfeitas += r.desfeitas;
    } catch (e) { erros++; console.warn('[recebimento automático] lote', l.sessionId, e.message); }
  }
  return { lotes: lots.length, aplicadas, desfeitas, erros };
}

const state = { lastRunAt: null, lastResult: null, lastError: null };
function iniciarRecebimentoAutomatico(db) {
  if (process.env.RECEBIMENTO_AUTOMATICO === '0') { console.log('[recebimento automático] desligado (RECEBIMENTO_AUTOMATICO=0)'); return; }
  const rodar = () => aplicarTodos(db).then((r) => { state.lastRunAt = new Date().toISOString(); state.lastResult = r; state.lastError = null; if (r.aplicadas || r.desfeitas) console.log('[recebimento automático]', JSON.stringify(r)); })
    .catch((e) => { state.lastError = e.message; console.warn('[recebimento automático] falhou:', e.message); });
  setTimeout(rodar, 90 * 1000);
  setInterval(rodar, 10 * 60 * 1000);
  console.log('[recebimento automático] ligado: cada recebimento bipado entra no estoque da loja (varredura a cada 10 min + na hora do bipe)');
}
function estadoRecebimentoAutomatico() { return JSON.parse(JSON.stringify(state)); }

module.exports = { desde, SOURCE, SOURCE_REVERSE, SOURCE_PAIR, SOURCE_UNPAIR, aplicarLote, parear, antesDeExcluirBipe, jaEntrouPorTamanho, jaEntrouPorLeituras, aplicarTodos, iniciarRecebimentoAutomatico, estadoRecebimentoAutomatico, deveEntrar, replacementRound };
