const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  defaultTemplates,
  generateLabelsPDF,
  isDuplexTemplate,
  isSaldoTemplate,
} = require('../src/services/labelGenerator');

async function main() {
  const template = defaultTemplates().a4_16_5x7_saldo;

  assert.ok(template, 'Template SALDO 5x7 não encontrado');
  assert.equal(template.name, 'SALDO REPETIDO — A4 16 etiquetas (5x7 cm) — frente e costas');
  assert.deepEqual(template.legacyNames, ['SALDO — A4 16 etiquetas (5x7 cm)']);
  assert.equal(template.type, 'PROMOTIONAL');
  assert.equal(template.widthMm, 50);
  assert.equal(template.heightMm, 70);
  assert.equal(template.columns, 4);
  assert.equal(template.rows, 4);
  assert.equal(template.marginLeftMm, 5);
  assert.equal(template.marginTopMm, 8.5);
  assert.equal(isDuplexTemplate(template), true);
  assert.equal(template.layoutConfig.duplexBinding, 'long-edge');
  assert.equal(template.layoutConfig.labelsPerProduct, 1);
  assert.deepEqual(template.layoutConfig.sides, { front: 'saldo', back: 'saldo' });
  assert.equal(template.layoutConfig.saldoRepeatColumns, 2);
  assert.equal(template.layoutConfig.saldoRepeatRows, 5);
  assert.equal(template.layoutConfig.saldoFontSize, 14);
  assert.equal(template.layoutConfig.labelDesign, 'saldo-5x7-repeated-v3');
  assert.equal(template.layoutConfig.cutMarksOnBothSides, true);
  assert.equal(template.layoutConfig.cutContourEachLabel, true);
  assert.equal(template.layoutConfig.cutContourColor, '#FF8A3D');
  assert.equal(isSaldoTemplate(template), true);

  const items = Array.from({ length: 16 }, () => ({ quantity: 1 }));

  const pdf = await generateLabelsPDF({
    template,
    storeName: 'Sports & Tennis',
    items,
  });

  assert.ok(Buffer.isBuffer(pdf));
  assert.ok(pdf.length > 3500, 'PDF SALDO está vazio ou incompleto');
  assert.equal(pdf.subarray(0, 4).toString(), '%PDF');
  const source = pdf.toString('latin1');
  assert.equal((source.match(/\/Type\s*\/Page\b/g) || []).length, 2);
  assert.match(source, /\/Duplex \/DuplexFlipLongEdge/);
  assert.match(source, /\/PrintScaling \/None/);
  assert.match(source, /\/PickTrayByPDFSize true/);

  const output = path.join(__dirname, '..', 'tmp', 'pdfs', 'etiqueta-saldo-5x7-teste.pdf');
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.writeFileSync(output, pdf);
  console.log(`Etiqueta SALDO 5x7 validada: ${output}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
