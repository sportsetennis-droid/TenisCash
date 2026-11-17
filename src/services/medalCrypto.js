// =====================================================================
// MEDALHAS DIGITAIS — núcleo criptográfico (Open Badges 3.0, VC-JWT)
// ---------------------------------------------------------------------
// - Cada EMISSOR (organizador, escola, federação) tem um par Ed25519.
// - A identidade do emissor é um did:key: a CHAVE PÚBLICA está dentro do
//   próprio identificador. Por isso qualquer pessoa verifica a medalha
//   SEM falar com o nosso servidor (não há "busca de chave").
// - A medalha é um VC-JWT (JWS compacto, alg EdDSA) cujo payload é a
//   OpenBadgeCredential + claims iss/jti/nbf (OB 3.0 §8.2, VC-JOSE).
// - A chave privada fica no banco CIFRADA (AES-256-GCM) com o segredo
//   MEDAL_KEY_SECRET (fallback: JWT_SECRET). Nunca sai do servidor.
// - "Baked badge": a credencial vai embutida no PNG compartilhado
//   (chunk iTXt "openbadgecredential", padrão de baking do OB 3.0).
// Só usa o módulo nativo `crypto` do Node.
// =====================================================================
const crypto = require('crypto');

// ---------- base64url / base58btc ----------
const b64u = (buf) => Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const fromB64u = (s) => Buffer.from(String(s).replace(/-/g, '+').replace(/_/g, '/'), 'base64');

const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
function base58encode(bytes) {
  let n = BigInt('0x' + (Buffer.from(bytes).toString('hex') || '0'));
  let out = '';
  while (n > 0n) { out = B58[Number(n % 58n)] + out; n /= 58n; }
  for (const b of bytes) { if (b === 0) out = '1' + out; else break; }
  return out;
}
function base58decode(str) {
  let n = 0n;
  for (const ch of str) {
    const i = B58.indexOf(ch);
    if (i < 0) throw new Error('base58 inválido');
    n = n * 58n + BigInt(i);
  }
  let hex = n.toString(16);
  if (hex.length % 2) hex = '0' + hex;
  const body = n === 0n ? Buffer.alloc(0) : Buffer.from(hex, 'hex');
  let zeros = 0;
  for (const ch of str) { if (ch === '1') zeros += 1; else break; }
  return Buffer.concat([Buffer.alloc(zeros), body]);
}

// ---------- did:key (Ed25519, multicodec 0xed01) ----------
const ED25519_PREFIX = Buffer.from([0xed, 0x01]);
function didKeyFromRaw(raw32) {
  return 'did:key:z' + base58encode(Buffer.concat([ED25519_PREFIX, Buffer.from(raw32)]));
}
function rawFromDidKey(did) {
  const m = /^did:key:z([1-9A-HJ-NP-Za-km-z]+)/.exec(String(did || ''));
  if (!m) throw new Error('did:key inválido');
  const bytes = base58decode(m[1]);
  if (bytes.length !== 34 || bytes[0] !== 0xed || bytes[1] !== 0x01) throw new Error('did:key não é Ed25519');
  return bytes.subarray(2);
}
const kidFor = (did) => did + '#' + did.slice('did:key:'.length);

function publicKeyFromRaw(raw32) {
  return crypto.createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: b64u(raw32) }, format: 'jwk' });
}

// ---------- cofre da chave privada ----------
function vaultKey(secret = process.env.MEDAL_KEY_SECRET || process.env.JWT_SECRET) {
  if (!secret) throw new Error('MEDAL_KEY_SECRET (ou JWT_SECRET) ausente — não dá pra guardar chave de emissor');
  return crypto.createHash('sha256').update('medal-vault:' + secret).digest();
}
// Abre com o segredo atual e, se falhar, com o reserva: configurar MEDAL_KEY_SECRET
// depois NÃO tranca as chaves que foram guardadas com JWT_SECRET.
function vaultKeys() {
  const ks = [process.env.MEDAL_KEY_SECRET, process.env.JWT_SECRET].filter(Boolean);
  if (!ks.length) throw new Error('MEDAL_KEY_SECRET (ou JWT_SECRET) ausente — não dá pra abrir chave de emissor');
  return [...new Set(ks)].map((k) => vaultKey(k));
}
function sealSecret(plain) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', vaultKey(), iv);
  const enc = Buffer.concat([c.update(String(plain), 'utf8'), c.final()]);
  return 'v1.' + [iv, c.getAuthTag(), enc].map(b64u).join('.');
}
function openSecret(sealed) {
  const [v, iv, tag, enc] = String(sealed).split('.');
  if (v !== 'v1') throw new Error('cofre: versão desconhecida');
  let ultimo;
  for (const key of vaultKeys()) {
    try {
      const d = crypto.createDecipheriv('aes-256-gcm', key, fromB64u(iv));
      d.setAuthTag(fromB64u(tag));
      return Buffer.concat([d.update(fromB64u(enc)), d.final()]).toString('utf8');
    } catch (e) { ultimo = e; }
  }
  throw new Error('cofre: não abriu com nenhum segredo configurado (' + (ultimo && ultimo.message) + ')');
}

// ---------- chaves do emissor ----------
function generateIssuerKeys() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const jwk = publicKey.export({ format: 'jwk' });
  const raw = fromB64u(jwk.x);
  const did = didKeyFromRaw(raw);
  const pem = privateKey.export({ format: 'pem', type: 'pkcs8' });
  return { did, publicJwk: { kty: 'OKP', crv: 'Ed25519', x: jwk.x }, privateKeySealed: sealSecret(pem) };
}

