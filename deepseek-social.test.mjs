import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {DeepSeekModel,deepseekMessages,deepseekEffort} from './deepseek.mjs';
import {buildPrompt} from './bridge.mjs';
import {aggregateJobs,aggregationDelay} from './aggregation.mjs';
import {BotStorage} from './storage.mjs';
import {UsageBudget} from './budget.mjs';
import {ModelDiagnostics} from './diagnostics.mjs';
import {SocialEngine} from './social.mjs';
import {InitiativeScheduler} from './initiative.mjs';
import {WakeManager} from './wake.mjs';
const root=path.dirname(fileURLToPath(import.meta.url)),schema=JSON.parse(fs.readFileSync(path.join(root,'reply.schema.json'),'utf8'));
const cfg={model:'deepseek-flash',reasoningEffort:'xhigh',social:{enabled:true},llm:{apiBase:'https://api.deepseek.com',apiKeyEnv:'TEST_DFL_KEY',thinking:true}};
const temporary=(t,close=()=>{})=>{const dir=fs.mkdtempSync(path.join(os.tmpdir(),'dfl-improvements-'));t.after(()=>{
  close();if(!path.resolve(dir).startsWith(path.resolve(os.tmpdir())+path.sep+'dfl-improvements-'))throw Error('UNSAFE_TEST_PATH');
  fs.rmSync(dir,{recursive:true,force:true});});return dir;};
function value(s){if(s.enum)return s.enum[0];if(s.type==='object')return Object.fromEntries(Object.entries(s.properties).map(([k,v])=>[k,value(v)]));if(s.type==='array')return [];return s.type==='boolean'?false:s.type==='integer'?0:'';}
const reply={...value(schema),shouldReply:true,text:'4，True。'};
const body=(result=reply)=>({model:'deepseek-flash',choices:[{finish_reason:'tool_calls',message:{role:'assistant',content:'',reasoning_content:'internal',
  tool_calls:[{id:'reply_1',type:'function',function:{name:'submit_qq_reply',arguments:JSON.stringify(result)}}]}}],
  usage:{prompt_tokens:100,prompt_cache_hit_tokens:60,completion_tokens:30,completion_tokens_details:{reasoning_tokens:10}}});

test('DeepSeek context uses each QQ source once, separates roles, and maps xhigh honestly',()=>{
  const first={id:'a',role:'user',user:'1',at:1,text:'唯一历史事实_甲'},answer={id:'b',role:'assistant',at:2,text:'已发送的回答_乙'},last={id:'c',role:'user',user:'2',at:3,text:'当前问题_丙'};
  const messages=deepseekMessages(cfg,last.text,[{role:'user',content:'不应重复的fallback'}],{recentMessages:[first,first,answer,last],dialogueContext:{recentExchange:[first,answer]}},buildPrompt);
  const serialized=JSON.stringify(messages);
  for(const word of [first.text,answer.text,last.text])assert.equal(serialized.split(word).length-1,1);
  assert.ok(!serialized.includes('不应重复的fallback'));
  assert.equal(messages[2].role,'assistant');assert.equal(messages[2].reasoning_content,'');
  assert.deepEqual(deepseekEffort({},cfg),{thinking:true,effort:'high'});
  assert.equal(deepseekEffort({thinking:false},cfg).thinking,false);
});

