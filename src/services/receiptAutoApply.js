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
// - Vale desde o início da contagem nova de cada loja (09/11/2026). Dono, 18/11:
//   "Valide todos… veja o que foi vendido nesse tempo e faça a diminuição" — a venda
//   já baixa o estoque na hora; o recebimento anterior à contagem já está na recontagem
//   física (somar daria em dobro), então fica como está. (Antes: só a partir de 18/11.)
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
  const v = Date.parse(process.env.RECEBIMENTO_AUTOMATICO_DESDE || '2026-11-09T00:00:00-03:00');
  return Number.isFinite(v) ? v : Date.parse('2026-11-09T00:00:00-03:00');
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

const SRC_SQL = "('" + SOURCE + "', '" + SOURCE_REVERSE + "')"; // literal: casa com o índice parcial

// Pode ENTRAR agora (entrada nova): lote aberto, peça reconhecida e com tamanho, bipada depois
// do ponto de partida e do início da contagem nova da loja.
function deveEntrar(read, lot, round) {
  if (!lot || lot.mode !== 'receipt' || lot.status !== 'open' || !round) return false;
  if (deveSair(read, lot)) return false;
  const t = new Date(read.scannedAt).getTime();
  return t >= new Date(round.startedAt).getTime() && t >= desde();
}
// Só sai do estoque por motivo EXPLÍCITO na própria leitura ou no lote (nunca por data/janela).
function deveSair(read, lot) {
  if (lot && lot.status === 'archived') return true;
  if (read.removed || !read.recognized || !read.productSizeId) return true;
  return !!(read.requiresSizeConfirmation && !String(read.confirmedSize || '').trim());
}

