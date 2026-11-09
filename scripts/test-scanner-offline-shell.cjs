'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),path=require('node:path');
const source=fs.readFileSync(path.join(__dirname,'../public/sw.js'),'utf8');
const html=fs.readFileSync(path.join(__dirname,'../public/bipar.html'),'utf8');
const origin='https://scanner.test',events={},stores=new Map(),requested=[];let offline=false,skips=0,cacheUnavailable=false,networkHtml=null;
const key=x=>new URL(typeof x==='string'?x:x.url,origin).href;
const caches={async open(name){if(cacheUnavailable)throw Error('QuotaExceededError');if(!stores.has(name))stores.set(name,new Map());const data=stores.get(name);return {
 async addAll(urls){for(const url of urls){requested.push(url);data.set(key(url),new Response(url==='/bipar.html'?html:'static:'+url));}},
 async put(url,response){data.set(key(url),response.clone());},async match(url){return data.get(key(url))?.clone();}};},
 async keys(){return [...stores.keys()]},async delete(name){return stores.delete(name)}};
vm.runInNewContext(source,{URL,Set,Error,caches,self:{location:{origin},addEventListener:(name,fn)=>events[name]=fn,skipWaiting(){skips++;},clients:{claim:async()=>{},matchAll:async()=>[]}},fetch:async request=>{if(offline)throw Error('offline');return new Response(networkHtml&&new URL(request.url).pathname==='/bipar.html'?networkHtml:'network:'+request.url);}});
async function dispatch(request){let promise;events.fetch({request,respondWith(value){promise=value;}});return promise;}
(async()=>{
 let installing;events.install({waitUntil(p){installing=p;}});await installing;assert.equal(skips,0,'Updates do not forcibly replace an active scanner worker');
 assert.ok(requested.includes('/bipar.html'));assert.ok(requested.every(url=>!url.startsWith('/api/')&&!/token|capture|upload/.test(url)));
 for(const match of html.matchAll(/<script src="([^"]+)"/g))assert.ok(requested.includes(match[1]),'Offline shell precaches exact current script URL: '+match[1]);
 offline=true;const shell=await dispatch(new Request(origin+'/bipar.html'));assert.equal(await shell.text(),html);
 const contextualShell=await dispatch(new Request(origin+'/bipar.html?mode=replacement&storeId=original-store&v=current'));assert.equal(await contextualShell.text(),html,'Real replacement link uses the same static offline shell without caching store context');
 assert.ok([...stores.values()].every(cache=>[...cache.keys()].every(url=>!url.includes('storeId='))));
 // A still-active worker may receive the next deployment's HTML before its
 // dependencies or replacement worker finish downloading. Losing the network
 // then must leave the previously complete offline shell intact.
 const nextScript='/scanner-auto.js?v=isolated-next-release';
 networkHtml=html.replace(/\/scanner-auto\.js\?v=[^"\s]+/,nextScript);
 assert.notEqual(networkHtml,html);offline=false;
 assert.equal(await (await dispatch(new Request(origin+'/bipar.html?mode=replacement&storeId=original-store&v=next'))).text(),networkHtml,'Online navigation still receives the latest HTML');
 offline=true;
 const retained=await (await dispatch(new Request(origin+'/bipar.html'))).text();
 assert.equal(retained,html,'Interrupted update must not overwrite the installed complete offline HTML');
 for(const match of retained.matchAll(/<script src="([^"]+)"/g))assert.ok(await dispatch(new Request(origin+match[1])),'Every retained HTML dependency remains available offline: '+match[1]);
 await assert.rejects(()=>dispatch(new Request(origin+nextScript)),/offline/,'Regression specifically covers an unavailable new dependency');
 networkHtml=null;
 for(const url of ['/api/stocktake/etiqueta-status','/api/auth/context','/uploads/photo.jpg','/app.html','/bipar.html?token=secret','https://other.test/bipar.html'])assert.equal(await dispatch(new Request(new URL(url,origin))),undefined,'Not intercepted/cached: '+url);
 assert.equal(await dispatch(new Request(origin+'/bipar.html',{headers:{Authorization:'Bearer secret'}})),undefined);
 assert.equal(await dispatch(new Request(origin+'/bipar.html',{method:'POST',body:'x'})),undefined);
 offline=false;const asset=origin+'/vendor/ocr/worker.min.js';await dispatch(new Request(asset));offline=true;assert.match(await (await dispatch(new Request(asset))).text(),/network:/);
 stores.set('teniscash-scanner-shell-old',new Map());stores.set('other-app-cache',new Map());let activation;events.activate({waitUntil(p){activation=p;}});await activation;
 assert.equal(stores.has('teniscash-scanner-shell-old'),false);assert.equal(stores.has('other-app-cache'),true);
 assert.equal(typeof events.push,'function');assert.equal(typeof events.notificationclick,'function');
 const current=[...stores.keys()].find(name=>name.startsWith('teniscash-scanner-shell-'));
 stores.get(current).delete(origin+'/bipar.html');stores.set('teniscash-scanner-shell-previous',new Map([[origin+'/bipar.html',new Response('previous-complete-shell')]]));
 events.activate({waitUntil(p){activation=p;}});await activation;assert.equal(stores.has('teniscash-scanner-shell-previous'),true);
 offline=true;assert.equal(await (await dispatch(new Request(origin+'/bipar.html'))).text(),'previous-complete-shell','Incomplete new cache preserves and serves the previous offline shell');
 cacheUnavailable=true;events.install({waitUntil(p){installing=p;}});await installing;
 offline=false;assert.match(await (await dispatch(new Request(origin+'/bipar.html'))).text(),/network:/,'Unavailable cache does not break online scanner or worker installation/push');
 console.log('PASS: scanner shell cold-offline fallback after install; interrupted update preserves complete installed HTML and all scripts; exact script versions; lazy local libraries; no API/token/photo/other-page cache; safe activation; original push handlers retained.');
})().catch(error=>{console.error(error);process.exitCode=1;});
