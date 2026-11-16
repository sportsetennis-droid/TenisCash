'use strict';

// Proteção de dados sensíveis da folha (CPF, dados bancários): AES-256-GCM.
// Chave: PAYROLL_DATA_KEY (recomendado) ou derivada do JWT_SECRET. Formato "v1:iv:tag:dado".

const crypto = require('node:crypto');

function key() {
  const secret = process.env.PAYROLL_DATA_KEY || process.env.JWT_SECRET || 'teniscash-dev-secret';
  return crypto.createHash('sha256').update('payroll-data:' + secret).digest();
}
function encrypt(text) {
  if (text == null || text === '') return null;
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key(), iv);
  const enc = Buffer.concat([cipher.update(String(text), 'utf8'), cipher.final()]);
  return ['v1', iv.toString('base64'), cipher.getAuthTag().toString('base64'), enc.toString('base64')].join(':');
}
function decrypt(payload) {
  if (!payload) return null;
  const [v, iv, tag, data] = String(payload).split(':');
  if (v !== 'v1') throw new Error('formato de dado protegido desconhecido');
  const decipher = crypto.createDecipheriv('aes-256-gcm', key(), Buffer.from(iv, 'base64'));
  decipher.setAuthTag(Buffer.from(tag, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(data, 'base64')), decipher.final()]).toString('utf8');
}
function maskCpf(last4) {
  const d = String(last4 || '').replace(/\D/g, '').slice(-4);
  return d.length === 4 ? `***.***.*${d.slice(0, 2)}-${d.slice(2)}` : '***.***.***-**';
}
// Link assinado com validade (PDF pelo WhatsApp): HMAC do id + validade.
function signLink(id, expiresAtMs) {
  const sig = crypto.createHmac('sha256', key()).update(`${id}.${expiresAtMs}`).digest('base64url');
  return `${id}.${expiresAtMs}.${sig}`;
}
function verifyLink(token, nowMs = Date.now()) {
  const [id, exp, sig] = String(token || '').split('.');
  if (!id || !exp || !sig) return null;
  const expected = crypto.createHmac('sha256', key()).update(`${id}.${exp}`).digest('base64url');
  if (sig.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
  if (Number(exp) < nowMs) return null;
  return id;
}
function verifyCode() {
  return crypto.randomBytes(9).toString('base64url').toUpperCase().replace(/[^A-Z0-9]/g, 'X').slice(0, 12);
}
function sha256(data) { return crypto.createHash('sha256').update(data).digest('hex'); }

module.exports = { encrypt, decrypt, maskCpf, signLink, verifyLink, verifyCode, sha256 };
