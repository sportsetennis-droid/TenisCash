/* Pixel-buffer decoding does not require OffscreenCanvas or ImageData. */
importScripts('/vendor/barcode/zxing-reader-3.1.4.js','/scanner-regions.js?v=20260914-worker-1','/scanner-auto.js?v=20261018-live-fast-1');
self.onmessage=async({data})=>{
  try{
    const code=await self.ScannerAuto.decodePixels({width:data.width,height:data.height,data:new Uint8ClampedArray(data.buffer)});
    self.postMessage({id:data.id,code});
  }catch(error){self.postMessage({id:data.id,error:String(error.message||error),code:''});}
};
// Compile/load WASM while getUserMedia is starting, before the first frame.
self.ScannerAuto.prepareReader().then(()=>self.postMessage({ready:true,pixelBuffer:true}))
  .catch(error=>self.postMessage({type:'init-error',error:String(error.message||error)}));
