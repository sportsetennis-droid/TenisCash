const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

// Execute the production route body with real Express, bcrypt and JWT. Only
// persistence is replaced; these tests never contact a user or a live database.
const auth = fs.readFileSync(path.join(__dirname, '../src/routes/auth.js'), 'utf8');
const start = auth.indexOf("router.post('/login'");
const end = auth.indexOf('// PERFIL', start);
assert.ok(start >= 0 && end > start, 'Production login route must exist');
const source = auth.slice(start, end);
const secret = 'local-login-regression-test-only';
const password = '  Senha-Teste-42  ';
const hash = bcrypt.hashSync(password, 4);
const account = {
  id: 'seller-test', name: 'Vendedor Teste', role: 'seller', active: true,
  email: 'Vendedor.Teste@Example.COM', phone: '83999991234', pin: hash,
  storeId: 'store-test', store: { id: 'store-test', name: 'Loja Teste' },
  balance: 0, profileComplete: false, createdAt: '2026-09-14T12:00:00.000Z',
  partner: null,
};

// PostgreSQL ILIKE treats unescaped _ and % as wildcards. Model that behavior
// instead of JavaScript equality, so a missing query escape fails this test.
function matchesILike(value, pattern) {
  if (typeof value !== 'string') return false;
  let source = '^';
  const literal = char => char.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  for (let i = 0; i < pattern.length; i++) {
    const char = pattern[i];
    if (char === '\\') {
      assert.ok(i + 1 < pattern.length, 'ILIKE pattern must not end in an escape');
      source += literal(pattern[++i]);
    } else if (char === '%') source += '[\\s\\S]*';
    else if (char === '_') source += '[\\s\\S]';
    else source += literal(char);
  }
  return new RegExp(source + '$', 'iu').test(value);
}

async function request(body, users = [account], databaseError = null, forcedMatches = null) {
  const calls = { queries: [], comparisons: [], logs: [] };
  const recordQuery = (method, query) => {
    calls.queries.push({ method, query });
    if (databaseError) throw databaseError;
  };
  const prisma = { user: {
    findMany: async query => {
      recordQuery('findMany', query);
      assert.equal(query.where.email.mode, 'insensitive');
      assert.equal(query.take, 2, 'Duplicate detection needs at most two accounts');
      assert.ok(query.include.store.select.id);
      assert.ok(query.include.partner.select.id);
      return forcedMatches || users.filter(user => matchesILike(user.email, query.where.email.equals)).slice(0, query.take);
    },
    findUnique: async query => {
      recordQuery('findUnique', query);
      assert.ok(query.include.store.select.id);
      return users.find(user => user.phone === query.where.phone) || null;
    },
  } };
  const router = express.Router();
  vm.runInNewContext(source, {
    router, prisma, jwt, JWT_SECRET: secret,
    bcrypt: { compare: async (plain, stored) => {
      calls.comparisons.push({ plain, stored });
      return bcrypt.compare(plain, stored);
    } },
    console: {
      log: (...args) => calls.logs.push(args.join(' ')),
      error: (...args) => calls.logs.push(args.join(' ')),
    },
  });
  const route = router.stack.find(layer => layer.route?.path === '/login' && layer.route.methods.post);
  assert.ok(route, 'Real Express login route must be registered');
  let status = 200, result;
  const res = {
    status(value) { status = value; return this; },
    json(value) { result = value; return this; },
  };
  await route.route.stack[0].handle({ body }, res);
  assert.ok(result, 'Every login attempt must receive a JSON response');
  const logs = calls.logs.join('\n');
  for (const sensitive of [password, hash, account.email, account.phone, 'sensitive-database-detail']) {
    assert.ok(!logs.includes(sensitive), 'Login must not log credentials or personal identifiers');
    if (status !== 200) assert.ok(!JSON.stringify(result).includes(sensitive), 'Errors must not disclose credentials');
  }
  return { status, result, calls };
}

function authenticated(response, expected = account) {
  assert.equal(response.status, 200);
  assert.equal(response.result.user.id, expected.id);
  assert.equal(response.result.user.storeId, expected.storeId);
  assert.equal(response.result.user.store.id, expected.store.id);
  assert.equal(response.result.user.role, 'seller');
  assert.equal(response.result.user.profileComplete, false, 'Login must not require completion of a customer profile');
  assert.ok(!Object.hasOwn(response.result.user, 'pin'));
  assert.ok(!Object.hasOwn(response.result.user, 'password'));
  const claims = jwt.verify(response.result.token, secret);
  assert.equal(claims.userId, expected.id);
  assert.equal(claims.role, expected.role);
  assert.equal(claims.exp - claims.iat, 30 * 24 * 60 * 60);
  assert.equal(response.calls.comparisons.length, 1);
  assert.equal(response.calls.comparisons[0].plain, password, 'Password spaces and case must remain literal');
}

