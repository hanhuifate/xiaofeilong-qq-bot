import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CodexSessions } from './sessions.mjs';
import { buildPrompt, readConfig } from './bridge.mjs';
const root = path.dirname(fileURLToPath(import.meta.url));
test('web routes retain the native search dispatcher without enabling local or external tools', () => {
  const cfg=readConfig();
  for(const webSearch of [false,true]) {
    const client=new CodexSessions(cfg,root,buildPrompt,{webSearch});
    const isolation=client.threadOptions().config;
    assert.equal(isolation.web_search,webSearch?'live':'disabled');
    assert.equal(isolation['features.code_mode'],webSearch);
    assert.equal(isolation['features.code_mode_host'],webSearch);
    for(const feature of ['shell_tool','unified_exec','apps','plugins','computer_use','view_image'])
      assert.equal(isolation[`features.${feature}`],false);
    assert.deepEqual(isolation.mcp_servers,{});
  }
});
function fixture(t, file) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-sessions-'));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const cfg = readConfig(); const calls = [];
  const client = new CodexSessions(cfg, root, buildPrompt, { file: file || path.join(temp, 'sessions.json') });
  client.connect = async () => ({});
  client.rpc = async (method, params) => {
    calls.push({ method, params });
    if (method === 'thread/start') return { thread: { id: 'thread-' + calls.length } };
    if (method === 'turn/start') {
      queueMicrotask(() => {
        client.consume({ method: 'turn/started', params: { threadId: params.threadId, turn: { id: 'turn-1' } } });
        client.consume({ method: 'item/completed', params: { threadId: params.threadId,
          item: { type: 'agentMessage', text: JSON.stringify({ shouldReply: true, text: '知道啦', imageId: '', pokeTarget: '', memoryQuery: '', imageNotes: [] }) } } });
        client.consume({ method: 'thread/tokenUsage/updated', params: { threadId: params.threadId,
          tokenUsage: { last: { inputTokens: 6000, cachedInputTokens: 5700, outputTokens: 40, reasoningOutputTokens: 0 } } } });
        client.consume({ method: 'turn/completed', params: { threadId: params.threadId, turn: { status: 'completed' } } });
      });
      return { turn: { id: 'turn-1' } };
    }
    return {};
  };
  return { client, cfg, calls };
}
test('an explicit search missing its tool call is retried once before returning a reply', async t => {
  const {client,cfg,calls}=fixture(t);client.webSearch=true;
  client.refreshInstructions();
  const base=client.rpc;let turns=0;
  client.rpc=async(method,params)=>{
    if(method==='turn/start'&&++turns===2)queueMicrotask(()=>client.consume({method:'item/started',params:{threadId:params.threadId,item:{type:'webSearch'}}}));
    return base(method,params);
  };
  const result=await client.answer(cfg,'那你查一下',[],{chatKey:'123',webSearchAllowed:true});
  const packets=calls.filter(c=>c.method==='turn/start').map(c=>JSON.parse(c.params.input[0].text));
  assert.equal(packets.length,2);
  assert.equal(packets[0].capabilityStatus.searchRequired,true);
  assert.equal(packets[1].capabilityStatus.searchRetry,true);
  assert.equal(result.usedWebSearch,true);
  assert.equal(result.searchRetried,true);
  assert.equal(result.usage.input_tokens,12000);
});
test('search retry is bounded and disabled when the route has no search permission',async t=>{
  const {client,cfg,calls}=fixture(t);client.webSearch=true;
  await client.answer(cfg,'那你查一下',[],{chatKey:'123',webSearchAllowed:true});
  assert.equal(calls.filter(c=>c.method==='turn/start').length,2);
  await client.answer(cfg,'那你查一下',[],{chatKey:'456',webSearchAllowed:false});
  assert.equal(calls.filter(c=>c.method==='turn/start').length,3);
});
test('persistent thread appends new messages, restores after restart and records measured cache', async t => {
  const { client, cfg, calls } = fixture(t);
  const context = { chatKey: '123', requesterId: '456', requesterName: '小明', recentMessages: [{ id: 'one', role: 'user', text: '旧消息' }] };
  const a = await client.answer(cfg, '第一条', [{ role: 'user', content: '历史' }], context);
  const b = await client.answer(cfg, '第二条', [{ content: '不应重复' }], { ...context, requesterId: '789',
    recentMessages: [...context.recentMessages, { id: 'two', role: 'user', text: '旁观消息一' },
      {id:'bot_sent',role:'assistant',text:'另一条线路已经解释过的内容'},
      { id: 'three', role: 'user', text: '旁观消息二' }] });
  assert.equal(a.threadId, b.threadId);
  const packets = calls.filter(c => c.method === 'turn/start').map(c => JSON.parse(c.params.input[0].text));
  assert.equal(packets[0].bootstrap.history[0].content, '历史');
  assert.equal(packets[1].bootstrap, undefined); assert.equal(packets[1].recentMessages, undefined);
  assert.equal(packets[1].requester.id, '789');
  assert.deepEqual(packets[1].newMessages.map(m => m.id), ['two', 'bot_sent', 'three']);
  assert.deepEqual(packets[1].dialogueContext.recentExchange, []);
  assert.equal(packets[1].recentBotReplies[0].text,'另一条线路已经解释过的内容');
  assert.equal(client.state.sessions['123'].lastCachePercent, 95);
  const resumed = fixture(t, client.file);
  const c = await resumed.client.answer(cfg, '第三条', [], context);
  assert.equal(c.threadId, a.threadId);
  assert.ok(resumed.calls.some(c => c.method === 'thread/resume'));
  assert.ok(!resumed.calls.some(c => c.method === 'thread/start'));
});
test('group and private sessions are isolated; reset retires only the selected thread', async t => {
  const { client, cfg, calls } = fixture(t);
  const organized = []; client.onThreadReady = async (chat, threadId) => organized.push({ chat, threadId });
  const a = await client.answer(cfg, '群聊', [], { chatKey: '123' });
  const b = await client.answer(cfg, '私聊', [], { chatKey: 'private:123' });
  assert.notEqual(a.threadId, b.threadId);
  assert.deepEqual(organized.map(x => x.chat), ['123', 'private:123']);
  if (cfg.performance?.groupProjectId) {
    const starts = calls.filter(c => c.method === 'thread/start');
    assert.equal(starts[0].params.projectId, cfg.performance.groupProjectId);
    assert.equal(starts[1].params.projectId, cfg.performance.groupProjectId);
    assert.equal(starts[0].params.sandbox, 'read-only');
  }
  client.reset('123');
  const c = await client.answer(cfg, '重新开始', [], { chatKey: '123' });
  assert.notEqual(c.threadId, a.threadId);
  assert.equal(client.state.sessions['private:123'].threadId, b.threadId);
});
test('corrupt session index is preserved and never silently replaced', t => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-corrupt-'));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const file = path.join(temp, 'sessions.json'); fs.writeFileSync(file, '{broken');
  assert.throws(() => new CodexSessions(readConfig(), root, buildPrompt, { file }), /INDEX_INVALID/);
  assert.equal(fs.readFileSync(file, 'utf8'), '{broken');
});
test('auth and IO errors preserve existing mapping instead of creating an empty conversation', async t => {
  const { client, cfg } = fixture(t);
  const a = await client.answer(cfg, '消息', [], { chatKey: '123' });
  client.loaded.clear();
  const rpc = client.rpc;
  client.rpc = async (method, params) => { if (method === 'thread/resume') throw new Error('CODEX_RPC_FAILED'); return rpc(method, params); };
  await assert.rejects(client.answer(cfg, '下一条', [], { chatKey: '123' }), /RPC_FAILED/);
  assert.equal(client.state.sessions['123'].threadId, a.threadId);
});