test('official DeepSeek repairs a bad candidate once, preserves all usage, and never executes proposals',async()=>{
  process.env.TEST_DFL_KEY='local-protocol-test';
  const requests=[];
  const client=new DeepSeekModel(cfg,root,buildPrompt,{sleep:async()=>{},fetcher:async(url,options)=>{
    if(String(url).endsWith('/models'))return Response.json({data:[{id:'deepseek-flash',input_modalities:['text','image']}]});
    requests.push(JSON.parse(options.body));
    return Response.json(body(requests.length===1?{...reply,unauthorizedField:'reject'}:reply));
  }});
  const result=await client.answer(cfg,'测试',[],{});
  assert.equal(result.usage.input_tokens,200);assert.equal(result.usage.output_tokens,60);
  assert.equal(requests.length,2);assert.equal(requests[0].tool_choice,'auto');
  assert.ok(String(client.endpoint).includes('/beta/'));assert.equal(requests[0].tools[0].function.strict,true);
  assert.equal(result.diagnostics.attempts[0].status,'failed');
  assert.ok(requests[1].messages.some(m=>m.role==='tool'&&m.content.includes('"executed":false')));
  const noThinking={...cfg,llm:{...cfg.llm,thinking:false}};
  await client.answer(noThinking,'测试');
  assert.equal(requests.at(-1).tool_choice.function.name,'submit_qq_reply');
  assert.equal(requests.at(-1).thinking.type,'disabled');assert.ok(!('reasoning_effort'in requests.at(-1)));
});

test('DeepSeek rejects unsupported vision and permanent auth errors without a generation retry',async()=>{
  process.env.TEST_DFL_KEY='local-protocol-test';let generated=0;
  const client=new DeepSeekModel(cfg,root,buildPrompt,{fetcher:async(url)=>{
    if(String(url).endsWith('/models'))return Response.json({data:[{id:'deepseek-flash',input_modalities:['text']}]});
    generated++;return new Response('',{status:401});
  }});
  await assert.rejects(client.answer(cfg,'看看',[],{images:[{path:'not-read'}]}),/MODEL_VISION_UNAVAILABLE/);assert.equal(generated,0);
  await assert.rejects(client.answer(cfg,'测试'),error=>error.message==='DEEPSEEK_API_HTTP_401'&&error.rejectedBeforeGeneration&&error.retryHandled);
  assert.equal(generated,1);
  const savedKey=process.env.TEST_DFL_KEY;delete process.env.TEST_DFL_KEY;
  try {
    const missing=new DeepSeekModel(cfg,root,buildPrompt,{fetcher:async()=>{throw Error('must not fetch');}});
    await assert.rejects(missing.answer(cfg,'测试'),error=>error.message==='DEEPSEEK_KEY_MISSING'&&error.rejectedBeforeGeneration);
  }finally{process.env.TEST_DFL_KEY=savedKey;}
});

test('failed provider output with measured usage is charged once and diagnostics stay private',async t=>{
  let store,diagnostics;
  const dir=temporary(t,()=>{diagnostics?.close();store?.close();});
  store=new BotStorage(path.join(dir,'bot.sqlite3'));diagnostics=new ModelDiagnostics(path.join(dir,'diagnostics.sqlite3'));
  const budget=new UsageBudget({budget:{reserveTokens:4000}},store);
  const fn=budget.wrap(diagnostics.wrap(async()=>{throw Object.assign(Error('DEEPSEEK_REPLY_SCHEMA_INVALID'),
    {usage:{input_tokens:100,cached_input_tokens:60,output_tokens:30,reasoning_output_tokens:10},estimatedCostUsd:.001,provider:'deepseek',retryHandled:true});}));
  await assert.rejects(fn(cfg,'PRIVATE_SECRET_MESSAGE',[],{chatKey:'test'}));
  assert.equal(store.totals().tokens,130);assert.equal(store.totals().estimatedCalls,0);
  diagnostics.flush();const summary=diagnostics.summary();assert.equal(summary.providers[0].failures,1);
  assert.equal(summary.providers[0].inputTokens,100);assert.equal(summary.providers[0].p95Ms>=0,true);
  assert.ok(!JSON.stringify(diagnostics.db.prepare('SELECT * FROM model_requests').all()).includes('PRIVATE_SECRET_MESSAGE'));
});

