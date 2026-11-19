// =====================================================================
// Segredo do JWT — UMA fonte para o sistema inteiro (Liga Aberta F0).
// ---------------------------------------------------------------------
// Produção (NODE_ENV=production OU variável do Railway presente) SEM
// JWT_SECRET → lança erro no boot. É de propósito: o healthcheck do
// Railway marca o deploy como falho e mantém a versão anterior no ar,
// em vez de subir um servidor que assina token com segredo conhecido.
// Fora de produção: gera um segredo aleatório por processo (os tokens
// morrem quando o processo reinicia) e avisa no console.
//
// ⚠️ NÃO usar este valor para CIFRAR dado gravado (folha, medalhas,
// calendário): aquilo continua com a chave própria de cada módulo,
// senão trocar o segredo apagaria a leitura do que já existe.
// =====================================================================

const crypto = require('crypto');

function isProductionEnv(env = process.env) {
  return env.NODE_ENV === 'production' || !!env.RAILWAY_ENVIRONMENT || !!env.RAILWAY_ENVIRONMENT_NAME;
}

function resolveJwtSecret(env = process.env, log = console) {
  const configured = typeof env.JWT_SECRET === 'string' ? env.JWT_SECRET.trim() : '';
  if (configured) {
    if (configured.length < 16 && log && log.warn) {
      log.warn('[jwt] JWT_SECRET muito curto (menos de 16 caracteres). Troque por um valor longo e aleatório.');
    }
    return configured;
  }
  if (isProductionEnv(env)) {
    throw new Error('JWT_SECRET não definido em produção. Configure a variável JWT_SECRET no Railway antes de subir o servidor.');
  }
  if (log && log.warn) {
    log.warn('[jwt] JWT_SECRET ausente (fora de produção): usando segredo aleatório deste processo. Tokens deixam de valer ao reiniciar.');
  }
  return crypto.randomBytes(48).toString('hex');
}

module.exports = { isProductionEnv, resolveJwtSecret };
