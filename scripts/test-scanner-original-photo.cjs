'use strict';
const assert=require('node:assert/strict'),sharp=require('sharp');
const {archiveDataUri}=require('../src/services/scannerOriginalPhoto');
(async()=>{
 for(const format of ['jpeg','png','webp']){
  const image=await sharp({create:{width:1800,height:1200,channels:3,background:'#03a6ef'}}).toFormat(format).toBuffer();
  assert.equal(await archiveDataUri(image),'data:image/'+format+';base64,'+image.toString('base64'));
  await assert.rejects(archiveDataUri(image.subarray(0,Math.floor(image.length/2))),/incompleta|corrompida/);
 }
 await assert.rejects(archiveDataUri(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"/>')),/JPEG/);
 await assert.rejects(archiveDataUri(Buffer.alloc(12*1024*1024+1)),/12 MB/);
 console.log('PASS: inventory preserves original JPEG/PNG/WebP bytes and rejects truncated/unsupported/oversized photos.');
})().catch(e=>{console.error(e);process.exitCode=1;});
