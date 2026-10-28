import test from 'node:test';
import assert from 'node:assert/strict';
import { SpeechRecognizer } from './speech.mjs';
import { GroupBot, groupText } from './bridge.mjs';
const cfg = { botQQ: '1000000001', groups: ['123'], allChats: true, replyEveryMessage: false,
  maxQuestionChars: 6000, maxReplyChars: 3500, maxQueue: 100, cooldownSeconds: 0, historyTurns: 2, historyTtlMinutes: 60,
  persona: { name: '大肥龙' }, social: { enabled: true }, speech: { enabled: true, retryDelayMs: 1 } };
const event = patch => ({ post_type: 'message', message_type: 'private', self_id: 1000000001, user_id: 10001,
  message_id: 101, message: [{ type: 'record', data: { file: 'not-a-local-file.amr', url: 'http://127.0.0.1/secrets' } }], ...patch });

test('quote plus mention without text reads and transcribes the original group voice', async () => {
  const calls = [];
  const input = event({ message_type: 'group', group_id: 123, message: [
    { type: 'reply', data: { id: '777' } }, { type: 'at', data: { qq: cfg.botQQ } }
  ] });
  const speech = new SpeechRecognizer(cfg, { call: async (action, params) => {
    calls.push({ action, params });
    if (action === 'get_msg') return { group_id: 123, message_type: 'group', message: [{ type: 'record', data: {} }] };
    return { text: '上午的语音内容' };
  } });
  assert.ok(groupText(input, cfg));
  const output = await speech.prepare(input);
  assert.match(groupText(output, cfg), /引用语音转写.*上午/);
  assert.deepEqual(calls, [ { action: 'get_msg', params: { message_id: '777' } },
    { action: 'fetch_ptt_text', params: { message_id: '777' } } ]);
});

test('a quote outside the current group is not transcribed', async () => {
  const speech = new SpeechRecognizer(cfg, { call: async action => {
    assert.equal(action, 'get_msg');
    return { group_id: 999, message: [{ type: 'record', data: {} }] };
  } });
  const output = await speech.prepare(event({ message_type: 'group', group_id: 123, message: [
    { type: 'reply', data: { id: '777' } }, { type: 'at', data: { qq: cfg.botQQ } }
  ] }));
  assert.match(groupText(output, cfg), /引用消息读取失败/);
});
function fixture(answer, transcribe = async () => ({ text: '大肥龙，用一句话解释单片机' })) {
  const calls = [], questions = [];
  const api = { call: async (action, params) => {
    calls.push({ action, params });
    if (action === 'get_login_info') return { user_id: 1000000001 };
    if (action === 'get_group_list') return [];
    if (action === 'fetch_ptt_text') return transcribe(params);
    return { message_id: 200 };
  } };
  const bot = new GroupBot(cfg, api, async (_cfg, q, history, context) => {
    questions.push({ q, context }); return answer ? answer(q) : { shouldReply: true, text: '单片机是一种小型控制计算机。' };
  });
  return { bot, api, calls, questions };
}
test('voice recognition passes only the QQ message id and caches duplicates', async () => {
  const { api, calls } = fixture(); const speech = new SpeechRecognizer(cfg, api);
  const a = await speech.prepare(event()); const b = await speech.prepare(event());
  assert.match(a._voiceTranscript, /单片机/); assert.equal(b._voiceTranscript, a._voiceTranscript);
  assert.deepEqual(calls, [{ action: 'fetch_ptt_text', params: { message_id: 101 } }]);
});
test('a real voice segment enters the normal private question pipeline only once', async () => {
  const { bot, calls, questions } = fixture();
  try {
    await bot.verify(); await bot.receive(event()); await bot.receive(event());
    assert.equal(questions.length, 1); assert.match(questions[0].q, /语音转写.*单片机/);
    assert.equal(calls.filter(c => c.action === 'send_private_msg').length, 1);
    await bot.receive(event({ user_id: 1000000001, message_id: 102 }));
    await bot.receive(event({ self_id: 9, message_id: 103 }));
    assert.equal(calls.filter(c => c.action === 'fetch_ptt_text').length, 1);
  } finally { bot.disconnect(); }
});
test('unrelated group voice is understood and buffered without forcing a reply', async () => {
  const { bot, questions } = fixture(undefined, async () => ({ text: '我到楼下了，你下来吧' }));
  try {
    await bot.verify(); await bot.receive(event({ message_type: 'group', group_id: 123 }));
    assert.equal(questions.length, 0);
    assert.match(bot.contextFor('123')[0].text, /语音转写.*楼下/);
  } finally { bot.disconnect(); }
});
test('later text waits for voice transcription, but not for model completion', async () => {
  let finishSpeech, finishModel;
  const { bot, questions } = fixture(q => q.includes('语音转写')
    ? new Promise(resolve => { finishModel = resolve; }) : { shouldReply: true, text: '第二条' },
    () => new Promise(resolve => { finishSpeech = resolve; }));
  try {
    await bot.verify(); const voice = bot.receive(event());
    await new Promise(resolve => setImmediate(resolve));
    const text = bot.receive(event({ message_id: 102, message: [{ type: 'text', data: { text: '补充说明' } }] }));
    assert.equal(questions.length, 0);
    finishSpeech({ text: '解释单片机' });
    await text;
    assert.match(questions[0].q, /语音转写/);
    finishModel({ shouldReply: true, text: '第一条' }); await voice;
    assert.equal(questions[1].q, '补充说明');
  } finally { bot.disconnect(); }
});
test('recognition failure gives a private fallback and never calls the model with guessed words', async () => {
  const { bot, calls, questions } = fixture(undefined, async () => { throw Error('QQ failure'); });
  try {
    await bot.verify(); await bot.receive(event());
    assert.equal(questions.length, 0); assert.equal(calls.filter(c => c.action === 'fetch_ptt_text').length, 2);
    assert.match(JSON.stringify(calls.filter(c => c.action === 'send_private_msg')), /没转出来/);
  } finally { bot.disconnect(); }
});
test('overlong voice is rejected before recognition and pending work is discarded after disconnect', async () => {
  const { api, calls } = fixture(); const speech = new SpeechRecognizer(cfg, api);
  const long = await speech.prepare(event({ message: [{ type: 'record', data: { duration: 121 } }] }));
  assert.equal(long._speechError, 'SPEECH_TOO_LONG'); assert.equal(calls.length, 0);
  assert.equal(groupText(event(), cfg), '[语音]');
  let finish;
  const f = fixture(undefined, () => new Promise(resolve => { finish = resolve; }));
  await f.bot.verify(); const pending = f.bot.receive(event()); await new Promise(resolve => setImmediate(resolve));
  f.bot.disconnect(); finish({ text: '晚到的转写' }); await pending; assert.equal(f.questions.length, 0);
});
