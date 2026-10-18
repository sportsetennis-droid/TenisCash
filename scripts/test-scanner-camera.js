'use strict';
const assert = require('node:assert/strict'), fs = require('node:fs'), vm = require('node:vm');
const source = fs.readFileSync(require('node:path').join(__dirname, '../public/scanner-camera.js'), 'utf8');
function harness() {
  let clock = 0, id = 0; const timers = new Map(), draws = [], canvas = [];
  const window = { getComputedStyle: video => ({ objectFit: video.fit || 'contain' }), ScannerAuto: { warmupDecoder: async () => true } };
  const document = { hidden: false, getElementById: () => null, createElement: () => { const c = { getContext: () => ({ drawImage: (...args) => draws.push(args) }) }; canvas.push(c); return c; } };
  const context = vm.createContext({ window, document, performance: { now: () => clock }, setTimeout(fn, delay) { const key = ++id; timers.set(key, { fn, at: clock + delay }); return key; }, clearTimeout: key => timers.delete(key) });
  vm.runInContext(source, context);
  return { api: window.ScannerCamera, timers, draws, canvas, document, async advance(ms) { clock += ms; const ready = [...timers].filter(([,t]) => t.at <= clock); for (const [key,t] of ready) { timers.delete(key); await t.fn(); } } };
}
async function main() {
  const h = harness();
  const video = { videoWidth: 1920, videoHeight: 1080, readyState: 4, paused: false, ended: false, currentTime: 0, getBoundingClientRect: () => ({ width: 390, height: 700 }) };
  const full = h.api.snapshot(video); assert.equal(full.width, 1800); assert.equal(full.height, 1013);
  video.fit = 'cover'; const visible = h.api.snapshot(video); assert.equal(visible.width, 602); assert.equal(visible.height, 1080);
  assert(h.draws.at(-1)[1] > 650); assert.equal(h.draws.at(-1)[2], 0, 'crop centered horizontally, not a different shelf');
  video.videoWidth = 1080; video.videoHeight = 1920; video.getBoundingClientRect = () => ({ width: 900, height: 500 });
  const horizontal = h.api.snapshot(video); assert.equal(horizontal.width, 1080); assert.equal(horizontal.height, 600); assert(h.draws.at(-1)[2] > 600);
  video.readyState = 1; assert.equal(h.api.snapshot(video), null); video.readyState = 4;
  let calls = 0; const reader = { tick: async () => { calls++; } }, loop = h.api.start(video, reader);
  await h.advance(0); assert.equal(calls, 1);
  await h.advance(80); await h.advance(80); assert.equal(calls, 1, 'a frozen video frame cannot satisfy two-frame confirmation');
  video.currentTime = 1; await h.advance(80); assert.equal(calls, 2);
  let plays = 0; video.srcObject = { active: true }; video.play = async () => { plays++; video.paused = false; }; video.paused = true;
  await h.advance(80); assert.equal(plays, 1); video.currentTime = 2; await h.advance(80); assert.equal(calls, 3);
  h.document.hidden = true; video.paused = true; await h.advance(1600); assert.equal(plays, 1, 'background camera is not reopened');
  loop.stop(); video.paused = false; video.currentTime = 3; await h.advance(2000); assert.equal(calls, 3, 'closed loop cannot restart');
  const slow = harness(); let finish, inflight = 0, peak = 0, reads = 0;
  video.currentTime = 0; const slowLoop = slow.api.start(video, { tick() { reads++; peak = Math.max(peak, ++inflight); return new Promise(resolve => { finish = () => { inflight--; resolve(); }; }); } });
  const pending = slow.advance(0); await Promise.resolve(); video.currentTime = 1; await slow.advance(1000); assert.equal(reads, 1); assert.equal(peak, 1);
  slowLoop.stop(); finish(); await pending; await slow.advance(1000); assert.equal(reads, 1, 'an old decoder completion never schedules a closed camera');
  let requested, cb, cancelled; video.requestVideoFrameCallback = fn => { requested = fn; return 7; }; video.cancelVideoFrameCallback = key => { cancelled = key; };
  const frames = harness(); let count = 0; const fresh = frames.api.start(video, { tick: async () => count++ }); await frames.advance(0); assert.equal(count, 0);
  cb = requested; cb(); await frames.advance(80); assert.equal(count, 1, 'new compositor frame works even if media time is rounded');
  video.currentTime += .1; await frames.advance(80); assert.equal(count, 1, 'a media clock update without a new compositor frame cannot satisfy confirmation');
  fresh.stop(); assert.equal(cancelled, 7);
  let constraint; await h.api.tune({ getVideoTracks: () => [{ getCapabilities: () => ({ focusMode: ['manual','continuous'], zoom: { min: 1, max: 8 } }), applyConstraints: async value => { constraint = value; } }] });
  assert.equal(constraint.advanced[0].focusMode, 'continuous'); assert.equal(constraint.advanced[0].zoom, undefined, 'never force an optical lens/zoom change');
  await h.api.tune({ getVideoTracks: () => [{ getCapabilities: () => ({ focusMode: ['continuous'] }), applyConstraints: async () => { throw Error('unsupported'); } }] });
  console.log('PASS: visible preview crop, landscape/portrait, fresh frames, serial decode, pause recovery, background/close cancellation and optional focus');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
