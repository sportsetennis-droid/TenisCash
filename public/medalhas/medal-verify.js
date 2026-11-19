/* =====================================================================
 * Verificador de medalha (Open Badges 3.0 / VC-JWT EdDSA) — 100% local.
 * Roda no navegador (e no Node, pros testes). NÃO consulta servidor pra
 * conferir a assinatura: a chave pública vem do did:key do emissor, que
 * está dentro da própria medalha.
 *  - Ed25519 via WebCrypto quando o navegador suporta;
 *  - senão, verificação RFC 8032 em JS puro (BigInt) — celular antigo.
 * Também extrai a credencial de um PNG "assado" (iTXt openbadgecredential).
 * ===================================================================== */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.MedalVerify = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  var subtle = (typeof crypto !== 'undefined' && crypto.subtle) ? crypto.subtle : null;

  function b64uToBytes(s) {
    s = String(s).replace(/-/g, '+').replace(/_/g, '/');
    while (s.length % 4) s += '=';
    var bin = atob(s), out = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }
  function utf8(bytes) { return new TextDecoder('utf-8').decode(bytes); }
  var B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  function base58decode(str) {
    var n = 0n;
    for (var i = 0; i < str.length; i++) {
      var k = B58.indexOf(str[i]);
      if (k < 0) throw new Error('base58 inválido');
      n = n * 58n + BigInt(k);
    }
    var bytes = [];
    while (n > 0n) { bytes.unshift(Number(n & 255n)); n >>= 8n; }
    for (var j = 0; j < str.length && str[j] === '1'; j++) bytes.unshift(0);
    return new Uint8Array(bytes);
  }
  function rawFromDidKey(did) {
    var m = /^did:key:z([1-9A-HJ-NP-Za-km-z]+)/.exec(String(did || ''));
    if (!m) throw new Error('emissor sem did:key');
    var b = base58decode(m[1]);
    if (b.length !== 34 || b[0] !== 0xed || b[1] !== 0x01) throw new Error('did:key não é Ed25519');
    return b.slice(2);
  }

  // ---------------- Ed25519 em JS puro (RFC 8032, só verificação) ----------------
  var P = (1n << 255n) - 19n;
  var L = (1n << 252n) + 27742317777372353535851937790883648493n;
  function mod(a, m) { m = m || P; var r = a % m; return r >= 0n ? r : r + m; }
  function pow(b, e, m) { m = m || P; var r = 1n; b = mod(b, m); while (e > 0n) { if (e & 1n) r = r * b % m; b = b * b % m; e >>= 1n; } return r; }
  function inv(a) { return pow(a, P - 2n); }
  var D = mod(-121665n * inv(121666n));
  var SQRTM1 = pow(2n, (P - 1n) / 4n);
  function leToBig(bytes) { var n = 0n; for (var i = bytes.length - 1; i >= 0; i--) n = (n << 8n) | BigInt(bytes[i]); return n; }
  function decodePoint(bytes) {
    var b = bytes.slice(); var sign = (b[31] >> 7) & 1; b[31] &= 0x7f;
    var y = leToBig(b); if (y >= P) return null;
    var y2 = y * y % P;
    var x2 = mod((y2 - 1n) * inv(D * y2 + 1n));
    if (x2 === 0n) { if (sign) return null; return [0n, y, 1n, 0n]; }
    var x = pow(x2, (P + 3n) / 8n);
    if (mod(x * x - x2) !== 0n) x = x * SQRTM1 % P;
    if (mod(x * x - x2) !== 0n) return null;
    if (Number(x & 1n) !== sign) x = P - x;
    return [x, y, 1n, x * y % P];
  }
  function add(p, q) { // coordenadas estendidas, fórmula completa (a = -1)
    var A = mod((p[1] - p[0]) * (q[1] - q[0])), B = mod((p[1] + p[0]) * (q[1] + q[0]));
    var C = mod(p[3] * 2n * D * q[3]), Dd = mod(p[2] * 2n * q[2]);
    var E = B - A, F = Dd - C, G = Dd + C, H = B + A;
    return [mod(E * F), mod(G * H), mod(F * G), mod(E * H)];
  }
  function mul(p, n) { var r = [0n, 1n, 1n, 0n], q = p; while (n > 0n) { if (n & 1n) r = add(r, q); q = add(q, q); n >>= 1n; } return r; }
  var BASE = (function () { var by = mod(4n * inv(5n)); var b = new Uint8Array(32); var t = by; for (var i = 0; i < 32; i++) { b[i] = Number(t & 255n); t >>= 8n; } return decodePoint(b); })();
  function sameP(p, q) { return mod(p[0] * q[2] - q[0] * p[2]) === 0n && mod(p[1] * q[2] - q[1] * p[2]) === 0n; }
  function sha512(bytes) {
    if (subtle) return subtle.digest('SHA-512', bytes).then(function (b) { return new Uint8Array(b); });
    return Promise.reject(new Error('SHA-512 indisponível neste navegador'));
  }
  function verifyEd25519Pure(pub, msg, sig) {
    if (sig.length !== 64 || pub.length !== 32) return Promise.resolve(false);
    var A = decodePoint(pub), R = decodePoint(sig.slice(0, 32)); var S = leToBig(sig.slice(32));
    if (!A || !R || S >= L) return Promise.resolve(false);
    var buf = new Uint8Array(64 + msg.length); buf.set(sig.slice(0, 32), 0); buf.set(pub, 32); buf.set(msg, 64);
    return sha512(buf).then(function (h) {
      var k = mod(leToBig(h), L);
      return sameP(mul(BASE, S), add(R, mul(A, k)));
    });
  }
  function verifyEd25519(pub, msg, sig, opts) {
    if (opts && opts.forcePure) return verifyEd25519Pure(pub, msg, sig).then(function (ok) { return { ok: ok, engine: 'js-puro' }; });
    if (!subtle) return verifyEd25519Pure(pub, msg, sig).then(function (ok) { return { ok: ok, engine: 'js-puro' }; });
    return subtle.importKey('raw', pub, { name: 'Ed25519' }, false, ['verify'])
      .then(function (k) { return subtle.verify({ name: 'Ed25519' }, k, sig, msg); })
      .then(function (ok) { return { ok: ok, engine: 'webcrypto' }; })
      .catch(function () { return verifyEd25519Pure(pub, msg, sig).then(function (ok) { return { ok: ok, engine: 'js-puro' }; }); });
  }

  // ---------------- PNG assado ----------------
  function unbakePng(arrayBuffer) {
    var b = new Uint8Array(arrayBuffer), dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
    if (dv.getUint32(0) !== 0x89504e47) return null;
    var off = 8;
    while (off + 8 <= b.length) {
      var len = dv.getUint32(off), type = String.fromCharCode(b[off + 4], b[off + 5], b[off + 6], b[off + 7]);
      if (type === 'iTXt') {
        var data = b.subarray(off + 8, off + 8 + len), z = data.indexOf(0);
        if (utf8(data.subarray(0, z)) === 'openbadgecredential') {
          var p = z + 3; p = data.indexOf(0, p) + 1; p = data.indexOf(0, p) + 1;
          return utf8(data.subarray(p)).trim();
        }
      }
      if (type === 'IEND') break;
      off += 12 + len;
    }
    return null;
  }

  // Aceita: JWT compacto, JSON {"credential": jwt} ou texto com um JWT dentro.
  function extractJwt(text) {
    var s = String(text || '').trim();
    var m = /([A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{40,})/.exec(s);
    return m ? m[1] : null;
  }

  // ---------------- verificação OB 3.0 ----------------
  function verify(jwt, opts) {
    var res = { valid: false, checks: [] };
    function check(id, ok, label) { res.checks.push({ id: id, ok: !!ok, label: label }); return ok; }
    try {
      var parts = String(jwt || '').trim().split('.');
      if (!check('formato', parts.length === 3, 'Formato da credencial (VC-JWT)')) return Promise.resolve(res);
      var header = JSON.parse(utf8(b64uToBytes(parts[0])));
      var payload = JSON.parse(utf8(b64uToBytes(parts[1])));
      res.header = header; res.payload = payload;
      var types = [].concat(payload.type || []);
      check('tipo', types.indexOf('VerifiableCredential') >= 0 && types.indexOf('OpenBadgeCredential') >= 0, 'É uma Open Badge 3.0');
      check('alg', header.alg === 'EdDSA', 'Assinatura Ed25519 (EdDSA)');
      var issuerId = payload.issuer && (payload.issuer.id || payload.issuer);
      res.issuer = issuerId;
      check('emissor', issuerId && payload.iss === issuerId && String(header.kid || '').indexOf(issuerId + '#') === 0, 'Emissor identificado pela própria chave (did:key)');
      var nbf = payload.nbf ? payload.nbf * 1000 : Date.parse(payload.validFrom || '');
      check('data', !nbf || nbf <= Date.now() + 5 * 60000, 'Data de emissão válida');
      var pub = rawFromDidKey(issuerId);
      var msg = new TextEncoder().encode(parts[0] + '.' + parts[1]);
      return verifyEd25519(pub, msg, b64uToBytes(parts[2]), opts).then(function (r) {
        res.engine = r.engine;
        check('assinatura', r.ok, 'Assinatura digital confere (nada foi alterado)');
        res.valid = res.checks.every(function (c) { return c.ok; });
        return res;
      });
    } catch (e) {
      check('leitura', false, 'Não foi possível ler a credencial: ' + e.message);
      return Promise.resolve(res);
    }
  }

  // Consulta OPCIONAL de revogação (precisa de rede; a assinatura não precisa).
  function checkStatus(payload, fetchImpl) {
    var st = payload && payload.credentialStatus;
    var f = fetchImpl || (typeof fetch !== 'undefined' ? fetch : null);
    if (!st || !st.id || !f) return Promise.resolve({ checked: false });
    return f(st.id + (st.id.indexOf('?') >= 0 ? '&' : '?') + 'id=' + encodeURIComponent(payload.id), { cache: 'no-store' })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (j) {
        if (!j) return { checked: false };
        var hit = (j.revokedCredentials || []).filter(function (x) { return x.id === payload.id; })[0];
        return { checked: true, revoked: !!hit, entry: hit || null, history: j.history || [] };
      })
      .catch(function () { return { checked: false }; });
  }

  return { verify: verify, verifyEd25519: verifyEd25519, unbakePng: unbakePng, extractJwt: extractJwt, checkStatus: checkStatus, rawFromDidKey: rawFromDidKey };
});
