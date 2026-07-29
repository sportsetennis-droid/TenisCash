const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  defaultTemplates,
  generateLabelsPDF,
  isSTHorizontalTemplate,
} = require('../src/services/labelGenerator');

async function main() {
  const template = defaultTemplates().st_145x25;

  assert.ok(template, 'Template S&T 14,5x2,5cm não encontrado');
  assert.equal(template.widthMm, 145);
  assert.equal(template.heightMm, 25);
  assert.equal(template.columns, 1);
  assert.equal(template.rows, 11);
  assert.equal(template.marginLeftMm, 32.5);
  assert.equal(template.marginTopMm, 11);
  assert.ok(template.legacyNames.includes('S&T Etiqueta 15x3cm (9 por A4)'));
  assert.equal(isSTHorizontalTemplate(template), true);
  const pdf = await generateLabelsPDF({
    template: {
      ...template,
      showPromotionalPrice: true,
      showQRCode: true,
      showBarcode: false,
    },
    storeName: 'Sports & Tennis',
    items: [{
      name: 'Tênis de corrida modelo demonstrativo',
      supplierRef: 'REF-145X25-TESTE',
      gender: 'Unissex',
      category: 'Tênis',
      modality: 'Corrida',
      tier: 'Treino',
      price: 999.9,
      promotionalPrice: 899.9,
      barcode: '7891234567890',
      qrCodeValue: 'https://teniscash.com.br/produto/teste-145x25',
      quantity: 12,
    }],
  });

  assert.ok(Buffer.isBuffer(pdf));
  assert.ok(pdf.length > 1000, 'PDF gerado está vazio ou incompleto');
  assert.equal(pdf.subarray(0, 4).toString(), '%PDF');
  const pdfSource = pdf.toString('latin1');
  assert.match(pdfSource, /\/PrintScaling \/None/);
  assert.match(pdfSource, /\/PickTrayByPDFSize true/);

  const outputPath = process.argv[2]
    ? path.resolve(process.argv[2])
    : path.join(__dirname, '..', 'tmp', 'pdfs', 'etiqueta-145x25-teste.pdf');
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, pdf);

  console.log(`PDF de teste gerado: ${outputPath}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
