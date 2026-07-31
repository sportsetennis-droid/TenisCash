const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
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
  assert.equal(template.layoutConfig.sides.front, 'brand-product-price-warranty');
  assert.equal(template.layoutConfig.sides.back, 'store-barcode-qr');
  assert.equal(template.layoutConfig.backBleedMm, 4.5);
  assert.equal(template.layoutConfig.backPrintOffsetXMm, -1.5);
  assert.equal(template.layoutConfig.cutMarksInsideArtwork, true);
  assert.equal(template.layoutConfig.cutMarkSafeGapMm, 0.35);
  assert.equal(template.layoutConfig.backFullPageBackground, true);
  assert.equal(template.layoutConfig.backBackgroundOverscanMm, 10);
  assert.equal(template.layoutConfig.backBackgroundStopsInOuterBleed, true);
  assert.equal(template.layoutConfig.backBackgroundRenderMode, 'rgb-image');
  assert.equal(template.layoutConfig.backgroundHex, '#F4511E');

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

  const decodedStreams = [...source.matchAll(/stream\r?\n([\s\S]*?)\r?\nendstream/g)]
    .map((match) => {
      try {
        return zlib.inflateSync(Buffer.from(match[1], 'latin1')).toString('latin1');
      } catch {
        return '';
      }
    });
  const backPageStream = decodedStreams.find((stream) => (
    stream.includes('651.972913')
    && stream.includes('819.212599')
    && /\/I\d+ Do/.test(stream)
  ));
  assert.ok(backPageStream, 'o fundo RGB rasterizado do verso deve existir');
  assert.doesNotMatch(backPageStream, /\/DeviceCMYK cs/);
  assert.doesNotMatch(backPageStream, /651\.972913 819\.212599 re/);

  const frontPageStream = decodedStreams.find((stream) => stream.includes('0.510236 w'));
  assert.ok(frontPageStream, 'o plano de corte da frente deve existir');
  const cutMarkBlocks = [...frontPageStream.matchAll(/0\.510236 w([\s\S]*?)Q/g)];
  const interiorCutStrokes = Math.max(
    0,
    ...cutMarkBlocks.map((match) => (match[1].match(/\nS\n/g) || []).length),
  );
  assert.equal(interiorCutStrokes, 50, 'as 25 intersecoes devem ter duas hastes cada');

  const output = path.join(__dirname, '..', 'tmp', 'pdfs', 'etiqueta-5x7-frente-verso-teste.pdf');
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.writeFileSync(output, pdf);
  console.log(`Etiqueta unica frente/verso validada: ${output}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
