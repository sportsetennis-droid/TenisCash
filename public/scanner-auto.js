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
    let epoch=0,locked=false,busy=false,lastCode='',hits=0,lastOcr=0,previous=null,stableSince=0,afterCode='',clearFrames=0;
    function reset(options={}){epoch++;locked=false;lastCode='';hits=0;previous=null;stableSince=now();afterCode=String(options.afterCode||'').replace(/^0+/,'');clearFrames=0;}
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
        if(now()-stableSince<1200||now()-lastOcr<4000)return;
        lastOcr=now();onHint('Lendo referência automaticamente… mantenha a etiqueta parada.');
        const text=await recognize(frame);
        if(stamp!==epoch||locked||!canRead())return;
        const current=snapshot();
        if(current&&distance(sig,signature(current))<=10&&labelText(text)){
          locked=true;onCapture({ean:'',frame,ocrText:text});
        } else onHint('Centralize a etiqueta inteira e mantenha parada. Leitura automática ativa.');
      } catch (_) {if(stamp===epoch&&!locked)onHint('Centralize a etiqueta inteira e mantenha parada.');}
      finally{busy=false;}
    }
    return {tick,reset,stop};
  }
  let wasmReady;
  let decoderWorker, decoderRequest=0, decoderPending;
  function stopDecoder(){
    decoderWorker?.terminate();decoderWorker=null;
    if(decoderPending){clearTimeout(decoderPending.timer);decoderPending.resolve('');decoderPending=null;}
  }
  function decodeInWorker(frame){
    if(decoderPending)return Promise.resolve('');
    if(typeof Worker==='undefined')return Promise.resolve('');
    try{
      if(!decoderWorker){
        decoderWorker=new Worker('/scanner-barcode-worker.js?v=20260914-worker-1');
        decoderWorker.onmessage=({data})=>{if(!decoderPending||data.id!==decoderPending.id)return;const pending=decoderPending;decoderPending=null;clearTimeout(pending.timer);pending.resolve(data.code||'');};
        decoderWorker.onerror=stopDecoder;
      }
      const pixels=frame.getContext('2d',{willReadFrequently:true}).getImageData(0,0,frame.width,frame.height);
      return new Promise(resolve=>{
        const id=++decoderRequest,timer=setTimeout(stopDecoder,10000);
        decoderPending={id,resolve,timer};
        try{decoderWorker.postMessage({id,width:pixels.width,height:pixels.height,buffer:pixels.data.buffer},[pixels.data.buffer]);}catch(_){stopDecoder();}
      });
    }catch(_){stopDecoder();return Promise.resolve('');}
  }
  async function decodeCanvas(frame,core,ZXing){
    if(root.ZXingWASM)try{
      if(!wasmReady)wasmReady=root.ZXingWASM.prepareZXingModule({overrides:{locateFile:()=>'/vendor/barcode/zxing_reader.wasm'},fireImmediately:true});
      await wasmReady;
      const c=createCanvas();c.width=Math.round(frame.width*.84);c.height=Math.round(frame.height*.84);
      const ctx=c.getContext('2d',{willReadFrequently:true});ctx.drawImage(frame,(frame.width-c.width)/2,(frame.height-c.height)/2,c.width,c.height,0,0,c.width,c.height);
      const options={tryHarder:true,tryRotate:true,tryInvert:true,formats:['EAN13','UPCA','EAN8','Code128','ITF'],maxNumberOfSymbols:3};
      let results=await root.ZXingWASM.readBarcodes(ctx.getImageData(0,0,c.width,c.height),options);
      if(!results.length){
        const enhanced=createCanvas(),scale=Math.min(2,2000/Math.max(c.width,c.height));
        enhanced.width=Math.round(c.height*scale);enhanced.height=Math.round(c.width*scale);
        const ec=enhanced.getContext('2d',{willReadFrequently:true});ec.translate(enhanced.width/2,enhanced.height/2);ec.rotate(Math.PI/2);ec.drawImage(c,-c.width*scale/2,-c.height*scale/2,c.width*scale,c.height*scale);
        const pixels=ec.getImageData(0,0,enhanced.width,enhanced.height);root.ScannerRegions?.normalizePixels(pixels.data);
        results=await root.ZXingWASM.readBarcodes(pixels,options);
      }
      const codes=[...new Set(results.map(r=>String(r.text||'')).filter(t=>/^\d{8}$|^\d{12,14}$/.test(t)))];
      if(codes.length===1)return codes[0];
      if(codes.length>1)return '';
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
  const api={create,decodeCanvas,decodeInWorker,stopDecoder,labelText};
  if(typeof module==='object'&&module.exports)module.exports=api;else root.ScannerAuto=api;
})(typeof window!=='undefined'?window:globalThis);
