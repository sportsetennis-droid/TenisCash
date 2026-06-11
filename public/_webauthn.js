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

    // Atalho p/ telas que entram via "token no localStorage + reload": entra com o rosto,
    // salva o token na chave da tela e recarrega (a própria tela valida role + entra).
    async loginAndReload(tokenKey) {
      const data = await this.login();
      try { localStorage.setItem(tokenKey, data.token); } catch (_) {}
      location.reload();
    },

    // Mostra um botão flutuante "Ativar entrada com o rosto" em QUALQUER tela, se: aparelho
    // suporta + está logado (token) + ainda não cadastrou. Some após ativar. Reutilizável.
    async mountEnrollChip(token, opts) {
      try {
        if (!token || !(await this.available())) return;
        const st = await this.status(token);
        if (st && st.enrolled) return;
        if (document.getElementById('tcBioChip')) return;
        const chip = document.createElement('button');
        chip.id = 'tcBioChip';
        chip.type = 'button';
        chip.textContent = '👤 Ativar entrada com o rosto';
        chip.style.cssText = 'position:fixed;left:50%;transform:translateX(-50%);bottom:16px;z-index:99999;background:#E5571E;color:#fff;border:none;border-radius:24px;padding:12px 18px;font-size:13px;font-weight:700;box-shadow:0 4px 16px rgba(0,0,0,.25);cursor:pointer;max-width:92vw;';
        chip.onclick = async () => {
          chip.disabled = true; chip.textContent = 'Aguarde…';
          try { await this.register(token, (navigator.userAgent || '').slice(0, 50)); chip.textContent = '✅ Rosto ativado'; chip.style.background = '#0a843d'; setTimeout(() => chip.remove(), 2500); }
          catch (e) { const m = String((e && e.message) || ''); if (!/cancel|NotAllowed|abort|The operation/i.test(m)) alert('Não deu pra ativar: ' + m); chip.disabled = false; chip.textContent = '👤 Ativar entrada com o rosto'; }
        };
        document.body.appendChild(chip);
      } catch (_) {}
    },
  };
  window.TCBio = TCBio;
})();
