// =====================================================================
// smoke-command-center-http.js
// Testa o Centro de Comando POR HTTP, com a stack REAL:
// authMiddleware + adminMiddleware + router real + serviço + banco real.
// Não sobe o index.js inteiro (evita acordar cron/jobs) — monta só o router.
//
// Uso: node scripts/smoke-command-center-http.js
// =====================================================================

const fs = require('fs');
const path = require('path');

// ---- .env minimalista ----
(function loadEnv() {
  const envPath = path.join(__dirname, '..', '.env');
  if (!fs.existsSync(envPath)) return;
  for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const eq = t.indexOf('=');
    if (eq === -1) continue;
    const k = t.slice(0, eq).trim();
    let v = t.slice(eq + 1).trim();
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

function get(port, p, token) {
  return new Promise((resolve) => {
    const req = http.request({ host: '127.0.0.1', port, path: p, method: 'GET', headers: { Authorization: 'Bearer ' + token } }, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => { let j; try { j = JSON.parse(data); } catch (_) { j = data; } resolve({ status: res.statusCode, body: j }); });
    });
    req.on('error', (e) => resolve({ status: 0, body: { error: e.message } }));
    req.end();
  });
}
function post(port, p, token, payload) {
  return new Promise((resolve) => {
    const body = JSON.stringify(payload || {});
    const req = http.request({ host: '127.0.0.1', port, path: p, method: 'POST', headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } }, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => { let j; try { j = JSON.parse(data); } catch (_) { j = data; } resolve({ status: res.statusCode, body: j }); });
    });
    req.on('error', (e) => resolve({ status: 0, body: { error: e.message } }));
    req.write(body); req.end();
  });
}

(async () => {
  const app = express();
  app.use(express.json());
  app.use('/api/admin/ai', router);
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  const port = server.address().port;
  console.log('Servidor de teste em 127.0.0.1:' + port);

  const adminToken = jwt.sign({ userId: 'smoke-admin', role: 'admin' }, JWT_SECRET, { expiresIn: '5m' });
  const noToken = '';
  const badToken = jwt.sign({ userId: 'smoke-user', role: 'customer' }, JWT_SECRET, { expiresIn: '5m' });

  let pass = 0, fail = 0;
  const check = (label, cond, detail) => {
    if (cond) { pass++; console.log(`✅ ${label}`); }
    else { fail++; console.log(`❌ ${label}` + (detail ? ` → ${detail}` : '')); }
  };

  // 1) sem token → 401
  let r = await get(port, '/api/admin/ai/command-center/briefing', noToken);
  check('GET briefing sem token → 401', r.status === 401, `status ${r.status}`);

  // 2) token não-admin → 403
  r = await get(port, '/api/admin/ai/command-center/briefing', badToken);
  check('GET briefing com role customer → 403', r.status === 403, `status ${r.status}`);

  // 3) briefing admin → 200 + shape
  r = await get(port, '/api/admin/ai/command-center/briefing', adminToken);
  check('GET briefing admin → 200', r.status === 200, `status ${r.status}`);
  check('briefing tem status/summaryText/alerts', r.body && r.body.status && typeof r.body.summaryText === 'string' && Array.isArray(r.body.alerts), JSON.stringify(r.body).slice(0, 120));

  // 4) cost
  r = await get(port, '/api/admin/ai/command-center/cost?days=30', adminToken);
  check('GET cost → 200 + byAgent[]', r.status === 200 && Array.isArray(r.body.byAgent), `status ${r.status}`);
  check('cost tem cap + monthPct/dayPct', r.body && r.body.cap && typeof r.body.monthPct === 'number', JSON.stringify(r.body && r.body.cap));

  // 5) activity
  r = await get(port, '/api/admin/ai/command-center/activity?days=30', adminToken);
  check('GET activity → 200 + orchestrations', r.status === 200 && r.body.orchestrations, `status ${r.status}`);

  // 6) scorecard
  r = await get(port, '/api/admin/ai/command-center/scorecard?days=30', adminToken);
  check('GET scorecard → 200 + agents[]', r.status === 200 && Array.isArray(r.body.agents), `status ${r.status}`);

  // 7) approvals
  r = await get(port, '/api/admin/ai/command-center/approvals?days=30', adminToken);
  check('GET approvals → 200 + byStatus', r.status === 200 && r.body.byStatus, `status ${r.status}`);

  // 8) cap GET
  r = await get(port, '/api/admin/ai/command-center/cap', adminToken);
  const capBefore = r.body;
  check('GET cap → 200 + monthlyBRL/dailyBRL', r.status === 200 && typeof r.body.monthlyBRL === 'number' && typeof r.body.dailyBRL === 'number', JSON.stringify(r.body));

  // 9) cap POST (read-modify-restore — não deixa lixo)
  const probeDaily = (capBefore.dailyBRL || 30) + 1;
  r = await post(port, '/api/admin/ai/command-center/cap', adminToken, { dailyBRL: probeDaily, monthlyBRL: capBefore.monthlyBRL });
  check('POST cap → 200 + persistiu dailyBRL', r.status === 200 && r.body.dailyBRL === probeDaily, JSON.stringify(r.body));
  // restaura
  await post(port, '/api/admin/ai/command-center/cap', adminToken, { dailyBRL: capBefore.dailyBRL, monthlyBRL: capBefore.monthlyBRL });
  // se o cap era 'env' (sem arquivo), remove o cap.json criado pelo probe pra não virar lixo commitado
  if (capBefore.source === 'env') {
    const capFile = path.join(__dirname, '..', 'src', 'ai', 'command-center', 'cap.json');
    if (fs.existsSync(capFile)) { fs.unlinkSync(capFile); console.log('   (cap.json de teste removido — cap volta a vir do env)'); }
  }

  console.log(`\n${'─'.repeat(60)}\nRESULTADO: ${pass} passou, ${fail} falhou`);
  server.close();
  await prisma.$disconnect();
  process.exit(fail === 0 ? 0 : 1);
})().catch(async (e) => { console.error('erro fatal:', e); try { await prisma.$disconnect(); } catch (_) {} process.exit(1); });
