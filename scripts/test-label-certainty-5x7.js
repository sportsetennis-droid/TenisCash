const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  DEFAULT_CERTAINTY_PHRASES,
  certaintyPhraseForItem,
  defaultTemplates,
  generateLabelsPDF,
  isFourSideProductTemplate,
} = require('../src/services/labelGenerator');

function svgDataUrl(label) {
  const safeLabel = String(label).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="640" height="240" viewBox="0 0 640 240">
    <rect x="20" y="20" width="200" height="200" rx="100" fill="#111"/>
    <text x="120" y="148" font-family="Arial" font-size="76" font-weight="700" fill="#fff" text-anchor="middle">${safeLabel.slice(0, 2)}</text>
    <text x="250" y="148" font-family="Arial" font-size="70" font-weight="700" fill="#111">${safeLabel}</text>
  </svg>`;
  return `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`;
}

async function main() {
  const template = defaultTemplates().a4_16_5x7_duplex;
  assert.ok(template, 'Template 5x7 de certeza não encontrado');
  assert.equal(template.widthMm, 50);
  assert.equal(template.heightMm, 70);
  assert.equal(template.columns, 4);
  assert.equal(template.rows, 4);
  assert.equal(template.layoutConfig.sides.backB, 'certainty');
  assert.equal(isFourSideProductTemplate(template), true);
  assert.ok(template.legacyNames.includes('A4 16 etiquetas (5x7 cm) — frente e verso'));

  const item = {
    name: 'Tênis de corrida modelo demonstrativo',
    productName: 'Tênis de corrida modelo demonstrativo',
    brand: 'Marca Teste',
    reference: 'REFTESTE01',
    categoryLabel: 'Corrida · Treino',
    availableSizes: '38 | 39 | 40 | 41',
    internalBarcode: '2000000000018',
    brandLogoUrl: svgDataUrl('MARCA'),
    quantity: 1,
  };
  const phrase = certaintyPhraseForItem(item, template);
  assert.ok(template.layoutConfig.certaintyPhrases.includes(phrase));
  assert.equal(certaintyPhraseForItem(item, template), phrase, 'A frase precisa permanecer estável para o produto');
  const items = DEFAULT_CERTAINTY_PHRASES.map((certaintyPhrase, index) => ({
    ...item,
    name: `Tênis demonstrativo ${index + 1}`,
    productName: `Tênis demonstrativo ${index + 1}`,
    reference: `REFTESTE${String(index + 1).padStart(2, '0')}`,
    internalBarcode: `20000000000${String(index + 1).padStart(2, '0')}`,
    certaintyPhrase,
  }));

  const pdf = await generateLabelsPDF({
    template: {
      ...template,
      showPrice: false,
      showPromotionalPrice: false,
      showQRCode: false,
      showBarcode: true,
    },
    storeName: 'Sports & Tennis',
    storeLogoUrl: svgDataUrl('SPORTS & TENNIS'),
    items,
  });

  assert.ok(Buffer.isBuffer(pdf));
  assert.ok(pdf.length > 1000, 'PDF de certeza está vazio ou incompleto');
  assert.equal(pdf.subarray(0, 4).toString(), '%PDF');
  const pdfSource = pdf.toString('latin1');
  assert.match(pdfSource, /\/PrintScaling \/None/);
  assert.match(pdfSource, /\/Duplex \/DuplexFlipLongEdge/);

  const outputPath = process.argv[2]
    ? path.resolve(process.argv[2])
    : path.join(__dirname, '..', 'tmp', 'pdfs', 'etiqueta-certeza-5x7-teste.pdf');
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, pdf);
  console.log(`PDF de certeza gerado: ${outputPath}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
