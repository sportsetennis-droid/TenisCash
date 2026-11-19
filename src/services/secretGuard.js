// =====================================================================
// Guarda das rotas TEMPORÁRIAS por ?g= (Liga Aberta F0).
// ---------------------------------------------------------------------
// O segredo NÃO fica mais em texto no código: guardamos só o sha256 dele
// e comparamos em tempo constante (crypto.timingSafeEqual) — mesmo padrão
// do /api/_waqr. Quem chama continua mandando o mesmo ?g=.
//
// Rotação sem deploy de código: se a variável de ambiente `envName`
// existir (ex.: ROUTE_GUARD_FISCALDIAG), ela passa a ser o segredo e o
// hash antigo deixa de valer.
// =====================================================================

const crypto = require('crypto');

function sha256Hex(value) {
  return crypto.createHash('sha256').update(String(value == null ? '' : value)).digest('hex');
}

function matchesSecretHash(input, expectedHashHex, envName) {
  const fromEnv = envName && typeof process.env[envName] === 'string' && process.env[envName].trim()
    ? sha256Hex(process.env[envName].trim())
    : null;
  const expected = fromEnv || String(expectedHashHex || '').toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(expected)) return false;
  if (input == null || input === '') return false;
  const got = Buffer.from(sha256Hex(input), 'hex');
  const want = Buffer.from(expected, 'hex');
  return got.length === want.length && crypto.timingSafeEqual(got, want);
}

module.exports = { sha256Hex, matchesSecretHash };
