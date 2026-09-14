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
      assert.equal(query.take, 11, 'Read one account beyond the ten-comparison limit to detect overflow');
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

function authenticated(response, expected = account, expectedPassword = password, expectedComparisons = 1) {
  assert.equal(response.status, 200);
  assert.equal(response.result.user.id, expected.id);
  assert.equal(response.result.user.storeId, expected.storeId);
  assert.equal(response.result.user.store.id, expected.store.id);
  assert.equal(response.result.user.role, expected.role);
  assert.equal(response.result.user.profileComplete, false, 'Login must not require completion of a customer profile');
  assert.ok(!Object.hasOwn(response.result.user, 'pin'));
  assert.ok(!Object.hasOwn(response.result.user, 'password'));
  const claims = jwt.verify(response.result.token, secret);
  assert.equal(claims.userId, expected.id);
  assert.equal(claims.role, expected.role);
  assert.equal(claims.exp - claims.iat, 30 * 24 * 60 * 60);
  assert.equal(response.calls.comparisons.length, expectedComparisons);
  for (const comparison of response.calls.comparisons) {
    assert.equal(comparison.plain, expectedPassword, 'Password spaces and case must remain literal');
  }
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
    assert.equal(inactive.calls.comparisons.length, login.email ? 1 : 0);
    assert.ok(!inactive.result.token);
  }

  const otherPassword = 'Different-Family-Password';
  const extra = { ...account, id: 'family-account', email: account.email.toLowerCase(),
    role: 'user', pin: bcrypt.hashSync(otherPassword, 4) };
  const owner = { ...account, role: 'superadmin' };
  for (const users of [[owner, extra], [extra, owner]]) {
    authenticated(await request({ email: account.email, password }, users), owner, password, 2);
    authenticated(await request({ email: account.email, password: otherPassword }, users), extra, otherPassword, 2);
    const wrongPassword = await request({ email: account.email, password: 'wrong-password' }, users);
    assert.equal(wrongPassword.status, 401);
    assert.equal(wrongPassword.result.error, 'Credenciais incorretas');
    assert.equal(wrongPassword.calls.comparisons.length, 2);
    assert.ok(!wrongPassword.result.token);
  }
  // Inactive accounts also count toward ambiguity. A shared password must never
  // select the active or privileged account by role, status or result ordering.
  for (const active of [true, false]) {
    const samePassword = { ...extra, active, pin: hash };
    for (const users of [[owner, samePassword], [samePassword, owner]]) {
      const ambiguous = await request({ email: account.email, password }, users);
      assert.equal(ambiguous.status, 401);
      assert.equal(ambiguous.result.error, 'Credenciais incorretas');
      assert.equal(ambiguous.calls.comparisons.length, 2);
      assert.ok(!ambiguous.result.token);
    }
    const distinct = { ...extra, active };
    for (const users of [[owner, distinct], [distinct, owner]]) {
      authenticated(await request({ email: account.email, password }, users), owner, password, 2);
      const response = await request({ email: account.email, password: otherPassword }, users);
      if (active) authenticated(response, distinct, otherPassword, 2);
      else {
        assert.equal(response.status, 403, 'Only a unique correct password may identify an inactive email account');
        assert.match(response.result.error, /Conta desativada/);
        assert.equal(response.calls.comparisons.length, 2);
        assert.ok(!response.result.token);
      }
    }
  }
  const inactiveWrongPassword = await request({ email: account.email, password: 'wrong-password' }, [{ ...account, active: false }]);
  assert.equal(inactiveWrongPassword.status, 401);
  assert.equal(inactiveWrongPassword.result.error, 'Credenciais incorretas');
  assert.ok(!inactiveWrongPassword.result.token);

  const nonmatchingAccounts = Array.from({ length: 10 }, (_, index) => ({ ...extra, id: `shared-email-${index}` }));
  const atLimit = [owner, ...nonmatchingAccounts.slice(0, 9)];
  for (const users of [atLimit, [...atLimit].reverse()]) {
    authenticated(await request({ email: account.email, password }, users), owner, password, 10);
  }
  for (const users of [[owner, ...nonmatchingAccounts], [...nonmatchingAccounts, owner]]) {
    const overflow = await request({ email: account.email, password }, users);
    assert.equal(overflow.status, 401, 'Overflow must reject before comparisons, never authenticate from a truncated subset');
    assert.equal(overflow.result.error, 'Credenciais incorretas');
    assert.equal(overflow.calls.comparisons.length, 0);
    assert.ok(!overflow.result.token);
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
  console.log('PASS: literal case-insensitive email login, ILIKE metacharacters, shared-email password identity, ambiguity and comparison limits, formatted WhatsApp, literal password verification, inactive accounts, JWT identity, malformed input and credential privacy; no live account changed');
})().catch(error => { console.error(error); process.exitCode = 1; });
