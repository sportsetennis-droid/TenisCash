'use strict';
// Barcode decoding stays on this server. No paid image/crop service.
const fs=require('fs'),path=require('path'),sharp=require('sharp');
let mod;
function getMod(){if(mod)return mod;mod=require('zxing-wasm/reader');const file=path.join(__dirname,'../../node_modules/zxing-wasm/dist/reader/zxing_reader.wasm');const overrides={wasmBinary:fs.readFileSync(file)};if(mod.prepareZXingModule)mod.prepareZXingModule({overrides});else mod.setZXingModuleOverrides(overrides);return mod;}
async function read(buf){const {data,info}=await sharp(buf).ensureAlpha().raw().toBuffer({resolveWithObject:true});const rows=await getMod().readBarcodes({data:new Uint8ClampedArray(data),width:info.width,height:info.height},{tryHarder:true,tryRotate:true,tryInvert:true,formats:['EAN-13','UPC-A','EAN-8'],maxNumberOfSymbols:3});return [...new Set(rows.map(r=>String(r.text||'')).filter(s=>/^\d{8,14}$/.test(s)))];}
async function decodeBarcodesFromDataUri(uri){if(!uri)return[];const buf=Buffer.from(String(uri).split(',').pop(),'base64');let codes=await read(buf);if(codes.length)return codes;const image=await sharp(buf).rotate(270).resize({width:2400,height:2400,fit:'inside'}).grayscale().normalize().png().toBuffer();return read(image);}
module.exports={decodeBarcodesFromDataUri};