(async () => {
  for (const email of ['vendedor.teste@example.com', 'VENDEDOR.TESTE@EXAMPLE.COM', '  Vendedor.Teste@Example.COM  ']) {
    const response = await request({ email, password });
    authenticated(response);
    assert.equal(response.calls.queries.length, 1);
    assert.equal(response.calls.queries[0].query.where.email.equals, 'vendedor.teste@example.com');
  }
  for (const phone of ['83999991234', '(83) 99999-1234', ' 83 99999 1234 ']) {
    const response = await request({ phone, password });
    authenticated(response);
    assert.equal(response.calls.queries[0].method, 'findUnique');
    assert.equal(response.calls.queries[0].query.where.phone, account.phone);
  }
  authenticated(await request({ email: '  ', phone: account.phone, password }));

  // Similar addresses must not become duplicates, and wildcard input must not
  // authenticate a different address even if that account has the same password.
  for (const [email, similarEmail, escapedEmail] of [
    ['vendedor_teste@example.com', 'vendedorXteste@example.com', 'vendedor\\_teste@example.com'],
    ['vendedor%teste@example.com', 'vendedorOutroteste@example.com', 'vendedor\\%teste@example.com'],
    ['vendedor\\teste@example.com', 'vendedorteste@example.com', 'vendedor\\\\teste@example.com'],
  ]) {
    const exact = { ...account, email };
    const similar = { ...account, id: 'similar-address', email: similarEmail };
    const response = await request({ email: email.toUpperCase(), password }, [similar, exact]);
    authenticated(response, exact);
    assert.equal(response.calls.queries[0].query.where.email.equals, escapedEmail, 'ILIKE input must escape every literal metacharacter');
    const missingLiteral = await request({ email, password }, [similar]);
    assert.equal(missingLiteral.status, 401);
    assert.equal(missingLiteral.calls.comparisons.length, 0);
    assert.ok(!missingLiteral.result.token);
  }
  for (const email of ['different@example.com', null]) {
    const unexpectedMatch = await request({ email: account.email, password }, [], null, [{ ...account, email }]);
    assert.equal(unexpectedMatch.status, 401, 'Returned email must independently equal the requested address');
    assert.equal(unexpectedMatch.calls.comparisons.length, 0);
    assert.ok(!unexpectedMatch.result.token);
  }

  for (const login of [{ email: account.email }, { phone: account.phone }]) {
    for (const incorrectPassword of [password.trim(), password.toLowerCase(), 'wrong-password']) {
      const response = await request({ ...login, password: incorrectPassword });
      assert.equal(response.status, 401);
      assert.equal(response.result.error, 'Credenciais incorretas');
      assert.ok(!response.result.token);
    }
    const inactive = await request({ ...login, password }, [{ ...account, active: false }]);
    assert.equal(inactive.status, 403);
    assert.match(inactive.result.error, /Conta desativada/);
    assert.equal(inactive.calls.comparisons.length, 0);
    assert.ok(!inactive.result.token);
  }

  for (const extra of [
    { ...account, id: 'duplicate', email: account.email.toLowerCase() },
    { ...account, id: 'duplicate', email: account.email.toLowerCase(), pin: bcrypt.hashSync('different-password', 4) },
    { ...account, id: 'duplicate', email: account.email.toLowerCase(), active: false },
  ]) {
    for (const users of [[account, extra], [extra, account]]) {
      const ambiguous = await request({ email: account.email, password }, users);
      assert.equal(ambiguous.status, 401, 'Ambiguous email must not pick an account, irrespective of row order or password');
      assert.equal(ambiguous.result.error, 'Credenciais incorretas');
      assert.equal(ambiguous.calls.comparisons.length, 0);
      assert.ok(!ambiguous.result.token);
    }
  }
  for (const login of [{ email: 'missing@example.com' }, { phone: '83999990000' }]) {
    const missing = await request({ ...login, password });
    assert.equal(missing.status, 401);
    assert.equal(missing.result.error, 'Credenciais incorretas');
  }

  for (const invalid of [undefined, null, {}, { email: account.email }, { email: account.email, password: {} },
    { email: account.email, password: '' }, { password }, { email: ' ', password },
    { email: {}, password }, { phone: {}, password }, { phone: '()- ', password }]) {
    const response = await request(invalid);
    assert.equal(response.status, 400, 'Malformed input must be rejected without an internal error');
    assert.equal(response.calls.queries.length, 0);
    assert.equal(response.calls.comparisons.length, 0);
    assert.ok(!response.result.token);
  }
  const failure = await request({ email: account.email, password }, [account], new Error(
    'sensitive-database-detail ' + account.email + ' ' + password + ' ' + hash,
  ));
  assert.equal(failure.status, 500);
  assert.equal(failure.result.error, 'Erro interno no servidor');
  assert.ok(!failure.result.token);
  console.log('PASS: literal case-insensitive email login, ILIKE metacharacters, duplicate rejection, formatted WhatsApp, literal password verification, inactive accounts, JWT identity, malformed input and credential privacy; no live account changed');
})().catch(error => { console.error(error); process.exitCode = 1; });
