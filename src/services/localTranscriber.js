// Transcrição de áudio SEM API (dono 18/11/2026: "precisa funcionar por áudio e sem api").
// Roda o Whisper (modelo aberto) dentro do próprio servidor com o transformers.js
// (github.com/huggingface/transformers.js) + ffmpeg (já no nixpacks.toml) para abrir o
// áudio do WhatsApp (ogg/opus). Nada sai do servidor, nada é cobrado por uso.
//  - Modelo: ASR_MODEL (padrão onnx-community/whisper-small, q8). O "base" errava o nome da loja.
//  - Um áudio por vez (fila) para não estourar memória.
//  - O modelo sai da memória depois de ASR_IDLE_MIN minutos sem uso (padrão 15).

const { spawn } = require('child_process');

const MODEL = process.env.ASR_MODEL || 'onnx-community/whisper-small';
const DTYPE = process.env.ASR_DTYPE || 'q8';
const IDLE_MS = Math.max(1, Number(process.env.ASR_IDLE_MIN || 15)) * 60 * 1000;
const MAX_SECONDS = Math.max(10, Number(process.env.ASR_MAX_SECONDS || 180));

const state = { loaded: false, loading: false, calls: 0, failures: 0, lastMs: null, lastError: null };
let pipePromise = null;
let idleTimer = null;
let queue = Promise.resolve();

function decodeToPcm(buf) {
  return new Promise((resolve, reject) => {
    const p = spawn(process.env.FFMPEG_PATH || 'ffmpeg', ['-hide_banner', '-loglevel', 'error', '-i', 'pipe:0', '-t', String(MAX_SECONDS), '-ac', '1', '-ar', '16000', '-f', 'f32le', 'pipe:1']);
    const chunks = []; let err = '';
    p.stdout.on('data', (c) => chunks.push(c));
    p.stderr.on('data', (d) => { err += d; });
    p.on('error', reject);
    p.on('close', (code) => {
      if (code !== 0) return reject(new Error(`ffmpeg ${code} ${err.slice(0, 160)}`));
      const b = Buffer.concat(chunks);
      resolve(new Float32Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.length - (b.length % 4))));
    });
    p.stdin.on('error', () => {});
    p.stdin.end(buf);
  });
}

function getPipe() {
  if (!pipePromise) {
    state.loading = true;
    pipePromise = (async () => {
      const { pipeline } = await import('@huggingface/transformers');
      const asr = await pipeline('automatic-speech-recognition', MODEL, { dtype: DTYPE });
      state.loaded = true;
      return asr;
    })().catch((e) => { pipePromise = null; throw e; }).finally(() => { state.loading = false; });
  }
  return pipePromise;
}

function scheduleUnload() {
  clearTimeout(idleTimer);
  idleTimer = setTimeout(async () => {
    const p = pipePromise; pipePromise = null; state.loaded = false;
    try { const asr = await p; if (asr && asr.dispose) await asr.dispose(); } catch (_) {}
  }, IDLE_MS);
  if (idleTimer.unref) idleTimer.unref();
}

async function runOne(buf) {
  const t0 = Date.now();
  const audio = await decodeToPcm(buf);
  if (audio.length < 16000 * 0.4) return { ok: false, reason: 'curto' };
  const asr = await getPipe();
  const out = await asr(audio, { language: 'portuguese', task: 'transcribe', chunk_length_s: 30, stride_length_s: 5 });
  state.lastMs = Date.now() - t0;
  const text = String((out && out.text) || '').replace(/\s+/g, ' ').trim();
  return text ? { ok: true, text } : { ok: false, reason: 'vazio' };
}

// Entrada: base64 do áudio (como vem da Evolution). Saída: { ok, text } ou { ok:false, reason }.
function transcribeBase64(base64) {
  const buf = Buffer.from(String(base64 || ''), 'base64');
  const job = queue.then(() => runOne(buf));
  queue = job.catch(() => {}).finally(scheduleUnload);
  state.calls++;
  return job.catch((e) => { state.failures++; state.lastError = String(e.message || e).slice(0, 160); return { ok: false, reason: state.lastError }; });
}

function getAsrState() { return { modelo: MODEL, carregado: state.loaded, carregando: state.loading, chamadas: state.calls, falhas: state.failures, ultimoTempoMs: state.lastMs, ultimoErro: state.lastError }; }

module.exports = { transcribeBase64, getAsrState, decodeToPcm };
