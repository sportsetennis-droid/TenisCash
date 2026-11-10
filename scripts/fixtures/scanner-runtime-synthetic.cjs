'use strict';
// Benchmark inputs are generated from literal SVG and an EAN test symbol.
// No photographs, database, catalogue records, remote fonts or network access.
const fs=require('node:fs'),path=require('node:path'),{createHash}=require('node:crypto');
const sharp=require('sharp'),writer=require('zxing-wasm/writer');
const WIDTH=1800,HEIGHT=1013,BARCODE='5901234123457';
const digest=bytes=>createHash('sha256').update(bytes).digest('hex');
let writerReady=false;
const wrap=body=>`<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${HEIGHT}" viewBox="0 0 ${WIDTH} ${HEIGHT}">
<rect width="1800" height="1013" fill="white"/>
<rect x="40" y="40" width="1720" height="933" fill="none" stroke="#111" stroke-width="5"/>
<g fill="#111" font-family="sans-serif">${body}</g></svg>`;
const stressSvg=wrap(`
<text x="90" y="135" font-size="68" font-weight="bold">SYNTHETIC MEMORY CONTROL</text>
<text x="90" y="230" font-size="45">ALPHA LABEL   OMEGA SAMPLE   DELTA TEST</text>
<rect x="85" y="285" width="1630" height="300" fill="#fafafa" stroke="#777" stroke-width="3"/>
<path d="M85 435H1715 M625 285V585 M1170 285V585" stroke="#777" stroke-width="3" fill="none"/>
<text x="125" y="380" font-size="43">SAMPLE TEXT</text>
<text x="675" y="380" font-size="43">TEST IMAGE</text>
<text x="1210" y="380" font-size="43">LITERAL WORDS</text>
<text x="125" y="530" font-size="43">ONLY SYNTHETIC</text>
<text x="675" y="530" font-size="43">NO SIZES</text>
<text x="1210" y="530" font-size="43">NO MODEL</text>
<text x="930" y="745" font-size="45">ALPHA BETA GAMMA</text>
<text x="930" y="825" font-size="45">OMEGA DELTA SIGMA</text>
<text x="100" y="943" font-size="32">SYNTHETIC PIXELS ONLY</text>`);
const positiveSvg=wrap(`
<text x="90" y="140" font-size="65" font-weight="bold">SYNTHETIC POSITIVE CONTROL</text>
<text x="100" y="335" font-size="126" font-weight="bold">AB12345</text>
<text x="100" y="535" font-size="126" font-weight="bold">BR</text>
<text x="370" y="535" font-size="126" font-weight="bold">41</text>
<text x="970" y="740" font-size="46">TEST LABEL ONLY</text>
<text x="100" y="943" font-size="32">SYNTHETIC PIXELS ONLY</text>`);

async function generateFixtures(){
 if(!writerReady){writer.prepareZXingModule({overrides:{wasmBinary:fs.readFileSync(path.join(__dirname,'../../node_modules/zxing-wasm/dist/writer/zxing_writer.wasm'))}});writerReady=true;}
 const symbol=await writer.writeBarcode(BARCODE,{format:'EAN-13',scale:5,addQuietZones:true,addHRT:false});
 if(symbol.error||!symbol.image)throw Error('Synthetic EAN generation failed');
 const rendered=Buffer.from(await symbol.image.arrayBuffer());
 // The synthetic barcode has its own quiet zone; nearest-neighbour resizing
 // keeps each bar crisp. This is fixture construction, never a photo transform.
 const barcodeBitmap=await sharp(rendered).resize({width:684,height:220,fit:'fill',kernel:'nearest'}).png().toBuffer();
 const sources=[{name:'stress',sourceSvg:stressSvg,expected:{pending:true,reason:'photo_size_or_reference_pending',passes:16}},
  {name:'positive',sourceSvg:positiveSvg,expected:{size:'41',reference:'AB12345'}}];
 const fixtures=[];
 for(const source of sources){
  const buffer=await sharp(Buffer.from(source.sourceSvg)).composite([{input:barcodeBitmap,left:100,top:660}]).png().toBuffer();
  const info=await sharp(buffer).metadata();
  if(info.width!==WIDTH||info.height!==HEIGHT)throw Error('Synthetic fixture dimensions changed');
  fixtures.push({...source,synthetic:true,width:WIDTH,height:HEIGHT,barcode:BARCODE,buffer,
   sha256:digest(buffer),sourceSvgSha256:digest(source.sourceSvg),barcodeBitmapSha256:digest(barcodeBitmap)});
 }
 return fixtures;
}
module.exports={generateFixtures,WIDTH,HEIGHT,BARCODE};
