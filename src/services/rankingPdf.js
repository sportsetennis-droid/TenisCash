const PDFDocument = require('pdfkit');

async function createRankingPdf(data, { storeName = 'Todas as lojas', generatedAt = new Date() } = {}) {
  const doc = new PDFDocument({ size: 'A4', layout: 'landscape', margin: 28, bufferPages: true,
    info: { Title: 'Ranking de vendas - Sports & Tennis', Author: 'TenisCash' } });
  const chunks = [];
  const result = new Promise((resolve, reject) => {
    doc.on('data', chunk => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
  });
  const fmt = n => Number(n || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
  const date = d => new Date(d).toLocaleDateString('pt-BR', { timeZone: 'America/Recife' });
  const periods = { today: 'Hoje', yesterday: 'Ontem', month: 'Mês atual', last_month: 'Mês anterior', custom: 'Personalizado' };
  const x = 28, width = doc.page.width - 56;
  const widths = [25, 135, 42, 70, 62, 82, 82, 94, 65, width - 657];
  const headings = ['Pos.', 'Vendedor / loja', 'Vendas', 'Valor vendido', 'Geral\n1%', 'Batendo 50k\nGeral 2%', 'Vestuário S&T\n1%', 'Vestuário S&T\n20k - 4%', 'Total\n1%', 'Total\n2% + 4%'];
  let y;
  function text(value, left, top, w, size = 8, bold = false) {
    doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(size).fillColor('#242424')
      .text(String(value), left, top, { width: w, lineGap: 2 });
  }
  function header() {
    text('SPORTS & TENNIS | Ranking de vendas', x, 26, width, 17, true);
    text(`${storeName} | ${periods[data.period] || data.period} | ${date(data.from)} a ${date(new Date(new Date(data.to).getTime() - 1))}`, x, 52, width, 10);
    text(`Gerado em ${generatedAt.toLocaleString('pt-BR', { timeZone: 'America/Recife' })} | ${data.ranking.length} vendedores`, x, 69, width, 9);
    y = 90;
    doc.rect(x, y, width, 34).fill('#fff0e5');
    let left = x;
    headings.forEach((h, i) => { text(h, left + 5, y + 6, widths[i] - 10, 8, true); left += widths[i]; });
    y += 34;
  }
  header();
  for (const r of data.ranking) {
    const c = r.commission;
    const storesLabel = [...new Set((r.stores?.length ? r.stores : [r.store]).filter(Boolean).map(store => store.name).filter(Boolean))].join(' / ');
    const cells = [String(r.position), `${r.name}\n${storesLabel || '-'}\nComissão calculada: ${fmt(r.commissionAmount)}`, String(r.salesCount), fmt(r.salesAmount), fmt(c.baseAmount),
      fmt(c.at50kAmount), fmt(c.clothingBaseAmount), fmt(c.at20kClothingAmount),
      fmt(c.totalAt1Percent), fmt(c.totalAt2And4Percent)];
    doc.font('Helvetica').fontSize(8);
    const height = Math.max(52, ...cells.map((v, i) => doc.heightOfString(v, { width: widths[i] - 10, lineGap: 2 }) + 14));
    if (y + height > doc.page.height - 42) { doc.addPage(); header(); }
    // Long custom ranges may need a continuation within the same seller row.
    const lines = cells.map((v, i) => {
      const wrapped = [];
      for (const paragraph of v.split('\n')) {
        let line = '';
        for (const word of paragraph.split(' ')) {
          if (line && doc.widthOfString(line + ' ' + word) > widths[i] - 10) { wrapped.push(line); line = word; }
          else line += (line ? ' ' : '') + word;
        }
        wrapped.push(line);
      }
      return wrapped;
    });
    let offset = 0;
    const count = Math.max(...lines.map(a => a.length));
    while (offset < count) {
      const capacity = Math.max(1, Math.floor((doc.page.height - 42 - y - 14) / 12));
      const take = Math.min(capacity, count - offset);
      const rowHeight = Math.max(52, take * 12 + 14);
      doc.rect(x, y, width, rowHeight).fill(r.position % 2 ? '#ffffff' : '#f7f7f7');
      let left = x;
      lines.forEach((parts, i) => { text(parts.slice(offset, offset + take).join('\n'), left + 5, y + 7, widths[i] - 10); left += widths[i]; });
      y += rowHeight; offset += take;
      if (offset < count) { doc.addPage(); header(); }
    }
  }
  if (!data.ranking.length) text('Nenhum vendedor encontrado nos filtros selecionados.', x, y + 18, width, 11);
  const pages = doc.bufferedPageRange();
  for (let i = 0; i < pages.count; i++) {
    doc.switchToPage(i);
    text(`TenisCash | ${i + 1} / ${pages.count}`, x, doc.page.height - 39, width, 8);
  }
  doc.end();
  return result;
}
module.exports = { createRankingPdf };
