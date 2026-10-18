/* Shared live-camera scheduling. Frames stay in memory; this never saves photos. */
(function (root) {
  'use strict';
  const constraints = { audio: false, video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1080 }, frameRate: { ideal: 30, max: 30 } } };
  function warmup() { void root.ScannerAuto?.warmupDecoder?.().catch(() => false); }
  async function tune(stream) {
    try {
      const track = stream?.getVideoTracks()[0], caps = track?.getCapabilities?.();
      // Ask only for advertised capabilities. Do not force a zoom/lens change.
      if (caps?.focusMode?.includes('continuous')) await track.applyConstraints({ advanced: [{ focusMode: 'continuous' }] });
    } catch (_) { /* Optional focus tuning cannot prevent live reading. */ }
  }
  function snapshot(video) {
    if (!video?.videoWidth || !video.videoHeight || video.readyState < 2) return null;
    const sourceWidth = video.videoWidth, sourceHeight = video.videoHeight;
    let width = sourceWidth, height = sourceHeight, x = 0, y = 0;
    const rect = video.getBoundingClientRect?.();
    // A portrait preview may crop a landscape stream. Decode only pixels the
    // operator can actually see, instead of hidden neighbouring boxes.
    if (rect?.width > 0 && rect.height > 0 && root.getComputedStyle(video).objectFit === 'cover') {
      const ratio = Math.max(rect.width / sourceWidth, rect.height / sourceHeight);
      width = Math.min(sourceWidth, rect.width / ratio); height = Math.min(sourceHeight, rect.height / ratio);
      x = (sourceWidth - width) / 2; y = (sourceHeight - height) / 2;
    }
    const scale = Math.min(1, 1800 / Math.max(width, height)), canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(width * scale)); canvas.height = Math.max(1, Math.round(height * scale));
    canvas.getContext('2d', { willReadFrequently: true }).drawImage(video, x, y, width, height, 0, 0, canvas.width, canvas.height);
    return canvas;
  }
  function start(video, scanner, interval = 80) {
    const hasFrameCallback = typeof video.requestVideoFrameCallback === 'function';
    let stopped = false, timer = null, callback = null, serial = 0, seen = hasFrameCallback ? 0 : -1, lastTime = -1, lastResume = -Infinity;
    const onFrame = () => { if (stopped) return; serial++; callback = video.requestVideoFrameCallback(onFrame); };
    if (hasFrameCallback) callback = video.requestVideoFrameCallback(onFrame);
    async function next() {
      if (stopped) return;
      const started = performance.now();
      try {
        if (video.paused && !video.ended && video.srcObject?.active && !document.hidden && started - lastResume > 1500) {
          lastResume = started;
          // Safari may pause an active stream after an interruption. Resume the
          // same stream, never open another camera or retry a saved capture.
          void video.play().catch(() => {});
        }
        const current = video.currentTime;
        const fresh = hasFrameCallback ? serial !== seen : current !== lastTime;
        if (video.readyState >= 2 && !video.paused && !video.ended && fresh) {
          seen = serial; lastTime = current;
          await scanner.tick();
        }
      } catch (_) { /* A transient video frame error must not stop the loop. */ }
      finally {
        if (!stopped) timer = setTimeout(next, Math.max(16, interval - (performance.now() - started)));
      }
    }
    timer = setTimeout(next, 0);
    return { stop() { stopped = true; clearTimeout(timer); if (callback !== null) video.cancelVideoFrameCallback?.(callback); } };
  }
  let flashTimer;
  function feedback(text) {
    const flash = document.getElementById('etiq-flash'); if (!flash) return;
    clearTimeout(flashTimer); flash.textContent = text; flash.style.display = 'flex';
    flashTimer = setTimeout(() => { flash.style.display = 'none'; }, 550);
  }
  root.ScannerCamera = { constraints, warmup, tune, snapshot, start, feedback };
})(window);