// ---------- VC-JWT ----------
function signCredentialJwt(credential, { did, privateKeySealed }) {
  const header = { alg: 'EdDSA', typ: 'JWT', kid: kidFor(did) };
  const issued = credential.validFrom ? Math.floor(new Date(credential.validFrom).getTime() / 1000) : Math.floor(Date.now() / 1000);
  const payload = Object.assign({}, credential, { iss: did, jti: credential.id, nbf: issued });
  const input = b64u(JSON.stringify(header)) + '.' + b64u(JSON.stringify(payload));
  const key = crypto.createPrivateKey(openSecret(privateKeySealed));
  const sig = crypto.sign(null, Buffer.from(input, 'ascii'), key);
  return input + '.' + b64u(sig);
}

// Verificação COMPLETA sem rede: a chave sai do did:key do próprio JWT.
function verifyCredentialJwt(jwt) {
  try {
    const parts = String(jwt || '').trim().split('.');
    if (parts.length !== 3) return { valid: false, error: 'formato JWT inválido' };
    const header = JSON.parse(fromB64u(parts[0]).toString('utf8'));
    const payload = JSON.parse(fromB64u(parts[1]).toString('utf8'));
    if (header.alg !== 'EdDSA') return { valid: false, error: 'algoritmo não suportado: ' + header.alg };
    const issuerId = payload.issuer && (payload.issuer.id || payload.issuer);
    if (!issuerId || payload.iss !== issuerId) return { valid: false, error: 'emissor inconsistente (iss ≠ issuer.id)' };
    if (!String(header.kid || '').startsWith(issuerId + '#')) return { valid: false, error: 'kid não pertence ao emissor' };
    const pub = publicKeyFromRaw(rawFromDidKey(issuerId));
    const ok = crypto.verify(null, Buffer.from(parts[0] + '.' + parts[1], 'ascii'), pub, fromB64u(parts[2]));
    if (!ok) return { valid: false, error: 'assinatura não confere — a medalha foi alterada ou não é deste emissor', header, payload };
    const types = [].concat(payload.type || []);
    if (!types.includes('VerifiableCredential') || !types.includes('OpenBadgeCredential')) {
      return { valid: false, error: 'não é uma OpenBadgeCredential', header, payload };
    }
    return { valid: true, header, payload, issuer: issuerId };
  } catch (e) {
    return { valid: false, error: e.message };
  }
}

// ---------- vínculo com o CPF ----------
// O hash vai PÚBLICO na medalha, mas o SAL não (é secreto, fica com o atleta).
// Sem o sal, o CPF não é recuperável por força bruta (o espaço de CPFs é pequeno,
// um sal público deixaria quebrar em minutos). Prova de titularidade: o atleta
// apresenta CPF + código de titularidade (o sal) e qualquer um recalcula.
const onlyDigits = (s) => String(s || '').replace(/\D/g, '');
function newIdentitySalt() { return crypto.randomBytes(16).toString('hex'); }
function identityHash(cpf, salt) {
  return 'sha256$' + crypto.createHash('sha256').update(onlyDigits(cpf) + salt).digest('hex');
}

// Código curto de verificação impresso no verso (derivado da própria credencial).
function verificationCode(jwt) {
  const h = crypto.createHash('sha256').update(String(jwt)).digest();
  const A = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let s = '';
  for (let i = 0; i < 12; i++) s += A[h[i] % 32];
  return s.slice(0, 4) + '-' + s.slice(4, 8) + '-' + s.slice(8, 12);
}

// ---------- baking em PNG (iTXt "openbadgecredential") ----------
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function bakePng(png, jwt) {
  png = Buffer.from(png);
  if (png.readUInt32BE(0) !== 0x89504e47) throw new Error('não é PNG');
  // iTXt: keyword \0 compFlag(0) compMethod(0) lang\0 translated\0 text
  const data = Buffer.concat([Buffer.from('openbadgecredential', 'latin1'), Buffer.from([0, 0, 0, 0, 0]), Buffer.from(jwt, 'utf8')]);
  const type = Buffer.from('iTXt', 'latin1');
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([type, data])));
  const chunk = Buffer.concat([len, type, data, crc]);
  const ihdrEnd = 8 + 8 + png.readUInt32BE(8) + 4; // assinatura + IHDR completo
  return Buffer.concat([png.subarray(0, ihdrEnd), chunk, png.subarray(ihdrEnd)]);
}
function unbakePng(png) {
  png = Buffer.from(png);
  let off = 8;
  while (off + 8 <= png.length) {
    const len = png.readUInt32BE(off);
    const type = png.toString('latin1', off + 4, off + 8);
    if (type === 'iTXt') {
      const data = png.subarray(off + 8, off + 8 + len);
      const z = data.indexOf(0);
      if (data.toString('latin1', 0, z) === 'openbadgecredential') {
        let p = z + 3; // \0 + compFlag + compMethod
        p = data.indexOf(0, p) + 1; // lang
        p = data.indexOf(0, p) + 1; // translated keyword
        return data.subarray(p).toString('utf8');
      }
    }
    if (type === 'IEND') break;
    off += 12 + len;
  }
  return null;
}

module.exports = {
  b64u, fromB64u, base58encode, base58decode,
  didKeyFromRaw, rawFromDidKey, kidFor,
  sealSecret, openSecret, generateIssuerKeys,
  signCredentialJwt, verifyCredentialJwt,
  newIdentitySalt, identityHash, verificationCode,
  bakePng, unbakePng, crc32,
};
