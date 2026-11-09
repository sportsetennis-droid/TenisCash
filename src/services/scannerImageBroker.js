'use strict';
const { fork } = require('node:child_process');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

const limits = Object.freeze({ maxImageBytes: 12 * 1024 * 1024, maxQueuedBytes: 24 * 1024 * 1024,
  maxQueued: 8, labelTimeoutMs: 24000, barcodeTimeoutMs: 8000, maxRssBytes: 384 * 1024 * 1024,
  idleMs: 30000, maxJobs: 12, heapMb: 128 });
function failure(code) { const error = Error(code); error.code = code; return error; }

// Labels are scheduled by the durable queue. Barcode callers have a bounded
// FIFO for compatibility with concurrent recovery; never retain unlimited images.
function createBroker(options = {}) {
  const cfg = { ...limits, ...options.limits };
  const spawn = options.spawn || (() => fork(path.join(__dirname, 'scannerImageWorker.js'), [], {
    stdio: ['ignore', 'ignore', 'ignore', 'ipc'], serialization: 'advanced', windowsHide: true,
    execArgv: [`--max-old-space-size=${cfg.heapMb}`],
  }));
  let state = null, active = null, queuedBytes = 0, idleTimer, closed = false;
  const queue = [];
  function stats() { return { running: !!active, stopping: !!state?.stopping, pid: state?.child.pid || null,
    queued: queue.length, queuedBytes, rss: state?.rss || 0, completedInProcess: state?.jobs || 0 }; }
  function settle(job, error, result) {
    if (!job || job.done) return;
    job.done = true; clearTimeout(job.timer);
    if (active === job) active = null;
    job.image = null;
    if (error) job.reject(error); else job.resolve(result);
  }
  function retire(current, error) {
    if (!current || current !== state || current.stopping) return;
    current.stopping = true; clearTimeout(idleTimer);
    current.child.ref(); current.child.channel?.ref();
    if (active) settle(active, error || failure('SCANNER_IMAGE_UNAVAILABLE'));
    // Keep ownership until this PID exits: never overlap a replacement process
    // with old native code still running or terminating.
    try { current.child.kill('SIGKILL'); } catch (_) { /* exit/error owns cleanup */ }
  }
  function finishExit(current) {
    if (current !== state) return;
    clearTimeout(idleTimer);
    if (active) settle(active, failure('SCANNER_IMAGE_UNAVAILABLE'));
    state = null; current.exitedResolve(); pump();
  }
  function ensureProcess() {
    if (state) return state;
    const child = spawn();
    const current = { child, ready: false, stopping: false, jobs: 0, rss: 0 };
    current.exited = new Promise(resolve => { current.exitedResolve = resolve; });
    state = current;
    child.on('message', message => {
      if (current !== state || current.stopping || !message) return;
      if (message.type === 'ready') { current.ready = true; dispatch(); return; }
      if (message.type === 'memory') {
        current.rss = Number(message.rss) || 0;
        if (current.rss > cfg.maxRssBytes) retire(current, failure('SCANNER_IMAGE_MEMORY_LIMIT'));
        return;
      }
      if (!active || message.id !== active.id) return;
      if (message.type === 'failure') { retire(current, failure('SCANNER_IMAGE_UNAVAILABLE')); return; }
      if (message.type === 'result') {
        current.jobs++; settle(active, null, message.result);
        if (current.jobs >= cfg.maxJobs) retire(current); else pump();
      }
    });
    child.once('error', () => {
      retire(current, failure('SCANNER_IMAGE_UNAVAILABLE'));
      if (!child.pid) finishExit(current); // failed spawn may not emit exit
    });
    child.once('exit', () => finishExit(current));
    child.unref(); child.channel?.unref();
    return current;
  }
  function dispatch() {
    if (!active || active.sent || !state?.ready || state.stopping) return;
    active.sent = true;
    const job = active;
    try {
      state.child.send({ type: 'run', id: job.id, kind: job.kind, image: job.image, barcode: job.barcode }, error => {
        if (error && active === job) retire(state, failure('SCANNER_IMAGE_UNAVAILABLE'));
      });
    } catch (_) { retire(state, failure('SCANNER_IMAGE_UNAVAILABLE')); }
  }
  function start(job) {
    active = job; clearTimeout(idleTimer);
    try {
      const current = ensureProcess();
      current.child.ref(); current.child.channel?.ref();
      job.timer = setTimeout(() => { if (active === job) retire(current, failure('SCANNER_IMAGE_TIMEOUT')); },
        job.kind === 'label' ? cfg.labelTimeoutMs : cfg.barcodeTimeoutMs);
      dispatch();
    } catch (_) { settle(job, failure('SCANNER_IMAGE_UNAVAILABLE')); pump(); }
  }
  function pump() {
    if (active || state?.stopping) return;
    if (closed) { if (state) retire(state); return; }
    const job = queue.shift();
    if (job) { queuedBytes -= job.image.length; start(job); return; }
    if (state) {
      state.child.unref(); state.child.channel?.unref();
      const current = state;
      idleTimer = setTimeout(() => retire(current), cfg.idleMs); idleTimer.unref?.();
    }
  }
  function run(kind, image, barcode, { queue: allowQueue = false } = {}) {
    if (!['label', 'barcode'].includes(kind) || !Buffer.isBuffer(image) || !image.length || image.length > cfg.maxImageBytes) {
      return Promise.reject(failure('SCANNER_IMAGE_INVALID'));
    }
    if (closed) return Promise.reject(failure('SCANNER_IMAGE_UNAVAILABLE'));
    const waiting = !!active || !!state?.stopping || queue.length > 0;
    if (waiting && (!allowQueue || queue.length >= cfg.maxQueued || queuedBytes + image.length > cfg.maxQueuedBytes)) {
      return Promise.reject(failure('SCANNER_IMAGE_BUSY'));
    }
    return new Promise((resolve, reject) => {
      const job = { id: randomUUID(), kind, image, barcode, resolve, reject, done: false };
      if (waiting) { queue.push(job); queuedBytes += image.length; pump(); } else start(job);
    });
  }
  async function shutdown() {
    closed = true;
    for (const job of queue.splice(0)) settle(job, failure('SCANNER_IMAGE_UNAVAILABLE'));
    queuedBytes = 0;
    if (state) { const current = state; retire(current); await current.exited; }
  }
  return { run, shutdown, getStatus: stats };
}
module.exports = { ...createBroker(), createBroker, limits, failure };
