'use strict';

// PDF do contracheque (A4, retrato). Gera a partir do RESULTADO congelado — os números
// do PDF são exatamente os da tela (mesmo `result`). Identificador, versão, data de
// geração e QR de verificação em todas as páginas.

const PDFDocument = require('pdfkit');
const QRCode = require('qrcode');

const brl = (c) => (Number(c || 0) / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
const dateBr = (d) => (d ? String(d).slice(0, 10).split('-').reverse().join('/') : '—');
const KIND = { MENSAL: 'Folha mensal', FERIAS: 'Recibo de férias', DECIMO_TERCEIRO_1: '13º salário — 1ª parcela', DECIMO_TERCEIRO_2: '13º salário — 2ª parcela' };
const CONTRACT = { MENSALISTA: 'Mensalista', HORISTA: 'Horista', ESCALA_12X36: 'Escala 12x36', APRENDIZ: 'Aprendiz', PARCIAL: 'Tempo parcial', SEM_REGISTRO: 'Sem registro formal' };

async function createPayslipPdf({ payslip, result, company, employee, verifyUrl, generatedAt = new Date() }) {
  const doc = new PDFDocument({ size: 'A4', margin: 36, bufferPages: true,
    info: { Title: `Contracheque ${result.competence} - ${employee.name}`, Author: company.fantasyName || company.companyName || 'TenisCash' } });
  const chunks = [];
  const done = new Promise((resolve, reject) => { doc.on('data', (c) => chunks.push(c)); doc.on('end', () => resolve(Buffer.concat(chunks))); doc.on('error', reject); });
  const qr = await QRCode.toBuffer(verifyUrl, { margin: 1, width: 180 });
  const W = doc.page.width - 72, X = 36;
  let y = 36;
  const text = (v, x, top, w, size = 9, bold = false, align = 'left', color = '#1d1d1f') => {
    doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(size).fillColor(color).text(String(v ?? ''), x, top, { width: w, align, lineGap: 1 });
  };
  const ensure = (h) => { if (y + h > doc.page.height - 70) { doc.addPage(); y = 36; } };

  // Cabeçalho
  doc.rect(X, y, W, 4).fill('#E5571E'); y += 10;
  text(company.companyName || '—', X, y, W - 110, 13, true);
  text(`${company.fantasyName ? company.fantasyName + ' · ' : ''}CNPJ ${company.cnpj || '—'}`, X, y + 17, W - 110, 9);
  text(company.address || '', X, y + 30, W - 110, 8, false, 'left', '#555');
  text(KIND[result.kind] || 'Contracheque', X + W - 200, y, 200, 12, true, 'right');
  text(`Competência ${result.competence.split('-').reverse().join('/')}`, X + W - 200, y + 16, 200, 10, false, 'right');
  text(`Pagamento: ${dateBr(payslip.paymentDate)}`, X + W - 200, y + 30, 200, 8, false, 'right', '#555');
  y += 50;
  doc.moveTo(X, y).lineTo(X + W, y).strokeColor('#ddd').stroke(); y += 8;

  // Funcionário
  const c = result.contract || {};
  const rows = [
    ['Funcionário', employee.name], ['Matrícula', employee.registration || '—'], ['CPF', employee.cpfMasked || '—'],
    ['Cargo', [c.jobTitle || employee.jobTitle, employee.cbo ? 'CBO ' + employee.cbo : null].filter(Boolean).join(' · ') || '—'],
    ['Admissão', dateBr(c.admissionDate)], ['Contrato', CONTRACT[c.type] || c.type || '—'],
    ['Salário-base', c.baseSalaryCents ? brl(c.baseSalaryCents) : (c.hourlyRateCents ? brl(c.hourlyRateCents) + '/h' : '—')],
    ['Jornada', c.shiftMinutes ? `Plantão ${c.shiftMinutes / 60}h` : `${(c.weeklyMinutes || 0) / 60}h semanais`],
    ['Loja', employee.storeName || '—'], ['Sindicato / CCT', [employee.unionName, employee.cctRef].filter(Boolean).join(' · ') || 'Pendente de validação do DP'],
  ];
  const colW = W / 2;
  rows.forEach(([k, v], i) => {
    const cx = X + (i % 2) * colW, cy = y + Math.floor(i / 2) * 15;
    text(k + ':', cx, cy, 80, 8, true, 'left', '#555'); text(v, cx + 80, cy, colW - 84, 8);
  });
  y += Math.ceil(rows.length / 2) * 15 + 6;

  // Tabela de verbas
  const cols = [{ t: 'Cód.', w: 96 }, { t: 'Descrição', w: W - 96 - 70 - 80 - 80 }, { t: 'Referência', w: 70 }, { t: 'Proventos', w: 80, r: true }, { t: 'Descontos', w: 80, r: true }];
  const head = () => {
    doc.rect(X, y, W, 18).fill('#fff0e5'); let cx = X;
    cols.forEach((col) => { text(col.t, cx + 4, y + 5, col.w - 8, 8, true, col.r ? 'right' : 'left'); cx += col.w; });
    y += 18;
  };
  ensure(40); head();
  for (const it of result.items) {
    doc.font('Helvetica').fontSize(8);
    const h = Math.max(16, doc.heightOfString(it.label + (it.memo ? '\n' + it.memo : ''), { width: cols[1].w - 8 }) + 6);
    if (y + h > doc.page.height - 120) { doc.addPage(); y = 36; head(); }
    let cx = X;
    const cells = [it.code, null, it.refText || '', it.type === 'PROVENTO' ? brl(it.cents) : '', it.type === 'DESCONTO' ? brl(it.cents) : ''];
    cells.forEach((v, i) => {
      if (i === 1) { text(it.label, cx + 4, y + 3, cols[1].w - 8, 8, true); if (it.memo) text(it.memo, cx + 4, doc.y, cols[1].w - 8, 7, false, 'left', '#666'); }
      else text(v, cx + 4, y + 3, cols[i].w - 8, i === 0 ? 6 : 8, false, cols[i].r ? 'right' : 'left');
      cx += cols[i].w;
    });
    y += h; doc.moveTo(X, y).lineTo(X + W, y).strokeColor('#eee').stroke();
  }
  ensure(120);
  const tot = result.totals;
  y += 6;
  text('Total de proventos', X, y, W - 170, 9, true, 'right'); text(brl(tot.grossCents), X + W - 160, y, 80, 9, true, 'right'); y += 14;
  text('Total de descontos', X, y, W - 170, 9, true, 'right'); text(brl(tot.deductionsCents), X + W - 80, y, 80, 9, true, 'right'); y += 16;
  doc.rect(X + W - 260, y - 2, 260, 22).fill('#1d1d1f');
  text('LÍQUIDO A RECEBER', X + W - 255, y + 4, 150, 10, true, 'left', '#fff'); text(brl(tot.netCents), X + W - 105, y + 4, 100, 11, true, 'right', '#fff');
  y += 32;

  // Bases
  const b = result.bases || {};
  const basesRows = [
    ['Salário de contribuição / base INSS', brl(b.inss?.baseCents ?? b.contributionBaseCents)], ['INSS descontado', brl(b.inss?.valueCents)],
    ['Base FGTS', brl(b.fgts?.baseCents)], ['FGTS do mês (empresa; não desconta)', b.fgts ? `${brl(b.fgts.valueCents)} (${b.fgts.rate}%)` : '—'],
    ['Base IRRF', brl(b.irrf?.baseCents)], ['Dependentes IRRF', String(b.dependents ?? 0)],
    ['Valor-hora', c.hourCents ? brl(c.hourCents) : '—'], ['Horas normais / extras', result.time ? `${Math.round((result.time.totals.regularMinutes || 0) / 60)}h / ${Math.round((result.time.totals.extraMinutes || 0) / 6) / 10}h` : '—'],
  ];
  ensure(110);
  text('Bases e informações', X, y, W, 10, true); y += 14;
  basesRows.forEach(([k, v], i) => {
    const cx = X + (i % 2) * colW, cy = y + Math.floor(i / 2) * 13;
    text(k, cx, cy, colW - 110, 7.5, false, 'left', '#555'); text(v, cx + colW - 110, cy, 100, 7.5, true, 'right');
  });
  y += Math.ceil(basesRows.length / 2) * 13 + 8;
  if (result.pendencies?.length || payslip.reason) {
    ensure(40);
    text('Observações do fechamento', X, y, W, 9, true); y += 12;
    const obs = [payslip.reason, ...(result.pendencies || []).map((p) => p.text)].filter(Boolean).slice(0, 12).join('\n');
    text(obs, X, y, W, 7.5, false, 'left', '#444'); y = doc.y + 6;
  }

  // Rodapé em todas as páginas: id, versão, data, QR.
  const range = doc.bufferedPageRange();
  for (let i = range.start; i < range.start + range.count; i++) {
    doc.switchToPage(i);
    doc.page.margins.bottom = 0; // rodapé fora da margem não pode abrir página nova
    const fy = doc.page.height - 64;
    doc.image(qr, X, fy - 2, { width: 52 });
    text(`Documento ${payslip.id} · versão ${payslip.version} · ${payslip.status}`, X + 60, fy, W - 60, 7, false, 'left', '#555');
    text(`Gerado em ${generatedAt.toLocaleString('pt-BR', { timeZone: 'America/Fortaleza' })} · Código de verificação ${payslip.verifyCode}`, X + 60, fy + 10, W - 60, 7, false, 'left', '#555');
    text(`Confira a autenticidade em ${verifyUrl}`, X + 60, fy + 20, W - 60, 7, false, 'left', '#555');
    text(`Página ${i - range.start + 1} de ${range.count}`, X + 60, fy + 30, W - 60, 7, false, 'left', '#999');
  }
  doc.end();
  return done;
}

module.exports = { createPayslipPdf };
