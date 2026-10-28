import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {once} from 'node:events';
import {fileURLToPath} from 'node:url';
import {BotStorage} from './storage.mjs';
import {ChatMemory} from './memory.mjs';
import {SocialEngine} from './social.mjs';
import {UsageBudget} from './budget.mjs';
import {CompatibleModel} from './model-api.mjs';
import {inspectBackup,restoreBackup} from './storage-admin.mjs';
import {ModerationService} from './moderation.mjs';
import {GroupBot,buildPrompt,saveModelSettings} from './bridge.mjs';

const root=path.dirname(fileURLToPath(import.meta.url));
function temporary(t) {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'dfl-final-'));
  t.after(()=>fs.rmSync(dir,{recursive:true,force:true,maxRetries:3,retryDelay:100}));
  return dir;
}
const record=(id,user,text,at=Date.now())=>({id,user,role:'user',speaker:'群友'+user,text,at});

test('production SQLite migration preserves old context and finds matches beyond the old snippet cutoff',t=>{
  const dir=temporary(t),file=path.join(dir,'legacy.jsonl'),database=path.join(dir,'bot.sqlite3');
  fs.writeFileSync(file,JSON.stringify({chat:'123456',...record('123456:1:user','11111','旧记录'.repeat(1000)+'羽毛球约在周五',Date.now()-120*86400000)})+'\n');
  let memory=new ChatMemory({memory:{enabled:true,retentionDays:0,maxRecords:0}},{file,database});
  assert.equal(memory.recent('123456',200,0).length,1);
  assert.match(memory.searchLocal('羽毛球','123456')[0].text,/羽毛球约在周五/);
  memory.close();
  memory=new ChatMemory({memory:{enabled:true,retentionDays:0,maxRecords:0}},{file,database});
  assert.equal(memory.records.length,1);
  memory.forget('123456','11111');memory.close();
  const store=new BotStorage(database);
  assert.equal(store.addEvent('123456',record('123456:1:user','11111','不应重新导入')),false);
  assert.equal(store.stats().events,0);store.close();
});

test('learned memory requires provenance, corrections need agreeing evidence, and rollback restores the old fact',t=>{
  const dir=temporary(t),memory=new ChatMemory({memory:{enabled:true,longTermEnabled:true}},{file:path.join(dir,'legacy'),database:path.join(dir,'bot.sqlite3')});
  const social=new SocialEngine({memory:{longTermEnabled:true}},memory);
  const at=Date.now()-5000,first={...record('123456:1:user','11111','我喜欢羽毛球',at),at},
    answer={id:'123456:90:assistant',role:'assistant',at:at+1000,forUser:'11111',text:'你喜欢羽毛球。'},
    second=record('123456:2:user','11111','改一下，我更喜欢网球',at+2000),
    third=record('123456:3:user','11111','对，更喜欢网球',at+3000);
  social.observe('123456',first);
  const item={kind:'preference',key:'运动偏好',userId:'11111',text:'喜欢羽毛球',importance:80,expiresDays:0,sensitive:false,sourceIds:[first.id]};
  social.apply('123456',{memoryUpdates:[item,{...item,key:'伪造来源',sourceIds:['not-a-message']}]},[first],'11111');
  assert.equal(memory.store.stats().memories,1);
  social.apply('123456',{memoryUpdates:[{...item,kind:'correction',text:'更喜欢网球',importance:70,sourceIds:[second.id]}]},[first,answer,second],'11111');
  assert.deepEqual(memory.store.memories('123456').map(x=>x.text),['喜欢羽毛球']);
  social.apply('123456',{memoryUpdates:[{...item,kind:'correction',text:'更喜欢网球',importance:90,sourceIds:[third.id]}]},[first,answer,second,third],'11111');
  assert.deepEqual(memory.store.memories('123456').map(x=>x.text),['更喜欢网球']);
  assert.equal(memory.store.stats().feedbackEvidence,2);
  const promoted=memory.store.memories('123456')[0];
  assert.equal(memory.store.rollbackMemory('123456',promoted.id).restored,true);
  assert.deepEqual(memory.store.memories('123456').map(x=>x.text),['喜欢羽毛球']);
  memory.forget('123456','11111');
  assert.equal(memory.store.stats().memories,0);
  assert.equal(memory.store.stats().feedbackEvidence,0);
  assert.equal(memory.store.stats().revisions,0);
  assert.equal(memory.store.memories('654321').length,0);
  assert.equal(memory.store.relationships('654321').length,0);
  memory.close();
});

