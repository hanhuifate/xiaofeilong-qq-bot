import test from 'node:test';
import assert from 'node:assert/strict';
import { GroupBot, questionFrom, codexArgs, buildPrompt } from './bridge.mjs';

const cfg = { botQQ: '1000000001', groups: ['200000001'], maxQuestionChars: 6000,
  maxReplyChars: 3500, maxQueue: 4, cooldownSeconds: 0, historyTurns: 2,
  historyTtlMinutes: 60, model: 'gpt-6.1-sol', reasoningEffort: 'low' };
function event(patch = {}) {
  return { post_type: 'message', message_type: 'group', self_id: 1000000001,
    group_id: 200000001, user_id: 10001, message_id: 1,
    message: [{ type: 'at', data: { qq: '1000000001' } }, { type: 'text', data: { text: ' 单片机是什么？' } }], ...patch };
}
function fixture(answer = async () => ({ text: '单片机是一种集成了处理器、存储器和外设的芯片。' })) {
  const calls = [];
  const api = { call: async (action, params) => {
    calls.push({ action, params });
    if (action === 'get_login_info') return { user_id: 1000000001 };
    if (action === 'get_group_list') return [{ group_id: 200000001 }];
    return { message_id: 123 };
  } };
  return { calls, api, bot: new GroupBot(cfg, api, answer) };
}
test('only explicit mentions in the authorized group are accepted', () => {
  assert.equal(questionFrom(event(), cfg), '单片机是什么？');
  for (const patch of [{ group_id: 1 }, { self_id: 1 }, { user_id: 1000000001 },
    { message_type: 'private' }, { post_type: 'notice' },
    { message: [{ type: 'text', data: { text: '[CQ:at,qq=1000000001] hi' } }] },
    { message: [{ type: 'at', data: { qq: 'all' } }] }]) assert.equal(questionFrom(event(patch), cfg), null);
});
test('login and group membership are verified before sending', async () => {
  const { bot, calls } = fixture();
  await bot.receive(event()); assert.equal(calls.length, 0);
  await bot.verify(); assert.equal(bot.ready, true);
  await bot.receive(event());
  const sent = calls.filter(x => x.action === 'send_group_msg');
  assert.equal(sent.length, 1); assert.equal(sent[0].params.group_id, 200000001);
  assert.equal(sent[0].params.message[0].data.qq, '10001');
  await bot.receive(event()); assert.equal(calls.filter(x => x.action === 'send_group_msg').length, 1);
});
test('wrong account and missing target group fail closed', async () => {
  const badAccount = new GroupBot(cfg, { call: async () => ({ user_id: 2 }) });
  await assert.rejects(badAccount.verify(), /WRONG_QQ_ACCOUNT/); assert.equal(badAccount.ready, false);
  const noGroup = new GroupBot(cfg, { call: async action => action === 'get_login_info' ? { user_id: 1000000001 } : [] });
  await assert.rejects(noGroup.verify(), /QQ_NOT_IN_GROUP/); assert.equal(noGroup.ready, false);
});
test('history is isolated per member and reset never invokes Codex', async () => {
  const received = [];
  const { bot } = fixture(async (_c, q, history) => { received.push({ q, history }); return { text: 'answer' }; });
  await bot.verify(); await bot.receive(event());
  await bot.receive(event({ message_id: 2 })); assert.equal(received[1].history.length, 2);
  await bot.receive(event({ message_id: 3, user_id: 10002 })); assert.equal(received[2].history.length, 0);
  await bot.receive(event({ message_id: 4, message: [{ type: 'at', data: { qq: '1000000001' } }, { type: 'text', data: { text: '/清空' } }] }));
  assert.equal(received.length, 3);
  await bot.receive(event({ message_id: 5 })); assert.equal(received[3].history.length, 0);
});
test('a reply generated before disconnect cannot be sent after reconnect', async () => {
  let finish;
  const { bot, calls } = fixture(() => new Promise(resolve => { finish = resolve; }));
  await bot.verify(); const pending = bot.receive(event());
  bot.disconnect(); await bot.verify(); finish({ text: 'stale reply' }); await pending;
  assert.equal(calls.filter(x => x.action === 'send_group_msg').length, 0);
});
test('model failure sends a generic message without leaking errors', async () => {
  const { bot, calls } = fixture(async () => { throw new Error('private detail'); });
  await bot.verify(); await bot.receive(event());
  const sent = calls.find(x => x.action === 'send_group_msg');
  assert.ok(sent); assert.doesNotMatch(JSON.stringify(sent), /private detail/);
});
test('CLI uses stdin, isolated configuration, read-only mode and disabled host tools', () => {
  const args = codexArgs(cfg);
  assert.ok(args.includes('--ignore-user-config')); assert.ok(args.includes('--ephemeral'));
  assert.ok(args.includes('read-only')); assert.equal(args.at(-1), '-');
  for (const key of ['shell_tool', 'apps', 'plugins', 'hooks', 'multi_agent', 'computer_use', 'code_mode_host']) {
    assert.ok(args.includes(`features.${key}=false`));
  }
});

