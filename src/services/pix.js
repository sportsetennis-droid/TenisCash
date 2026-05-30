// =====================================================================
// PIX — Gerador de BR Code estático (EMV / "copia e cola") + QR
// ---------------------------------------------------------------------
// Usado na cobrança OFF-PLATFORM: o profissional cobra pelo app, mas
// o pagamento cai direto na chave Pix DELE (não passa pela S&T).
// Spec: EMV QRCPS-MPM + Manual de Padrões do Pix (BACEN).
// =====================================================================

const crypto = require('crypto');

let QRCode = null;
try { QRCode = require('qrcode'); } catch (_) { QRCode = null; }

// Remove acentos e caracteres não-ASCII (campos do BR Code são ASCII).
function sanitize(s) {
  return String(s == null ? '' : s)
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '') // remove marcas de acento combinantes
    .replace(/[^\x20-\x7E]/g, '')
    .trim();
}

// Tag-Length-Value: ID (2) + LEN (2, nº de chars) + VALUE.
function tlv(id, value) {
  const v = String(value);
  const len = v.length.toString().padStart(2, '0');
  return `${id}${len}${v}`;
}

// CRC16-CCITT (poly 0x1021, init 0xFFFF) — exigido no campo 63.
function crc16(payload) {
  let crc = 0xffff;
  for (let i = 0; i < payload.length; i++) {
    crc ^= payload.charCodeAt(i) << 8;
    for (let j = 0; j < 8; j++) {
      crc = crc & 0x8000 ? (crc << 1) ^ 0x1021 : crc << 1;
      crc &= 0xffff;
    }
  }
  return crc.toString(16).toUpperCase().padStart(4, '0');
}

// txid: alfanumérico, máx 25; "***" quando não há referência.
function normalizeTxid(txid) {
  const t = sanitize(txid).replace(/[^A-Za-z0-9]/g, '');
  return t ? t.slice(0, 25) : '***';
}

/**
 * Monta o payload Pix "copia e cola".
 * @param {object} o
 * @param {string} o.pixKey        chave Pix do recebedor (profissional)
 * @param {string} o.merchantName  nome do recebedor (máx 25)
 * @param {string} o.merchantCity  cidade (máx 15)
 * @param {number} [o.amount]      valor; omitido => pagador digita
 * @param {string} [o.txid]        referência (ex.: token da cobrança)
 * @returns {string} BR Code completo (com CRC)
 */
function buildPixPayload({ pixKey, merchantName, merchantCity, amount, txid }) {
  const key = sanitize(pixKey);
  if (!key) throw new Error('pixKey obrigatória');

  const mai = tlv('00', 'br.gov.bcb.pix') + tlv('01', key);

  let payload =
    tlv('00', '01') + // Payload Format Indicator
    tlv('26', mai) + // Merchant Account Information - Pix
    tlv('52', '0000') + // Merchant Category Code
    tlv('53', '986') + // Moeda = BRL
    (amount != null && Number(amount) > 0 ? tlv('54', Number(amount).toFixed(2)) : '') +
    tlv('58', 'BR') + // País
    tlv('59', (sanitize(merchantName).slice(0, 25) || 'RECEBEDOR').toUpperCase()) +
    tlv('60', (sanitize(merchantCity).slice(0, 15) || 'CIDADE').toUpperCase()) +
    tlv('62', tlv('05', normalizeTxid(txid))) + // Additional Data (Reference Label)
    '6304'; // campo CRC com tamanho fixo, antes de calcular

  return payload + crc16(payload);
}

// Gera QR como data URL (PNG base64). Retorna null se qrcode indisponível.
async function buildPixQrDataUrl(payloadOrOpts) {
  if (!QRCode) return null;
  const payload = typeof payloadOrOpts === 'string' ? payloadOrOpts : buildPixPayload(payloadOrOpts);
  try {
    return await QRCode.toDataURL(payload, { errorCorrectionLevel: 'M', margin: 1, width: 360 });
  } catch (_) {
    return null;
  }
}

// Token url-safe pra página pública de cobrança (/c/<token>).
function generatePublicToken() {
  return crypto.randomBytes(12).toString('base64url'); // ~16 chars
}

module.exports = { buildPixPayload, buildPixQrDataUrl, generatePublicToken, crc16, sanitize };
