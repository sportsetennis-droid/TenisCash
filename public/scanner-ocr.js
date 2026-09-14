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
  async function imageCanvas(image) {
    if (image && typeof image.getContext === 'function') return image;
    const img = new Image();
    const blobURL = typeof image === 'string' ? null : URL.createObjectURL(image);
    try {
      await new Promise((resolve, reject) => { img.onload = resolve; img.onerror = reject; img.src = blobURL || image; });
      const canvas = document.createElement('canvas');
      const scale = Math.min(1, 1800 / Math.max(img.naturalWidth, img.naturalHeight));
      canvas.width = Math.round(img.naturalWidth * scale); canvas.height = Math.round(img.naturalHeight * scale);
      canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
      return canvas;
    } finally { if (blobURL) URL.revokeObjectURL(blobURL); }
  }
  function textCrop(canvas, region) {
    const crop = document.createElement('canvas');
    const scale = Math.min(region.kind === 'size' ? 4 : 2, 2000 / region.width);
    crop.width = Math.round(region.width * scale); crop.height = Math.round(region.height * scale);
    const ctx = crop.getContext('2d', { willReadFrequently: true });
    ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(canvas, region.x, region.y, region.width, region.height, 0, 0, crop.width, crop.height);
    const pixels = ctx.getImageData(0, 0, crop.width, crop.height);
    window.ScannerRegions.normalizePixels(pixels.data); ctx.putImageData(pixels, 0, 0);
    return crop;
  }
  function usefulReference(text) {
    return /\b[A-Z]{2}\d{4}[- ]?\d{3}\b/i.test(text) || /\b[A-Z]{3,}-[A-Z0-9-]{3,}\b/i.test(text);
  }
  async function recognize(image, progress) {
    clearTimeout(idleTimer);
    let deadline, expired = false;
    try {
      progress?.('Lendo referência no aparelho…');
      const work = (async () => {
        const ready = await getWorker();
        if (expired) throw new Error('Leitura local demorou demais');
        const canvas = await imageCanvas(image);
        const pixels = canvas.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, canvas.width, canvas.height);
        const regions = window.ScannerRegions.findRegions(pixels);
        let best = '';
        // Read the reference strip apart from the barcode and packaging text.
        for (const region of regions) {
          if (expired) throw new Error('Leitura local demorou demais');
          const { data } = await ready.recognize(textCrop(canvas, region));
          let text = String(data.text || '').slice(0, 3500);
          if (data.confidence >= 40 && usefulReference(text)) {
            if (region.kind === 'header-text') {
              // Read the size in the same label separately; never convert AL to XL.
              const sizeRegion = { kind: 'size', x: region.x + Math.round(region.width * .80),
                y: region.y + Math.round(region.height * .52), width: Math.round(region.width * .20),
                height: Math.round(region.height * .42) };
              await ready.setParameters({ tessedit_pageseg_mode: '7' });
              const sizeResult = await ready.recognize(textCrop(canvas, sizeRegion));
              await ready.setParameters({ tessedit_pageseg_mode: '11' });
              const size = String(sizeResult.data.text || '').trim().toUpperCase();
              if (sizeResult.data.confidence >= 60 && /^(XXXL|XXL|XL|XS|L|M|S|P|G|GG|PP)$/.test(size)) text += '\n' + size;
            }
            if (/^\s*(?:SIZE\s+)?(?:XL|XXL|XS|L|M|S|P|G|GG|PP)\s*$/im.test(text) || /\bBR\s*\d{2}/i.test(text)) return text;
            if (!best) best = text;
          }
        }
        if (best) return best;
        const result = await ready.recognize(canvas);
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

