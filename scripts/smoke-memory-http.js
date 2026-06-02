// =====================================================================
// smoke-memory-http.js
// Testa a Memória da Empresa POR HTTP, com a stack REAL:
// authMiddleware + adminMiddleware + router real + memory.service + banco real.
// Monta só o router (não sobe index.js, pra não acordar cron/jobs).
//
// Lê os fatos JÁ seedados em produção (não cria fato fixo de teste).
// O que cria (1 nota de teste) é APAGADO no fim — não deixa lixo.
//
// Uso: node scripts/smoke-memory-http.js
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

const http = require('http');
const express = require('express');
const jwt = require('jsonwebtoken');
const { prisma } = require('../src/middleware');
const router = require('../src/ai/orchestrator/orchestrator.routes');

const JWT_SECRET = process.env.JWT_SECRET || 'teniscash-secret-change-in-production';

function req(port, method, p, token, payload) {
  return new Promise((resolve) => {
    const body = payload ? JSON.stringify(payload) : null;
    const headers = { Authorization: 'Bearer ' + token };
    if (body) { headers['Content-Type'] = 'application/json'; headers['Content-Length'] = Buffer.byteLength(body); }
    const r = http.request({ host: '127.0.0.1', port, path: p, method, headers }, (res) => {
      let d = ''; res.on('data', (c) => (d += c));
      res.on('end', () => { let j; try { j = JSON.parse(d); } catch (_) { j = d; } resolve({ status: res.statusCode, body: j }); });
    });
    r.on('error', (e) => resolve({ status: 0, body: { error: e.message } }));
    if (body) r.write(body);
    r.end();
  });
}
const get = (port, p, t) => req(port, 'GET', p, t, null);
const post = (port, p, t, b) => req(port, 'POST', p, t, b);
const del = (port, p, t) => req(port, 'DELETE', p, t, null);

(async () => {
  const app = express();
  app.use(express.json());
  app.use('/api/admin/ai', router);
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  const port = server.address().port;
  console.log('Servidor de teste em 127.0.0.1:' + port);

  const admin = jwt.sign({ userId: 'smoke-admin', role: 'admin' }, JWT_SECRET, { expiresIn: '5m' });
  const customer = jwt.sign({ userId: 'smoke-user', role: 'customer' }, JWT_SECRET, { expiresIn: '5m' });

  let pass = 0, fail = 0;
  const check = (label, cond, detail) => { if (cond) { pass++; console.log('✅', label); } else { fail++; console.log('❌', label, detail ? '→ ' + detail : ''); } };

  // auth gate
  check('GET stats sem token → 401', (await get(port, '/api/admin/ai/memory/stats', '')).status === 401);
  check('GET stats role customer → 403', (await get(port, '/api/admin/ai/memory/stats', customer)).status === 403);

  // stats (lê os 22 fatos seedados)
  let r = await get(port, '/api/admin/ai/memory/stats', admin);
  check('GET stats admin → 200', r.status === 200, 'status ' + r.status);
  check('stats.facts >= 22 (seed carregado)', r.body && r.body.facts >= 22, 'facts=' + (r.body && r.body.facts));
  check('stats.byCategory tem loja/regra/marca', r.body && r.body.byCategory && ['loja', 'regra', 'marca'].every((c) => r.body.byCategory.some((x) => x.category === c)), JSON.stringify(r.body && r.body.byCategory));

  // brain (texto pronto pro prompt da IA)
  r = await get(port, '/api/admin/ai/memory/brain', admin);
  check('GET brain admin → 200', r.status === 200, 'status ' + r.status);
  check('brain.promptText inclui fato fundador', r.body && typeof r.body.promptText === 'string' && r.body.promptText.includes('Sports & Tennis é uma rede'), null);
  check('brain.factCount >= 22', r.body && r.body.factCount >= 22, 'factCount=' + (r.body && r.body.factCount));

  // timeline
  r = await get(port, '/api/admin/ai/memory/timeline?days=3650&limit=500', admin);
  check('GET timeline admin → 200 + items[]', r.status === 200 && Array.isArray(r.body.items), 'status ' + r.status);

  // note write → delete (não deixa lixo)
  const TAG = '__SMOKE__' + Date.now();
  r = await post(port, '/api/admin/ai/memory/note', admin, { title: TAG + ' anotação de teste', detail: 'apagar' });
  const noteId = r.body && r.body.memory && r.body.memory.id;
  check('POST note → 200 + id', r.status === 200 && !!noteId, JSON.stringify(r.body).slice(0, 120));
  check('validação: POST note sem title → 400', (await post(port, '/api/admin/ai/memory/note', admin, { detail: 'sem titulo' })).status === 400);
  if (noteId) check('DELETE note → 200', (await del(port, '/api/admin/ai/memory/' + noteId, admin)).status === 200);

  // limpeza de qualquer resíduo de smoke
  const leftover = await prisma.companyMemory.deleteMany({ where: { title: { contains: '__SMOKE__' } } });
  console.log(`\n🧹 limpeza: ${leftover.count} item(ns) de smoke removido(s).`);

  console.log(`${'─'.repeat(56)}\n${pass} passou, ${fail} falhou`);
  server.close();
  await prisma.$disconnect();
  process.exit(fail === 0 ? 0 : 1);
})().catch(async (e) => { console.error('erro fatal:', e); try { await prisma.$disconnect(); } catch (_) {} process.exit(1); });
