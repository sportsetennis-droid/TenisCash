// Leitura LOCAL de código de barras (zxing-wasm) — GRÁTIS, roda no servidor, sem API paga.
// Carrega o .wasm do disco (nunca de CDN, senão quebra offline/headless).
const fs = require('fs');
const path = require('path');
const sharp = require('sharp');

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

// Recebe dataURI (data:image/webp;base64,...) ou base64 puro. Devolve lista de códigos (dígitos), sem repetir.
async function decodeBarcodesFromDataUri(dataUri) {
  if (!dataUri) return [];
  const b64 = String(dataUri).includes(',') ? String(dataUri).split(',')[1] : String(dataUri);
  const buf = Buffer.from(b64, 'base64');
  const { data, info } = await sharp(buf).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const { readBarcodes } = getMod();
  const res = await readBarcodes(
    { data: new Uint8ClampedArray(data), width: info.width, height: info.height },
    { tryHarder: true, formats: ['EAN-13', 'UPC-A', 'EAN-8'] }
  );
  return [...new Set((res || []).map((r) => String(r.text || '').replace(/\D/g, '')).filter((x) => x.length >= 8))];
}

module.exports = { decodeBarcodesFromDataUri };