test('message batching preserves requester, quote boundaries, media, and a bounded wait',()=>{
  const job=(user,text,id,quote)=>({question:text,mode:'direct',event:{group_id:123456,user_id:user,message_id:id,message:quote?[{type:'reply',data:{id:quote}}]:[],_imageIds:[String(id)]}});
  const rows=aggregateJobs([job(1,'一句',1),job(1,'续句',2),job(2,'别人请求',3),job(1,'回到原人',4),job(1,'换引用',5,6),job(1,'不同引用',6,7)]);
  assert.equal(rows.length,4);assert.equal(rows[0].question,'一句\n续句');assert.equal(rows[1].event.user_id,2);
  assert.deepEqual(rows[0].event._imageIds,['1','2']);
  assert.equal(aggregationDelay({directDebounceMs:2500,directMaxWaitMs:9000},{since:0},'半句',8900),100);
  assert.ok(aggregationDelay({directDebounceMs:2500},{since:0},'完整问题？',0)<=1200);
});

test('active mode honors model dive; explicit calls can wake it; unrelated chatter is not feedback',()=>{
  let at=1000000;const wake=new WakeManager({social:{autonomousWake:true,activeMode:true,semanticParticipation:true}},{now:()=>at});
  wake.settle('123456',{shouldReply:false,wakePlan:{mode:'dive',seconds:120}},'1','话题');
  assert.equal(wake.reason('123456',{text:'普通闲聊',user:'2'}),null);
  wake.called('123456','1','话题');assert.equal(wake.get('123456').mode,'observing');
  const social=new SocialEngine({},{store:null});social.save('123456',{initiativeUnanswered:true});
  social.observe('123456',{id:'a',at:1,user:'2',text:'另一件事',audience:{kind:'group'}});
  assert.equal(social.state('123456').initiativeUnanswered,true);
  social.observe('123456',{id:'b',at:2,user:'2',text:'回答你',audience:{kind:'bot'}});
  assert.equal(social.state('123456').initiativeUnanswered,false);
});

test('followups persist across restart, claim once, expire, and never replay uncertain sends',async t=>{
  let store;const dir=temporary(t,()=>store?.close());store=new BotStorage(path.join(dir,'bot.sqlite3'));
  const memory={store,has:(_chat,id)=>id==='source'},now=Date.now();
  const society=new SocialEngine({},memory);
  const g={id:'123456',latest:{ambientAllowed:true,event:{group_id:123456,user_id:1}},lastReplyAt:0,evalTimes:[],replyTimes:[]};
  const bot={society,memory,ready:true,groupStates:new Map([[g.id,g]]),queue:[],connectionEpoch:1,cfg:{maxQueue:20},paused:()=>false,
    socialFor:()=>({enabled:true,proactiveCooldownSeconds:0,maxEvaluationsPerHour:30,maxProactivePerHour:30}),
    wake:{get:()=>({mode:'observing',until:0})},drain:async()=>{}};
  society.save(g.id,{lastHumanAt:now-1000,lastBotAt:now-2000,followup:{id:'job',status:'pending',sourceId:'source',userId:'1',topic:'未完的话题',dueAt:now-1,expiresAt:now+100000,attempts:0}});
  bot.society=new SocialEngine({},memory);const scheduler=new InitiativeScheduler(bot);
  await Promise.all([scheduler.tick(),scheduler.tick()]);assert.equal(bot.queue.length,1);
  assert.equal(bot.society.state(g.id).followup.status,'queued');assert.equal(scheduler.start(g,'job'),true);
  const state=bot.society.state(g.id);bot.society.save(g.id,{...state,followup:{...state.followup,leaseUntil:now-1}});
  const intent=store.beginDelivery({chat:g.id,target:g.id,sourceId:'initiative:job',kind:'ambient',payload:'test'});store.markDelivery(intent.id,'uncertain');
  scheduler.reconcile(g);assert.equal(bot.society.state(g.id).followup.reason,'delivery_already_attempted');
  bot.society.save(g.id,{...state,followup:{...state.followup,status:'pending',expiresAt:now-1}});
  scheduler.reconcile(g);assert.equal(bot.society.state(g.id).followup.status,'expired');
});
