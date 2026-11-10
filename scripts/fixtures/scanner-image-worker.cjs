'use strict';
// Only used by process-isolation tests; production worker accepts no commands.
process.on('disconnect',()=>process.exit(0));
process.on('message',message=>{
  const command=message.image.toString();
  if(command==='crash')return process.exit(7);
  if(command==='hang'){while(true){ /* prove parent remains responsive */ }}
  if(command==='memory'){process.send({type:'memory',id:message.id,rss:2**30});return;}
  if(command==='stale')process.send({type:'result',id:'another-photo',result:['WRONG']});
  setTimeout(()=>process.send({type:'result',id:message.id,result:[command]}),20);
});
process.send({type:'ready'});
