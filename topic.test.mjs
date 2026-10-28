import test from 'node:test';
import assert from 'node:assert/strict';
import { conversationRelation, conversationAudience, repeatedReply } from './topic.mjs';
import { GroupBot, buildPrompt } from './bridge.mjs';

const botQQ = '1000000001';
const event = (text, patch = {}) => ({ post_type: 'message', message_type: 'group',
  self_id: Number(botQQ), group_id: 200000003, user_id: 1000000002, message_id: 1,
  message: [{ type: 'text', data: { text } }], ...patch });
const previous = (now = Date.now()) => [{ at: now - 22_000, role: 'assistant',
  text: '这张确实可爱得有点过分了，我顶多认领“笨蛋”俩字，可爱部分先不碰瓷。', forUser: '1000000004' }];

test('GPT references and clear callbacks can address the bot across different group speakers', () => {
  for (const text of ['gpt这么谨慎干嘛', 'GPT，你怎么这么客气', 'ChatGPT刚才怎么不承认']) {
    assert.equal(conversationRelation(event(text), text, previous(), botQQ), 'bot_reference');
  }
  assert.equal(conversationRelation(event('你刚才也太谨慎了'), '你刚才也太谨慎了', previous(), botQQ), 'reply_followup');
});

test('GPT product talk, other addressees, expired context and rejection do not summon the bot', () => {
  for (const text of ['gpt', 'GPT多少钱', 'gpt怎么安装', 'gpt怎么收费', 'GPT和DeepSeek哪个好',
    '别人的gpt这么谨慎干嘛', 'gpt你别回了', '今天吃面', '小王你刚才怎么说的']) {
    assert.equal(conversationRelation(event(text), text, previous(), botQQ), '', text);
  }
  const text = 'gpt这么谨慎干嘛';
  assert.equal(conversationRelation(event(text), text, [], botQQ), '');
  assert.equal(conversationRelation(event(text), text, previous(Date.now() - 180_000), botQQ), '');
  for (const segment of [{ type: 'at', data: { qq: '10002' } }, { type: 'reply', data: { id: 'another-person' } }]) {
    assert.equal(conversationRelation(event(text, { message: [segment] }), text, previous(), botQQ), '');
  }
  assert.equal(conversationRelation(event(text), text, [...previous(), { at: Date.now(), role: 'user', addressedToOthers: true }], botQQ), '');
  const busy = [...previous(), ...Array.from({ length: 7 }, () => ({ at: Date.now(), role: 'user' }))];
  assert.equal(conversationRelation(event(text), text, busy, botQQ), '');
});

function fixture() {
  const cfg = { botQQ, groups: ['200000003'], allChats: true, maxQuestionChars: 6000, maxReplyChars: 3500,
    maxQueue: 10, cooldownSeconds: 0, historyTurns: 2, historyTtlMinutes: 60, persona: { name: '大肥龙' },
    social: { enabled: true, quietMode: true, autonomousWake: true, directDebounceMs: 60_000, directMaxWaitMs: 60_000 } };
  const calls = [], generations = [], updates = [];
  const api = { call: async (action, params) => {
    calls.push({ action, params });
    if (action === 'get_login_info') return { user_id: Number(botQQ) };
    if (action === 'get_group_list') return [];
    return { message_id: 200 };
  } };
  const bot = new GroupBot(cfg, api, async (...args) => {
    generations.push(args); return { shouldReply: true, text: '谨慎是怕顺手把可爱也认领了。笨蛋我先认半天。' };
  }, patch => updates.push(patch));
  return { cfg, bot, calls, generations, updates };
}

test('human addressees persist across an omitted name and across the other speaker replying', () => {
  const now = Date.now();
  const first = conversationAudience(event('', { message: [{ type: 'at', data: { qq: '1000000005' } }] }), '没有在图片里看到你啊', [], botQQ);
  assert.equal(first.kind, 'other');
  const records = [{ role: 'user', user: '1000000002', at: now - 16000, addressedToOthers: true, audience: first }];
  assert.equal(conversationAudience(event('请所有人喝蜜雪冰城吗？'), '请所有人喝蜜雪冰城吗？', records, botQQ).kind, 'other');
  assert.equal(conversationAudience(event('请大家喝奶茶吗？'), '请大家喝奶茶吗？', records, botQQ).kind, 'other');
  assert.equal(conversationAudience(event('白上衣', { user_id: 1000000005 }), '白上衣', records, botQQ).kind, 'other');
  assert.equal(conversationAudience(event('大家觉得后面怎么做？'), '大家觉得后面怎么做？', records, botQQ).kind, 'group');
  assert.equal(conversationAudience(event('大肥龙解释一下'), '大肥龙解释一下', records, botQQ, true).kind, 'bot');
  assert.equal(conversationAudience(event('请所有人喝吗'), '请所有人喝吗', [{ ...records[0], at: now - 181000 }], botQQ).kind, 'group');
});

test('a different speakers terse action request does not assign the bot a human role', () => {
  const records = [{ role: 'user', at: Date.now(), user: '1000000002', text: '你们觉得拉其他同学怎么样' },
    { role: 'assistant', at: Date.now(), forUser: '1000000002', text: '先小范围试运行。' }];
  assert.equal(conversationAudience(event('你试一下呗', { user_id: 1000000005 }), '你试一下呗', records, botQQ).kind, 'unclear');
  assert.equal(conversationAudience(event('你试一下呗', { user_id: 1000000005 }), '你试一下呗', records, botQQ, true).kind, 'bot');
});

