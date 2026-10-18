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
          onHint('Leitura automática ativa — centralize a etiqueta e mantenha parada.');
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
  function barcodeRegions(image){
    const w=image.width,h=image.height,block=8,cols=Math.ceil(w/block),rows=Math.ceil(h/block);
    const gray=new Uint8Array(w*h),gx=new Float32Array(cols*rows),gy=new Float32Array(cols*rows);
    for(let i=0;i<gray.length;i++)gray[i]=(image.data[i*4]+image.data[i*4+1]+image.data[i*4+2])/3;
    for(let by=0;by<rows;by++)for(let bx=0;bx<cols;bx++){
      let xEdges=0,yEdges=0,n=0;
      for(let y=Math.max(1,by*block);y<Math.min(h-1,(by+1)*block);y+=2)for(let x=Math.max(1,bx*block);x<Math.min(w-1,(bx+1)*block);x+=2){
        xEdges+=Math.abs(gray[y*w+x+1]-gray[y*w+x-1]);yEdges+=Math.abs(gray[(y+1)*w+x]-gray[(y-1)*w+x]);n++;
      }
      gx[by*cols+bx]=xEdges/(n||1);gy[by*cols+bx]=yEdges/(n||1);
    }
    const regions=[];
    // Coherent parallel edges locate bars in either orientation. Text and
    // package art usually have mixed gradients, so they are not enlarged.
    for(const verticalBars of [true,false]){
      const active=new Uint8Array(cols*rows),seen=new Uint8Array(cols*rows);
      for(let i=0;i<active.length;i++){const a=verticalBars?gx[i]:gy[i],b=verticalBars?gy[i]:gx[i];active[i]=a>=10&&a>b*2?1:0;}
      const components=[];
      for(let start=0;start<active.length;start++){
        if(!active[start]||seen[start])continue;
        const queue=[start];seen[start]=1;let minX=cols,minY=rows,maxX=0,maxY=0;
        for(let at=0;at<queue.length;at++){
          const i=queue[at],x=i%cols,y=Math.floor(i/cols);minX=Math.min(minX,x);maxX=Math.max(maxX,x);minY=Math.min(minY,y);maxY=Math.max(maxY,y);
          for(let dy=-1;dy<=1;dy++)for(let dx=-1;dx<=1;dx++){
            const nx=x+dx,ny=y+dy,ni=ny*cols+nx;
            if(nx>=0&&ny>=0&&nx<cols&&ny<rows&&active[ni]&&!seen[ni]){seen[ni]=1;queue.push(ni);}
          }
        }
        const cw=(maxX-minX+1)*block,ch=(maxY-minY+1)*block,along=verticalBars?ch:cw;
        if(along>=24&&queue.length>=4)components.push({minX,minY,maxX,maxY,cells:queue.length});
      }
      // White modules may separate bars into components. Join only adjacent
      // components with matching height, without joining text above/below.
      if(components.length>256)return [{},{},{},{}];
      components.sort((a,b)=>verticalBars?a.minX-b.minX:a.minY-b.minY);
      const merged=[];
      for(const component of components){
        const start=verticalBars?component.minY:component.minX,end=verticalBars?component.maxY:component.maxX;
        const group=merged.find(item=>{
          const a=verticalBars?item.minY:item.minX,b=verticalBars?item.maxY:item.maxX;
          const gap=(verticalBars?component.minX-item.maxX:component.minY-item.maxY)-1;
          return gap>=0&&gap<=2&&Math.abs((end-start)-(b-a))<=Math.min(end-start+1,b-a+1)*.25&&Math.min(end,b)-Math.max(start,a)+1>=Math.min(end-start+1,b-a+1)*.8;
        });
        if(group){group.minX=Math.min(group.minX,component.minX);group.minY=Math.min(group.minY,component.minY);group.maxX=Math.max(group.maxX,component.maxX);group.maxY=Math.max(group.maxY,component.maxY);group.cells+=component.cells;}
        else merged.push({...component});
      }
      for(const {minX,minY,maxX,maxY,cells} of merged){
        const cw=(maxX-minX+1)*block,ch=(maxY-minY+1)*block,across=verticalBars?cw:ch,along=verticalBars?ch:cw;
        if(across<60||across<along*1.2||cells*block*block/(cw*ch)<.45)continue;
        // Quiet zones remain inside the crop; never truncate the outer bars.
        const px=Math.max(12,Math.round(cw*.12)),py=Math.max(12,Math.round(ch*.12));
        const x=Math.max(0,minX*block-px),y=Math.max(0,minY*block-py);
        regions.push({x,y,width:Math.min(w,(maxX+1)*block+px)-x,height:Math.min(h,(maxY+1)*block+py)-y});
      }
    }
    return regions;
  }
  function enlargedRegionPixels(image,region){
    const scale=Math.min(4,1600/Math.max(region.width,region.height),Math.sqrt(850000/(region.width*region.height)));
    const width=Math.max(1,Math.round(region.width*scale)),height=Math.max(1,Math.round(region.height*scale)),data=new Uint8ClampedArray(width*height*4);
    // Bilinear pixels, not a canvas: compatible with WebKit workers too.
    for(let y=0;y<height;y++){
      const sy=Math.max(0,Math.min(region.height-1,(y+.5)*region.height/height-.5)),y0=Math.floor(sy),fy=sy-y0,y1=Math.min(region.height-1,y0+1);
      for(let x=0;x<width;x++){
        const sx=Math.max(0,Math.min(region.width-1,(x+.5)*region.width/width-.5)),x0=Math.floor(sx),fx=sx-x0,x1=Math.min(region.width-1,x0+1);
        const a=((region.y+y0)*image.width+region.x+x0)*4,b=((region.y+y0)*image.width+region.x+x1)*4,c=((region.y+y1)*image.width+region.x+x0)*4,d=((region.y+y1)*image.width+region.x+x1)*4,to=(y*width+x)*4;
        for(let channel=0;channel<3;channel++)data[to+channel]=(image.data[a+channel]*(1-fx)+image.data[b+channel]*fx)*(1-fy)+(image.data[c+channel]*(1-fx)+image.data[d+channel]*fx)*fy;
        data[to+3]=255;
      }
    }
    return {width,height,data};
  }
  async function recoverBarcodeRegions(image,regions){
    // Do not select the first label or silently skip candidates when a crowded
    // frame exceeds budget. A null result means the frame cannot be accepted.
    if(!regions.length)return [];if(regions.length>3)return null;
    const enlarged=regions.map(region=>enlargedRegionPixels(image,region));
    if(enlarged.reduce((sum,item)=>sum+item.width*item.height*2,0)>5100000)return null;
    const results=[];
    for(const candidate of enlarged){
      results.push(...await root.ZXingWASM.readBarcodes(candidate,readerOptions));
      root.ScannerRegions?.normalizePixels(candidate.data);
      results.push(...await root.ZXingWASM.readBarcodes(candidate,readerOptions));
    }
    return results;
  }
  async function decodePixels(image){
    if(!Number.isInteger(image?.width)||!Number.isInteger(image?.height)||image.width<1||image.height<1||image.width*image.height>16000000||image.data?.length!==image.width*image.height*4)throw new Error('Quadro de leitura inválido');
    await prepareReader();
    const centered=centeredPixels(image);
    let results=await root.ZXingWASM.readBarcodes(centered,readerOptions);
    if(!results.length)results=await root.ZXingWASM.readBarcodes(rotatedEnhancedPixels(centered),readerOptions);
    const regions=barcodeRegions(centered);
    if(regions.length>3)return '';
    // A sharp label must not hide a second blurry label in the same frame.
    if(!results.length||regions.length>1){
      const recovered=await recoverBarcodeRegions(centered,regions);if(recovered===null)return '';
      results.push(...recovered);
    }
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
        const worker=decoderWorker=new Worker('/scanner-barcode-worker.js?v=20261017-auto-reader-4');
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