test('prompt and schema edits resume the same private thread instead of creating duplicates', async t => {
  const {client,cfg,calls}=fixture(t);
  const first=await client.answer(cfg,'第一条',[],{chatKey:'private:123'});
  client.loaded.clear();client.fingerprint='updated-instructions-and-schema';
  const second=await client.answer(cfg,'第二条',[],{chatKey:'private:123'});
  assert.equal(first.threadId,second.threadId);
  assert.equal(calls.filter(c=>c.method==='thread/start').length,1);
  assert.ok(calls.some(c=>c.method==='thread/resume'));
});

test('desktop writer contention uses ephemeral fallback without replacing the mapping', async t => {
  const {client,cfg,calls}=fixture(t);
  const first=await client.answer(cfg,'第一条',[],{chatKey:'private:123'});
  client.loaded.clear();
  const rpc=client.rpc;
  client.rpc=async(method,params)=>{
    if(method==='thread/resume'){const e=new Error('CODEX_RPC_FAILED');e.rpcMessage='thread already has an active writer';throw e;}
    return rpc(method,params);
  };
  client.onBusy=async()=>({text:'正常回答',shouldReply:true});
  const second=await client.answer(cfg,'后续',[],{chatKey:'private:123'});
  assert.equal(second.threadId,first.threadId);
  assert.equal(second.sessionFallback,'ephemeral_writer_busy');
  assert.equal(calls.filter(c=>c.method==='thread/start').length,1);
});

