import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { GroupBot, groupText } from './bridge.mjs';
import { ChatMemory } from './memory.mjs';
import { MediaStore } from './media.mjs';
import { ModerationService } from './moderation.mjs';
const cfg = { botQQ: '1000000001', groups: ['200000001'], allChats: true, replyEveryMessage: true,
  maxQuestionChars: 6000, maxReplyChars: 3500, maxQueue: 1000, cooldownSeconds: 100,
  historyTurns: 4, historyTtlMinutes: 60, persona: { name: '大肥龙' }, social: { enabled: true },
  media: { enabled: true, shared: true }, memory: { enabled: true, crossSearch: true } };
function scratch(t) {
  const base = path.resolve('work'), dir = path.join(base, 'qq-all-chats-' + randomUUID()); fs.mkdirSync(dir, { recursive: true });
  t.after(() => { if (!path.resolve(dir).startsWith(base + path.sep)) throw new Error('Unsafe cleanup'); fs.rmSync(dir, { recursive: true, force: true }); });
  return dir;
}
function event(text, patch = {}) {
  return { post_type: 'message', message_type: 'group', self_id: 1000000001, user_id: 10001,
    group_id: 999999, message_id: 1, message: [{ type: 'text', data: { text } }], ...patch };
}
function fixture(t, answer = async () => ({ shouldReply: true, text: '收到啦。' }), runtimeCfg = cfg) {
  const dir = scratch(t), calls = [], requests = [];
  const api = { call: async (action, params) => {
    calls.push({ action, params });
    if (action === 'get_login_info') return { user_id: 1000000001 };
    if (action === 'get_group_list') return [];
    return { message_id: 9000 + calls.length };
  } };
  const memory = new ChatMemory(runtimeCfg, { file: path.join(dir, 'memory.jsonl') });
  const media = new MediaStore(runtimeCfg, api, { dir: path.join(dir, 'images'), normalize: async (_c, input, preview) => {
    fs.copyFileSync(input, preview); return { extension: 'png', width: 1, height: 1 };
  } });
  const moderation = new ModerationService(runtimeCfg, api, path.resolve('outputs/codex-qq'), {
    settingsFile: path.join(dir, 'moderation-settings.json'), database: path.join(dir, 'moderation.sqlite3') });
  const bot = new GroupBot(runtimeCfg, api, async (...args) => { requests.push(args); return answer(...args); }, () => {}, { memory, media, moderation });
  t.after(() => bot.disconnect()); return { bot, memory, media, calls, requests, dir };
}

test('quiet mode combines a directed group message and its unmentioned continuation into one response', async t => {
  const quiet = { ...cfg, replyEveryMessage: false, cooldownSeconds: 0,
    social: { enabled: true, quietMode: true, directDebounceMs: 3500, directMaxWaitMs: 9000 } };
  const { bot, requests, calls } = fixture(t, async () => ({ shouldReply: true, text: '合起来回答。' }), quiet);
  await bot.verify();
  await bot.receive(event('大肥龙，我想问个问题'));
  await bot.receive(event('就是这两句话连着看', { message_id: 2 }));
  assert.equal(requests.length, 0);
  await bot.flushDirect(bot.group('999999'));
  assert.equal(requests.length, 1);
  assert.match(requests[0][1], /我想问个问题\n就是这两句话连着看/);
  assert.equal(calls.filter(x => x.action === 'send_group_msg').length, 1);
});

