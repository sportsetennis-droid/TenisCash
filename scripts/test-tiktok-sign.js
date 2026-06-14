// Teste do algoritmo de assinatura do TikTok Shop (src/services/tiktokShop.js).
// Roda offline (sem rede). Implementa o spec de forma INDEPENDENTE e compara
// com signRequest(), além de checar casos de borda.
//
//   node scripts/test-tiktok-sign.js
//
// Spec (doc oficial + SDK EcomPHP/tiktokshop-php):
//   base = app_secret + path + sorted(k+v, exclui sign/access_token/x-tts-access-token)
//          + body(se !GET e !multipart) + app_secret
//   sign = HMAC_SHA256(base, key=app_secret) em hex

const crypto = require('crypto');
const { signRequest } = require('../src/services/tiktokShop');

const APP_SECRET = 'test_secret_123';

// Implementação independente do spec, só pro teste.
function expectedSign({ path, query, bodyString, method, contentType }) {
  const exclude = new Set(['sign', 'access_token', 'x-tts-access-token']);
  const keys = Object.keys(query)
    .filter((k) => !exclude.has(k) && query[k] != null && query[k] !== '')
    .sort();
  let s = '';
  for (const k of keys) s += `${k}${query[k]}`;
  s = `${path}${s}`;
  const multipart = String(contentType || '').includes('multipart/form-data');
  if (String(method).toUpperCase() !== 'GET' && !multipart && bodyString) s += bodyString;
  s = `${APP_SECRET}${s}${APP_SECRET}`;
  return crypto.createHmac('sha256', APP_SECRET).update(s, 'utf8').digest('hex');
}

let pass = 0;
let fail = 0;
function check(name, got, want) {
  if (got === want) { pass++; console.log('  ✓', name); }
  else { fail++; console.error('  ✗', name, '\n     got :', got, '\n     want:', want); }
}

// 1) POST com body — body entra na assinatura
{
  const args = {
    path: '/product/202309/products',
    query: { app_key: 'abc', timestamp: 1700000000, shop_cipher: 'GCP_xyz' },
    bodyString: JSON.stringify({ title: 'Tênis X', skus: [{ price: { amount: '299.90' } }] }),
    method: 'POST',
    contentType: 'application/json',
  };
  check('POST inclui body', signRequest({ ...args, appSecret: APP_SECRET }), expectedSign(args));
}

// 2) GET — body NÃO entra
{
  const args = {
    path: '/authorization/202309/shops',
    query: { app_key: 'abc', timestamp: 1700000000 },
    bodyString: '',
    method: 'GET',
    contentType: 'application/json',
  };
  check('GET sem body', signRequest({ ...args, appSecret: APP_SECRET }), expectedSign(args));
}

// 3) multipart — body NÃO entra mesmo em POST
{
  const args = {
    path: '/product/202309/images/upload',
    query: { app_key: 'abc', timestamp: 1700000000 },
    bodyString: 'BINARY-DATA-NAO-DEVE-ENTRAR',
    method: 'POST',
    contentType: 'multipart/form-data; boundary=xyz',
  };
  check('multipart pula body', signRequest({ ...args, appSecret: APP_SECRET }), expectedSign(args));
}

// 4) ordenação independe da ordem de inserção
{
  const a = { path: '/x', query: { c: 3, a: 1, b: 2 }, bodyString: '', method: 'GET', contentType: 'application/json' };
  const b = { path: '/x', query: { a: 1, b: 2, c: 3 }, bodyString: '', method: 'GET', contentType: 'application/json' };
  check('ordem das params nao importa',
    signRequest({ ...a, appSecret: APP_SECRET }),
    signRequest({ ...b, appSecret: APP_SECRET }));
}

// 5) sign/access_token/x-tts-access-token são excluídos da base
{
  const withNoise = { path: '/x', query: { app_key: 'abc', sign: 'OLD', access_token: 'TOK', 'x-tts-access-token': 'TOK2' }, bodyString: '', method: 'GET', contentType: 'application/json' };
  const clean = { path: '/x', query: { app_key: 'abc' }, bodyString: '', method: 'GET', contentType: 'application/json' };
  check('exclui sign/access_token',
    signRequest({ ...withNoise, appSecret: APP_SECRET }),
    signRequest({ ...clean, appSecret: APP_SECRET }));
}

// 6) é HMAC-SHA256 hex (64 chars)
{
  const sig = signRequest({ path: '/x', query: { a: 1 }, bodyString: '', method: 'GET', contentType: 'application/json', appSecret: APP_SECRET });
  check('hex de 64 chars', /^[0-9a-f]{64}$/.test(sig) ? 'ok' : sig, 'ok');
}

console.log(`\nResultado: ${pass} passou, ${fail} falhou`);
process.exit(fail === 0 ? 0 : 1);
