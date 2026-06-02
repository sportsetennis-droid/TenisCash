// =====================================================================
// verify-memory.js — valida a Memória da Empresa contra o BANCO REAL.
// Grava 3 itens de TESTE, lê de volta por stats/timeline/brain e APAGA
// tudo no fim (não deixa lixo na memória de produção).
//
// Uso: node scripts/verify-memory.js
// =====================================================================
const fs = require('fs');
const path = require('path');
(function loadEnv() {
  const p = path.join(__dirname, '..', '.env');
  if (!fs.existsSync(p)) return;
  for (const l of fs.readFileSync(p, 'utf8').split(/\r?\n/)) {
    const t = l.trim(); if (!t || t.startsWith('#')) continue;
    const e = t.indexOf('='); if (e < 0) continue;
    const k = t.slice(0, e).trim(); let v = t.slice(e + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    if (!(k in process.env)) process.env[k] = v;
  }
})();

const mem = require('../src/ai/memory/memory.service');
const { prisma } = require('../src/middleware');

const TAG = '__VERIFY__' + Date.now();
let pass = 0, fail = 0;
const ok = (label, cond, d) => { if (cond) { pass++; console.log('✅', label); } else { fail++; console.log('❌', label, d ? '→ ' + d : ''); } };

(async () => {
  const created = [];
  try {
    // grava 3 tipos
    const f = await mem.addFact({ category: 'empresa', title: TAG + ' Loja Parahyba Mall existe', detail: 'fato de teste', importance: 3 });
    const n = await mem.recordNote({ category: 'nota', title: TAG + ' anotação do dono', detail: 'nota de teste' });
    const e = await mem.recordEvent({ category: 'ia', title: TAG + ' evento de teste', source: 'system', importance: 2 });
    [f, n, e].forEach((x) => x && created.push(x.id));
    ok('addFact grava', !!f && f.kind === 'fact' && f.pinned === true, JSON.stringify(f && { kind: f.kind, pinned: f.pinned }));
    ok('recordNote grava', !!n && n.kind === 'event', n && n.kind);
    ok('recordEvent grava', !!e && e.kind === 'event', e && e.kind);

    // stats enxerga
    const stats = await mem.getStats();
    ok('getStats conta total >= 3', stats.total >= 3, 'total=' + stats.total);
    ok('getStats separa fatos/eventos', stats.facts >= 1 && stats.events >= 2, `facts=${stats.facts} events=${stats.events}`);

    // timeline acha os de teste
    const tl = await mem.getTimeline({ days: 1, limit: 200 });
    const mine = tl.filter((x) => x.title.includes(TAG));
    ok('getTimeline devolve os 3 de teste', mine.length === 3, 'achou=' + mine.length);

    // brain carrega o fato fixado
    const brain = await mem.getBrain({ maxEvents: 50, eventDays: 1 });
    ok('getBrain inclui o fato no promptText', brain.promptText.includes(TAG + ' Loja Parahyba Mall'), null);
    ok('getBrain tem factCount/eventCount', typeof brain.factCount === 'number' && typeof brain.eventCount === 'number', `f=${brain.factCount} e=${brain.eventCount}`);

    // delete funciona
    const delOk = await mem.deleteMemory(created[0]);
    ok('deleteMemory apaga', delOk === true, null);
  } catch (err) {
    fail++; console.log('❌ exceção:', err.message); console.log(err.stack);
  } finally {
    // limpeza: remove QUALQUER item de teste que tenha sobrado
    const leftover = await prisma.companyMemory.deleteMany({ where: { title: { contains: '__VERIFY__' } } });
    console.log(`\n🧹 limpeza: ${leftover.count} item(ns) de teste removido(s).`);
  }

  console.log(`${'─'.repeat(56)}\n${pass} passou, ${fail} falhou`);
  await prisma.$disconnect();
  process.exit(fail === 0 ? 0 : 1);
})().catch(async (e) => { console.error('fatal:', e); try { await prisma.$disconnect(); } catch (_) {} process.exit(1); });
