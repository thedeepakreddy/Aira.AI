import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {chromium} from 'playwright';

const base=process.env.AIRA_TEST_URL||'http://127.0.0.1:5191';
const output=resolve('artifacts/browser-ui-qa');
await mkdir(output,{recursive:true});
const browser=await chromium.launch({headless:true});
const context=await browser.newContext({viewport:{width:1280,height:860},reducedMotion:'reduce'});
const page=await context.newPage();
page.setDefaultTimeout(12000);
const errors=[],checks=[];
page.on('pageerror',error=>errors.push(error.message));
let remembered=[];
await context.route('**/*',async route=>{
 const url=new URL(route.request().url());
 if(url.origin===new URL(base).origin){
  if(url.pathname==='/src/lib/supabase.ts')return route.fulfill({contentType:'application/javascript',body:`
   let session={access_token:'test-token',user:{id:'browser-test-user',email:'test@example.invalid'}};
   const listeners=new Set();
   window.__browserSetSession=next=>{session=next;for(const handler of listeners)handler(session)};
   export const supabase=null,isAuthConfigured=true;
   export async function getAccessToken(){return session.access_token}
   export async function getSession(){return session}
   export function onAuthChange(handler){listeners.add(handler);queueMicrotask(()=>handler(session));return()=>listeners.delete(handler)}
   export async function signIn(){} export async function signUp(){} export async function signOut(){}
  `});
  return route.continue();
 }
 let body;
 if(url.pathname==='/v1/models')body={models:[{id:'test-research',label:'Research model',provider:'test',tier:'frontier',contextWindow:128000}],routing:{task:'test-research'}};
 else if(url.pathname==='/v1/memory'&&route.request().method()==='POST'){remembered.push(route.request().postDataJSON());body={entry:remembered.at(-1)}}
 else return route.abort();
 return route.fulfill({contentType:'application/json',body:JSON.stringify(body),headers:{'Access-Control-Allow-Origin':'*'}});
});
await context.addInitScript(()=>{
 const state=window.__browserTest={running:false,private:false,tabs:[],activeId:'',next:1,calls:[],callbacks:{},listeners:{},nextCallback:1,pending:new Map(),longRun:false,delayStart:false,releaseStart:null,failScreen:false};
 const status=()=>({running:state.running,port:state.running?19450:null,token:state.running?'browser-token':null,python:'/test/python'});
 const tabs=()=>({running:state.running,private:state.private,tabs:state.tabs,activeId:state.activeId,busy:state.pending.size>0});
 const emit=(event,payload)=>{const id=state.listeners[event];if(id)state.callbacks[id]?.({event,id,payload})};
 const open=url=>{const id='tab-'+state.next++;state.tabs.push({id,url,title:url==='about:blank'?'New tab':'Fixture '+state.next});state.activeId=id;return tabs()};
 const image='data:image/svg+xml;base64,'+btoa('<svg xmlns="http://www.w3.org/2000/svg" width="900" height="550"><rect width="900" height="550" fill="#faf7f3"/><text x="45" y="70" font-size="30" fill="#332619">Shared Chrome fixture</text><rect x="45" y="110" width="350" height="48" fill="white" stroke="#aaa"/><text x="55" y="143" font-size="18">Interactive test page</text></svg>');
 window.__TAURI_INTERNALS__={
  transformCallback(callback){const id=state.nextCallback++;state.callbacks[id]=callback;return id},
  unregisterCallback(id){delete state.callbacks[id]},
  async invoke(command,args={}){
   state.calls.push({command,args});
   if(command==='browser_status')return status();
   if(command==='browser_start'){
    if(state.delayStart)return new Promise(resolve=>{state.releaseStart=()=>{state.running=true;resolve(status())}});
    state.running=true;return status();
   }
   if(command==='browser_stop'){state.running=false;state.tabs=[];return}
   if(command==='browser_log')return[];
   if(command==='opencode_stop'||command==='openclaw_stop')return;
   if(command==='plugin:event|listen'){state.listeners[args.event]=args.handler;return args.handler}
   if(command==='plugin:event|unlisten'){delete state.listeners[args.event];return}
   if(command==='browser_api'){
    const body=args.body||{};
    if(args.path==='/health')return{ready:true};
    if(args.path==='/tabs')return tabs();
    if(args.path==='/screen'){if(state.failScreen)throw new Error('Preview capture failed');const tab=state.tabs.find(t=>t.id===state.activeId);return{image,url:tab?.url||'',title:tab?.title||''}}
    if(args.path==='/tabs/open')return open(body.url);
    if(args.path==='/tabs/select'){state.activeId=body.id;return tabs()}
    if(args.path==='/tabs/close'){state.tabs=state.tabs.filter(t=>t.id!==body.id);if(state.activeId===body.id)state.activeId=state.tabs[0]?.id||'';if(!state.tabs.length)return open('about:blank');return tabs()}
    if(args.path==='/navigate'){state.tabs.find(t=>t.id===state.activeId).url=body.url;return tabs()}
    if(args.path==='/history'||args.path==='/focus')return tabs();
    if(args.path==='/input'||args.path==='/configure')return{ok:true};
    if(args.path==='/mode'){state.private=body.private;state.tabs=[];return{private:state.private}}
    if(args.path==='/cancel'){const finish=state.pending.get(body.run);if(finish){state.pending.delete(body.run);emit('browser://event/'+body.run,{type:'cancelled'});finish()}return{ok:true}}
   }
   if(command==='browser_run')return new Promise(resolve=>{
    state.pending.set(args.run,resolve);
    setTimeout(()=>emit('browser://event/'+args.run,{type:'step',n:1,url:'https://example.com/',action:'Reading source'}),20);
    if(!state.longRun)setTimeout(()=>{if(!state.pending.has(args.run))return;emit('browser://event/'+args.run,{type:'result',text:'A verified **research result** with clear findings.',steps:1,urls:['https://example.com/']});emit('browser://event/'+args.run,{type:'done'});state.pending.delete(args.run);resolve()},180);
   });
   throw new Error('Unexpected browser test command '+command+' '+args.path);
  }
 };
 window.__TAURI_EVENT_PLUGIN_INTERNALS__={unregisterListener(){}};
});