const socialCfg = { ...cfg, groups: ['200000001', '200000002'], persona: { name: '阿澈' }, social: {
  enabled: true, debounceMs: 60000, maxWaitMs: 60000, evaluationIntervalSeconds: 0,
  proactiveCooldownSeconds: 0, contextMessages: 6, contextChars: 500,
  maxEvaluationsPerHour: 3, maxProactivePerHour: 2
} };
function textEvent(text, patch = {}) {
  return event({ message: [{ type: 'text', data: { text } }], ...patch });
}
function socialFixture(answer = async () => ({ shouldReply: true, text: '我觉得这个话题挺有意思。' })) {
  const calls = [], generations = [];
  const api = { call: async (action, params) => {
    calls.push({ action, params });
    if (action === 'get_login_info') return { user_id: 1000000001 };
    if (action === 'get_group_list') return [{ group_id: 200000001 }, { group_id: 200000002 }];
    return { message_id: 9876 };
  } };
  const bot = new GroupBot(socialCfg, api, async (...args) => { generations.push(args); return answer(...args); });
  return { calls, generations, bot };
}

test('semantic social mode routes unmentioned ordinary banter through the conversation engine',async()=>{
  const calls=[],generations=[];
  const active={...socialCfg,social:{...socialCfg.social,autonomousWake:true,activeMode:true,semanticParticipation:true,minNewMessages:1,minIntervalSeconds:0}};
  const api={call:async(action,params)=>{
    calls.push({action,params});
    if(action==='get_login_info')return {user_id:1000000001};
    if(action==='get_group_list')return [{group_id:200000001},{group_id:200000002}];
    return {message_id:9890};
  }};
  const bot=new GroupBot(active,api,async(...args)=>{generations.push(args);return {shouldReply:true,text:'顶着小鸡还一脸无辜，这个表情包有点东西。'};});
  try{
    await bot.verify();
    await bot.receive(textEvent('这只小狗头顶还有一只鸡'));
    await bot.evaluateAmbient('200000001');
    assert.equal(generations.length,1);
    assert.equal(generations[0][3].mode,'ambient');
    assert.equal(calls.filter(x=>x.action==='send_group_msg').length,1);
  }finally{bot.disconnect();}
});
test('all authorized text is buffered, while other groups, private messages and self messages are ignored', async () => {
  const { bot, generations } = socialFixture(); await bot.verify();
  await bot.receive(textEvent('今天食堂有点挤'));
  await bot.receive(textEvent('其他群的私密话', { group_id: 2, message_id: 2 }));
  await bot.receive(textEvent('私聊', { message_type: 'private', message_id: 3 }));
  await bot.receive(textEvent('自己的回声', { user_id: 1000000001, message_id: 4 }));
  assert.deepEqual(bot.contextFor('200000001').map(x => x.text), ['今天食堂有点挤']);
  assert.equal(generations.length, 0); bot.disconnect();
});
test('unmentioned chat is batched and can receive a natural response without an at segment', async () => {
  const { bot, calls, generations } = socialFixture(); await bot.verify();
  await bot.receive(textEvent('晚上想吃面'));
  await bot.receive(textEvent('有好吃的推荐吗？', { user_id: 10002, message_id: 2 }));
  assert.equal(generations.length, 0);
  await bot.evaluateAmbient('200000001');
  assert.equal(generations.length, 1); assert.equal(generations[0][3].mode, 'ambient');
  assert.equal(generations[0][3].recentMessages.length, 2);
  const sent = calls.find(x => x.action === 'send_group_msg');
  assert.deepEqual(sent.params.message, [{ type: 'text', data: { text: '我觉得这个话题挺有意思。' } }]);
  bot.disconnect();
});
test('the model can choose silence without generating an empty or error group message', async () => {
  const { bot, calls } = socialFixture(async () => ({ shouldReply: false, text: '' })); await bot.verify();
  await bot.receive(textEvent('群里有人吗？')); await bot.evaluateAmbient('200000001');
  assert.equal(calls.filter(x => x.action === 'send_group_msg').length, 0);
  await bot.evaluateAmbient('200000001');
  assert.equal(bot.group('200000001').evalTimes.length, 1); bot.disconnect();
});
test('name and replies to bot messages trigger direct dialogue without an at', async () => {
  const { bot, generations } = socialFixture(); await bot.verify();
  await bot.receive(textEvent('阿澈，你喜欢什么游戏？'));
  assert.equal(generations.length, 1); assert.equal(generations[0][3].mode, 'direct');
  await bot.receive(event({ message_id: 2, message: [{ type: 'reply', data: { id: '9876' } }, { type: 'text', data: { text: '为什么呀' } }] }));
  assert.equal(generations.length, 2); assert.equal(generations[1][3].mode, 'direct'); bot.disconnect();
});
test('context stays within the current group even when both groups are active', async () => {
  const { bot, generations } = socialFixture(); await bot.verify();
  await bot.receive(textEvent('第一个群的话题'));
  await bot.receive(textEvent('第二个群的话题', { group_id: 200000002, message_id: 2 }));
  await bot.receive(textEvent('阿澈聊聊', { group_id: 200000002, message_id: 3 }));
  const context = generations[0][3].recentMessages;
  assert.ok(context.some(x => x.text === '第二个群的话题'));
  assert.ok(!context.some(x => x.text === '第一个群的话题')); bot.disconnect();
});
test('messages addressed to another person do not trigger opportunistic replies', async () => {
  const { bot, generations } = socialFixture(); await bot.verify();
  await bot.receive(event({ message: [{ type: 'at', data: { qq: '10002' } }, { type: 'text', data: { text: '你晚上吃什么？' } }] }));
  await bot.evaluateAmbient('200000001'); assert.equal(generations.length, 0); bot.disconnect();
});
test('proactive rate limits do not block explicit questions', async () => {
  const { bot, generations } = socialFixture(); await bot.verify();
  const g = bot.group('200000001');
  g.replyTimes = [Date.now(), Date.now()];
  await bot.receive(textEvent('有没有人知道？')); await bot.evaluateAmbient(g.id);
  assert.equal(generations.length, 0);
  await bot.receive(textEvent('阿澈，解释一下', { message_id: 2 }));
  assert.equal(generations.length, 1); bot.disconnect();
});
test('ambient failures stay silent, preventing error messages from interrupting chat', async () => {
  const { bot, calls } = socialFixture(async () => { throw new Error('backend down'); }); await bot.verify();
  await bot.receive(textEvent('这个题怎么解？')); await bot.evaluateAmbient('200000001');
  assert.equal(calls.filter(x => x.action === 'send_group_msg').length, 0); bot.disconnect();
});
test('group context expires and is bounded', async () => {
  const { bot } = socialFixture(); await bot.verify();
  const g = bot.group('200000001');
  g.messages.push({ at: Date.now() - 3600000 * 24, speaker: 'old', text: '过期内容', role: 'user' });
  for (let n = 0; n < 10; n++) await bot.receive(textEvent('x'.repeat(150), { message_id: n + 1 }));
  const messages = bot.contextFor(g.id);
  assert.ok(messages.length <= 6); assert.ok(messages.reduce((n, x) => n + x.text.length, 0) <= 500);
  assert.ok(!messages.some(x => x.text === '过期内容')); bot.disconnect();
});
test('structured social replies and transparent persona are configured', () => {
  assert.ok(codexArgs(socialCfg).includes('--output-schema'));
  const prompt = buildPrompt(socialCfg, '你是真人吗', [], { mode: 'direct', recentMessages: [] });
  assert.match(prompt, /坦诚自己是AI/); assert.match(prompt, /不假装真人/); assert.match(prompt, /shouldReply/);
  const activePrompt = buildPrompt({...socialCfg,social:{...socialCfg.social,activeMode:true}}, '', [],
    {persistentSession:true,activeGroup:true});
  assert.match(activePrompt, /高活跃参与/);
  assert.match(activePrompt, /优先用简短、有实际内容的一句话参与/);
});
test('proactive cooldown and hourly evaluation cap suppress extra model calls', async () => {
  const { bot, generations } = socialFixture(); await bot.verify();
  bot.social.proactiveCooldownSeconds = 35;
  const g = bot.group('200000001'); g.lastReplyAt = Date.now();
  await bot.receive(textEvent('这题怎么做？')); await bot.evaluateAmbient(g.id);
  assert.equal(generations.length, 0);
  g.lastReplyAt = 0; g.evalTimes = [Date.now(), Date.now(), Date.now()];
  await bot.evaluateAmbient(g.id); assert.equal(generations.length, 0); bot.disconnect();
});
test('ambient response is discarded if a newer direct question changes the conversation', async () => {
  let finish;
  const { bot, calls } = socialFixture((_cfg, _q, _h, context) => context.mode === 'ambient'
    ? new Promise(resolve => { finish = resolve; })
    : Promise.resolve({ shouldReply: true, text: '这是给你的直接回答。' }));
  await bot.verify(); await bot.receive(textEvent('有没有好玩的游戏？'));
  const pending = bot.evaluateAmbient('200000001');
  await bot.receive(textEvent('阿澈，先解释单片机', { message_id: 2 }));
  finish({ shouldReply: true, text: '已经过时的接话' }); await pending;
  const messages = calls.filter(x => x.action === 'send_group_msg');
  assert.equal(messages.length, 1); assert.match(JSON.stringify(messages), /这是给你的直接回答/);
  assert.doesNotMatch(JSON.stringify(messages), /已经过时/); bot.disconnect();
});
test('clearing personal memory also removes that member from the shared recent context', async () => {
  const { bot } = socialFixture(); await bot.verify();
  await bot.receive(textEvent('这是我想清掉的内容'));
  await bot.receive(textEvent('另一位的内容', { user_id: 10002, message_id: 2 }));
  await bot.receive(textEvent('阿澈 /清空', { message_id: 3 }));
  const context = bot.contextFor('200000001');
  assert.ok(!context.some(x => x.text === '这是我想清掉的内容'));
  assert.ok(context.some(x => x.text === '另一位的内容')); bot.disconnect();
});
test('the actual debounce timer combines a burst into a single model decision', async () => {
  const { bot, generations } = socialFixture();
  bot.social.debounceMs = 15; bot.social.maxWaitMs = 50;
  let completed, timeout;
  const done = new Promise((resolve, reject) => {
    completed = resolve; timeout = setTimeout(() => reject(new Error('debounce did not fire')), 2000);
  });
  bot.update = patch => { if (patch.lastDecision === 'joined_chat') completed(); };
  try {
    await bot.verify();
    await bot.receive(textEvent('最近开始学单片机'));
    await bot.receive(textEvent('术语有点多', { message_id: 2 }));
    await bot.receive(textEvent('能用一句话解释吗？', { message_id: 3 }));
    await done;
    assert.equal(generations.length, 1);
    assert.equal(generations[0][3].recentMessages.length, 3);
  } finally { clearTimeout(timeout); bot.disconnect(); }
});