test('restore preserves deletion tombstones and current usage, and saves the replaced database',async t=>{
  const dir=temporary(t),live=path.join(dir,'bot.sqlite3');
  let store=new BotStorage(live);
  store.addEvent('123456',record('a','11111','待删除内容'));
  store.addEvent('123456',record('b','22222','其他群友的内容'));
  const saved=await store.backup();
  const reservation=store.reserve(100,0,{});store.settle(reservation,'123456',{input_tokens:80,cached_input_tokens:20,output_tokens:10},0);
  store.forget('123456','11111');store.close();
  assert.equal(inspectBackup(saved).events,2);
  const result=await restoreBackup(saved,dir);
  assert.equal(result.ok,true);
  store=new BotStorage(live);
  assert.deepEqual(store.events('123456').map(x=>x.user),['22222']);
  assert.equal(store.totals().tokens,90);
  assert.ok(fs.existsSync(path.join(dir,'backups',result.previous)));
  assert.equal(store.addEvent('123456',record('a','11111','禁止复活')),false);
  store.close();
});

test('provider quota rejection is not charged as estimated tokens and suppresses repeated calls',async t=>{
  const dir=temporary(t),store=new BotStorage(path.join(dir,'bot.sqlite3'));
  const budget=new UsageBudget({budget:{reserveTokens:4000,maxHourlyTokens:10000,maxDailyTokens:10000}},store);
  let calls=0;
  const answer=budget.wrap(async()=>{calls++;if(calls===1)throw Error('MODEL_USAGE_LIMIT');return {text:'连接正常',usage:{input_tokens:100,cached_input_tokens:40,output_tokens:5}};});
  const context={mode:'direct',chatKey:'123456',requesterId:'11111'};
  assert.equal((await answer({},'测试',[],context)).providerUnavailable,true);
  assert.equal((await answer({},'测试',[],context)).providerUnavailable,true);
  assert.equal(calls,1);assert.equal(store.totals().tokens,0);
  await answer({},'测试',[],{...context,forceProbe:true});
  assert.equal(store.totals().tokens,105);assert.equal(store.setting('global','providerCooldown'),null);
  budget.settings.maxDailyTokens=200;
  assert.equal((await answer({},'测试',[],context)).budgetBlocked,true);assert.equal(calls,2);
  store.close();
});

test('delivery intents distinguish accepted from uncertain and never resend the same source payload',async t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'dfl-delivery-')),database=path.join(dir,'bot.sqlite3');
  const memory=new ChatMemory({memory:{enabled:true,social:{}}},{file:path.join(dir,'legacy'),database});
  const cfg={botQQ:'1000000001',groups:['123456'],social:{enabled:false},media:{enabled:false},pokes:{enabled:false},moderation:{enabled:false}};
  const okCalls=[],okBot=new GroupBot(cfg,{call:async(action,params)=>{okCalls.push({action,params});return {message_id:'9001'};}},async()=>({text:''}),()=>{},{memory});
  okBot.ready=true;
  const event={self_id:1000000001,post_type:'message',message_type:'group',group_id:123456,user_id:22222,message_id:77,message:[]};
  t.after(()=>{memory.close();fs.rmSync(dir,{recursive:true,force:true,maxRetries:3,retryDelay:100});});
  assert.equal(await okBot.reply(event,'答复'),true);
  assert.equal(await okBot.reply(event,'答复'),true);
  assert.equal(okCalls.length,1);
  assert.equal(memory.store.deliveryIntents('123456')[0].status,'accepted');
  assert.equal(memory.store.deliveryIntents('123456')[0].provider_message_id,'9001');

  let attempts=0;
  const failBot=new GroupBot(cfg,{call:async()=>{attempts++;throw Error('socket closed');}},async()=>({text:''}),()=>{},{memory});
  failBot.ready=true;
  const failedEvent={...event,message_id:78};
  await assert.rejects(failBot.reply(failedEvent,'不确定'),/socket closed/);
  await assert.rejects(failBot.reply(failedEvent,'不确定'),/DELIVERY_ALREADY_ATTEMPTED/);
  assert.equal(attempts,1);
  assert.equal(memory.store.deliveryIntents('123456')[0].status,'uncertain');
});