try{
 await page.goto(base+'/browse');
 await page.getByRole('button',{name:'Connect browser',exact:true}).last().click();
 await page.getByRole('img',{name:/Interactive preview/}).waitFor();
 const start=await page.evaluate(()=>window.__browserTest.calls.find(c=>c.command==='browser_start'));
 assert.equal(start.args.model,'');assert.equal(start.args.token,'');
 checks.push('Normal browsing starts without authentication or model spend');
 await page.getByRole('button',{name:'New browser tab'}).click();
 await page.getByRole('tab',{name:'New tab',exact:true}).waitFor();
 await page.getByRole('textbox',{name:'Search or enter a web address'}).fill('reliable research');
 await page.getByRole('button',{name:'Navigate',exact:true}).click();
 await page.waitForFunction(()=>window.__browserTest.tabs.some(t=>t.url==='https://www.google.com/search?q=reliable%20research'));
 await page.getByRole('tab').first().click();
 await page.getByRole('button',{name:'Back',exact:true}).click();
 await page.getByRole('button',{name:'Forward',exact:true}).click();
 await page.getByRole('button',{name:'Reload',exact:true}).click();
 await page.getByRole('button',{name:'Open browser window'}).click();
 await page.getByRole('img',{name:/Interactive preview/}).click({position:{x:80,y:110}});
 await page.keyboard.type('hello');
 await page.getByRole('button',{name:'Close New tab',exact:true}).click();
 checks.push('Real tab command IDs, separate web search, navigation/history, browser window, page click and typing');
 await page.getByRole('button',{name:'Hide research panel'}).click();
 assert.equal(await page.getByRole('complementary',{name:'Research assistant'}).count(),0);
 await page.getByRole('button',{name:'Show research panel'}).click();
 await page.getByRole('textbox',{name:'Research question'}).fill('Research this subject');
 await page.getByRole('button',{name:'Research',exact:true}).click();
 await page.getByText('A verified research result with clear findings.',{exact:true}).waitFor();
 await page.getByRole('button',{name:'Save to memory',exact:true}).click();
 await page.getByRole('button',{name:'Saved to memory',exact:true}).waitFor();
 assert.equal(remembered.length,1);assert.equal(remembered[0].surface,'browser');
 checks.push('Research uses configured model, renders full result, and explicitly saves shared memory');
 const beforeNavigation=await page.evaluate(()=>window.__browserTest.calls.filter(c=>c.command==='browser_stop').length);
 await page.getByRole('button',{name:'Aira home',exact:true}).click();
 await page.getByRole('button',{name:'Browser',exact:true}).click();
 await page.getByRole('img',{name:/Interactive preview/}).waitFor();
 assert.equal(await page.evaluate(()=>window.__browserTest.calls.filter(c=>c.command==='browser_stop').length),beforeNavigation);
 await page.getByText('A verified research result with clear findings.',{exact:true}).waitFor();
 checks.push('Panel navigation preserves the shared runtime and research output');
 await page.evaluate(()=>{window.__browserTest.longRun=true});
 await page.getByRole('textbox',{name:'Research question'}).fill('Research slowly');
 await page.getByRole('button',{name:'Research',exact:true}).click();
 await page.waitForFunction(()=>window.__browserTest.pending.size===1);
 await page.getByRole('button',{name:'Stop',exact:true}).click();
 await page.getByText('Research stopped. Your tabs are still open.',{exact:true}).waitFor();
 await page.waitForFunction(()=>window.__browserTest.pending.size===0);
 const runs=await page.evaluate(()=>window.__browserTest.calls.filter(c=>c.command==='browser_run').length);
 assert.equal(runs,2);
 checks.push('Stop cancels server run, preserves browser, and never resubmits form');
 await page.getByRole('button',{name:'Dismiss browser message'}).click();
 await page.getByRole('button',{name:'Private browser profile',exact:true}).click();
 await page.waitForFunction(()=>window.__browserTest.private===true);
 await page.evaluate(()=>{window.__browserTest.longRun=false});
 await page.getByRole('textbox',{name:'Research question'}).fill('Private research');
 await page.getByRole('button',{name:'Research',exact:true}).click();
 await page.getByText('A verified research result with clear findings.',{exact:true}).waitFor();
 assert.equal(await page.getByRole('button',{name:'Save to memory',exact:true}).isDisabled(),true);
 await page.getByRole('button',{name:'Private browser profile',exact:true}).click();
 await page.waitForFunction(()=>window.__browserTest.private===false);
 assert.equal(await page.getByRole('button',{name:'Save to memory',exact:true}).isDisabled(),true);
 checks.push('Temporary-profile results remain excluded from saved memory after profile switch');
 for(const [width,height]of [[1280,860],[1000,700],[390,844]]){
  await page.setViewportSize({width,height});
  await page.screenshot({path:resolve(output,`browser-connected-${width}.png`)});
  const metrics=await page.evaluate(()=>({overflow:document.documentElement.scrollWidth>innerWidth+1,heading:document.querySelector('.cli-heading').getBoundingClientRect().top,header:document.querySelector('.app-header').getBoundingClientRect().bottom}));
  assert.equal(metrics.overflow,false);assert.ok(metrics.heading>=metrics.header);
  checks.push(`Connected browser layout ${width}x${height}`);
 }
 await page.setViewportSize({width:1280,height:860});
 await page.evaluate(()=>{window.__browserTest.failScreen=true});
 await page.getByRole('alert').filter({hasText:'Preview capture failed'}).waitFor();
 await page.evaluate(()=>{window.__browserTest.failScreen=false});
 checks.push('Repeated preview capture failures are surfaced in the panel');
 const stopsBeforeAccountChange=await page.evaluate(()=>window.__browserTest.calls.filter(c=>c.command==='browser_stop').length);
 await page.evaluate(()=>window.__browserSetSession({access_token:'second-account-token',user:{id:'second-browser-user',email:'second@example.invalid'}}));
 await page.waitForFunction(()=>window.__browserTest.running===false);
 await page.getByRole('button',{name:'Connect browser',exact:true}).last().waitFor();
 assert.ok((await page.evaluate(()=>window.__browserTest.calls.filter(c=>c.command==='browser_stop').length))>stopsBeforeAccountChange);
 assert.equal(await page.getByText('A verified research result with clear findings.',{exact:true}).count(),0);
 checks.push('Account changes stop the previous runtime and remove previous research output');
 await page.evaluate(()=>{window.__browserTest.delayStart=true});
 await page.getByRole('button',{name:'Connect browser',exact:true}).last().click();
 await page.waitForFunction(()=>Boolean(window.__browserTest.releaseStart));
 await page.evaluate(()=>window.__browserSetSession({access_token:'third-account-token',user:{id:'third-browser-user',email:'third@example.invalid'}}));
 await page.evaluate(()=>{window.__browserTest.releaseStart();window.__browserTest.delayStart=false});
 await page.waitForFunction(()=>window.__browserTest.running===false);
 await page.getByRole('button',{name:'Connect browser',exact:true}).last().waitFor();
 await page.waitForFunction(()=>!document.querySelector('.browser-welcome-actions button')?.disabled);
 checks.push('A runtime that finishes starting after account unmount is stopped before the new account can adopt it');
 assert.deepEqual(errors,[]);
 await writeFile(resolve(output,'results.json'),JSON.stringify({checks,errors},null,2));
 console.log(JSON.stringify({passed:checks.length,checks,errors},null,2));
}catch(error){await page.screenshot({path:resolve(output,'failure.png')});console.error((await page.locator('body').innerText()).slice(-4000));throw error}
finally{await browser.close()}
