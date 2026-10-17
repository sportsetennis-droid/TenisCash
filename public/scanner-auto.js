/* Automatic capture, entirely on-device. One capture per explicit next-piece cycle. */
(function (root) {
  'use strict';
  function createCanvas(){return typeof document!=='undefined'?document.createElement('canvas'):new OffscreenCanvas(1,1);}
  function labelText(text) {
    return /\b(?:[A-Z]{2}\d{4}(?:[- ]?\d{3})?|\d{5,6}(?:BR)?\s*[/\-]\s*[A-Z]{2,5})\b/i.test(text) &&
      (/\bBRA?\s*[:\-]?\s*\d{2}\b/i.test(text) || /^\s*(?:SIZE\s+)?(?:XXXL|XXL|XL|XS|L|M|S|P|G|GG|PP)\s*$/im.test(text));
  }
  function signature(canvas) {
    const c=createCanvas();c.width=24;c.height=24;
    const ctx=c.getContext('2d',{willReadFrequently:true});
    ctx.drawImage(canvas,canvas.width*.15,canvas.height*.15,canvas.width*.7,canvas.height*.7,0,0,24,24);
    const pixels=ctx.getImageData(0,0,24,24).data;
    return Array.from({length:576},(_,i)=>(pixels[i*4]+pixels[i*4+1]+pixels[i*4+2])/3);
  }
  function distance(a,b){return a.reduce((sum,v,i)=>sum+Math.abs(v-b[i]),0)/a.length;}
  function create({snapshot,decode,recognize,canRead,onCapture,onHint,now=Date.now}) {
    let epoch=0,locked=false,busy=false,lastCode='',hits=0,lastOcr=0,previous=null,stableSince=0,afterCode='',clearFrames=0,ocrJob=null;
    function reset(options={}){epoch++;busy=false;locked=false;lastCode='';hits=0;previous=null;stableSince=now();afterCode=String(options.afterCode||'').replace(/^0+/,'');clearFrames=0;}
    function stop(){epoch++;locked=true;}
    async function tick(){
      if(locked||busy||!canRead())return;
      const frame=snapshot();if(!frame)return;
      const stamp=epoch;busy=true;
      try {
        const code=await decode(frame);
        if(stamp!==epoch||locked||!canRead())return;
        if(afterCode){
          const normalized=String(code||'').replace(/^0+/,'');
          if(normalized===afterCode){clearFrames=0;onHint('Afaste a etiqueta já lida antes de apresentar outro par.');return;}
          if(!normalized && ++clearFrames<2)return;
          afterCode='';clearFrames=0;
        }
        if(code){hits=code===lastCode?hits+1:1;lastCode=code;
          onHint('Código reconhecido. Mantenha a etiqueta parada…');
          if(hits>=2&&stamp===epoch&&canRead()){locked=true;onCapture({ean:code,frame});}return;
        }
        lastCode='';hits=0;
        const sig=signature(frame);
        if(!previous||distance(previous,sig)>8){stableSince=now();previous=sig;return;}
        previous=sig;
        if(ocrJob||now()-stableSince<1200||now()-lastOcr<4000)return;
        lastOcr=now();onHint('Lendo referência automaticamente… mantenha a etiqueta parada.');
        // OCR may take seconds. Keep decoding subsequent barcode frames while
        // one OCR job runs, and accept its result only for the same still frame.
        const job={stamp};ocrJob=job;
        Promise.resolve().then(()=>recognize(frame)).then(text=>{
          if(stamp!==epoch||locked||lastCode||!canRead())return;
          const current=snapshot();
          if(current&&distance(sig,signature(current))<=10&&labelText(text)){
            locked=true;onCapture({ean:'',frame,ocrText:text});
          }else onHint('Centralize a etiqueta inteira e mantenha parada. Leitura automática ativa.');
        }).catch(()=>{if(stamp===epoch&&!locked&&!lastCode)onHint('Leitura automática ativa. Centralize o código de barras.');})
          .finally(()=>{if(ocrJob===job)ocrJob=null;});
      } catch (error) {if(stamp===epoch&&!locked)onHint(error?.code==='SCANNER_DECODER_UNAVAILABLE'?'O leitor automático está tentando se recuperar. Mantenha a etiqueta na câmera.':'Centralize a etiqueta inteira e mantenha parada.');}
      finally{if(stamp===epoch)busy=false;}
    }
    return {tick,reset,stop};
  }
  let wasmReady;
  const wasmLocation=()=>'/vendor/barcode/zxing_reader.wasm';
  const readerOptions={tryHarder:true,tryRotate:true,tryInvert:true,formats:['EAN13','UPCA','EAN8','Code128','ITF'],maxNumberOfSymbols:3};
  async function prepareReader(){
    if(!root.ZXingWASM)throw new Error('Leitor de código não carregado');
    if(!wasmReady)wasmReady=root.ZXingWASM.prepareZXingModule({overrides:{locateFile:wasmLocation},fireImmediately:true});
    try{await wasmReady;}catch(error){wasmReady=null;root.ZXingWASM.purgeZXingModule?.();throw error;}
  }
  // ZXing accepts an ImageData-shaped object. No Canvas or ImageData constructor
  // is needed inside a worker (some Safari/WebKit workers expose neither).
  function centeredPixels(image){
    const width=Math.max(1,Math.round(image.width*.84)),height=Math.max(1,Math.round(image.height*.84));
    const left=Math.floor((image.width-width)/2),top=Math.floor((image.height-height)/2);
    const data=new Uint8ClampedArray(width*height*4);
    for(let y=0;y<height;y++)data.set(image.data.subarray(((top+y)*image.width+left)*4,((top+y)*image.width+left+width)*4),y*width*4);
    return {width,height,data};
  }
  function rotatedEnhancedPixels(image){
    const scale=Math.min(2,2000/Math.max(image.width,image.height));
    const width=Math.max(1,Math.round(image.height*scale)),height=Math.max(1,Math.round(image.width*scale));
    const data=new Uint8ClampedArray(width*height*4);
    for(let y=0;y<height;y++)for(let x=0;x<width;x++){
      const sx=Math.min(image.width-1,Math.floor(y/scale)),sy=Math.max(0,image.height-1-Math.floor(x/scale));
      const from=(sy*image.width+sx)*4,to=(y*width+x)*4;
      data[to]=image.data[from];data[to+1]=image.data[from+1];data[to+2]=image.data[from+2];data[to+3]=image.data[from+3];
    }
    root.ScannerRegions?.normalizePixels(data);
    return {width,height,data};
  }
  async function decodePixels(image){
    if(!Number.isInteger(image?.width)||!Number.isInteger(image?.height)||image.width<1||image.height<1||image.width*image.height>16000000||image.data?.length!==image.width*image.height*4)throw new Error('Quadro de leitura inválido');
    await prepareReader();
    const centered=centeredPixels(image);
    let results=await root.ZXingWASM.readBarcodes(centered,readerOptions);
    if(!results.length)results=await root.ZXingWASM.readBarcodes(rotatedEnhancedPixels(centered),readerOptions);
    const codes=[...new Set(results.map(r=>String(r.text||'')).filter(t=>/^\d{8}$|^\d{12,14}$/.test(t)))];
    return codes.length===1?codes[0]:'';
  }
  let decoderWorker, decoderRequest=0, decoderPending, decoderEpoch=0, workerRetryAt=0;
  let decoderState={method:'worker',ready:false,error:null};
  function destroyWorker(){decoderWorker?.terminate();decoderWorker=null;}
  function stopDecoder(){
    decoderEpoch++;destroyWorker();
    if(decoderPending){clearTimeout(decoderPending.timer);decoderPending.resolve('');decoderPending=null;}
    decoderState={method:'worker',ready:false,error:null};
  }
  function workerFailed(worker,reason){
    if(decoderWorker!==worker)return;
    if(decoderPending){void fallbackDecode(decoderPending,reason);return;}
    // An idle worker can fail between frames. Do not send the next frame into
    // a dead worker and wait another timeout before recovering.
    destroyWorker();workerRetryAt=Date.now()+30000;
    decoderState={method:'fallback',ready:false,error:reason};
  }
  async function fallbackDecode(pending,reason){
    if(decoderPending!==pending||pending.epoch!==decoderEpoch||pending.fallback)return;
    pending.fallback=true;clearTimeout(pending.timer);destroyWorker();
    workerRetryAt=Date.now()+30000;decoderState={method:'fallback',ready:false,error:String(reason||'worker unavailable')};
    pending.timer=setTimeout(()=>finishDecode(pending,null,new Error('Tempo de recuperação excedido')),10000);
    try{
      // Used only when the worker cannot run; one bounded frame, no backlog,
      // and a task boundary lets the camera controls update before recovery.
      await new Promise(resolve=>setTimeout(resolve,0));
      if(decoderPending!==pending||pending.epoch!==decoderEpoch)return;
      const pixels=pending.frame.getContext('2d',{willReadFrequently:true}).getImageData(0,0,pending.frame.width,pending.frame.height);
      const code=await decodePixels(pixels);
      finishDecode(pending,code);
    }catch(error){finishDecode(pending,null,error);}
  }
  function finishDecode(pending,code,error){
    if(decoderPending!==pending||pending.epoch!==decoderEpoch)return;
    clearTimeout(pending.timer);decoderPending=null;
    if(error){decoderState={method:pending.fallback?'fallback':'worker',ready:false,error:String(error.message||error)};error.code='SCANNER_DECODER_UNAVAILABLE';pending.reject(error);}
    else{decoderState={method:pending.fallback?'fallback':'worker',ready:true,error:null};pending.resolve(code||'');}
  }
  function decodeInWorker(frame){
    if(decoderPending)return Promise.resolve('');
    return new Promise((resolve,reject)=>{
      const pending={id:++decoderRequest,epoch:decoderEpoch,frame,resolve,reject,fallback:false};decoderPending=pending;
      if(typeof Worker==='undefined'||Date.now()<workerRetryAt){void fallbackDecode(pending,'Worker indisponível');return;}
      try{
      if(!decoderWorker){
        const worker=decoderWorker=new Worker('/scanner-barcode-worker.js?v=20261017-auto-reader-3');
        worker.onmessage=({data})=>{
          if(decoderWorker!==worker)return;
          if(data?.ready){decoderState={method:'worker',ready:true,error:null};return;}
          const current=decoderPending;if(!current||data?.id!==current.id)return;
          if(data.error){void fallbackDecode(current,data.error);return;}
          finishDecode(current,data.code);
        };
        worker.onerror=()=>workerFailed(worker,'Falha ao iniciar o leitor');
        worker.onmessageerror=()=>workerFailed(worker,'Falha de comunicação com o leitor');
      }
      const pixels=frame.getContext('2d',{willReadFrequently:true}).getImageData(0,0,frame.width,frame.height);
      pending.timer=setTimeout(()=>fallbackDecode(pending,'O leitor não respondeu'),10000);
      decoderWorker.postMessage({id:pending.id,width:pixels.width,height:pixels.height,buffer:pixels.data.buffer},[pixels.data.buffer]);
      }catch(error){void fallbackDecode(pending,error.message);}
    });
  }
  async function decodeCanvas(frame,core,ZXing){
    if(root.ZXingWASM)try{
      const pixels=frame.getContext('2d',{willReadFrequently:true}).getImageData(0,0,frame.width,frame.height);
      return await decodePixels(pixels);
    }catch(_){}
    if(!core||!ZXing)return '';
    // Central crops in both axes: never scan a product at the edge of the scene.
    for(const [fw,fh] of [[.6,.38],[.84,.84]])for(const angle of [0,90]){
      const w=Math.round(frame.width*fw),h=Math.round(frame.height*fh),c=createCanvas();
      c.width=angle?h:w;c.height=angle?w:h;const ctx=c.getContext('2d');
      ctx.translate(c.width/2,c.height/2);ctx.rotate(angle*Math.PI/180);
      ctx.drawImage(frame,(frame.width-w)/2,(frame.height-h)/2,w,h,-w/2,-h/2,w,h);
      try{const result=core.decode(new ZXing.BinaryBitmap(new ZXing.HybridBinarizer(new ZXing.HTMLCanvasElementLuminanceSource(c))));
        const text=String(result.getText()||'').trim();if(/^\d{8}$|^\d{12,14}$/.test(text))return text;
      }catch(_){}finally{core.reset();}
    }
    return '';
  }
  const api={create,decodeCanvas,decodePixels,decodeInWorker,stopDecoder,labelText,decoderStatus:()=>({...decoderState})};
  if(typeof module==='object'&&module.exports)module.exports=api;else root.ScannerAuto=api;
})(typeof window!=='undefined'?window:globalThis);