test('mixed social batches never inherit the last speaker management authority',async t=>{
  const runtime={...cfg,replyEveryMessage:false,cooldownSeconds:0,moderation:{enabled:true,owners:['10001']},social:{enabled:true,directDebounceMs:3000}};
  const {bot,calls}=fixture(t,async()=>({shouldReply:true,text:'候选',management:{operation:'propose',kind:'kick',targetUser:'10003'}}),runtime);
  let managementCalls=0;
  bot.moderation.context=async()=>({enabled:true,administrator:true,botRole:'owner'});
  bot.moderation.decision=async()=>{managementCalls++;return {handled:true,text:'不应执行'};};
  await bot.verify();const g=bot.group('999999');
  g.messages.push({id:'999999:0:assistant',at:Date.now()-1000,role:'assistant',forUser:'10001',text:'前一句'});
  await bot.receive(event('GPT，你刚才怎么说的',{user_id:10002}));
  await bot.receive(event('把他踢出群',{message_id:2,message:[{type:'at',data:{qq:'1000000001'}},{type:'text',data:{text:'把他踢出群'}}]}));
  await bot.flushDirect(g);
  assert.equal(managementCalls,0);
  assert.ok(calls.some(c=>c.action==='send_group_msg'&&c.params.message.some(m=>m.data?.text?.includes('单独发起'))));
});

test('quiet mode records messages to others without responding; private bursts are merged', async t => {
  const quiet = { ...cfg, replyEveryMessage: false, cooldownSeconds: 0,
    social: { enabled: true, quietMode: true, directDebounceMs: 3500 } };
  const { bot, requests } = fixture(t, async () => ({ shouldReply: true, text: '一起回答。' }), quiet);
  await bot.verify();
  await bot.receive(event('你几点到', { message: [{ type: 'at', data: { qq: '10002' } }, { type: 'text', data: { text: '你几点到' } }] }));
  assert.equal(requests.length, 0); assert.equal(bot.ambientEligible(bot.group('999999')), false);
  await bot.receive(event('第一句', { message_type: 'private', group_id: undefined, message_id: 2 }));
  await bot.receive(event('第二句', { message_type: 'private', group_id: undefined, message_id: 3 }));
  assert.equal(requests.length, 0);
  await bot.flushDirect(bot.group('private:10001'));
  assert.equal(requests.length, 1); assert.equal(requests[0][1], '第一句\n第二句');
});

test('followups replace the unsent draft and yield exactly one combined QQ reply', async t => {
  let finish;
  const runtime = { ...cfg, replyEveryMessage: false, cooldownSeconds: 0,
    social: { enabled: true, followupFusion: true } };
  const { bot, calls, requests } = fixture(t, async (_cfg, question) => question.includes('补充：')
    ? { shouldReply: true, text: '这是合并后的答案。' }
    : new Promise(resolve => { finish = resolve; }), runtime);
  await bot.verify();
  const first = bot.receive(event('大肥龙，解释一下单片机'));
  await bot.receive(event('补充：只要一句话', { message_id: 2 }));
  assert.equal(requests.length, 1);
  finish({ shouldReply: true, text: '不应发送的旧草稿' }); await first;
  assert.equal(requests.length, 2);
  const sent = calls.filter(x => x.action === 'send_group_msg');
  assert.equal(sent.length, 1); assert.match(JSON.stringify(sent), /合并后的答案/);
  assert.doesNotMatch(JSON.stringify(sent), /旧草稿/);
});

test('accepted native steering consumes a followup without starting a replacement turn', async t => {
  let finish;
  const runtime = { ...cfg, replyEveryMessage: false, cooldownSeconds: 0,
    social: { enabled: true, followupFusion: true } };
  const { bot, requests, calls } = fixture(t, () => new Promise(resolve => { finish = resolve; }), runtime);
  let steered = '';
  bot.answer.steer = async (_chat, text) => { steered = text; return true; };
  await bot.verify(); const first = bot.receive(event('大肥龙，帮我解释'));
  await bot.receive(event('补充：简短一点', { message_id: 2 }));
  await bot.steerFollowups(bot.group('999999'));
  assert.match(steered, /简短一点/);
  finish({ shouldReply: true, text: '简短答案' }); await first;
  assert.equal(requests.length, 1); assert.equal(calls.filter(x => x.action === 'send_group_msg').length, 1);
});

