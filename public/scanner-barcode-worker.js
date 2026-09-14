/* Heavy barcode work never runs on the camera/UI thread. */
importScripts('/vendor/barcode/zxing-reader-3.1.4.js','/scanner-regions.js?v=20260914-worker-1','/scanner-auto.js?v=20260914-worker-1');
self.onmessage=async({data})=>{
  try{
    const frame=new OffscreenCanvas(data.width,data.height);
    frame.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(data.buffer),data.width,data.height),0,0);
    const code=await self.ScannerAuto.decodeCanvas(frame);
    self.postMessage({id:data.id,code});
  }catch(_){self.postMessage({id:data.id,code:''});}
};
