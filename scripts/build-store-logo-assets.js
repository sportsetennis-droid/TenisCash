const fs = require('fs');
const path = require('path');
const sharp = require('sharp');

const PROJECT_ROOT = path.join(__dirname, '..');
const PROFILE_LOGO = path.join(PROJECT_ROOT, 'public', 'st-profile-logo.jpeg');
const DEFAULT_OUTPUT_DIR = path.join(PROJECT_ROOT, 'assets', 'logos');
const OFFICIAL_LOGO_URL = 'https://d2az8otjr0j19j.cloudfront.net/templates/007/890/890/twig/static/images/st-logo-sports-tennis-white-transparent-20260601.png?v=20260601-logo3';

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

async function buildHighResolutionIcon(outputDir) {
  const { data, info } = await sharp(PROFILE_LOGO)
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  // Cores da arte oficial usada no perfil da loja.
  const foreground = [0, 128, 70];
  const background = [255, 214, 18];
  const direction = foreground.map((value, index) => value - background[index]);
  const denominator = direction.reduce((sum, value) => sum + value * value, 0);
  const rgba = Buffer.alloc(info.width * info.height * 4);

  for (let pixel = 0; pixel < info.width * info.height; pixel += 1) {
    const sourceOffset = pixel * info.channels;
    const outputOffset = pixel * 4;
    const projection = direction.reduce(
      (sum, value, channel) => sum + (data[sourceOffset + channel] - background[channel]) * value,
      0,
    ) / denominator;

    // Elimina ruído de compressão JPEG no fundo e preserva o antialias das bordas.
    const alpha = clamp((projection - 0.08) / 0.84, 0, 1);
    const smoothAlpha = alpha * alpha * (3 - 2 * alpha);
    rgba[outputOffset] = 255;
    rgba[outputOffset + 1] = 255;
    rgba[outputOffset + 2] = 255;
    rgba[outputOffset + 3] = Math.round(smoothAlpha * 255);
  }

  const output = path.join(outputDir, 'sports-tennis-icon-white-hires.png');
  await sharp(rgba, {
    raw: {
      width: info.width,
      height: info.height,
      channels: 4,
    },
  })
    .trim({ background: { r: 255, g: 255, b: 255, alpha: 0 } })
    .resize({ width: 2400, kernel: sharp.kernel.lanczos3 })
    .withMetadata({ density: 600 })
    .png({ compressionLevel: 9, adaptiveFiltering: true })
    .toFile(output);
  return output;
}

async function buildHighResolutionWordmark(outputDir) {
  const response = await fetch(OFFICIAL_LOGO_URL);
  if (!response.ok) throw new Error(`Falha ao obter wordmark oficial: HTTP ${response.status}`);
  const raw = Buffer.from(await response.arrayBuffer());
  const metadata = await sharp(raw).metadata();
  const splitX = Math.round(Number(metadata.width) * (230 / 1007));
  const output = path.join(outputDir, 'sports-tennis-wordmark-white-hires.png');
  const extracted = await sharp(raw)
    .ensureAlpha()
    .extract({
      left: splitX,
      top: 0,
      width: Number(metadata.width) - splitX,
      height: Number(metadata.height),
    })
    .png()
    .toBuffer();

  await sharp(extracted)
    .trim()
    .resize({ width: 3000, kernel: sharp.kernel.lanczos3 })
    .withMetadata({ density: 600 })
    .png({ compressionLevel: 9, adaptiveFiltering: true })
    .toFile(output);
  return output;
}

async function main() {
  const outputDir = process.argv[2]
    ? path.resolve(process.argv[2])
    : DEFAULT_OUTPUT_DIR;
  fs.mkdirSync(outputDir, { recursive: true });
  const outputs = await Promise.all([
    buildHighResolutionIcon(outputDir),
    buildHighResolutionWordmark(outputDir),
  ]);
  outputs.forEach((output) => console.log(output));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
