(function(){
 const esc=v=>String(v==null?'':v).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
 window.StockVerification={
 options:'<option value="">Todas as situações</option><option value="verified">✓ Conferidos nesta rodada</option><option value="pending">⚠ Com pendência</option><option value="unverified">○ Ainda não conferidos</option>',
 render(p){
 if(!Array.isArray(p.verification))return '';
 const rows=p.verification;
 if(!rows.length)return '<div style="padding:8px;color:#666;background:#eee;border-radius:8px">○ Ainda não conferido nesta rodada</div>';
 return '<section style="margin:8px 0;padding:8px;border:1px solid #aaa;border-radius:8px;background:#fff;color:#222"><strong>Conferência atual · saldo separado</strong><div style="display:flex;gap:6px;flex-wrap:wrap;margin-top:6px">'+rows.map(r=>{
 const green=r.status==='verified',color=green?'#146534':'#795000',bg=green?'#dcfce7':'#fff1bd';
 const details=r.evidence.map(e=>`${e.barcode} · ${e.seller||'Operador'} · ${new Date(e.at).toLocaleString('pt-BR')} · ${e.valid?'validado':'pendente'}`).join('\n');
 return `<details style="background:${bg};color:${color};border:1px solid ${color};border-radius:8px;padding:6px" onclick="event.stopPropagation()"><summary style="cursor:pointer;font-weight:bold">${green?'✓':'⚠'} ${esc(r.size)} · ${green?r.available+' un. conferidas':'Pendente'} · ${esc(r.storeCode||'Loja')}</summary><div style="font-size:12px;max-width:280px;white-space:pre-wrap">Rodada ${r.roundNumber}\n${r.counted} validadas · ${r.pending} pendentes\nSaídas após contagem: ${Math.abs(r.movementDelta)}\n${r.reconcile?'Movimentação exige reconferência.\n':''}${esc(details)}</div></details>`;
 }).join('')+(p.sizes||[]).filter(s=>!rows.some(r=>r.productSizeId===s.id)).map(s=>'<span style="background:#eee;color:#555;border-radius:8px;padding:6px">○ '+esc(s.size)+' · Não conferido</span>').join('')+'</div><small>Não somar ao estoque anterior. Contagem parcial não comprova falta.</small></section>';
 }
 };
})();
