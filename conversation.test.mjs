import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {conversationPacket} from './conversation.mjs';
import {createQQToolDispatcher} from './qq-tools.mjs';
import {BotStorage} from './storage.mjs';

test('incremental conversation preserves current request and delivery facts without reintroducing database history',()=>{
 const cfg={memory:{enabled:true}},context={mode:'direct',requesterId:'1',batchSourceIds:['new'],
  recentMessages:[{id:'old',role:'user',user:'1',text:'旧问题'},{id:'sent',role:'assistant',text:'前一答复'},{id:'new',role:'user',user:'1',text:'新的问题'}],
  socialContext:{learnedMemories:[{text:'不应自动注入'}]},localMemoryResults:[{text:'不应自动注入'}]};
 const packet=conversationPacket(cfg,'新的问题',context,{turns:1,contextKeys:['old'],lastResponseText:'前一答复'});
 assert.deepEqual(packet.messages.map(m=>m.id),['new']);assert.deepEqual(packet.currentMessageIds,['new']);
 assert.equal(packet.question,undefined);assert.equal(packet.socialContext,undefined);assert.equal(packet.localMemoryResults,undefined);
 assert.deepEqual(packet.deliveryReceipts,[{id:'sent',status:'delivered'}]);
});

function fixture(t){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'qq-tools-')),store=new BotStorage(path.join(dir,'bot.sqlite3'));
 const state={calls:0,fail:false};
 const bot={ready:true,connectionEpoch:3,group:()=>({contextEpoch:2}),paused:()=>false,
  memory:{store,enabled:true,searchLocal:()=>[{id:'current',source:'当前对话'}]},
  moderation:{enabled:true,decision:async(event)=>{assert.equal(event.user_id,10001);state.calls++;if(state.fail)throw Error('NETWORK_UNCERTAIN');return {handled:true,text:'待本人确认'};}},
  authorizedMemorySearch:async()=>[{id:'other',source:'已授权私聊'}]};
 const context={mode:'direct',_host:{chat:'123',epoch:3,contextEpoch:2,event:{user_id:10001,message_id:7}}};
 const call={chat:'123',turnId:'t',callId:'c'};
 t.after(()=>{store.close();fs.rmSync(dir,{recursive:true,force:true});});
 return {dispatch:createQQToolDispatcher(bot),context,call,state,bot};
}
test('model tool arguments cannot replace the actor and repeated management requests reuse durable receipts',async t=>{
 const {dispatch,context,call,state}=fixture(t),args={operation:'propose',actor:'99999'};
 const first=await dispatch('qq_manage',args,context,call);
 const again=await dispatch('qq_manage',args,context,{...call,callId:'new-model-call',turnId:'retry'});
 assert.equal(state.calls,1);assert.deepEqual(first,again);
});
test('uncertain action and expired chat context fail closed instead of replaying side effects',async t=>{
 const {dispatch,context,call,state}=fixture(t);state.fail=true;
 await assert.rejects(dispatch('qq_manage',{},context,call),/NETWORK_UNCERTAIN/);
 await assert.rejects(dispatch('qq_manage',{},context,{...call,callId:'retry'}),/PREVIOUS_RESULT_UNCERTAIN/);
 assert.equal(state.calls,1);
 await assert.rejects(dispatch('qq_memory',{query:'测试',scope:'current'},{...context,_host:{...context._host,epoch:2}},call),/CONTEXT_EXPIRED/);
});
test('cross conversation query is explicit and a mixed speaker batch cannot inherit authorization',async t=>{
 const {dispatch,context,call}=fixture(t);
 const local=await dispatch('qq_memory',{query:'测试',scope:'current'},context,call);
 const cross=await dispatch('qq_memory',{query:'测试',scope:'authorized'},context,call);
 const mixed=await dispatch('qq_memory',{query:'测试',scope:'authorized'},{...context,_host:{...context._host,event:{...context._host.event,_mixedBatch:true}}},call);
 assert.deepEqual(local.data.other,[]);assert.equal(cross.data.other.length,1);assert.deepEqual(mixed.data.other,[]);
});
