(function(){
  'use strict';
  let current=null, requestNumber=0;
  function selected(){return document.getElementById('loja')?.value||'';}
  function id(){return current?.storeId===selected() && current.status==='counting' ? current.id : null;}
  function requireRound(storeId){
    if(!id()||current.storeId!==storeId)throw Error('Selecione uma loja com rodada aberta. Nenhum bipe será misturado ao histórico.');
    return current.id;
  }
  async function refresh(){
    const n=++requestNumber,storeId=selected();
    try{
      const r=await fetch('/api/stocktake/rounds/current?storeId='+encodeURIComponent(storeId));
      if(!r.ok)throw Error('Não foi possível verificar a rodada.');
      const d=await r.json();if(n!==requestNumber||storeId!==selected())return;
      current=d.round;
      document.getElementById('round-title').textContent=current ? 'RODADA #'+current.number+' — '+current.name : 'SEM RODADA ABERTA';
      document.getElementById('round-detail').textContent=current ? (current.status==='counting'?'EM CONTAGEM':'EM CONFERÊNCIA — coleta encerrada')+' · Início '+new Date(current.startedAt).toLocaleString('pt-BR')+' · '+(d.totals?.total||0)+' leituras nesta rodada · '+(d.totals?.pending||0)+' pendentes' : 'O administrador deve iniciar o inventário desta loja. Leituras antigas ficam no histórico.';
      document.getElementById('round-box').dataset.ready=id()?'true':'false';
    }catch(e){if(n!==requestNumber)return;current=null;document.getElementById('round-title').textContent='RODADA NÃO VERIFICADA';document.getElementById('round-detail').textContent=e.message;}
    if(typeof atualizarStatus==='function')atualizarStatus();
    if(typeof renderLista==='function')renderLista();
    if(typeof renderStats==='function')renderStats();
  }
  window.ScannerRound={id,requireRound,refresh,current:()=>current};
  document.getElementById('refresh-round').addEventListener('click',refresh);
  setInterval(refresh,10000);
})();
