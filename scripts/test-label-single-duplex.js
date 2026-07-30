const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  defaultTemplates,
  generateLabelsPDF,
  isProductDuplexTemplate,
  isSingleProductDuplexTemplate,
} = require('../src/services/labelGenerator');

function dataUri(mime, value) {
  return `data:${mime};base64,${Buffer.from(value).toString('base64')}`;
}

async function main() {
  const template = defaultTemplates().a4_16_5x7_duplex;
  assert.equal(isProductDuplexTemplate(template), true);
  assert.equal(isSingleProductDuplexTemplate(template), true);
  assert.equal(template.layoutConfig.labelsPerProduct, 1);
  assert.equal(template.layoutConfig.sides.front, 'brand-product-price-payment-warranty');
  assert.equal(template.layoutConfig.sides.back, 'store-barcode-qr');

  const logoSvg = fs.readFileSync(
    path.join(__dirname, '..', 'assets', 'logos', 'brands', 'umbro.svg'),
    'utf8',
  );
  const brandLogoUrl = dataUri('image/svg+xml', logoSvg);
  const storeLogoUrl = 'https://example.test/st-logo-sports-tennis-white-transparent.png';
  const pdf = await generateLabelsPDF({
    template,
    storeName: 'Sports & Tennis',
    storeLogoUrl,
    items: [{
      productName: 'JOELHEIRA UMBRO NEOPRENE',
      categoryLabel: 'PROTEÇÃO ESPORTIVA',
      brand: 'Umbro',
      brandLogoUrl,
      availableSizes: 'P | M | 38',
      price: 50.27,
      promotionalPrice: 35.19,
      promotionText: 'Garanta 30% de Desconto levando três produtos da loja.',
      paymentTerms: 'PIX, DINHEIRO OU CARTÃO',
      guaranteeText: 'PRODUTO ORIGINAL E GARANTIA.',
      internalBarcode: '2066231773937',
      qrCodeValue: 'https://www.teniscash.com.br/p/teste',
      quantity: 16,
    }],
  });

  assert.ok(Buffer.isBuffer(pdf));
  assert.ok(pdf.length > 5000);
  assert.equal(pdf.subarray(0, 4).toString(), '%PDF');
  const source = pdf.toString('latin1');
  assert.equal((source.match(/\/Type\s*\/Page\b/g) || []).length, 2);
  assert.match(source, /\/Duplex \/DuplexFlipLongEdge/);
  assert.match(source, /\/PrintScaling \/None/);

  const output = path.join(__dirname, '..', 'tmp', 'pdfs', 'etiqueta-5x7-frente-verso-teste.pdf');
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.writeFileSync(output, pdf);
  console.log(`Etiqueta unica frente/verso validada: ${output}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
