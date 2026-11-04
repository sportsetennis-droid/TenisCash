const crypto = require('crypto');
const { prisma } = require('../middleware');

const CONFIG_KEY = 'meta_whatsapp_credentials_v1';
const KEY_CONTEXT = 'teniscash:meta-whatsapp-credentials:v1';

function encryptionKey(secret = process.env.META_APP_SECRET) {
  if (!secret) throw new Error('META_APP_SECRET não configurado');
  return crypto.createHash('sha256').update(KEY_CONTEXT).update(String(secret)).digest();
}

function encryptMetaWhatsAppCredentials(credentials, secret = process.env.META_APP_SECRET) {
  if (!credentials || typeof credentials.accessToken !== 'string' || !credentials.accessToken) {
    throw new Error('Credenciais do WhatsApp inválidas');
  }
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', encryptionKey(secret), iv);
  const encrypted = Buffer.concat([
    cipher.update(JSON.stringify(credentials), 'utf8'),
    cipher.final(),
  ]);
  return ['v1', iv.toString('base64'), cipher.getAuthTag().toString('base64'), encrypted.toString('base64')].join(':');
}

function decryptMetaWhatsAppCredentials(value, secret = process.env.META_APP_SECRET) {
  const [version, ivB64, tagB64, encryptedB64, extra] = String(value || '').split(':');
  if (version !== 'v1' || !ivB64 || !tagB64 || !encryptedB64 || extra !== undefined) {
    throw new Error('Credenciais WhatsApp armazenadas em formato inválido');
  }
  const decipher = crypto.createDecipheriv('aes-256-gcm', encryptionKey(secret), Buffer.from(ivB64, 'base64'));
  decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(encryptedB64, 'base64')),
    decipher.final(),
  ]).toString('utf8');
  const credentials = JSON.parse(plaintext);
  if (!credentials.accessToken || !credentials.phoneNumberId || !credentials.wabaId) {
    throw new Error('Credenciais WhatsApp armazenadas estão incompletas');
  }
  return credentials;
}

async function saveMetaWhatsAppCredentials(credentials) {
  const value = encryptMetaWhatsAppCredentials(credentials);
  await prisma.config.upsert({
    where: { key: CONFIG_KEY },
    create: { id: CONFIG_KEY, key: CONFIG_KEY, value },
    update: { value },
  });
}

async function loadMetaWhatsAppCredentials() {
  const row = await prisma.config.findUnique({ where: { key: CONFIG_KEY } });
  return row ? decryptMetaWhatsAppCredentials(row.value) : null;
}

module.exports = {
  CONFIG_KEY,
  encryptMetaWhatsAppCredentials,
  decryptMetaWhatsAppCredentials,
  saveMetaWhatsAppCredentials,
  loadMetaWhatsAppCredentials,
};
