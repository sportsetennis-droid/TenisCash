// Login biométrico (WebAuthn) — Face ID / digital / Windows Hello.
// Módulo compartilhado (loja + admin). Sem dependência externa: faz a conversão
// base64url <-> ArrayBuffer na mão. O backend é /api/webauthn/*.
(function () {
  function b64uToBuf(b64u) {
    const b64 = b64u.replace(/-/g, '+').replace(/_/g, '/');
    const pad = (4 - (b64.length % 4)) % 4;
    const bin = atob(b64 + '='.repeat(pad));
    const buf = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
    return buf.buffer;
  }
  function bufToB64u(buf) {
    const bytes = new Uint8Array(buf);
    let bin = '';
    for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }
  async function post(path, body, token) {
    const headers = { 'Content-Type': 'application/json' };
    if (token) headers['Authorization'] = 'Bearer ' + token;
    const r = await fetch('/api/webauthn/' + path, { method: 'POST', headers, body: JSON.stringify(body || {}) });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(data.error || ('Erro ' + r.status));
    return data;
  }

  const TCBio = {
    // Suportado pelo aparelho/navegador?
    supported() { return !!(window.PublicKeyCredential && navigator.credentials && navigator.credentials.create); },
    // O aparelho tem biometria/desbloqueio disponível? (Face ID, digital, Windows Hello)
    async available() {
      if (!this.supported()) return false;
      try { return await PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable(); }
      catch { return false; }
    },

    // PASSO B — ENTRAR com o rosto. Retorna { token, user }. Lança erro se falhar/cancelar.
    async login() {
      const opts = await post('auth/options', {});
      opts.challenge = b64uToBuf(opts.challenge);
      if (Array.isArray(opts.allowCredentials)) opts.allowCredentials.forEach(c => { c.id = b64uToBuf(c.id); });
      const a = await navigator.credentials.get({ publicKey: opts });
      if (!a) throw new Error('Cancelado');
      const cred = {
        id: a.id, rawId: bufToB64u(a.rawId), type: a.type,
        response: {
          authenticatorData: bufToB64u(a.response.authenticatorData),
          clientDataJSON: bufToB64u(a.response.clientDataJSON),
          signature: bufToB64u(a.response.signature),
          userHandle: a.response.userHandle ? bufToB64u(a.response.userHandle) : undefined,
        },
        clientExtensionResults: a.getClientExtensionResults ? a.getClientExtensionResults() : {},
        authenticatorAttachment: a.authenticatorAttachment || undefined,
      };
      return await post('auth/verify', { cred });
    },

    // PASSO A — ATIVAR (precisa estar logado: passa o token). label = nome do aparelho.
    async register(token, label) {
      const opts = await post('register/options', {}, token);
      opts.challenge = b64uToBuf(opts.challenge);
      opts.user.id = b64uToBuf(opts.user.id);
      if (Array.isArray(opts.excludeCredentials)) opts.excludeCredentials.forEach(c => { c.id = b64uToBuf(c.id); });
      const c = await navigator.credentials.create({ publicKey: opts });
      if (!c) throw new Error('Cancelado');
      const cred = {
        id: c.id, rawId: bufToB64u(c.rawId), type: c.type,
        response: {
          attestationObject: bufToB64u(c.response.attestationObject),
          clientDataJSON: bufToB64u(c.response.clientDataJSON),
          transports: c.response.getTransports ? c.response.getTransports() : [],
        },
        clientExtensionResults: c.getClientExtensionResults ? c.getClientExtensionResults() : {},
        authenticatorAttachment: c.authenticatorAttachment || undefined,
      };
      return await post('register/verify', { cred, label: label || '' }, token);
    },

    async status(token) { try { const r = await fetch('/api/webauthn/status', { headers: { Authorization: 'Bearer ' + token } }); return await r.json(); } catch { return { enrolled: false }; } },
  };
  window.TCBio = TCBio;
})();
