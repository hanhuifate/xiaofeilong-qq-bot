import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DoubaoImageService } from './doubao-image.mjs';
const root=path.dirname(fileURLToPath(import.meta.url));

test('temporary status failure keeps waiting for the same job and never generates another',async()=>{
  const service=new DoubaoImageService({capabilities:{doubaoImage:{enabled:true}}},root);
  let calls=0;service.pollDelay=async()=>{};
  service.tool=async name=>{assert.equal(name,'doubao_job_status');if(++calls===1)throw Error('temporary connection failure');return {ok:true,status:'completed',images:[]};};
  assert.equal((await service.waitFor('job_test')).status,'completed');assert.equal(calls,2);
});

test('generation network failure is not automatically submitted a second time',async()=>{
  const service=new DoubaoImageService({capabilities:{doubaoImage:{enabled:true}}},root);
  service.session='test';service.connect=async()=>{};let attempts=0;
  service.request=async()=>{attempts++;throw Error('connection failed after send');};
  await assert.rejects(service.tool('doubao_generate',{prompt:'画一只小龙'}),/SUBMISSION_UNCERTAIN/);
  assert.equal(attempts,1);
});

test('original images go to the local service without Chrome or Thunder downloads',async()=>{
  const noop=()=>{};const event={addListener:noop,removeListener:noop};
  const chrome={runtime:{onInstalled:event,onMessage:event,getManifest:()=>({version:'0.3.1'})},action:{onClicked:event},
    storage:{onChanged:event,local:{get:async()=>({token:''})}},tabs:{onUpdated:event},debugger:{onEvent:event,onDetach:event}};
  const sent=[];
  const context=vm.createContext({chrome,console,URL,setTimeout,clearTimeout,setInterval:()=>0,clearInterval:noop,WebSocket:{OPEN:1,CONNECTING:0}});
  const dir=path.join(root,'runtime/autodoubao/extension'),manifest=JSON.parse(fs.readFileSync(path.join(dir,'manifest.json'),'utf8'));
  vm.runInContext(fs.readFileSync(path.join(dir,manifest.background.service_worker),'utf8')+'\nglobalThis.directResult=handleGenerationResult;globalThis.setSocket=s=>{state.socket=s;};',context);
  context.setSocket({readyState:1,send:value=>sent.push(JSON.parse(value))});
  const url='https://example.byteimg.com/image_ori_raw?signature=unchanged';
  await context.directResult({job_id:'job_test',image_urls:[url,url]});
  assert.deepEqual(sent.at(-1),{type:'job_complete',job_id:'job_test',image_urls:[url],download_mode:'direct_http'});
  assert.ok(!manifest.permissions.includes('downloads'));
});

test('slow composer gets exactly one send attempt, with image instruction and requested ratio',async()=>{
  let sends=0;
  class Element {getBoundingClientRect(){return {width:800,height:80,bottom:600,top:520,left:0,right:800};}}
  class TextArea extends Element {get value(){return this._value||'';}set value(v){this._value=v;}focus(){}dispatchEvent(){}getAttribute(){return null;}}
  const composer=new TextArea();composer.isConnected=true;composer.tagName='TEXTAREA';
  const button=new Element();button.click=()=>sends++;button.getAttribute=()=>null;
  const source=fs.readFileSync(path.join(root,'runtime/autodoubao/extension/content.js'),'utf8').replace('return { reportPageStatus };','return { reportPageStatus, submitPrompt };');
  const noop=()=>{};
  const context=vm.createContext({Element,HTMLTextAreaElement:TextArea,HTMLInputElement:class{},
    document:{querySelector:()=>composer,querySelectorAll:()=>[button],body:{innerText:''},documentElement:{}},
    getComputedStyle:()=>({display:'block',visibility:'visible'}),window:{innerHeight:800,addEventListener:noop},
    location:{pathname:'/chat',href:'https://www.doubao.com/chat/'},MutationObserver:class{observe(){}},
    chrome:{runtime:{sendMessage:noop,onMessage:{addListener:noop}}},Event:class{},InputEvent:class{},KeyboardEvent:class{},
    setTimeout:fn=>{queueMicrotask(fn);return 1;},clearTimeout:noop,setInterval:noop});
  vm.runInContext(source+'\nglobalThis.submit=AutoDoubaoPage.submitPrompt;',context);
  const accepted=await context.submit({job_id:'test',prompt:'蓝色小龙',ratio:'3:4'});
  assert.equal(sends,1);assert.equal(accepted,false);
  assert.match(composer.value,/直接生成一张图片/);assert.match(composer.value,/3:4/);
});
