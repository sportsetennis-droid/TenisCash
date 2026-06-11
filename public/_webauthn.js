// Login pelo rosto — UNIFICADO. As telas só chamam TCBio.login()/register()/available()/mountEnrollChip().
// Por baixo: se o aparelho tem Face ID/digital/Windows Hello → usa WebAuthn (mais seguro);
// senão → usa a CÂMERA + face-api (reconhecimento do nosso sistema, funciona em qualquer aparelho).
// A imagem NUNCA sai do aparelho (só o "descriptor" de 128 números). Senha continua como fallback.
(function () {
  // ---------- helpers base64url <-> ArrayBuffer (WebAuthn) ----------
  function b64uToBuf(b64u) {
    const b64 = b64u.replace(/-/g, '+').replace(/_/g, '/');
    const pad = (4 - (b64.length % 4)) % 4;
    const bin = atob(b64 + '='.repeat(pad));
    const buf = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
    return buf.buffer;
  }
  function bufToB64u(buf) {
    const bytes = new Uint8Array(buf); let bin = '';
    for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }
  async function api(base, path, body, token) {
    const headers = { 'Content-Type': 'application/json' };
    if (token) headers['Authorization'] = 'Bearer ' + token;
    const r = await fetch('/api/' + base + '/' + path, { method: 'POST', headers, body: JSON.stringify(body || {}) });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(data.error || ('Erro ' + r.status));
    return data;
  }

  // ================= WebAuthn (Face ID / digital / Windows Hello) =================
  const WA = {
    supported() { return !!(window.PublicKeyCredential && navigator.credentials && navigator.credentials.create); },
    async platformAvailable() { if (!this.supported()) return false; try { return await PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable(); } catch { return false; } },
    async login() {
      const opts = await api('webauthn', 'auth/options', {});
      opts.challenge = b64uToBuf(opts.challenge);
      if (Array.isArray(opts.allowCredentials)) opts.allowCredentials.forEach(c => { c.id = b64uToBuf(c.id); });
      const a = await navigator.credentials.get({ publicKey: opts });
      if (!a) throw new Error('Cancelado');
      const cred = { id: a.id, rawId: bufToB64u(a.rawId), type: a.type, response: { authenticatorData: bufToB64u(a.response.authenticatorData), clientDataJSON: bufToB64u(a.response.clientDataJSON), signature: bufToB64u(a.response.signature), userHandle: a.response.userHandle ? bufToB64u(a.response.userHandle) : undefined }, clientExtensionResults: a.getClientExtensionResults ? a.getClientExtensionResults() : {}, authenticatorAttachment: a.authenticatorAttachment || undefined };
      return await api('webauthn', 'auth/verify', { cred });
    },
    async register(token, label) {
      const opts = await api('webauthn', 'register/options', {}, token);
      opts.challenge = b64uToBuf(opts.challenge); opts.user.id = b64uToBuf(opts.user.id);
      if (Array.isArray(opts.excludeCredentials)) opts.excludeCredentials.forEach(c => { c.id = b64uToBuf(c.id); });
      const c = await navigator.credentials.create({ publicKey: opts });
      if (!c) throw new Error('Cancelado');
      const cred = { id: c.id, rawId: bufToB64u(c.rawId), type: c.type, response: { attestationObject: bufToB64u(c.response.attestationObject), clientDataJSON: bufToB64u(c.response.clientDataJSON), transports: c.response.getTransports ? c.response.getTransports() : [] }, clientExtensionResults: c.getClientExtensionResults ? c.getClientExtensionResults() : {}, authenticatorAttachment: c.authenticatorAttachment || undefined };
      return await api('webauthn', 'register/verify', { cred, label: label || '' }, token);
    },
    async status(token) { try { const r = await fetch('/api/webauthn/status', { headers: { Authorization: 'Bearer ' + token } }); return await r.json(); } catch { return { enrolled: false }; } },
  };

  // ================= Câmera + face-api (nosso reconhecimento, qualquer aparelho) =================
  const FACE = {
    LIB: 'https://cdn.jsdelivr.net/npm/@vladmandic/face-api/dist/face-api.js',
    MODELS: 'https://cdn.jsdelivr.net/npm/@vladmandic/face-api/model',
    _ready: null,
    cameraSupported() { return !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia); },
    _loadScript(src) { return new Promise((res, rej) => { const s = document.createElement('script'); s.src = src; s.onload = res; s.onerror = () => rej(new Error('Falha ao carregar o reconhecimento facial')); document.head.appendChild(s); }); },
    async ensure() {
      if (this._ready) return this._ready;
      this._ready = (async () => {
        if (!window.faceapi) await this._loadScript(this.LIB);
        await faceapi.nets.tinyFaceDetector.loadFromUri(this.MODELS);
        await faceapi.nets.faceLandmark68Net.loadFromUri(this.MODELS);
        await faceapi.nets.faceRecognitionNet.loadFromUri(this.MODELS);
      })();
      return this._ready;
    },
    _ear(eye) { const d = (a, b) => Math.hypot(a._x - b._x, a._y - b._y); return (d(eye[1], eye[5]) + d(eye[2], eye[4])) / (2 * d(eye[0], eye[3])); },
    _overlay(title) {
      const ov = document.createElement('div');
      ov.style.cssText = 'position:fixed;inset:0;z-index:100000;background:rgba(0,0,0,.92);display:flex;flex-direction:column;align-items:center;justify-content:center;gap:14px;padding:20px;';
      const vid = document.createElement('video'); vid.autoplay = true; vid.playsInline = true; vid.muted = true;
      vid.style.cssText = 'width:260px;height:260px;border-radius:50%;object-fit:cover;border:3px solid #E5571E;transform:scaleX(-1);background:#000;';
      const msg = document.createElement('div'); msg.style.cssText = 'color:#fff;font:600 16px system-ui;text-align:center;max-width:300px;';
      msg.textContent = title; const x = document.createElement('button');
      x.textContent = 'Cancelar'; x.style.cssText = 'background:#fff;border:none;border-radius:20px;padding:10px 20px;font-weight:700;cursor:pointer;';
      ov.appendChild(vid); ov.appendChild(msg); ov.appendChild(x); document.body.appendChild(ov);
      return { ov, vid, setMsg: (t) => { msg.textContent = t; }, onCancel: (fn) => { x.onclick = fn; }, close: () => ov.remove() };
    },
    // Abre a câmera, exige uma PISCADA (anti-foto) e devolve o descriptor (128 nums) ou erro.
    async capture(title) {
      if (!this.cameraSupported()) throw new Error('Este aparelho não tem câmera disponível. Use a senha.');
      const ui = this._overlay('Carregando…');
      let stream, cancelled = false;
      ui.onCancel(() => { cancelled = true; });
      try {
        await this.ensure();
        stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'user' } });
        ui.vid.srcObject = stream; await ui.vid.play();
        ui.setMsg(title + ' — olhe pra câmera');
        const opts = new faceapi.TinyFaceDetectorOptions({ inputSize: 320, scoreThreshold: 0.5 });
        let blinked = false; const wait = (ms) => new Promise(r => setTimeout(r, ms)); const t0 = Date.now();
        while (!cancelled && Date.now() - t0 < 20000) {
          const det = await faceapi.detectSingleFace(ui.vid, opts).withFaceLandmarks().withFaceDescriptor();
          if (!det) { ui.setMsg('Centralize o rosto no círculo'); await wait(100); continue; }
          const e = (this._ear(det.landmarks.getLeftEye()) + this._ear(det.landmarks.getRightEye())) / 2;
          if (e < 0.2) { blinked = true; ui.setMsg('Quase lá…'); }
          else if (blinked) { return Array.from(det.descriptor); } // piscou e reabriu → captura (rosto vivo)
          else ui.setMsg('Pisque uma vez 👁️');
          await wait(70);
        }
        throw new Error(cancelled ? 'Cancelado' : 'Não consegui ler o rosto. Tente de novo ou use a senha.');
      } finally { if (stream) stream.getTracks().forEach(t => t.stop()); ui.close(); }
    },
    async login() { const descriptor = await this.capture('Entrar com o rosto'); return await api('face', 'login', { descriptor }); },
    async enroll(token, label) { const descriptor = await this.capture('Cadastrar seu rosto'); return await api('face', 'enroll', { descriptor, label }, token); },
    async status(token) { try { const r = await fetch('/api/face/status', { headers: { Authorization: 'Bearer ' + token } }); return await r.json(); } catch { return { enrolled: false }; } },
  };

  // ================= API pública unificada (o que as telas usam) =================
  const TCBio = {
    async available() { return (await WA.platformAvailable()) || FACE.cameraSupported(); },
    async _useWA() { return await WA.platformAvailable(); },

    async login() { return (await this._useWA()) ? WA.login() : FACE.login(); },
    async register(token, label) { return (await this._useWA()) ? WA.register(token, label) : FACE.enroll(token, label); },
    async status(token) {
      const useWA = await this._useWA();
      const st = useWA ? await WA.status(token) : await FACE.status(token);
      return { enrolled: !!(st && st.enrolled), method: useWA ? 'webauthn' : 'face' };
    },

    async loginAndReload(tokenKey) { const data = await this.login(); try { localStorage.setItem(tokenKey, data.token); } catch (_) {} location.reload(); },

    async mountEnrollChip(token) {
      try {
        if (!token || !(await this.available())) return;
        const st = await this.status(token);
        if (st && st.enrolled) return;
        if (document.getElementById('tcBioChip')) return;
        const chip = document.createElement('button');
        chip.id = 'tcBioChip'; chip.type = 'button'; chip.textContent = '👤 Ativar entrada com o rosto';
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