test('natural memory opt-out reaches the real chat pipeline, persists, and face-only replies remain usable',async t=>{
  const dir=temporary(t),file=path.join(dir,'legacy.jsonl'),database=path.join(dir,'bot.sqlite3'),contexts=[],sent=[];
  const cfg={botQQ:'1000000001',groups:['123456'],allChats:true,maxQuestionChars:6000,maxReplyChars:3000,
    historyTurns:4,historyTtlMinutes:0,maxQueue:20,cooldownSeconds:0,model:'test',persona:{name:'大肥龙'},
    social:{enabled:true,directDebounceMs:0},memory:{enabled:true,longTermEnabled:true,retentionDays:0,maxRecords:0,backfillOnReconnect:false},
    media:{enabled:false},speech:{enabled:false},pokes:{enabled:false}};
  const memory=new ChatMemory(cfg,{file,database});
  const api={call:async(action,params)=>{
    if(action==='get_login_info')return {user_id:1000000001};if(action==='get_group_list')return [{group_id:123456}];
    if(action==='send_group_msg'){sent.push(params);return {message_id:1000+sent.length};}return {};
  }};
  const bot=new GroupBot(cfg,api,async(_cfg,_q,_history,context)=>{
    contexts.push(context);
    return contexts.length===1?{shouldReply:true,text:'',memoryControl:{operation:'pause_memory',sourceId:context.recentMessages.at(-1).id}}
      :{shouldReply:true,text:'',faceIds:[14],replyAssessment:{addressee:'bot',addsNewInformation:true}};
  },()=>{},{memory});
  const event=(id,text)=>({self_id:1000000001,post_type:'message',message_type:'group',group_id:123456,user_id:11111,message_id:id,
    message:[{type:'at',data:{qq:'1000000001'}},{type:'text',data:{text}}]});
  try {
    await bot.verify();await bot.receive(event(1,'以后不要保存我的记忆'));await bot.receive(event(2,'给我一个表情'));
    assert.equal(memory.store.setting('123456','memory:11111'),false);
    assert.equal(memory.recent('123456').length,0);
    assert.equal(contexts[1].ephemeralHistory,true);
    assert.ok(sent[1].message.some(x=>x.type==='face'&&x.data.id===14));
  }finally{bot.disconnect();memory.close();}
  const reloaded=new ChatMemory(cfg,{file,database});
  assert.equal(reloaded.store.setting('123456','memory:11111'),false);assert.equal(reloaded.has('123456','123456:2:user'),true);reloaded.close();
});