test('screenshot human dialogue never starts a model reply, but explicit bot calls still work', async t => {
  const { bot, generations } = fixture(); t.after(() => bot.disconnect()); await bot.verify();
  await bot.receive(event('没有在图片里看到你啊', { message: [{ type: 'at', data: { qq: '1000000005' } },
    { type: 'text', data: { text: '没有在图片里看到你啊' } }] }));
  await bot.receive(event('请所有人喝蜜雪冰城吗？', { message_id: 2 }));
  const g = bot.group('200000003');
  await bot.evaluateAmbient(g.id); assert.equal(generations.length, 0);
  assert.equal(g.latest.ambientAllowed, false);
  await bot.receive(event('大肥龙，你怎么看？', { message_id: 3 }));
  await bot.flushDirect(g); assert.equal(generations.length, 1);
});

test('ambient repeated wording is suppressed while a genuinely different answer is allowed', async t => {
  const { bot, generations, calls } = fixture(); t.after(() => bot.disconnect()); await bot.verify();
  const g = bot.group('200000003');
  const old = '先找几位愿意参与的同学小范围试运行，明确群管理权限和记忆怎么存，再慢慢扩。';
  g.messages.push({ role: 'assistant', text: old, at: Date.now() });
  assert.equal(repeatedReply(old.replace('，', '。'), g.messages), true);
  assert.equal(repeatedReply('具体可以先邀请两位同学，在设置里给他们只读权限，然后测试退出后的数据删除。', g.messages), false);
  bot.answer = async () => { generations.push('checked'); return { shouldReply: true, text: old }; };
  bot.wake.cfg.social.activeMode = true; bot.wake.cfg.social.semanticParticipation = true;
  bot.social.proactiveCooldownSeconds = 0; bot.social.evaluationIntervalSeconds = 0;
  await bot.receive(event('大家觉得怎么做？'));
  await bot.evaluateAmbient(g.id);
  assert.equal(generations.length, 1);
  assert.equal(calls.filter(x => x.action === 'send_group_msg').length, 0);
});

test('semantic no-new-information assessment suppresses a paraphrase; explicit requests can repeat', async t => {
  const { bot, calls } = fixture(); t.after(() => bot.disconnect()); await bot.verify();
  bot.answer = async () => ({ shouldReply: true, text: '还是先邀请少数同学，把权限、保存和删除流程跑通再扩大。',
    replyAssessment: { addressee: 'group', addsNewInformation: false } });
  bot.wake.cfg.social.activeMode = true; bot.wake.cfg.social.semanticParticipation = true;
  bot.social.proactiveCooldownSeconds = 0; bot.social.evaluationIntervalSeconds = 0;
  await bot.receive(event('大家觉得怎么做？')); await bot.evaluateAmbient('200000003');
  assert.equal(calls.filter(x => x.action === 'send_group_msg').length, 0);
  await bot.receive(event('大肥龙，再说一遍', { message_id: 2 }));
  await bot.flushDirect(bot.group('200000003'));
  assert.equal(calls.filter(x => x.action === 'send_group_msg').length, 1);
});

test('active groups can send a useful meme reaction without requiring new factual knowledge',async t=>{
  const {bot,calls,updates}=fixture();t.after(()=>bot.disconnect());await bot.verify();
  bot.social.activeMode=true;bot.social.semanticParticipation=true;bot.social.minNewMessages=1;bot.social.proactiveCooldownSeconds=0;bot.social.evaluationIntervalSeconds=0;
  bot.wake.cfg.social.activeMode=true;bot.wake.cfg.social.semanticParticipation=true;
  bot.answer=async()=>({shouldReply:true,text:'这猫嘴上说没偷吃，舌头已经先招了。',replyAssessment:{addressee:'group',addsNewInformation:false}});
  await bot.receive(event('大家觉得这只猫怎么样？'));await bot.evaluateAmbient('200000003');
  assert.equal(calls.filter(c=>c.action==='send_group_msg').length,1,JSON.stringify(updates));
});

test('screenshot replay bypasses ambient cooldown and merges the next explicit mention into one answer', async t => {
  const { cfg, bot, calls, generations, updates } = fixture();
  t.after(() => bot.disconnect()); await bot.verify();
  const g = bot.group('200000003'); g.messages.push(...previous()); g.lastReplyAt = Date.now();
  bot.wake.settle(g.id, { shouldReply: true }, '1000000004', '笨蛋');
  bot.wake.get(g.id).calls = Array(12).fill(Date.now());
  await bot.receive(event('gpt这么谨慎干嘛'));
  assert.equal(g.pendingDirect.jobs.length, 1);
  assert.ok(updates.some(x => x.lastRoutingReason === 'bot_reference'));
  await bot.receive(event('你承认你是笨蛋了', { user_id: 1000000004, message_id: 2,
    message: [{ type: 'at', data: { qq: botQQ } }, { type: 'text', data: { text: '你承认你是笨蛋了' } }] }));
  await bot.flushDirect(g);
  assert.equal(generations.length, 1);
  assert.match(generations[0][1], /gpt这么谨慎干嘛[\s\S]*你承认你是笨蛋了/);
  assert.equal(generations[0][3].conversationRelation, 'bot_reference');
  assert.equal(calls.filter(x => x.action === 'send_group_msg').length, 1);
  const prompt = buildPrompt(cfg, generations[0][1], [], generations[0][3]);
  assert.equal(JSON.parse(prompt.split('\n').at(-1)).conversationRelation, 'bot_reference');
});

test('implicit callbacks respect requested quiet; unrelated chatter remains buffered', async t => {
  const { bot, generations } = fixture(); t.after(() => bot.disconnect()); await bot.verify();
  const g = bot.group('200000003'); g.messages.push(...previous()); bot.wake.dive(g.id);
  await bot.receive(event('你刚才也太谨慎了'));
  await bot.receive(event('GPT怎么安装', { message_id: 2 }));
  assert.equal(g.pendingDirect, undefined); assert.equal(generations.length, 0);
});
