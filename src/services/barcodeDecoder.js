// Leitura LOCAL de código de barras (zxing-wasm) — GRÁTIS, roda no servidor, sem API paga.
// Carrega o .wasm do disco (nunca de CDN, senão quebra offline/headless).
// Integração LocateAnything: tenta recortar a região do código de barras antes de decodificar,
// aumentando a taxa de leitura em fotos de etiqueta inteiras ou com fundo poluído.
const fs = require('fs');
const path = require('path');
const sharp = require('sharp');

let la = null;
try { la = require('./locateAnything'); } catch (_) {}

let _mod = null;
function getMod() {
  if (_mod) return _mod;
  const mod = require('zxing-wasm/reader');
  // localiza o .wasm dentro do pacote instalado (mesma estrutura local e no Railway)
  const candidatos = [
    path.join(__dirname, '..', '..', 'node_modules', 'zxing-wasm', 'dist', 'reader', 'zxing_reader.wasm'),
    path.join(process.cwd(), 'node_modules', 'zxing-wasm', 'dist', 'reader', 'zxing_reader.wasm'),
  ];
  const wasmPath = candidatos.find((p) => { try { return fs.existsSync(p); } catch (_) { return false; } });
  if (wasmPath) mod.setZXingModuleOverrides({ wasmBinary: fs.readFileSync(wasmPath) });
  _mod = mod;
  return mod;
}

async function _readRaw(buf) {
  const { data, info } = await sharp(buf).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const { readBarcodes } = getMod();
  const res = await readBarcodes(
    { data: new Uint8ClampedArray(data), width: info.width, height: info.height },
    { tryHarder: true, formats: ['EAN-13', 'UPC-A', 'EAN-8'] }
  );
  return [...new Set((res || []).map((r) => String(r.text || '').replace(/\D/g, '')).filter((x) => x.length >= 8))];
}

// Recebe dataURI (data:image/webp;base64,...) ou base64 puro. Devolve lista de códigos (dígitos), sem repetir.
// Fluxo: tenta ler imagem inteira → se não achar, usa LocateAnything pra recortar etiqueta → tenta de novo.
async function decodeBarcodesFromDataUri(dataUri) {
  if (!dataUri) return [];
  const b64 = String(dataUri).includes(',') ? String(dataUri).split(',')[1] : String(dataUri);
  const buf = Buffer.from(b64, 'base64');

  // 1ª tentativa: imagem inteira (mais rápido, sem custo de API)
  const codes = await _readRaw(buf);
  if (codes.length) return codes;

  // 2ª tentativa: recortar região do código de barras com LocateAnything
  if (!la) return [];
  try {
    const dataUri2 = `data:image/jpeg;base64,${b64}`;
    const bbox = await la.locate(dataUri2, 'barcode label or price tag');
    if (!bbox) return [];

    const meta = await sharp(buf).metadata();
    const W = meta.width || 800;
    const H = meta.height || 600;
    const px = la.bboxToPixels(bbox, W, H);
    // margem de 5% pra não cortar a borda do código
    const margin = Math.round(Math.min(W, H) * 0.05);
    const left = Math.max(0, px.x - margin);
    const top = Math.max(0, px.y - margin);
    const width = Math.min(W - left, px.w + margin * 2);
    const height = Math.min(H - top, px.h + margin * 2);

    const cropped = await sharp(buf).extract({ left, top, width, height }).toBuffer();
    return _readRaw(cropped);
  } catch (_) {
    return [];
  }
}

module.exports = { decodeBarcodesFromDataUri };
