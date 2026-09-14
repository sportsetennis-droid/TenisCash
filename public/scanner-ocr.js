/* Local OCR: self-hosted Tesseract 7, no image API and no per-scan credits. */
(function () {
  'use strict';
  let workerPromise, scriptPromise, worker, idleTimer, generation = 0;
  function loadScript() {
    if (window.Tesseract) return Promise.resolve();
    if (!scriptPromise) scriptPromise = new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = '/vendor/ocr/tesseract.min.js';
      script.onload = resolve;
      script.onerror = () => { script.remove(); scriptPromise = null; reject(new Error('Leitor local indisponível')); };
      document.head.appendChild(script);
    });
    return scriptPromise;
  }
  async function getWorker() {
    if (!workerPromise) {
      const started = generation;
      const pending = (async () => {
      await loadScript();
      const ready = await window.Tesseract.createWorker('eng', 1, {
        workerPath: '/vendor/ocr/worker.min.js', corePath: '/vendor/ocr',
        langPath: '/vendor/ocr', workerBlobURL: false,
      });
      if (started !== generation) { await ready.terminate(); throw new Error('Leitura cancelada'); }
      worker = ready;
      await ready.setParameters({ tessedit_pageseg_mode: '11', preserve_interword_spaces: '1' });
      return ready;
      })().catch(e => { if (workerPromise === pending) workerPromise = null; throw e; });
      workerPromise = pending;
    }
    return workerPromise;
  }
  async function stop() {
    clearTimeout(idleTimer);
    generation++;
    const old = worker;
    worker = null; workerPromise = null;
    if (old) await old.terminate();
  }
  async function recognize(image, progress) {
    clearTimeout(idleTimer);
    let deadline, expired = false;
    try {
      progress?.('Lendo referência no aparelho…');
      const work = (async () => {
        const ready = await getWorker();
        if (expired) throw new Error('Leitura local demorou demais');
        const result = await ready.recognize(image);
        return (result.data.confidence >= 45 ? result.data.text : '').slice(0, 4000);
      })();
      return await Promise.race([work, new Promise((_, reject) => {
        deadline = setTimeout(() => { expired = true; stop(); reject(new Error('Leitura local demorou demais')); }, 45000);
      })]);
    } finally {
      clearTimeout(deadline);
      idleTimer = setTimeout(stop, 60000);
    }
  }
  // The queue uploads the original photo even if OCR is unavailable or times out.
  async function readForScan(image, barcode, progress) {
    if (barcode) try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 4000);
      try {
        const response = await fetch('/api/stocktake/lookup/' + encodeURIComponent(barcode), { signal: controller.signal });
        const data = response.ok ? await response.json() : {};
        if (data.recognized || data.ambiguous) return '';
      } finally { clearTimeout(timer); }
    } catch (_) { /* Still attempt local OCR when the lookup is unavailable. */ }
    try { return await recognize(image, progress); }
    catch (_) { progress?.('Foto será salva para conferência.'); return ''; }
  }
  window.ScannerOCR = { readForScan, recognize, stop };
})();
