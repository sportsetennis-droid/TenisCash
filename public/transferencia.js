(function(){
 'use strict';
 const $=id=>document.getElementById(id);
 let token=sessionStorage.getItem('tc_transfer_token')||localStorage.getItem('tc_token')||localStorage.getItem('tc_admin_token')||'',actor,sessionId,selection,lastTransfer,stream,scanner,loop,busy=false,scanGeneration=0,undoId;
 const pendingKey=()=> 'tc_transfer_pending_'+actor.id;
 const pending=()=>{try{return JSON.parse(localStorage.getItem(pendingKey())||'null');}catch(_){return null;}};
 function message(text,error=false){$('message').textContent=text;$('message').hidden=!text;$('message').className='message'+(error?' error':'');}
 async function api(path,body){const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),25000);try{const r=await fetch('/api/scan-transfers'+path,{method:body?'POST':'GET',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},body:body?JSON.stringify(body):undefined,signal:controller.signal});const data=await r.json();if(!r.ok){const e=new Error(data.error||'Não foi possível concluir.');e.status=r.status;throw e;}return data;}finally{clearTimeout(timer);}}
 function stopCamera(){scanGeneration++;clearInterval(loop);scanner?.stop();scanner=null;window.ScannerAuto.stopDecoder();stream?.getTracks().forEach(t=>t.stop());stream=null;$('video').srcObject=null;$('cameraBox').hidden=true;$('startCamera').hidden=false;}
 function frame(){const v=$('video');if(!v.videoWidth)return null;const c=document.createElement('canvas'),k=Math.min(1,1800/Math.max(v.videoWidth,v.videoHeight));c.width=Math.round(v.videoWidth*k);c.height=Math.round(v.videoHeight*k);c.getContext('2d').drawImage(v,0,0,c.width,c.height);return c;}
 async function startCamera(){if(busy||pending())return;stopCamera();const generation=scanGeneration;message('');$('result').hidden=true;$('selection').hidden=true;
   try{const opened=await navigator.mediaDevices.getUserMedia({audio:false,video:{facingMode:{ideal:'environment'},width:{ideal:1920},height:{ideal:1080}}});if(generation!==scanGeneration){opened.getTracks().forEach(t=>t.stop());return;}stream=opened;$('video').srcObject=stream;await $('video').play();$('cameraBox').hidden=false;$('startCamera').hidden=true;
    scanner=ScannerAuto.create({snapshot:frame,decode:c=>ScannerAuto.decodeInWorker(c),recognize:c=>ScannerOCR.recognize(c),canRead:()=>!!stream&&!busy&&generation===scanGeneration,onHint:t=>$('hint').textContent=t,onCapture:p=>identify(p,generation)});loop=setInterval(()=>scanner?.tick(),400);
   }catch(e){stopCamera();message('Não foi possível abrir a câmera. Permita o acesso à câmera neste navegador e tente novamente.',true);}
 }
 async function identify(read,generation){busy=true;scanner?.stop();$('hint').textContent='Identificando produto e lojas…';
   try{let data;try{data=await api('/lookup',{barcode:read.ean,ocrText:read.ocrText||''});}catch(e){if(e.status!==404||read.ocrText)throw e;const text=await ScannerOCR.recognize(read.frame,t=>$('hint').textContent=t);if(generation!==scanGeneration)return;data=await api('/lookup',{barcode:read.ean,ocrText:text});}
    if(generation!==scanGeneration)return;stopCamera();selection={...data,requestId:crypto.randomUUID()};renderSelection();
   }catch(e){if(generation===scanGeneration){stopCamera();message(e.message||'Não foi possível identificar. Tente novamente.',true);}}
   finally{busy=false;}
 }
 function option(select,value,label,disabled=false){const o=document.createElement('option');o.value=value;o.textContent=label;o.disabled=disabled;select.append(o);}
 function renderSelection(){const p=selection.product;$('selection').hidden=false;$('result').hidden=true;$('productName').textContent=p.name;$('productDetail').textContent=p.brand+' · Tamanho '+p.size+' · '+p.barcode;
  $('locationsText').textContent=selection.locations.length?'Saldo cadastrado: '+selection.locations.map(s=>s.name+' ('+s.code+'): '+s.quantity).join(' · '):'Nenhuma loja possui saldo disponível deste tamanho. A transferência exige saldo cadastrado; uma contagem de inventário ainda aberta não altera esse saldo.';
  $('origin').replaceChildren();option($('origin'),'','Selecione a origem');for(const s of selection.locations)option($('origin'),s.id,s.name+' · '+s.code+' · '+s.quantity+' disponível(is)'+(!s.canTransfer?' · sem permissão na sua conta':''),!s.canTransfer);
  if(selection.locations.length===1&&selection.locations[0].canTransfer)$('origin').value=selection.locations[0].id;
  originChanged();$('selection').scrollIntoView({behavior:'smooth',block:'start'});
 }
 function originChanged(){$('destination').replaceChildren();option($('destination'),'','Selecione o destino');for(const s of selection.stores)if(s.id!==$('origin').value)option($('destination'),s.id,s.name+' · '+s.code);updateConfirmation();}
 function updateConfirmation(){const from=$('origin'),to=$('destination');$('confirmButton').disabled=busy||!from.value||!to.value||from.value===to.value;$('confirmationText').textContent=from.value&&to.value?'Transferir 1 peça de '+selection.stores.find(s=>s.id===from.value).name+' para '+selection.stores.find(s=>s.id===to.value).name+'.':'Escolha origem e destino para confirmar.';}
 async function confirmTransfer(retry=false){if(busy)return;const body=retry?pending():{requestId:selection?.requestId,sessionId,productSizeId:selection?.product.productSizeId,barcode:selection?.product.barcode,fromStoreId:$('origin').value,toStoreId:$('destination').value};if(!body)return;
  busy=true;$('confirmButton').disabled=true;$('retryPending').disabled=true;stopCamera();message('Confirmando transferência…');
  try{localStorage.setItem(pendingKey(),JSON.stringify(body));const result=await api('/confirm',body);localStorage.removeItem(pendingKey());$('pendingPanel').hidden=true;$('selection').hidden=true;$('result').hidden=false;$('result').querySelector('h2').textContent=result.status==='cancelled'?'Esta transferência foi desfeita':'Transferência concluída';$('resultText').textContent='#'+result.code+' · '+result.items[0].productName+' · '+result.items[0].size+'\n'+result.fromStore.name+' → '+result.toStore.name;selection=null;message('');await refreshHistory();}
  catch(e){if(e.status&&e.status<500){localStorage.removeItem(pendingKey());$('pendingPanel').hidden=true;message(e.message,true);}else{$('pendingPanel').hidden=false;$('selection').hidden=true;message('Resultado ainda não confirmado. Sua leitura foi preservada para consultar novamente, sem duplicar.',true);}}
  finally{busy=false;$('retryPending').disabled=false;if(selection)updateConfirmation();}
 }
 async function refreshHistory(){const data=await api('/history?sessionId='+encodeURIComponent(sessionId));lastTransfer=data.last;$('todayCount').textContent=data.today;$('sessionCount').textContent=data.session;$('undoButton').disabled=!lastTransfer||!!pending();$('historyList').replaceChildren();
  if(!data.items.length)$('historyList').textContent='Você ainda não transferiu peças hoje.';
  for(const t of data.items){const row=document.createElement('div');row.className='row';const title=document.createElement('strong');title.textContent='#'+t.code+' · '+t.items[0].productName+' · Tam. '+t.items[0].size;const desc=document.createElement('p');desc.textContent=t.fromStore.name+' → '+t.toStore.name;const when=document.createElement('p');when.className='muted';when.textContent=new Date(t.createdAt).toLocaleString('pt-BR',{timeZone:'America/Sao_Paulo'})+' · '+(t.status==='cancelled'?'DESFEITA':'TRANSFERIDA');row.append(title,desc,when);$('historyList').append(row);}
 }
 async function initialize(){try{const data=await api('/me');actor=data.user;sessionStorage.setItem('tc_transfer_token',token);const key='tc_transfer_session_'+actor.id;sessionId=sessionStorage.getItem(key)||crypto.randomUUID();sessionStorage.setItem(key,sessionId);$('person').textContent=actor.name;$('login').hidden=true;$('app').hidden=false;$('logout').hidden=false;$('pendingPanel').hidden=!pending();await refreshHistory();}catch(e){$('login').hidden=false;$('app').hidden=true;message(e.status===401?'Entre para iniciar suas transferências.':e.message,true);}}
 $('loginForm').onsubmit=async e=>{e.preventDefault();$('loginButton').disabled=true;try{const identity=$('identity').value.trim();const r=await fetch('/api/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({...identity.includes('@')?{email:identity}:{phone:identity.replace(/\D/g,'')},password:$('password').value})});const d=await r.json();if(!r.ok)throw new Error(d.error||'Não foi possível entrar.');token=d.token;$('password').value='';message('');await initialize();}catch(e){message(e.message,true);}finally{$('loginButton').disabled=false;}};
 $('startCamera').onclick=startCamera;$('stopCamera').onclick=stopCamera;$('nextButton').onclick=startCamera;$('origin').onchange=originChanged;$('destination').onchange=updateConfirmation;$('confirmButton').onclick=()=>confirmTransfer();$('retryPending').onclick=()=>confirmTransfer(true);
 $('cancelSelection').onclick=()=>{if(busy)return;selection=null;$('selection').hidden=true;startCamera();};
 $('historyButton').onclick=async()=>{try{await refreshHistory();$('historyPanel').hidden=!$('historyPanel').hidden;}catch(e){message(e.message,true);}};
 $('undoButton').onclick=()=>{if(busy||!lastTransfer||pending())return;stopCamera();undoId=lastTransfer.id;$('undoText').textContent='Devolver '+lastTransfer.items[0].productName+' (tam. '+lastTransfer.items[0].size+') de '+lastTransfer.toStore.name+' para '+lastTransfer.fromStore.name+'?';$('undoPanel').hidden=false;};
 $('cancelUndo').onclick=()=>{$('undoPanel').hidden=true;};
 $('confirmUndo').onclick=async()=>{if(busy)return;busy=true;$('confirmUndo').disabled=true;try{await api('/'+undoId+'/undo',{});$('undoPanel').hidden=true;message('Última transferência desfeita. A peça voltou ao estoque da origem.');await refreshHistory();}catch(e){message(e.message||'Consulte o histórico para conferir o resultado.',true);}finally{busy=false;$('confirmUndo').disabled=false;}};
 $('logout').onclick=()=>{if(busy)return;stopCamera();sessionStorage.removeItem('tc_transfer_token');token='';actor=null;$('app').hidden=true;$('login').hidden=false;$('logout').hidden=true;message('');};
 document.addEventListener('visibilitychange',()=>{if(document.hidden)stopCamera();});
 if(token)initialize();
})();