test('dedup ledger covers the configured context window and never replays its oldest messages', async t => {
  const {client,cfg,calls}=fixture(t);
  const start=Date.now()-200000;
  const messages=Array.from({length:200},(_,i)=>({id:'m'+i,role:i%5===0?'assistant':'user',
    user:i%5===0?'':String(400+i%4),text:'message '+i,at:start+i*1000}));
  await client.answer(cfg,'第一条',[],{chatKey:'123',recentMessages:messages});
  messages.push({id:'m200',role:'user',user:'401',text:'message 200',at:Date.now()});
  await client.answer(cfg,'第二条',[],{chatKey:'123',recentMessages:messages});
  messages.push({id:'m201',role:'user',user:'402',text:'message 201',at:Date.now()+1});
  await client.answer(cfg,'第三条',[],{chatKey:'123',recentMessages:messages});
  const packets=calls.filter(c=>c.method==='turn/start').map(c=>JSON.parse(c.params.input[0].text));
  assert.deepEqual(packets[2].newMessages.map(m=>m.id),['m201']);
});

test('a completed uncertain turn is recovered as committed before sending the next packets', async t => {
  const {client,cfg,calls}=fixture(t);
  await client.answer(cfg,'第一条',[],{chatKey:'123',recentMessages:[]});
  const entry=client.state.sessions['123'];
  entry.turn={id:'bridge-pending',phase:'uncertain',turnId:null,sourceIds:['old'],updatedAt:new Date().toISOString()};
  const base=client.rpc;
  client.rpc=async(method,params)=>method==='thread/read'
    ?{thread:{id:entry.threadId,status:{type:'idle'},turns:[{id:'turn-from-marker',status:{type:'completed'},
      items:[{type:'userMessage',content:[{type:'text',text:'{"bridgeTurnId":"bridge-pending"}'}]}]}]}}
    :base(method,params);
  await client.answer(cfg,'新的',[],{chatKey:'123',recentMessages:[
    {id:'old',role:'user',text:'已经由上一轮消费'},
    {id:'new',role:'user',text:'真正的新消息'}]});
  const packet=JSON.parse(calls.filter(c=>c.method==='turn/start').at(-1).params.input[0].text);
  assert.deepEqual(packet.newMessages.map(m=>m.id),['new']);
  assert.equal(entry.turn.phase,'committed');
});

test('a failed uncertain turn is retried as unseen, while a read error fails closed', async t => {
  const {client,cfg,calls}=fixture(t);
  await client.answer(cfg,'第一条',[],{chatKey:'123',recentMessages:[]});
  const entry=client.state.sessions['123'];
  entry.turn={id:'bridge-pending',phase:'uncertain',turnId:'turn-pending',sourceIds:['old'],updatedAt:new Date().toISOString()};
  const base=client.rpc;
  client.rpc=async(method,params)=>method==='thread/read'
    ?{thread:{id:entry.threadId,status:{type:'idle'},turns:[{id:'turn-pending',status:{type:'failed'}}]}}
    :base(method,params);
  await client.answer(cfg,'重试',[],{chatKey:'123',recentMessages:[{id:'old',role:'user',text:'未消费'}]});
  let packet=JSON.parse(calls.filter(c=>c.method==='turn/start').at(-1).params.input[0].text);
  assert.deepEqual(packet.newMessages.map(m=>m.id),['old']);

  entry.turn={id:'bridge-pending-2',phase:'uncertain',turnId:'turn-unknown',sourceIds:['new'],updatedAt:new Date().toISOString()};
  client.rpc=async(method,params)=>{if(method==='thread/read')throw new Error('CODEX_RPC_FAILED');return base(method,params);};
  const turns=calls.filter(c=>c.method==='turn/start').length;
  await assert.rejects(client.answer(cfg,'不应盲发',[],{chatKey:'123',recentMessages:[{id:'new',role:'user',text:'状态未知'}]}),/PREVIOUS_TURN_UNCERTAIN/);
  assert.equal(calls.filter(c=>c.method==='turn/start').length,turns);
});
