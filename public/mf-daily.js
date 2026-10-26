/* Apontamento diário da Meta Fardamentos. Usa o login e os componentes do sistema. */
let dailyProductionDay = '', dailyProductionData = null, dailyProductionOpen = false;
let dailyEntryRequest = null, dailyEntrySending = false, pointRequest = null, pointSending = false;
function mfToday() { return new Intl.DateTimeFormat('en-CA', {timeZone:'America/Fortaleza'}).format(new Date()); }
function mfDuration(minutes) { return minutes == null ? 'Conferir ponto' : Math.floor(minutes/60)+'h '+String(minutes%60).padStart(2,'0')+'min'; }
function mfAttendance(a) {
  if(a.issues.length) return H(a.issues.join(' '));
  if(a.state==='absent') return 'Sem ponto registrado';
  const label={working:'Trabalhando',break:'Em intervalo',finished:'Jornada encerrada'}[a.state]||'';
  return mfDuration((a.workedMinutes||0)+(a.ongoingMinutes||0))+' · '+label+(a.state==='working'?' (até agora)':'');
}
async function renderDailyProduction(day) {
  dailyProductionOpen=true;
  dailyProductionDay=day||dailyProductionDay||mfToday();
  const selectedDay=dailyProductionDay, v=document.getElementById('view');
  v.innerHTML='<div class="empty">Carregando produção do dia…</div>';
  document.getElementById('fab').classList.add('hide');
  try {
    const d=await api('/production-daily?day='+encodeURIComponent(selectedDay));
    if(current!=='producao'||dailyProductionDay!==selectedDay||!dailyProductionOpen)return;
    dailyProductionData=d;
    // O formulário já tem botão próprio; o botão flutuante das OS não cobre as quantidades.
    document.getElementById('fab').classList.add('hide');
    const kinds={in:'Entrada',break_in:'Intervalo',break_out:'Retorno',out:'Saída'};
    const people=d.employees.map(e=>`<div class="card"><div class="nm">${H(e.name)}${e.active?'':' · inativo'}</div>
      <div class="mt">${mfAttendance(e.attendance)}</div>
      ${e.punches.length?`<div class="mt">${e.punches.map(p=>kinds[p.kind]+' '+hhmm(p.at)).join(' · ')}</div>`:''}
      ${e.production.length?e.production.map(p=>`<div class="row" style="margin-top:8px;gap:8px"><div>${H(p.product)}<div class="mt">${H(p.activity)}</div></div><b>${p.quantity.toLocaleString('pt-BR')}</b></div>`).join(''):'<div class="mt" style="margin-top:8px">Sem produção lançada neste dia.</div>'}</div>`).join('');
    const entries=d.entries.map(e=>`<div class="card"><div class="row"><b>${H(e.employee.name)}</b><span class="pill ${e.voidedAt?'gray':'ok'}">${e.voidedAt?'Cancelado':e.quantity.toLocaleString('pt-BR')}</span></div>
      <div>${H(e.product)} · ${H(e.activity)}</div>${e.notes?'<div class="mt">'+H(e.notes)+'</div>':''}
      <div class="mt">Lançado por ${H(e.recorder.name)} · ${dt(e.createdAt)} ${hhmm(e.createdAt)}</div>
      ${d.canRecord&&!e.voidedAt?`<button class="btn sm ghost" style="margin-top:8px" data-void-entry="${H(e.id)}">Cancelar lançamento</button>`:''}</div>`).join('');
    v.innerHTML=`<h3 class="sec">Produção diária</h3><label for="mf-daily-day">Dia</label>
      <input id="mf-daily-day" type="date" class="fld" value="${d.day}" max="${mfToday()}">
      ${d.canRecord?'<button class="btn lar" style="margin-top:12px" onclick="formDailyProduction()">Lançar produção da equipe</button>':''}
      <button class="btn ghost" style="margin-top:8px" onclick="renderOrdensProducao()">Ordens de produção</button>
      <h3 class="sec">${d.canRecord?'Equipe e produção do dia':'Meu ponto e produção do dia'}</h3>
      ${people||'<div class="empty">Nenhum funcionário encontrado.</div>'}
      <h3 class="sec">Quantidades por produto e atividade</h3>
      <p class="mt">Corte, costura e outras atividades são contados separadamente. A mesma peça pode passar por várias atividades.</p>
      ${d.byActivity.map(p=>`<div class="card row"><div>${H(p.product)}<div class="mt">${H(p.activity)}</div></div><b>${p.quantity.toLocaleString('pt-BR')}</b></div>`).join('')||'<div class="empty">Sem produção lançada.</div>'}
      <h3 class="sec">Lançamentos do dia</h3>${entries||'<div class="empty">Nenhum lançamento.</div>'}`;
    document.getElementById('mf-daily-day').addEventListener('change',e=>renderDailyProduction(e.target.value));
    v.querySelectorAll('[data-void-entry]').forEach(b=>b.addEventListener('click',()=>voidDailyProduction(b.dataset.voidEntry)));
  }catch(e){if(current==='producao'&&dailyProductionDay===selectedDay)v.innerHTML='<div class="empty">'+H(e.message)+'</div>';}
}
function formDailyProduction() {
  if(!dailyProductionData?.canRecord)return;
  dailyEntryRequest={id:crypto.randomUUID(),body:null};
  sheet(`<h2>Lançar produção</h2><label for="md-date">Dia da produção</label><input id="md-date" class="fld" type="date" value="${dailyProductionDay}" max="${mfToday()}">
    <label for="md-employee">Quem produziu</label><select id="md-employee" class="fld"><option value="">Selecione o funcionário</option>${dailyProductionData.employees.filter(e=>e.active).map(e=>`<option value="${H(e.id)}">${H(e.name)}</option>`).join('')}</select>
    <label for="md-product">Produto ou pedido</label><input id="md-product" class="fld" maxlength="160" placeholder="Ex.: camisas polo — pedido 35">
    <label for="md-activity">Atividade realizada</label><input id="md-activity" class="fld" maxlength="100" list="md-activities" placeholder="Ex.: corte, costura ou acabamento">
    <datalist id="md-activities"><option value="Modelagem"><option value="Corte"><option value="Costura"><option value="Estamparia"><option value="Embalagem"></datalist>
    <label for="md-quantity">Quantidade feita</label><input id="md-quantity" class="fld" type="number" min="1" step="1" inputmode="numeric">
    <label for="md-notes">Observação (opcional)</label><textarea id="md-notes" class="fld" maxlength="1000" rows="2"></textarea>
    <p class="mt">Lançado por ${H(me.name)}.</p><button id="md-save" class="btn" style="margin-top:12px" onclick="saveDailyProduction()">Salvar produção</button>`);
}
async function saveDailyProduction() {
  if(dailyEntrySending||!dailyEntryRequest)return;
  const b={day:val('md-date'),employeeId:val('md-employee'),product:val('md-product'),activity:val('md-activity'),quantity:Number(val('md-quantity')),notes:val('md-notes')};
  if(!b.day||b.day>mfToday()||!b.employeeId||!b.product||!b.activity||!Number.isSafeInteger(b.quantity)||b.quantity<=0){toast('Preencha data, funcionário, produto, atividade e quantidade inteira maior que zero.');return;}
  const body=JSON.stringify(b);
  if(dailyEntryRequest.body&&dailyEntryRequest.body!==body){toast('O envio anterior não foi confirmado. Reenvie os mesmos dados e confira o lançamento antes de corrigir.');return;}
  dailyEntryRequest.body=body; dailyEntrySending=true;
  const button=document.getElementById('md-save'); button.disabled=true;button.textContent='Salvando…';
  try {
    await api('/production-daily',{method:'POST',body:JSON.stringify({...b,requestId:dailyEntryRequest.id})});
    dailyEntryRequest=null;closeSheet();toast('Produção registrada');await renderDailyProduction(b.day);
  }catch(e){if(e.status&&e.status<500&&e.status!==409)dailyEntryRequest.body=null;toast(e.message);button.disabled=false;button.textContent='Tentar salvar novamente';}
  finally{dailyEntrySending=false;}
}
async function voidDailyProduction(id) {
  if(!confirm('Cancelar este lançamento? Ele será preservado no histórico e sairá das quantidades do dia.'))return;
  try{await api('/production-daily/'+encodeURIComponent(id),{method:'DELETE'});toast('Lançamento cancelado');renderDailyProduction();}catch(e){toast(e.message);}
}

// Uma tentativa mantém o mesmo identificador em caso de falha de rede.
async function punch(kind) {
  if(pointSending)return;
  if(pointRequest&&pointRequest.kind!==kind){toast('Confira o resultado da batida anterior antes de registrar outra.');renderPonto();return;}
  const firstAttempt=!pointRequest;
  pointRequest=pointRequest||{kind,requestId:crypto.randomUUID()};pointSending=true;
  document.querySelectorAll('.pbtn').forEach(b=>b.disabled=true);
  try{
    if(firstAttempt&&navigator.geolocation){const position=await new Promise(resolve=>navigator.geolocation.getCurrentPosition(resolve,()=>resolve(null),{timeout:4000}));if(position){pointRequest.lat=position.coords.latitude;pointRequest.lng=position.coords.longitude;}}
    const r=await api('/ponto',{method:'POST',body:JSON.stringify(pointRequest)});pointRequest=null;toast('Registrado '+hhmm(r.at));
  }
  catch(e){if(e.status&&e.status<500)pointRequest=null;toast(e.message);}
  finally{pointSending=false;await renderPonto();}
}
