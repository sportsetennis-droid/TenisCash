(function (root) {
  'use strict';
  function create(options) {
    const storage = options.storage || root.ScannerPhotoStorage.create({ namespace: 'action-archive' });
    let running = null;
    async function changed(row) {
      const siblings = await storage.read({ includeImages: false, filter: x => x.lotId === row.lotId && x.scanId === row.scanId });
      await options.changed?.({ ...row, allArchived: siblings.length > 0 && siblings.every(x => x.status === 'archived'),
        error: siblings.find(x => x.status !== 'archived' && x.error)?.error || '' });
    }
    async function encode(frame) {
      if (!frame?.width || !frame?.height) throw Error('A câmera não capturou a etiqueta. Fotografe esta mesma peça novamente.');
      let canvas = frame;
      const longest = Math.max(frame.width, frame.height);
      if (longest > 2048) {
        canvas = document.createElement('canvas'); canvas.width = Math.round(frame.width * 2048 / longest); canvas.height = Math.round(frame.height * 2048 / longest);
        canvas.getContext('2d').drawImage(frame, 0, 0, canvas.width, canvas.height);
      }
      for (const quality of [0.9, 0.8, 0.7, 0.6]) {
        const image = canvas.toDataURL('image/jpeg', quality);
        if (image.startsWith('data:image/jpeg;base64,') && image.length < 1350000) return image;
      }
      throw Error('A foto ficou muito grande. Aproxime a etiqueta e fotografe a mesma peça novamente.');
    }
    async function capture(draft, item, frame) {
      const b64 = await encode(frame), id = root.crypto.randomUUID();
      const row = { clientScanId: id, scanId: item.clientScanId, lotId: draft.sessionId, operatorId: draft.context.actorId, context: draft.context,
        barcode: item.barcode, scanCreatedAt: item.createdAt, capturedAt: new Date().toISOString(), b64, ocrText: item.ocrText || '', status: 'pending' };
      await storage.append('id:' + id, row);
      await changed(row); return row;
    }
    async function updateText(captureId, text) {
      if (!captureId || !String(text || '').trim()) return;
      await storage.append('id:' + captureId, { ocrText: String(text).slice(0, 12000), status: 'pending' });
      const row = (await storage.read({ includeImages: false, filter: x => x.clientScanId === captureId }))[0];
      if (row) await changed(row);
    }
    async function flush() {
      if (running) return running;
      running = (async () => {
        const rows = await storage.read({ filter: row => (row.status !== 'archived' || row.identificationPending) && options.canUpload(row) });
        for (const row of rows) {
          if (!options.canUpload(row)) break;
          try {
            if (options.beforeUpload && !await options.beforeUpload(row)) continue;
            const data = await options.upload(row);
            if (!data?.archived || !data.photo?.id) throw Error('O servidor ainda não confirmou a foto.');
            // Another OCR update may have arrived during this upload. Keep it pending.
            const latest = (await storage.read({ includeImages: false, filter: x => x.clientScanId === row.clientScanId }))[0];
            const status = (latest?.ocrText || '') === (row.ocrText || '') ? 'archived' : 'pending';
            const update = { status, photoId: data.photo.id, error: '', identificationPending: data.identification?.retry === true };
            await storage.append('id:' + row.clientScanId, update); await changed({ ...row, ...update });
          } catch (error) {
            const update = { status: 'pending', error: error.message || 'Sem conexão. Foto preservada neste aparelho.' };
            await storage.append('id:' + row.clientScanId, update); await changed({ ...row, ...update });
          }
        }
      })().finally(() => { running = null; });
      return running;
    }
    const rows = (lotId, scanId) => storage.read({ filter: row => row.lotId === lotId && row.scanId === scanId });
    return { capture, flush, updateText, rows, metadata: () => storage.read({ includeImages: false }) };
  }
  root.ScanActionPhotos = { create };
})(typeof window !== 'undefined' ? window : globalThis);