test('autonomous wake does not call a model for a burst of unrelated group chat', async t => {
  const runtime = { ...cfg, replyEveryMessage: false, cooldownSeconds: 0,
    social: { enabled: true, autonomousWake: true, minNewMessages: 1 } };
  const { bot, requests } = fixture(t, async () => ({ shouldReply: true, text: '不应该调用' }), runtime);
  await bot.verify();
  for (let i = 0; i < 12; i++) await bot.receive(event('我已经到楼下了', { message_id: i + 1 }));
  await bot.evaluateAmbient('999999');
  assert.equal(requests.length, 0); assert.equal(bot.group('999999').timer, null);
});
test('active chat honors the configured participation message threshold', async t => {
  const runtime = { ...cfg, replyEveryMessage: false, cooldownSeconds: 0,
    social: { enabled: true, autonomousWake: true, activeMode: true, semanticParticipation: true,
      minNewMessages: 2, minIntervalSeconds: 0, evaluationIntervalSeconds: 0, proactiveCooldownSeconds: 0 } };
  const { bot } = fixture(t, async () => ({ shouldReply: true, text: '接一句。' }), runtime);
  await bot.verify();
  await bot.receive(event('今天试一下新的安排'));
  assert.equal(bot.ambientEligible(bot.group('999999')), false);
  await bot.receive(event('先看看大家会不会参加', { message_id: 2 }));
  assert.equal(bot.ambientEligible(bot.group('999999')), true);
});
test('all group chats and private conversations reply without names or mentions, while self messages stay ignored', async t => {
  const { bot, calls, requests } = fixture(t); await bot.verify();
  await bot.receive(event('今天吃面'));
  await bot.receive(event('你好', { message_type: 'private', user_id: 10002, group_id: undefined, message_id: 2 }));
  await bot.receive(event('不应该回复自己', { user_id: 1000000001, message_id: 3 }));
  assert.equal(requests.length, 2);
  assert.ok(calls.some(x => x.action === 'send_group_msg' && x.params.group_id === 999999));
  assert.ok(calls.some(x => x.action === 'send_private_msg' && x.params.user_id === 10002));
  assert.ok(!requests[1][3].recentMessages.some(x => x.text === '今天吃面'));
});