test('OpenAI-compatible transport validates the complete schema and records reported cache usage',async t=>{
  const schema=JSON.parse(fs.readFileSync(path.join(root,'reply.schema.json'),'utf8'));
  function value(s){if(s.enum)return s.enum[0];if(s.type==='object')return Object.fromEntries(Object.entries(s.properties).map(([k,v])=>[k,value(v)]));if(s.type==='array')return [];return s.type==='boolean'?false:s.type==='integer'?0:'';}
  let invalid=false,malformed=false;
  const server=http.createServer(async(req,res)=>{
    for await(const chunk of req){};
    const result={...value(schema),shouldReply:true,text:'API 连接正常'};if(invalid)result.untrustedExtra='not allowed';
    res.setHeader('Content-Type','application/json');res.end(JSON.stringify({model:'test-reported',choices:[{message:{content:malformed?'broken json':JSON.stringify(result)},finish_reason:'stop'}],usage:{prompt_tokens:100,completion_tokens:20,prompt_tokens_details:{cached_tokens:60}}}));
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(()=>{server.close();server.closeAllConnections();});
  const cfg={model:'test',social:{enabled:true},llm:{apiBase:`http://127.0.0.1:${server.address().port}/v1`,allowAnonymous:true}};
  const model=new CompatibleModel(cfg,root,buildPrompt);
  const result=await model.answer(cfg,'测试');assert.equal(result.usage.cached_input_tokens,60);
  invalid=true;await assert.rejects(model.answer(cfg,'测试'),error=>error.message.includes('SCHEMA_INVALID')&&error.usage.output_tokens===20&&error.usage.cached_input_tokens===60);
  malformed=true;await assert.rejects(model.answer(cfg,'测试'),error=>error.message.includes('JSON_INVALID')&&error.usage.input_tokens===100&&error.reportedModel==='test-reported'&&error.finishReason==='stop');
});

test('model provider changes are validated, backed up, and require an explicit restart',t=>{
  const dir=temporary(t),file=path.join(dir,'config.json');
  fs.writeFileSync(file,JSON.stringify({botQQ:'1000000001',model:'gpt-6-luna',reasoningEffort:'high'}));
  const status={};
  const saved=saveModelSettings(dir,status,{backend:'openai_compatible',model:'actual-model-id',
    reasoningEffort:'medium',apiBase:'https://api.deepseek.com',apiKeyEnv:'DFL_API_KEY',supportsImages:false,maxTokens:4096,maxTokensField:'max_tokens'});
  const raw=JSON.parse(fs.readFileSync(file,'utf8'));
  assert.equal(saved.backend,'openai_compatible');assert.equal(status.modelSettingsPendingRestart,true);
  assert.equal(raw.model,'actual-model-id');assert.equal(raw.llm.type,'openai_compatible');assert.equal(raw.llm.supportsImages,false);
  assert.equal(fs.readdirSync(path.join(dir,'data','config-backups')).length,1);
  assert.throws(()=>saveModelSettings(dir,{}, {backend:'openai_compatible',model:'bad',apiBase:'ftp://example.com',apiKeyEnv:'DFL_API_KEY',maxTokens:1024}),/API_BASE_INVALID/);
});

test('owner private approval of a real stored group request is bound to the exact pending operation',async t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'dfl-final-approval-')),writes=[];
  const api={call:async(action,params)=>{
    if(action==='get_group_member_info')return {role:'owner',user_id:params.user_id};
    if(action==='get_group_member_list')return [];
    writes.push({action,params});return {};
  }};
  const service=new ModerationService({moderation:{enabled:true,owners:['11111']}},api,root,{database:path.join(dir,'bot.sqlite3'),settingsFile:path.join(dir,'settings.json')});
  t.after(async()=>{const proc=service.proc;service.close();if(proc&&proc.exitCode===null)await once(proc,'exit');fs.rmSync(dir,{recursive:true,force:true,maxRetries:3,retryDelay:100});});
  const request={self_id:1000000001,post_type:'request',request_type:'group',sub_type:'add',group_id:123456,user_id:22222,flag:'local-test-flag',comment:'想加入讨论'};
  const received=await service.request(request);assert.ok(received.requestKey);
  assert.equal((await service.request(request)).requestKey,null);
  const actor={self_id:1000000001,user_id:11111,message_type:'private',_private:true,message:[]};
  const checked=async(label,operation)=>{try{return await operation();}catch(error){error.message=label+' ('+error.errorType+'): '+error.message;throw error;}};
  const context=await checked('initial private context',()=>service.context(actor));assert.equal(context.requests[0].group,'123456');assert.ok(!JSON.stringify(context).includes('local-test-flag'));
  await service.decision(actor,{operation:'propose',kind:'group_request',requestKey:received.requestKey,approve:true});
  const pending=(await checked('pending private context',()=>service.context(actor))).pending;assert.equal(pending.action.target_group,'123456');
  await service.decision(actor,{operation:'confirm',approvalId:'wrong-id'});assert.equal(writes.length,0);
  await service.decision(actor,{operation:'confirm',approvalId:pending.id});
  await service.decision(actor,{operation:'confirm',approvalId:pending.id});
  assert.equal(writes.filter(x=>x.action==='set_group_add_request').length,1);
});
