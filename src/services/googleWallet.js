// =====================================================================
// Cartão TenisCash na Carteira do Google (Google Wallet, passe genérico).
// ---------------------------------------------------------------------
// Fluxo "Save to Google Wallet": o servidor assina um JWT (RS256) com a chave
// da conta de serviço e o app abre https://pay.google.com/gp/v/save/<jwt>.
// Nenhuma chamada ao Google sai daqui — quem cria o passe é o Google quando
// o cliente toca no link.
//
// SÓ ATIVA com as duas envs:
//   GOOGLE_WALLET_ISSUER_ID  = id do emissor (Google Pay & Wallet Console)
//   GOOGLE_WALLET_SA_JSON    = JSON da conta de serviço, em BASE64
// Opcionais: GOOGLE_WALLET_CLASS_SUFFIX (padrão "teniscash_membro"),
//   GOOGLE_WALLET_LOGO_URL (PNG público; sem ele o passe sai sem logo).
//
// QR: o QR que a loja lê hoje é "TC:<token de 5 minutos>" (src/routes/qr.js).
// Um passe da carteira é estático, então NÃO dá pra pôr esse QR nele sem
// inventar um formato novo — por isso o passe leva um link "Abrir QR no app"
// em vez de código de barras. Ver docs/google-wallet.md.
//
// Saldo: vai o saldo do momento em que o cliente salvou, com data/hora
// escrita no passe (atualizar sozinho exige a API REST do Wallet — futuro).
// =====================================================================

const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const { publicBaseUrl } = require('../config/publicUrl');

const SAVE_URL = 'https://pay.google.com/gp/v/save/';

function readConfig(env = process.env) {
  const issuerId = String(env.GOOGLE_WALLET_ISSUER_ID || '').trim();
  const saB64 = String(env.GOOGLE_WALLET_SA_JSON || '').trim();
  if (!issuerId || !saB64) return null;
  if (!/^\d{6,25}$/.test(issuerId)) return null;
  let sa;
  try {
    sa = JSON.parse(Buffer.from(saB64, 'base64').toString('utf8'));
  } catch (_) {
    return null;
  }
  if (!sa || !sa.client_email || !sa.private_key) return null;
  const classSuffix = String(env.GOOGLE_WALLET_CLASS_SUFFIX || 'teniscash_membro').replace(/[^A-Za-z0-9._-]/g, '_');
  return {
    issuerId,
    clientEmail: sa.client_email,
    privateKey: sa.private_key,
    classId: `${issuerId}.${classSuffix}`,
    logoUrl: /^https:\/\//.test(String(env.GOOGLE_WALLET_LOGO_URL || '')) ? env.GOOGLE_WALLET_LOGO_URL : null,
  };
}

function isEnabled(env = process.env) {
  return !!readConfig(env);
}

// Id do objeto estável por cliente (mesmo cliente = mesmo passe), sem expor o id interno.
function objectIdFor(cfg, userId) {
  const h = crypto.createHash('sha256').update('tc-wallet:' + String(userId)).digest('hex').slice(0, 32);
  return `${cfg.issuerId}.tc_${h}`;
}

function fmtBalance(balance) {
  const n = Number(balance || 0);
  return 'T$ ' + n.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function fmtWhen(date) {
  return new Date(date).toLocaleString('pt-BR', {
    timeZone: 'America/Fortaleza', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit',
  });
}

function lv(value) {
  return { defaultValue: { language: 'pt-BR', value: String(value) } };
}

function buildGenericObject(cfg, user, now = new Date()) {
  const base = publicBaseUrl();
  const obj = {
    id: objectIdFor(cfg, user.id),
    classId: cfg.classId,
    state: 'ACTIVE',
    cardTitle: lv('TenisCash · Sports & Tennis'),
    subheader: lv('Membro'),
    header: lv(String(user.name || 'Cliente TenisCash').slice(0, 60)),
    hexBackgroundColor: '#E5571E',
    textModulesData: [
      { id: 'saldo', header: 'Saldo', body: `${fmtBalance(user.balance)} (em ${fmtWhen(now)})` },
      { id: 'uso', header: 'Como usar', body: 'Na loja, abra o app TenisCash e mostre o QR Code para usar o saldo.' },
    ],
    linksModuleData: {
      uris: [{ id: 'app', uri: base + '/', description: 'Abrir o app TenisCash (QR da loja)' }],
    },
  };
  if (cfg.logoUrl) obj.logo = { sourceUri: { uri: cfg.logoUrl }, contentDescription: lv('TenisCash') };
  return obj;
}

// Monta e assina o JWT "savetowallet". Devolve { url, jwt, objectId }.
function buildSaveLink(user, { env = process.env, now = new Date() } = {}) {
  const cfg = readConfig(env);
  if (!cfg) return null;
  const object = buildGenericObject(cfg, user, now);
  const claims = {
    iss: cfg.clientEmail,
    aud: 'google',
    typ: 'savetowallet',
    iat: Math.floor(now.getTime() / 1000),
    origins: [publicBaseUrl()],
    payload: {
      genericClasses: [{ id: cfg.classId }],
      genericObjects: [object],
    },
  };
  const token = jwt.sign(claims, cfg.privateKey, { algorithm: 'RS256', noTimestamp: true });
  return { url: SAVE_URL + token, jwt: token, objectId: object.id };
}

module.exports = { readConfig, isEnabled, buildSaveLink, buildGenericObject, objectIdFor, SAVE_URL };
