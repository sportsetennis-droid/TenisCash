'use strict';
// Robô de matching de figurinhas Copa 2026
// Varre todas as coleções, encontra parceiros ideais e avisa no WhatsApp

const { PrismaClient } = require('@prisma/client');
const { sendEvolutionText } = require('../whatsapp');

const prisma = new PrismaClient();

async function findBestMatches(collectionId, limit = 5) {
  const me = await prisma.stickerCollection.findUnique({
    where: { id: collectionId },
    include: { stickers: { select: { stickerId: true, quantity: true } } },
  });
  if (!me) return { matches: [], me: null };

  const myMap = Object.fromEntries(me.stickers.map(s => [s.stickerId, s.quantity]));

  const allStickers = await prisma.sticker.findMany({ select: { id: true } });
  const myMissing = new Set(allStickers.filter(s => (myMap[s.id] || 0) === 0).map(s => s.id));
  const myDups    = new Set(allStickers.filter(s => (myMap[s.id] || 0) >= 2).map(s => s.id));

  if (!myMissing.size) return { matches: [], me, complete: true };

  const others = await prisma.stickerCollection.findMany({
    where: { id: { not: collectionId } },
    include: { stickers: { select: { stickerId: true, quantity: true } } },
  });

  const scored = others.map(other => {
    const theirMap = Object.fromEntries(other.stickers.map(s => [s.stickerId, s.quantity]));
    const theyCanGiveMe = [...myMissing].filter(sid => (theirMap[sid] || 0) >= 2).length;
    const iCanGiveThem  = [...myDups].filter(sid  => (theirMap[sid] || 0) === 0).length;
    return { collection: other, theyCanGiveMe, iCanGiveThem, score: theyCanGiveMe * 3 + iCanGiveThem };
  })
  .filter(m => m.theyCanGiveMe > 0)
  .sort((a, b) => b.score - a.score)
  .slice(0, limit);

  return { matches: scored, me, missing: myMissing.size, dups: myDups.size };
}

function buildMessage(me, matches, missing) {
  const NUMS = ['1️⃣','2️⃣','3️⃣','4️⃣','5️⃣'];
  const lines = [
    `⚽ *Figurinhas Copa 2026 — Achei parceiros pra você!*`,
    ``,
    `Oi ${me.name}! 👋`,
    `Varri todas as coleções cadastradas e encontrei ${matches.length} pessoa${matches.length > 1 ? 's' : ''} que tem${matches.length > 1 ? 'têm' : ''} figurinhas que você precisa:`,
    ``,
  ];

  for (let i = 0; i < matches.length; i++) {
    const m = matches[i];
    const loc = [m.collection.neighborhood, m.collection.city].filter(Boolean).join(', ') || '';
    lines.push(`${NUMS[i]} *${m.collection.name}*${loc ? ` — ${loc}` : ''}`);
    lines.push(`   🟢 Pode te dar: *${m.theyCanGiveMe} figurinhas* que faltam`);
    if (m.iCanGiveThem > 0) lines.push(`   🔄 Você pode dar pra ele: ${m.iCanGiveThem} figurinhas`);
    lines.push(`   📲 wa.me/55${m.collection.whatsapp}`);
    lines.push('');
  }

  lines.push(`Você ainda precisa de *${missing} figurinhas* no total.`);
  lines.push(`👉 Cruce as coleções agora: teniscash.com.br/copa-figurinhas?t=${me.token}`);

  return lines.join('\n');
}

async function runForCollection(collectionId) {
  try {
    const { matches, me, missing, complete } = await findBestMatches(collectionId);

    if (!me) return { ok: false, reason: 'collection_not_found' };
    if (complete) return { ok: true, reason: 'album_complete', matched: 0 };
    if (!me.whatsapp) return { ok: false, reason: 'no_whatsapp' };
    if (!matches.length) return { ok: true, reason: 'no_matches_yet', matched: 0 };

    const msg = buildMessage(me, matches, missing);
    const result = await sendEvolutionText(me.whatsapp, msg);

    return { ok: result.ok, matched: matches.length, sent: result.ok, error: result.error };
  } catch (e) {
    console.error('[copaMatchBot] runForCollection error:', e.message);
    return { ok: false, error: e.message };
  }
}

async function runForAll() {
  console.log('[copaMatchBot] Iniciando rodada de matching...');
  // Só coleções ativas nos últimos 30 dias
  const cols = await prisma.stickerCollection.findMany({
    where: { updatedAt: { gte: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000) } },
    select: { id: true, name: true },
  });

  console.log(`[copaMatchBot] ${cols.length} coleções ativas para processar`);
  let sent = 0, noMatch = 0;

  for (const col of cols) {
    const r = await runForCollection(col.id);
    if (r.sent) sent++;
    else noMatch++;
    // Rate limit: 1 notificação/segundo
    await new Promise(res => setTimeout(res, 1200));
  }

  console.log(`[copaMatchBot] Concluído: ${sent} notificados, ${noMatch} sem match`);
  return { sent, noMatch, total: cols.length };
}

module.exports = { findBestMatches, runForCollection, runForAll };
