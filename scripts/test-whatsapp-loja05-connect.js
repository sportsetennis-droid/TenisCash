const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const archive = require('../src/services/whatsappStoreArchive');
const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jgXYAAAAASUVORK5CYII=';

function setup({ operator = { role: 'superadmin', active: true }, replies = [], configured = true, timeout = false } = {}) {
  const routes = {}, middleware = [], calls = [], timers = [], cleared = [], userReads = [];
  const auth = () => {}, admin = () => {};
  const router = {
    use(...items) { middleware.push(...items); },
    get(route, ...handlers) { routes['GET ' + route] = handlers.at(-1); },
    post(route, ...handlers) { routes['POST ' + route] = handlers.at(-1); },
  };
  const module = { exports: {} };
  const dependencies = {
    express: { Router: () => router },
    '../middleware': {
      authMiddleware: auth, adminMiddleware: admin,
      prisma: { user: { async findUnique(query) { userReads.push(query); return operator; } } },
    },
    '../whatsapp': { sendEvolutionRaw() { throw new Error('No WhatsApp sends permitted'); } },
    '../services/whatsappStoreArchive': archive,
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../src/routes/adminWhatsapp.js'), 'utf8'), {
    module, exports: module.exports, Buffer, AbortController,
    process: { env: configured ? { EVOLUTION_API_URL: 'https://provider.test', EVOLUTION_API_KEY: 'secret-test-key' } : {} },
    require(name) { if (dependencies[name]) return dependencies[name]; throw new Error('Unexpected dependency ' + name); },
    setTimeout(fn, ms) { timers.push(ms); if (timeout) fn(); return timers.length; },
    clearTimeout(id) { cleared.push(id); },
    async fetch(url, options) {
      calls.push({ url, options });
      if (options.signal.aborted) throw new Error('provider secret-test-key timeout');
      const reply = replies.shift();
      if (reply instanceof Error) throw reply;
      if (!reply) throw new Error('Unexpected provider call ' + url);
      return { ok: reply.ok !== false, async json() { return reply.body; } };
    },
  });
  assert.deepEqual(middleware, [auth, admin], 'route inherits authentication and admin middleware');
  const run = async (request = {}) => {
    const response = { statusCode: 200, headers: {}, set(k, v) { this.headers[k] = v; return this; }, status(n) { this.statusCode = n; return this; }, json(value) { this.body = value; return this; } };
    await routes['POST /loja05/connect']({ userId: 'owner-test', userRole: 'superadmin', body: {}, ...request }, response);
    assert.equal(response.headers['Cache-Control'], 'no-store');
    assert.doesNotMatch(JSON.stringify(response.body), /secret-test-key|provider\.test/);
    return response;
  };
  return { run, calls, timers, cleared, userReads };
}

async function main() {
  const unauth = setup();
  assert.equal((await unauth.run({ userId: undefined })).statusCode, 401);
  assert.equal(unauth.calls.length, 0);
  for (const operator of [{ role: 'admin', active: true }, { role: 'manager', active: true }, { role: 'superadmin', active: false }, null]) {
    const denied = setup({ operator });
    assert.equal((await denied.run()).statusCode, 403, 'fresh database role overrides stale token role');
    assert.equal(denied.calls.length, 0);
  }
  const current = setup({ replies: [{ body: { instance: { state: 'open' } } }] });
  const connected = await current.run();
  assert.equal(connected.statusCode, 200);
  assert.equal(connected.body.state, 'open');
  assert.equal(connected.body.qr, null);
  assert.equal(current.calls.length, 1, 'an open session must not generate another QR');
  assert.equal(current.calls[0].url, 'https://provider.test/instance/connectionState/tambau');
  assert.equal(current.userReads[0].where.id, 'owner-test');
  assert.equal(current.userReads[0].select.role, true);
  assert.equal(current.userReads[0].select.active, true);
  assert.deepEqual(current.timers, [20000]);
  assert.deepEqual(current.cleared, [1]);

  const qrTest = setup({ replies: [
    { body: { instance: { state: 'close' } } },
    { body: { base64: 'data:image/png;base64,' + png, apikey: 'secret-test-key' } },
  ] });
  const generated = await qrTest.run({ body: { instance: 'metafardamentos', number: 'arbitrary' }, query: { instance: 'baratao' } });
  assert.equal(generated.statusCode, 200);
  assert.equal(generated.body.instance, 'tambau');
  assert.equal(generated.body.storeCode, 'LOJA05');
  assert.equal(generated.body.state, 'connecting');
  assert.equal(generated.body.qr, 'data:image/png;base64,' + png);
  assert.equal(new Date(generated.body.generatedAt).toISOString(), generated.body.generatedAt);
  assert.deepEqual(qrTest.calls.map(call => call.url), [
    'https://provider.test/instance/connectionState/tambau',
    'https://provider.test/instance/connect/tambau',
  ]);
  assert.ok(qrTest.calls.every(call => call.options.method === 'GET'));
  assert.ok(qrTest.calls.every(call => !call.options.body));
  assert.equal(qrTest.calls[0].options.signal, qrTest.calls[1].options.signal, 'one timeout bounds both provider calls');

  for (const invalid of ['invalid', 'data:image/svg+xml;base64,' + png, Buffer.from('not a PNG').toString('base64'), null]) {
    const bad = setup({ replies: [{ body: { state: 'close' } }, { body: { base64: invalid } }] });
    assert.equal((await bad.run()).statusCode, 502, 'invalid provider PNG is rejected');
  }
  for (const reply of [{ ok: false, body: { error: 'secret-test-key' } }, new Error('provider secret-test-key')]) {
    const fail = setup({ replies: [reply] });
    assert.equal((await fail.run()).statusCode, 502);
    assert.equal(fail.calls.length, 1);
    assert.deepEqual(fail.cleared, [1]);
  }
  const expiry = setup({ timeout: true });
  assert.equal((await expiry.run()).statusCode, 502);
  assert.deepEqual(expiry.cleared, [1]);
  const missing = setup({ configured: false });
  assert.equal((await missing.run()).statusCode, 503);
  assert.equal(missing.calls.length, 0);
  console.log('PASS Loja 05 QR: owner authorization, fixed instance, no reconnect when open, PNG validation, bounded timeout, generic errors and no messages');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
