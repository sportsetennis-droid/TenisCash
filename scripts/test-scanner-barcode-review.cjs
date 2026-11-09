'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const sharp=require('sharp'),writer=require('zxing-wasm/writer');
const policy=require('../public/scanner-barcode-policy');
const {decode}=require('../src/services/scannerBarcodeEngine');
const root=path.resolve(__dirname,'..');
const internal='0615640591012795';
writer.prepareZXingModule({overrides:{wasmBinary:fs.readFileSync(path.join(root,'node_modules/zxing-wasm/dist/writer/zxing_writer.wasm'))}});
async function raster(code,format='Code128'){
 const result=await writer.writeBarcode(code,{format,scale:3,addQuietZones:true});
 assert.equal(result.error,'');assert.ok(result.image);
 return Buffer.from(await result.image.arrayBuffer());
}
(async()=>{
 const image=await raster(internal);
 for(const angle of [0,90,180,270]){
  const codes=await decode(await sharp(image).rotate(angle).png().toBuffer());
  assert.deepEqual(codes,[internal],'Archived photo must retain exact 16-digit Code128 in orientation '+angle);
 }
 assert.deepEqual(policy.variants(internal),[internal],'Internal identifier must never become a padded GTIN alias');
 const equivalent=['012345678905','0012345678905','00012345678905'];
 for(const source of equivalent)for(const target of equivalent){
  assert.ok(policy.variants(source).includes(target),'UPC leading-zero aliases must be symmetric: '+source+' -> '+target);
 }
 assert.ok(!policy.variants('12345678901234').includes('345678901234'),'Never remove nonzero GTIN-14 indicator digits');
 assert.ok(!policy.variants('96385074').includes('000096385074'),'EAN-8 does not acquire a new UPC alias');
 for(const code of ['061564059101279','0000000000000000','123456789','12345678901']){
  assert.deepEqual(await decode(await raster(code)),[],'Reject unsupported/truncated identifier length or all zero: '+code);
 }
 for(const [code,format] of [['5901234123457','EAN13'],['196974865902','UPCA'],['96385074','EAN8'],['12345678901234','ITF']]){
  const codes=await decode(await raster(code,format));
  assert.equal(codes.length,1,'Existing '+format+' reading remains supported');
  assert.equal(policy.identity(codes[0]),policy.identity(code),'Existing '+format+' retains its decoded identity');
 }
 const ean=await raster('5901234123457','EAN13'),meta1=await sharp(image).metadata(),meta2=await sharp(ean).metadata();
 const mixed=await sharp({create:{width:Math.max(meta1.width,meta2.width)+80,height:meta1.height+meta2.height+120,channels:4,background:'white'}})
  .composite([{input:image,left:40,top:40},{input:ean,left:40,top:meta1.height+80}]).png().toBuffer();
 assert.deepEqual((await decode(mixed)).sort(),[internal,'5901234123457'].sort(),'Two distinct decoded identifiers remain ambiguous; industrial does not silently replace EAN');
 console.log('PASS: real raster exact 16-digit internal Code128 in four rotations; leading zero retained; no GTIN alias; invalid lengths/all zero rejected; EAN/UPC/ITF preserved; mixed identifiers retained for conflict checking.');
})().catch(error=>{console.error(error);process.exitCode=1;});
