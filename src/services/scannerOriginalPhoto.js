'use strict';
const sharp=require('sharp');
async function archiveDataUri(bytes) {
  const bad=message=>{const e=Error(message);e.status=400;throw e;};
  if(!Buffer.isBuffer(bytes)||!bytes.length||bytes.length>12*1024*1024)bad('Foto inválida ou maior que 12 MB.');
  let metadata;
  try {metadata=await sharp(bytes,{limitInputPixels:16000000,failOn:'warning'}).metadata();
    await sharp(bytes,{limitInputPixels:16000000,failOn:'warning'}).stats();}
  catch(_){bad('A foto chegou incompleta ou corrompida. Reenvie a imagem da mesma peça.');}
  if(!['jpeg','png','webp'].includes(metadata.format)||(metadata.pages||1)>1)bad('Envie uma foto JPEG, PNG ou WebP estática.');
  return 'data:image/'+metadata.format+';base64,'+bytes.toString('base64');
}
module.exports={archiveDataUri};