test('private search authorization is explicit and included in the model packet', async t => {
  const searchable = { ...cfg, capabilities: { webSearchAllGroups: true, webSearchAllChats: true } };
  const { bot, requests } = fixture(t, async () => ({ shouldReply: true, text: '查到了。' }), searchable);
  await bot.verify();
  await bot.receive(event('查一下今天的公开新闻', { message_type: 'private', group_id: undefined, user_id: 10002, message_id: 20 }));
  await bot.flushDirect(bot.group('private:10002'));
  assert.equal(requests[0][3].webSearchAllowed, true);

  const disabled = { ...cfg, capabilities: { webSearchAllGroups: true, webSearchAllChats: false } };
  const second = fixture(t, async () => ({ shouldReply: true, text: '不能查。' }), disabled);
  await second.bot.verify();
  await second.bot.receive(event('再查一下', { message_type: 'private', group_id: undefined, user_id: 10003, message_id: 21 }));
  await second.bot.flushDirect(second.bot.group('private:10003'));
  assert.equal(second.requests[0][3].webSearchAllowed, false);
});
test('rapid messages from one person are all handled instead of being dropped by the old cooldown', async t => {
  const { bot, requests } = fixture(t); await bot.verify();
  await bot.receive(event('第一条')); await bot.receive(event('第二条', { message_id: 2 }));
  assert.equal(requests.length, 2);
});
test('an empty model decision cannot silently discard a message in reply-all mode', async t => {
  const { bot, calls } = fixture(t, async () => ({ shouldReply: false, text: '' })); await bot.verify();
  await bot.receive(event('在吗'));
  assert.equal(calls.filter(x => x.action === 'send_group_msg').length, 1);
});
test('voice and other unsupported payloads still trigger an honest acknowledgement', () => {
  assert.match(groupText(event('', { message: [{ type: 'record', data: { file: 'voice' } }] }), cfg), /语音/);
});
test('memory persists and searches other chats only on demand', async t => {
  const { bot, memory, requests, dir } = fixture(t, undefined, { ...cfg, moderation: { owners: ['10001'] } }); await bot.verify();
  await bot.receive(event('周五下午三点开会'));
  await bot.receive(event('你还记得其他群的开会时间吗？', { message_type: 'private', group_id: undefined, message_id: 2 }));
  assert.equal(requests[1][3].memorySearched, true);
  assert.ok(requests[1][3].memoryResults.some(x => x.text.includes('三点开会')));
  assert.equal(requests[0][3].memoryResults.length, 0);
  const reloaded = new ChatMemory(cfg, { file: path.join(dir, 'memory.jsonl') });
  assert.ok(reloaded.search('开会', 'private:10001').length > 0);
  memory.forget('999999', '10001'); assert.equal(memory.search('开会', 'private:10001').length, 0);
});
test('the model can request one bounded local memory lookup without sharing another chat', async t => {
  const { bot, memory, calls, requests } = fixture(t, async (_c, _q, _h, context) => context.memorySearched
    ? { shouldReply: true, text: '约的是周五下午三点。' }
    : { shouldReply: true, text: '', memoryQuery: '开会' });
  memory.add('999999', { id: 'meeting', at: Date.now(), role: 'user', speaker: '群友', text: '周五下午三点开会' });
  await bot.verify(); await bot.receive(event('我们几点集合？'));
  assert.equal(requests.length, 2); assert.equal(requests[1][3].localMemoryResults.length, 1);
  assert.equal(requests[1][3].memoryResults.length, 0);
  assert.equal(calls.filter(x => x.action === 'send_group_msg').length, 1);
});
test('shared fed images can be reused across group and private chats, but temporary images cannot', async t => {
  const { media } = fixture(t);
  const saved = await media.addBytes('999999', Buffer.from('saved'), { saved: true, label: '开心', owner: '10001' });
  const temporary = await media.addBytes('999999', Buffer.from('temporary'), { owner: '10001' });
  assert.ok(media.catalog('private:10002').some(x => x.id === saved.id));
  assert.ok(media.outgoing('private:10002', saved.id));
  assert.equal(media.outgoing('private:10002', temporary.id), null);
  assert.equal(media.deleteOwned('private:10002', saved.id, '10002'), false);
});
test('messages arriving while the model is busy are answered in FIFO order without cooldown drops', async t => {
  let finish;
  const { bot, requests } = fixture(t, async (_c, question) => question === '第一条'
    ? new Promise(resolve => { finish = resolve; }) : { shouldReply: true, text: '答：' + question });
  await bot.verify();
  const first = bot.receive(event('第一条'));
  await bot.receive(event('第二条', { message_id: 2 }));
  await bot.receive(event('第三条', { message_id: 3 }));
  finish({ shouldReply: true, text: '答：第一条' }); await first;
  assert.deepEqual(requests.map(x => x[1]), ['第一条', '第二条', '第三条']);
});
test('different chats run concurrently while messages in the same chat retain their order', async t => {
  let releaseFirst, otherStarted;
  const started = new Promise(resolve => { otherStarted = resolve; });
  const { bot, requests } = fixture(t, async (_c, q) => {
    if (q === '第一条') return new Promise(resolve => { releaseFirst = resolve; });
    if (q === '另一私聊') otherStarted();
    return { shouldReply: true, text: q };
  }, { ...cfg, performance: { maxConcurrent: 2 } });
  await bot.verify();
  const first = bot.receive(event('第一条'));
  await bot.receive(event('第二条', { message_id: 2 }));
  await bot.receive(event('另一私聊', { message_type: 'private', user_id: 10002, group_id: undefined, message_id: 3 }));
  let timer;
  try {
    await Promise.race([started, new Promise((_, reject) => { timer = setTimeout(() => reject(Error('Other chat blocked')), 2000); })]);
    assert.deepEqual(requests.map(x => x[1]), ['第一条', '另一私聊']);
  } finally { clearTimeout(timer); releaseFirst({ shouldReply: true, text: '第一条的回答' }); }
  await first;
  assert.deepEqual(requests.map(x => x[1]), ['第一条', '另一私聊', '第二条']);
});
