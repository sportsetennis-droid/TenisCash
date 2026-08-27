(function () {
  const PDF_JS = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/4.10.38/pdf.min.mjs';
  const PDF_WORKER = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/4.10.38/pdf.worker.min.mjs';

  window.openPdfInBrowser = function openPdfInBrowser(blob, options) {
    const opts = options || {};
    const popup = opts.popupWindow || window.open('', '_blank');
    if (!popup) {
      alert('O navegador bloqueou a nova aba. Permita pop-ups para o TenisCash e tente novamente.');
      return false;
    }

    const blobUrl = URL.createObjectURL(blob);
    const title = String(opts.title || 'PDF — TenisCash').replace(/[<>]/g, '');
    const safeTitle = JSON.stringify(title);
    const safeUrl = JSON.stringify(blobUrl);
    const html = `<!doctype html>
<html lang="pt-BR">
<head>
  <meta charset="utf-8">
  <title>${title}</title>
  <style>
    :root { color-scheme: light; }
    * { box-sizing: border-box; }
    html, body { margin: 0; min-height: 100%; background: #525659; font-family: Arial, sans-serif; }
    #toolbar { position: sticky; top: 0; z-index: 10; display: flex; align-items: center; gap: 10px; padding: 12px 16px; background: #202124; color: #fff; box-shadow: 0 2px 8px rgba(0,0,0,.35); }
    #toolbar strong { margin-right: auto; font-size: 14px; }
    #toolbar button, #toolbar a { border: 0; border-radius: 7px; padding: 9px 13px; background: #f4511e; color: #fff; font-weight: 800; text-decoration: none; cursor: pointer; }
    #status { padding: 18px; color: #fff; text-align: center; }
    #pages { padding: 18px 0 40px; }
    .page { width: 210mm; min-height: 297mm; margin: 0 auto 18px; background: #fff; box-shadow: 0 2px 12px rgba(0,0,0,.35); overflow: hidden; }
    .page canvas { display: block; width: 210mm; height: auto; }
    @media (max-width: 220mm) { .page, .page canvas { width: 100vw; } #pages { padding-top: 0; } }
    @media print {
      @page { size: A4; margin: 0; }
      html, body { background: #fff; }
      #toolbar, #status { display: none !important; }
      #pages { padding: 0; }
      .page { width: 210mm; min-height: 297mm; height: 297mm; margin: 0; box-shadow: none; break-after: page; page-break-after: always; }
      .page:last-child { break-after: auto; page-break-after: auto; }
      .page canvas { width: 210mm; height: 297mm; }
    }
  </style>
</head>
<body>
  <div id="toolbar"><strong>Visualização web — TenisCash</strong><button id="robot" style="background:#0a843d">🖨️ Imprimir na impressora da loja</button><button id="print" style="background:#5f6368">Imprimir pelo navegador</button><a id="download" download="etiquetas.pdf">Baixar PDF</a></div>
  <div id="status">Carregando páginas…</div>
  <main id="pages"></main>
  <script type="module">
    import * as pdfjsLib from ${JSON.stringify(PDF_JS)};
    pdfjsLib.GlobalWorkerOptions.workerSrc = ${JSON.stringify(PDF_WORKER)};
    const pdfUrl = ${safeUrl};
    const pages = document.getElementById('pages');
    const status = document.getElementById('status');
    document.title = ${safeTitle};
    document.getElementById('download').href = pdfUrl;
    document.getElementById('print').onclick = () => window.print();
    // Envia o PDF pro robô de impressão da central (localhost:8790), que manda direto
    // pra impressora por IPP — frente e verso na mesma folha, sem passar pelo Windows.
    const robotBtn = document.getElementById('robot');
    robotBtn.onclick = async () => {
      const original = robotBtn.textContent;
      robotBtn.disabled = true;
      robotBtn.style.opacity = '.7';
      robotBtn.textContent = 'Enviando pra impressora…';
      try {
        const blob = await (await fetch(pdfUrl)).blob();
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), 300000);
        const resp = await fetch('http://localhost:8790/print', {
          method: 'POST', body: blob,
          headers: { 'Content-Type': 'application/pdf' },
          signal: ctrl.signal,
        });
        clearTimeout(timer);
        const data = resp.ok ? await resp.json().catch(() => ({})) : {};
        robotBtn.textContent = data.ok ? '✅ Enviado! Saindo na impressora' : '⚠️ A impressora recusou';
      } catch (err) {
        robotBtn.textContent = '⚠️ Robô de impressão offline';
      }
      setTimeout(() => {
        robotBtn.textContent = original;
        robotBtn.disabled = false;
        robotBtn.style.opacity = '1';
      }, 6000);
    };
    async function renderPdf() {
      const pdf = await pdfjsLib.getDocument({ url: pdfUrl }).promise;
      status.textContent = 'Renderizando ' + pdf.numPages + ' página(s)…';
      for (let n = 1; n <= pdf.numPages; n += 1) {
        const page = await pdf.getPage(n);
        const viewport = page.getViewport({ scale: 2 });
        const wrapper = document.createElement('section');
        wrapper.className = 'page';
        const canvas = document.createElement('canvas');
        canvas.width = Math.ceil(viewport.width);
        canvas.height = Math.ceil(viewport.height);
        wrapper.appendChild(canvas);
        pages.appendChild(wrapper);
        await page.render({ canvasContext: canvas.getContext('2d'), viewport }).promise;
        status.textContent = 'Página ' + n + ' de ' + pdf.numPages;
      }
      status.remove();
    }
    renderPdf().catch((error) => {
      status.textContent = 'Não foi possível renderizar o PDF no navegador. Use o botão Baixar PDF.';
      console.error(error);
    });
  </script>
</body>
</html>`;
    popup.document.open();
    popup.document.write(html);
    popup.document.close();
    return true;
  };
}());
