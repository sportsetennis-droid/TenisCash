(function(root){'use strict';let closeActive=null;
function cancel(){if(closeActive)closeActive(false);}
function ask(message){cancel();return new Promise(resolve=>{
const cover=document.createElement('div');cover.id='scanner-repeat-dialog';cover.setAttribute('role','dialog');cover.setAttribute('aria-modal','true');cover.setAttribute('aria-label','Confirmar repetição');cover.style.cssText='position:fixed;inset:0;z-index:100010;background:rgba(0,0,0,.65);display:flex;align-items:center;justify-content:center;padding:12px;box-sizing:border-box';
const card=document.createElement('div');card.style.cssText='background:#fff;color:#171717;border-radius:16px;padding:18px;max-width:480px;width:100%;max-height:calc(100vh - 24px);max-height:calc(100dvh - 24px);overflow:hidden;display:flex;flex-direction:column;font:15px system-ui;box-sizing:border-box';
const text=document.createElement('div');text.style.cssText='white-space:pre-line;line-height:1.35;overflow:auto;min-height:0;overscroll-behavior:contain';text.textContent=message;card.appendChild(text);
const actions=document.createElement('div');actions.style.cssText='display:flex;gap:8px;margin-top:14px;flex-shrink:0;background:white;padding:6px 0';
let done=false;
function finish(value){if(done)return;done=true;cover.remove();document.removeEventListener('keydown',key);closeActive=null;resolve(value);}
function key(e){if(e.key==='Escape')finish(false);}
for(const [label,value,color] of [['Cancelar — não contar',false,'#555'],['É outro par — contar +1',true,'#087b3a']]){const b=document.createElement('button');b.type='button';b.textContent=label;b.style.cssText='flex:1;min-height:46px;border:0;border-radius:9px;color:white;font-weight:700;background:'+color;b.addEventListener('click',()=>finish(value));actions.appendChild(b);}
card.appendChild(actions);cover.appendChild(card);document.body.appendChild(cover);document.addEventListener('keydown',key);closeActive=finish;actions.firstChild.focus();
});}root.ScannerConfirm={ask,cancel};})(window);
