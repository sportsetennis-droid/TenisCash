const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.resolve(__dirname, '..');
const archive = require('../src/services/whatsappStoreArchive');

function load(relative, dependencies) {
  const module = { exports: {} };
  const source = fs.readFileSync(path.join(root, relative), 'utf8');
  vm.runInNewContext(source, {
    module, exports: module.exports, Buffer, process: { env: {} },
    console: { log() {}, warn() {}, error() {} },
    require(name) {
      if (Object.hasOwn(dependencies, name)) return dependencies[name];
      if (name === 'crypto') return require('node:crypto');
      throw new Error('Unexpected dependency: ' + name);
    },
  }, { filename: relative });
  return module.exports;
}

function routerStub() {
  const routes = {}, middleware = [];
  return { routes, middleware, use(...items) { middleware.push(...items); },
    get(route, ...handlers) { routes['GET ' + route] = handlers.at(-1); },
    post(route, ...handlers) { routes['POST ' + route] = handlers.at(-1); },
  };
}
function response() {
  return { statusCode: 200, headers: {}, status(n) { this.statusCode = n; return this; },
    set(k, v) { this.headers[k] = v; return this; }, json(data) { this.body = data; return this; } };
}

async function main() {
  const captured = new Map();
  let creates = 0, sends = 0, attendants = 0, specialized = 0;
  const inbox = load('src/services/whatsappInbox.js', {
    '../middleware': { prisma: { whatsappMessage: {
      async upsert(args) {
        const key = args.where.instance_messageId;
        const id = key.instance + ':' + key.messageId;
        if (!captured.has(id)) { captured.set(id, args.create); creates++; }
      },
      async create(args) { captured.set('no-id:' + creates++, args.data); },
    } } }, './whatsappStoreArchive': archive,
  });
  const web = routerStub();
  load('src/routes/whatsapp.js', {
    express: { Router: () => web },
    '../middleware': { authMiddleware() {}, adminMiddleware() {} },
    '../whatsapp': {
      async sendCustomMessage() { sends++; return { ok: true }; },
      async sendEvolutionRaw() { sends++; return { ok: true }; },
      isMetaWhatsAppConfigured: () => false, isEvolutionConfigured: () => true,
      formatPhoneBR: value => value,
    },
    '../services/aiAttendant': {
      isEnabled: () => true,
      async getAttendantReply() { attendants++; return { ok: true, reply: 'reply' }; },
    },
    '../services/metaFardamentosAttendant': { INSTANCE: 'metafardamentos', async handleMetaWebhook() { specialized++; } },
    '../services/barataoAttendant': { INSTANCE: 'baratao', async handleBarataoWebhook() { specialized++; } },
    '../services/metaApsAttendant': { INSTANCE: 'metaaps', async handleMetaApsWebhook() { specialized++; } },
    '../services/whatsappInbox': inbox,
    '../services/whatsappStoreArchive': archive,
  });
  const event = (id, options = {}) => ({
    key: { id, remoteJid: '558300000000@s.whatsapp.net', fromMe: false },
    messageTimestamp: 1700000000, pushName: 'Contato de teste',
    message: { conversation: 'mensagem de teste' }, ...options,
  });
  const hit = async (instance, eventType, data) => web.routes['POST /evolution']({ body: { instance, event: eventType, data } }, response());
  await hit('tambau', 'messages.upsert', event('m1'));
  await hit('tambau', 'MESSAGES_UPSERT', event('m1'));
  await hit('tambau', 'MESSAGES_SET', { messages: [event('m1'), event('m2', { key: { id: 'm2', remoteJid: '558300000000@s.whatsapp.net', fromMe: true } })] });
  await hit('tambau', 'messages.set', [event('m3', { message: { imageMessage: { caption: 'legenda' } } })]);
  await hit('tambau', 'connection.update', event('ignored'));
  assert.equal(creates, 3, 'history and repeated delivery share the same dedup key');
  assert.equal(captured.get('tambau:m2').fromMe, true, 'outgoing history is archived');
  assert.equal(captured.get('tambau:m3').msgType, 'image');
  assert.equal(sends, 0, 'Loja 05 must never send automatic replies');
  assert.equal(attendants, 0, 'Loja 05 must never invoke the AI');
  assert.equal(specialized, 0, 'Loja 05 must never invoke another company attendant');
  await hit('teniscash', 'MESSAGES_SET', { messages: [event('other-history')] });
  assert.equal(creates, 3, 'history behavior of other instances is unchanged');
  await hit('teniscash', 'messages.upsert', event('other-new'));
  assert.equal(attendants, 1, 'existing S&T new-message handler remains active');
  assert.equal(sends, 1);
  await hit('metafardamentos', 'messages.upsert', event('meta-new'));
  assert.equal(specialized, 1, 'existing company routing remains unchanged');

  const auth = () => {}, admin = () => {}, adminRouter = routerStub();
  const inserted = Array.from({ length: 204 }, (_, i) => ({
    id: 'm' + String(i).padStart(5, '0'), instance: 'tambau',
    createdAt: new Date('2026-09-19T12:00:00.000Z'), ts: new Date('2026-01-01T00:00:00.000Z'),
    text: 'test ' + i,
  }));
  let query, crmLookups = 0;
  load('src/routes/adminWhatsapp.js', {
    express: { Router: () => adminRouter },
    '../middleware': { authMiddleware: auth, adminMiddleware: admin, prisma: { whatsappMessage: {
      async findMany(args) {
        query = args;
        assert.equal(args.where.instance, 'tambau');
        assert.equal(JSON.stringify(args.orderBy), JSON.stringify([{ createdAt: 'asc' }, { id: 'asc' }]));
        assert.equal(args.select.createdAt, true);
        const or = args.where.OR;
        return inserted.filter(row => !or || row.createdAt > or[0].createdAt.gt ||
          (+row.createdAt === +or[1].createdAt && row.id > or[1].id.gt)).slice(0, args.take);
      },
    },
      async $queryRaw() { return [{ chatJid: '558300000000@s.whatsapp.net', phone: '558300000000', isGroup: false, ts: new Date(), text: 'test' }]; },
      mfCustomer: { async findMany() { crmLookups++; return [{ id: 'mf-test', phone: '558300000000', name: 'Outra empresa' }]; } },
    } },
    '../whatsapp': { sendEvolutionRaw() { throw new Error('No sends during export'); } },
    '../services/whatsappStoreArchive': archive,
  });
  assert.deepEqual(adminRouter.middleware, [auth, admin], 'archive remains admin authenticated');
  const lojaChats = response();
  await adminRouter.routes['GET /chats']({ query: { instance: 'tambau' } }, lojaChats);
  assert.equal(crmLookups, 0, 'Loja 05 must not query Meta Fardamentos CRM');
  assert.equal(lojaChats.body.chats[0].crmId, undefined);
  await adminRouter.routes['GET /chats']({ query: { instance: 'metafardamentos' } }, response());
  assert.equal(crmLookups, 1, 'existing Meta Fardamentos CRM enrichment remains unchanged');
  const read = async (args) => {
    const res = response();
    await adminRouter.routes['GET /archive']({ query: args }, res);
    return res;
  };
  const p1 = await read({ instance: 'tambau', limit: '200' });
  assert.equal(p1.statusCode, 200);
  assert.equal(p1.headers['Cache-Control'], 'no-store');
  assert.equal(p1.body.messages.length, 200);
  assert.equal(p1.body.hasMore, true);
  assert.equal(p1.body.storeId, archive.STORE_ARCHIVE.storeId);
  assert.equal(query.take, 201);
  const p2 = await read({ instance: 'tambau', after: p1.body.nextCursor, limit: '200' });
  assert.equal(p2.body.messages.length, 4, 'equal insertion times use ID as tiebreaker');
  assert.equal(p2.body.hasMore, false);
  inserted.push({ id: 'late-history', instance: 'tambau', createdAt: new Date('2026-09-19T13:00:00.000Z'), ts: new Date('2020-01-01T00:00:00.000Z') });
  const p3 = await read({ instance: 'tambau', after: p2.body.nextCursor });
  assert.equal(p3.body.messages[0].id, 'late-history', 'late history is exported despite an old message timestamp');
  const empty = await read({ instance: 'tambau', after: p3.body.nextCursor });
  assert.equal(empty.body.messages.length, 0);
  assert.equal(empty.body.nextCursor, p3.body.nextCursor, 'an empty poll must not reset the checkpoint');
  assert.equal((await read({ instance: 'metafardamentos' })).statusCode, 400, 'export cannot cross companies');
  assert.equal((await read({ instance: 'tambau', after: 'garbage' })).statusCode, 400);
  assert.equal((await read({ instance: 'tambau', limit: '1001' })).statusCode, 400);
  const foreignCursor = Buffer.from(JSON.stringify({ v: 1, instance: 'metafardamentos', createdAt: new Date().toISOString(), id: 'm1' })).toString('base64url');
  assert.equal((await read({ instance: 'tambau', after: foreignCursor })).statusCode, 400);
  console.log('PASS Loja 05: passive capture, history, dedup, company isolation, unchanged attendants, incremental export and cursor validation');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