// ---------------------------------------------------------------------
// RECEBIMENTO ANTERIOR À CONTAGEM NOVA (dono 18/11: "Valide todos… veja o que foi vendido
// nesse tempo e faça a diminuição"). A contagem nova conta todas as mercadorias, mas as lojas
// começaram pelo calçado: roupa e acessório recebidos antes dela nunca entraram no estoque e
// ainda não foram contados (auditoria 18/11: ~1.800 peças, saldo negativo pelas vendas).
// Entra quando: não é calçado nem insumo (calçado foi contado: tamanho sem bipe = peça que não
// está na loja), aquele tamanho não foi bipado na contagem e a loja ainda não está contando a
// família (menos de FAMILIA_CONTADA_MIN bipes). As vendas do tamanho entre o recebimento e o
// início da contagem — baixa apagada quando o saldo antigo foi arquivado — são baixadas de novo,
// uma vez (SOURCE_VENDAS). Se a contagem bipar a peça depois, o bipe pareia (não soma em dobro).
// ---------------------------------------------------------------------
const SOURCE_VENDAS = 'receipt-pre-round-sales';
const FAMILIA_CONTADA_MIN = Number(process.env.RECEBIMENTO_FAMILIA_CONTADA_MIN || 20);
const FAMILIAS_QUE_ENTRAM = new Set(['vestuario', 'acessorio']);
function anteriorDesde() {
  const v = Date.parse(process.env.RECEBIMENTO_ANTERIOR_DESDE || '2026-10-01T00:00:00-03:00');
  return Number.isFinite(v) ? v : Date.parse('2026-10-01T00:00:00-03:00');
}
function familiaDaCategoria(cat) {
  const c = String(cat || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase().trim();
  if (['TENIS', 'CHUTEIRAS', 'CHUTEIRA', 'SANDALIAS', 'SANDALIA', 'CALCADOS'].includes(c)) return 'calcado';
  if (['VESTUARIO', 'ROUPAS', 'ROUPA'].includes(c)) return 'vestuario';
  if (['ACESSORIOS', 'ACESSORIO'].includes(c)) return 'acessorio';
  return 'outro'; // insumo, dropper, "a classificar"…: não entra sem conferência
}
const FAMILIA_SQL = {
  calcado: "('TENIS','TÊNIS','CHUTEIRAS','CHUTEIRA','SANDALIAS','SANDÁLIAS','SANDALIA','SANDÁLIA','CALCADOS','CALÇADOS')",
  vestuario: "('VESTUARIO','VESTUÁRIO','ROUPAS','ROUPA')",
  acessorio: "('ACESSORIOS','ACESSÓRIOS','ACESSORIO','ACESSÓRIO')",
};
// cache por lote: { ps -> familia, 'fam:<f>' -> contada?, 'ps:<id>' -> bipado? }
async function podeEntrarAnterior(tx, read, lot, round, cache) {
  if (!lot || lot.mode !== 'receipt' || lot.status !== 'open' || !round || !round.open) return false;
  if (deveSair(read, lot)) return false;
  const t = new Date(read.scannedAt).getTime();
  if (!(t < new Date(round.startedAt).getTime()) || t < anteriorDesde()) return false;
  const ps = read.productSizeId;
  if (!cache.has(ps)) {
    const r = await tx.productSize.findUnique({ where: { id: ps }, select: { product: { select: { category: true } } } });
    cache.set(ps, familiaDaCategoria(r && r.product && r.product.category));
  }
  const fam = cache.get(ps);
  if (!FAMILIAS_QUE_ENTRAM.has(fam)) return false;
  const kPs = 'ps:' + ps;
  if (!cache.has(kPs)) {
    const b = await tx.$queryRawUnsafe(
      'SELECT 1 FROM "StockReplacementCheck" k JOIN "StocktakeBipe" b ON b.id = k."bipeId" WHERE k."roundId" = $1 AND k.status = \'applied\' AND k."reversedAt" IS NULL ' +
      'AND k."appliedProductSizeId" = $2 AND b."storeId" = $3 AND b."excludedAt" IS NULL LIMIT 1', round.id, ps, lot.toStoreId);
    cache.set(kPs, b.length > 0);
  }
  if (cache.get(kPs)) return false; // o tamanho foi contado: a contagem manda
  const kFam = 'fam:' + fam;
  if (!cache.has(kFam)) {
    const [c] = await tx.$queryRawUnsafe(
      'SELECT count(*)::int AS n FROM "StockReplacementCheck" k JOIN "StocktakeBipe" b ON b.id = k."bipeId" JOIN "ProductSize" s ON s.id = k."appliedProductSizeId" JOIN "Product" p ON p.id = s."productId" ' +
      'WHERE k."roundId" = $1 AND k.status = \'applied\' AND k."reversedAt" IS NULL AND b."storeId" = $2 AND b."excludedAt" IS NULL AND upper(btrim(p.category)) IN ' + FAMILIA_SQL[fam], round.id, lot.toStoreId);
    cache.set(kFam, (c && c.n) >= FAMILIA_CONTADA_MIN);
  }
  return !cache.get(kFam); // a loja já está contando essa família: a contagem manda
}

// Baixa das vendas apagadas pelo arquivamento: só para tamanho com recebimento ANTERIOR ativo
// nesta contagem; alvo = soma das vendas (e estornos) entre o 1º recebimento anterior e o início
// da contagem. Idempotente: grava só a diferença para o que já foi baixado.
async function baixarVendasArquivadas(tx, storeId, productSizeId, round) {
  if (!round || !round.open) return 0;
  const [a] = await tx.$queryRawUnsafe(
    'SELECT MIN(em) AS em FROM (SELECT metadata->>\'clientScanId\' AS cs, MIN(metadata->>\'scannedAt\') AS em, SUM(quantity) AS net, bool_or(metadata->>\'anteriorAContagem\' = \'true\') AS ant ' +
    'FROM "StoreStockMovement" WHERE source IN ' + SRC_SQL + ' AND "storeId" = $1 AND "productSizeId" = $2 AND metadata->>\'roundId\' = $3 GROUP BY 1) x WHERE net > 0 AND ant',
    storeId, productSizeId, round.id);
  let alvo = 0;
  if (a && a.em) {
    const [v] = await tx.$queryRawUnsafe(
      'SELECT COALESCE(SUM(quantity), 0)::int AS q FROM "StoreStockMovement" WHERE "storeId" = $1 AND "productSizeId" = $2 AND type ~ \'^(sale|exchange_|nuvemshop_order)\' AND "createdAt" >= $3::timestamp AND "createdAt" < $4::timestamp', // createdAt é UTC sem fuso: compara em UTC
      storeId, productSizeId, new Date(a.em).toISOString(), new Date(round.startedAt).toISOString());
    alvo = v ? v.q : 0;
  }
  const [j] = await tx.$queryRawUnsafe(
    'SELECT COALESCE(SUM(quantity), 0)::int AS q FROM "StoreStockMovement" WHERE source = $1 AND "storeId" = $2 AND "productSizeId" = $3 AND metadata->>\'roundId\' = $4',
    SOURCE_VENDAS, storeId, productSizeId, round.id);
  const delta = alvo - (j ? j.q : 0);
  if (!delta) return 0;
  await applyStoreStockDelta(tx, { storeId, productSizeId, quantity: delta, type: 'inventory_adjustment', source: SOURCE_VENDAS,
    reason: delta < 0 ? 'Vendas feitas antes da contagem nova (a baixa tinha sido arquivada) — recebimento anterior validado' : 'Recebimento anterior desfeito: devolve a baixa das vendas anteriores à contagem',
    metadata: { roundId: round.id, desde: a && a.em ? a.em : null } });
  return delta;
}

// Situação de cada leitura do lote: { clientScanId: { productSizeId, net, roundId } }
async function aplicadoPorLeitura(tx, lotId) {
  const rows = await tx.$queryRawUnsafe(
    'SELECT metadata->>\'clientScanId\' AS cs, "productSizeId" AS ps, SUM(quantity)::int AS net, MAX(metadata->>\'roundId\') AS rid FROM "StoreStockMovement" ' +
    'WHERE source IN ' + SRC_SQL + ' AND metadata->>\'lotId\' = $1 GROUP BY 1, 2', lotId);
  const out = new Map();
  for (const r of rows) if (r.net) out.set(r.cs, { productSizeId: r.ps, net: r.net, roundId: r.rid || null });
  return out;
}

async function lockSize(tx, storeId, productSizeId) {
  await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${'receipt-stock:' + storeId + ':' + productSizeId}))::text`;
}
// Ordem única de travas (auditoria 18/11): sempre em ordem crescente, ANTES de mexer no StoreStock.
async function lockSizes(tx, storeId, ids) {
  for (const id of [...new Set(ids.filter(Boolean))].sort()) await lockSize(tx, storeId, id);
}

// Pode desfazer uma entrada? Só na MESMA contagem em que ela entrou. Contagem nova aberta
// depois (que zerou e recontou a loja) = não desfaz. Contagem já fechada: só desfaz se a
// peça não foi confirmada por um bipe da contagem (pareada) — senão a peça contada some.
async function podeDesfazer(tx, storeId, entrada, clientScanId) {
  const atual = await replacementRound(tx, storeId);
  if (!atual || !entrada.roundId || atual.id !== entrada.roundId) return false;
  if (atual.open) return true;
  const pareado = await tx.$queryRawUnsafe(
    'SELECT 1 FROM "StockReplacementCheck" WHERE "roundId" = $1 AND "reversedAt" IS NULL AND evidence->>\'pareadoComRecebimento\' = $2 LIMIT 1', atual.id, clientScanId);
  return !pareado.length;
}

// Reaplica o lote: soma o que deve entrar e ainda não entrou; desfaz o que saiu por motivo explícito.
// Lote CONFIRMADO pela remessa não é mexido: a confirmação já descontou o que tinha entrado sozinho.
async function aplicarLote(tx, lotId) {
  const lot = await tx.scanActionLot.findUnique({ where: { sessionId: lotId }, include: { scans: true } });
  if (!lot || lot.mode !== 'receipt' || lot.status === 'confirmed') return { aplicadas: 0, desfeitas: 0 };
  const round = await replacementRound(tx, lot.toStoreId);
  const atual = await aplicadoPorLeitura(tx, lotId);
  // planeja primeiro; trava todos os tamanhos em ordem; só então escreve
  const planos = [];
  const cache = new Map();
  // 'novo' = depois do início da contagem; 'anterior' = recebido antes e ainda não contado; null = não entra
  const comoEntra = async (read) => (deveEntrar(read, lot, round) ? 'novo' : (await podeEntrarAnterior(tx, read, lot, round, cache)) ? 'anterior' : null);
  for (const read of lot.scans) {
    const ja = atual.get(read.clientScanId);
    const temEntrada = !!(ja && ja.net > 0);
    const trocou = temEntrada && !!read.productSizeId && ja.productSizeId !== read.productSizeId;
    if (temEntrada && (deveSair(read, lot) || trocou)) {
      if (await podeDesfazer(tx, lot.toStoreId, ja, read.clientScanId)) {
        planos.push({ tipo: 'sai', read, ja });
        const modo = trocou ? await comoEntra(read) : null;
        if (modo) planos.push({ tipo: 'entra', read, anterior: modo === 'anterior' });
      }
    } else if (!temEntrada) {
      const modo = await comoEntra(read);
      if (modo) planos.push({ tipo: 'entra', read, anterior: modo === 'anterior' });
    }
  }
  if (!planos.length) return { aplicadas: 0, desfeitas: 0 };
  await lockSizes(tx, lot.toStoreId, planos.map((x) => (x.tipo === 'sai' ? x.ja.productSizeId : x.read.productSizeId)));
  let aplicadas = 0, desfeitas = 0;
  const tocados = new Set();
  for (const x of planos) {
    if (x.tipo === 'sai') {
      await applyStoreStockDelta(tx, { storeId: lot.toStoreId, productSizeId: x.ja.productSizeId, quantity: -x.ja.net, type: 'receipt_reverse', source: SOURCE_REVERSE,
        reason: 'Recebimento desfeito (leitura removida, trocada ou lote arquivado)', metadata: { lotId, clientScanId: x.read.clientScanId, roundId: x.ja.roundId } });
      desfeitas++; tocados.add(x.ja.productSizeId);
    } else {
      await applyStoreStockDelta(tx, { storeId: lot.toStoreId, productSizeId: x.read.productSizeId, quantity: 1, type: 'receipt', source: SOURCE,
        reason: x.anterior ? 'Recebimento anterior à contagem nova, ainda não contado (validado; dono 18/11)' : 'Recebimento bipado (entra automático no estoque da loja)',
        metadata: { lotId, clientScanId: x.read.clientScanId, scannedAt: new Date(x.read.scannedAt).toISOString(), roundId: round.id, ...(x.anterior ? { anteriorAContagem: true } : {}) } });
      aplicadas++; tocados.add(x.read.productSizeId);
    }
  }
  if (round && round.open) {
    for (const ps of [...tocados].sort()) await baixarVendasArquivadas(tx, lot.toStoreId, ps, round);
    for (const ps of [...tocados].sort()) await parear(tx, lot.toStoreId, ps, round);
  }
  return { aplicadas, desfeitas };
}

// Leituras de recebimento ativas (net>0) da loja/tamanho, desde o início da rodada, em ordem de horário.
async function recebimentosAtivos(tx, storeId, productSizeId, round) {
  const rows = await tx.$queryRawUnsafe(
    'SELECT metadata->>\'clientScanId\' AS cs, MIN(metadata->>\'scannedAt\') AS em, SUM(quantity)::int AS net FROM "StoreStockMovement" ' +
    'WHERE source IN ' + SRC_SQL + ' AND "storeId" = $1 AND "productSizeId" = $2 GROUP BY 1 HAVING MAX(metadata->>\'roundId\') = $3', storeId, productSizeId, round.id);
  // todas as entradas desta contagem (o HAVING já prende ao roundId), inclusive recebimento ANTERIOR
  // validado: se a contagem bipar a peça depois, ela pareia com ele e não soma em dobro.
  return rows.filter((r) => r.net > 0 && r.em)
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
    'SELECT "productSizeId" AS ps, SUM(quantity)::int AS net FROM "StoreStockMovement" WHERE source IN ' + SRC_SQL + ' AND "storeId" = $1 AND metadata->>\'clientScanId\' = ANY($2::text[]) GROUP BY 1',
    storeId, ids);
  for (const r of rows) if (r.net > 0) out.set(r.ps, r.net);
  return out;
}

// Varredura: aplica todos os lotes de recebimento (inclui leituras que ganharam tamanho depois).
async function aplicarTodos(db, { limite = 500 } = {}) {
  // só lote aberto (ou arquivado há pouco, para desfazer); confirmado pela remessa não se mexe
  const lots = await db.scanActionLot.findMany({ where: { mode: 'receipt', OR: [{ status: 'open' }, { status: 'archived', updatedAt: { gte: new Date(Date.now() - 3 * 86400e3) } }] },
    select: { sessionId: true }, orderBy: { updatedAt: 'desc' }, take: limite });
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
  // índices parciais para as buscas por lote/leitura (só as linhas do recebimento automático)
  const indices = async () => {
    for (const sql of [
      'CREATE INDEX CONCURRENTLY IF NOT EXISTS "StoreStockMovement_recebimento_lote_idx" ON "StoreStockMovement" ((metadata->>\'lotId\')) WHERE source IN ' + SRC_SQL,
      'CREATE INDEX CONCURRENTLY IF NOT EXISTS "StoreStockMovement_recebimento_leitura_idx" ON "StoreStockMovement" ((metadata->>\'clientScanId\')) WHERE source IN ' + SRC_SQL,
    ]) { try { await db.$executeRawUnsafe(sql); } catch (e) { console.warn('[recebimento automático] índice:', e.message); } }
  };
  indices();
  const rodar = () => aplicarTodos(db).then((r) => { state.lastRunAt = new Date().toISOString(); state.lastResult = r; state.lastError = null; if (r.aplicadas || r.desfeitas) console.log('[recebimento automático]', JSON.stringify(r)); })
    .catch((e) => { state.lastError = e.message; console.warn('[recebimento automático] falhou:', e.message); });
  setTimeout(rodar, 90 * 1000);
  setInterval(rodar, 10 * 60 * 1000);
  console.log('[recebimento automático] ligado: cada recebimento bipado entra no estoque da loja (varredura a cada 10 min + na hora do bipe)');
}
function estadoRecebimentoAutomatico() { return JSON.parse(JSON.stringify(state)); }

module.exports = { desde, anteriorDesde, familiaDaCategoria, podeEntrarAnterior, baixarVendasArquivadas, SOURCE_VENDAS, deveSair, SOURCE, SOURCE_REVERSE, SOURCE_PAIR, SOURCE_UNPAIR, aplicarLote, parear, antesDeExcluirBipe, jaEntrouPorTamanho, jaEntrouPorLeituras, aplicarTodos, iniciarRecebimentoAutomatico, estadoRecebimentoAutomatico, deveEntrar, replacementRound };
