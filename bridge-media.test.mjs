import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { GroupBot } from './bridge.mjs';
import { MediaStore } from './media.mjs';
import { PokeController } from './pokes.mjs';
import { ChatMemory } from './memory.mjs';
import {AvatarReader} from './avatars.mjs';

const cfg = { botQQ: '1000000001', groups: ['200000001', '200000002'], maxQuestionChars: 6000,
  maxReplyChars: 3500, maxQueue: 4, cooldownSeconds: 0, historyTurns: 2, historyTtlMinutes: 60,
  persona: { name: '大肥龙' }, social: { enabled: true, debounceMs: 60000, maxWaitMs: 60000 },
  media: { enabled: true }, pokes: { enabled: true, probability: 1 } };
function event(text, id = 1, extra = {}) {
  return { self_id: 1000000001, post_type: 'message', message_type: 'group', group_id: 200000001,
    user_id: 10001, message_id: id, message: [{ type: 'text', data: { text } }], ...extra };
}
const image = { type: 'image', data: { url: 'https://gchat.qpic.cn/test-image' } };
test('explicit avatar requests attach actual downloaded bytes once, stay out of shared memes and respect the panel switch',async t=>{
  const {bot,requests,media}=fixture(t,async(_c,_q,_h,context)=>context.avatarSearched?
    {shouldReply:true,text:context.avatarResults[0].status==='loaded'?'头像读到了。':'头像没有读到。'}:
    {shouldReply:false,text:'',avatarUserId:'10001'});
  let downloads=0;
  bot.avatars=new AvatarReader({fetcher:async()=>{downloads++;return new Response('real avatar bytes',{headers:{'content-type':'image/png'}});}});
  await bot.verify();await bot.receive(event('大肥龙 看看我的头像',11));
  assert.equal(requests.length,2);assert.equal(downloads,1);
  assert.equal(requests[1][3].avatarResults[0].userId,'10001');
  assert.ok(fs.existsSync(requests[1][3].images[0].path));
  assert.equal(media.catalog('200000001').length,0);
  bot.social.avatarRecognitionEnabled=false;
  await bot.receive(event('大肥龙 再看看我的头像',12));
  assert.equal(requests.at(-1)[3].avatarAllowed,false);assert.equal(downloads,1);
});
function fixture(t, answer, runtimeCfg = cfg) {
  const base = path.resolve('work'), dir = path.join(base, 'qq-bridge-media-' + randomUUID());
  fs.mkdirSync(dir, { recursive: true });
  const calls = [], requests = [];
  const api = { call: async (action, params) => {
    calls.push({ action, params });
    if (action === 'get_login_info') return { user_id: 1000000001 };
    if (action === 'get_group_list') return [{ group_id: 200000001 }, { group_id: 200000002 }];
    return { message_id: 8000 + calls.length };
  } };
  const media = new MediaStore(runtimeCfg, api, { dir: path.join(dir, 'images'), fetcher: async () => new Response('test image'),
    normalize: async (_c, input, preview) => { fs.copyFileSync(input, preview); return { extension: 'png', width: 1, height: 1 }; } });
  const pokes = new PokeController(runtimeCfg, api, { file: path.join(dir, 'prefs.json'), random: () => 0 });
  const memory = new ChatMemory(runtimeCfg, { file: path.join(dir, 'memory.jsonl') });
  const bot = new GroupBot(runtimeCfg, api, async (...args) => { requests.push(args); return answer(...args); }, () => {}, { media, pokes, memory });
  t.after(() => {
    bot.disconnect();
    if (!path.resolve(dir).startsWith(base + path.sep)) throw new Error('Unsafe test cleanup');
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return { bot, calls, requests, media, memory, api, pokes };
}

test('image association survives restart and described images remain available for study followups', async t => {
  const runtimeCfg = { ...cfg, memory: { enabled: true }, performance: { selectiveImages: true } };
  const { bot, media, memory, api, pokes, requests } = fixture(t, async (_c, _q, _h, context) => ({
    shouldReply: true, text: '先看教材里的斜度和锥度。', imageNotes: context.images.map(x => ({ id: x.id, description: '教材上的斜度和锥度示意图' }))
  }), runtimeCfg);
  await bot.verify(); await bot.receive(event('', 1, { message: [image] }));
  await bot.receive(event('大肥龙 看看', 2));
  assert.equal(requests[0][3].images.length, 1);
  const restoredMemory = new ChatMemory(runtimeCfg, { file: memory.file });
  assert.equal(restoredMemory.recent('200000001').find(m => m.id === '200000001:1:user').imageIds.length, 1);
  bot.disconnect();
  const restored = new GroupBot(runtimeCfg, api, bot.answer, () => {}, { media, pokes, memory: restoredMemory });
  t.after(() => restored.disconnect()); await restored.verify();
  await restored.receive(event('大肥龙 帮我学习', 3));
  assert.equal(requests.at(-1)[3].images.length, 1);
  assert.match(requests.at(-1)[3].images[0].description, /斜度/);
  await restored.receive(event('大肥龙 帮我学习', 4, { user_id: 10002 }));
  assert.equal(requests.at(-1)[3].images.length, 0);
  await restored.receive(event('大肥龙 讲讲这题', 5, { user_id: 10002, message: [
    { type: 'reply', data: { id: '1' } }, { type: 'text', data: { text: '大肥龙 讲讲这题' } }
  ] }));
  assert.equal(requests.at(-1)[3].images.length, 1);
});

test('a text request waits for the preceding picture download before calling the model', async t => {
  const { bot, media, requests } = fixture(t, async () => ({ shouldReply: true, text: '从这页教材开始讲。' }),
    { ...cfg, performance: { selectiveImages: true } });
  let release, entered;
  const gate = new Promise(resolve => { release = resolve; });
  const started = new Promise(resolve => { entered = resolve; });
  const normalize = media.normalize;
  media.normalize = async (...args) => { entered(); await gate; return normalize(...args); };
  await bot.verify(); const picture = bot.receive(event('', 1, { message: [image] }));
  await started; const question = bot.receive(event('大肥龙 帮我学习', 2));
  assert.equal(requests.length, 0); release(); await Promise.all([picture, question]);
  assert.equal(requests.length, 1); assert.equal(requests[0][3].images.length, 1);
});
test('an image-only mention reaches the model as a real local attachment', async t => {
  const { bot, requests } = fixture(t, async () => ({ shouldReply: true, text: '我看到图片了。' }));
  await bot.verify();
  await bot.receive(event('', 1, { message: [{ type: 'at', data: { qq: '1000000001' } }, image] }));
  assert.equal(requests.length, 1); assert.equal(requests[0][3].images.length, 1);
  assert.ok(fs.existsSync(requests[0][3].images[0].path));
});
test('a scoped uncached quoted image is downloaded and attached without adding it to the shared library', async t => {
  const {bot,api,requests,media}=fixture(t,async()=>({shouldReply:true,text:'现在能看见引用的图片了。'}));
  const originalCall=api.call;
  api.call=async(action,params)=>action==='get_msg'?{message_type:'group',group_id:200000001,user_id:20002,
    sender:{user_id:20002,nickname:'原图发送者'},message_id:777,message:[image]}:originalCall(action,params);
  await bot.verify();
  await bot.receive(event('',2,{message:[{type:'reply',data:{id:'777'}},{type:'at',data:{qq:cfg.botQQ}}]}));
  assert.equal(requests.length,1);assert.equal(requests[0][3].images.length,1);
  assert.ok(fs.existsSync(requests[0][3].images[0].path));
  assert.equal(media.catalog('200000001').length,0);
  assert.equal(bot.contextFor('200000001').find(m=>m.role==='user').images.length,1);
  api.call=async(action,params)=>action==='get_msg'?{message_type:'group',group_id:999999,user_id:20002,message_id:778,message:[image]}:originalCall(action,params);
  await bot.receive(event('',3,{message:[{type:'reply',data:{id:'778'}},{type:'at',data:{qq:cfg.botQQ}}]}));
  assert.equal(requests.at(-1)[3].images.length,0);
});

test('feeding a picture then requesting a matching meme produces an image segment from that group library', async t => {
  const { bot, calls, media } = fixture(t, async (_c, q, _h, context) => q.includes('来张')
    ? { shouldReply: true, text: '', imageId: context.imageCatalog[0].id }
    : { shouldReply: true, text: '收到，开心表情入库。', imageNotes: context.images.map(x => ({ id: x.id, description: '开心的表情' })) });
  await bot.verify();
  await bot.receive(event('投喂开心', 1, { message: [{ type: 'text', data: { text: '投喂开心' } }, image] }));
  assert.equal(media.catalog('200000001').length, 1);
  await bot.receive(event('大肥龙，来张开心的表情', 2));
  const sent = calls.filter(x => x.action === 'send_group_msg');
  assert.equal(sent.length, 2);
  assert.ok(sent[1].params.message.some(s => s.type === 'image' && s.data.file.startsWith('file:')));
  assert.equal(media.catalog('200000002').length, 0);
});
test('a reply can feed an earlier image without downloading it again', async t => {
  const { bot, media } = fixture(t, async () => ({ shouldReply: true, text: '收好了。' })); await bot.verify();
  await bot.receive(event('', 1, { message: [image] }));
  assert.equal(media.catalog('200000001').length, 0);
  await bot.receive(event('大肥龙 投喂 惊讶', 2, { message: [{ type: 'reply', data: { id: '1' } },
    { type: 'text', data: { text: '大肥龙 投喂 惊讶' } }] }));
  assert.equal(media.catalog('200000001')[0].label, '惊讶');
});
test('a poke silently pokes back without a model call or a chat message', async t => {
  const { bot, calls, requests } = fixture(t, async (_c, _q, _h, context) => ({ shouldReply: true,
    text: '龙鳞都给你戳亮了。', pokeTarget: context.pokeTargets[0]?.id }));
  await bot.verify();
  const notice = { self_id: 1000000001, post_type: 'notice', notice_type: 'notify', sub_type: 'poke',
    group_id: 200000001, user_id: 10001, target_id: 1000000001 };
  await bot.receive(notice); await bot.receive(notice);
  assert.equal(requests.length, 0);
  assert.ok(calls.some(x => x.action === 'send_poke' && x.params.user_id === '10001'));
  assert.equal(calls.filter(x => x.action === 'send_group_msg').length, 0);
});
test('a plain opt-out is handled locally and an invalid model action cannot send local files or poke strangers', async t => {
  const { bot, calls, requests } = fixture(t, async () => ({ shouldReply: true, text: '',
    imageId: '../../config.json', pokeTarget: '99999' }));
  await bot.verify(); await bot.receive(event('别戳我'));
  assert.equal(requests.length, 0);
  assert.deepEqual(bot.pokes.choices({ group_id: 200000001, user_id: 10001 }, { reactive: true }), []);
  const before = calls.length;
  await bot.receive(event('大肥龙，来张图', 2));
  assert.equal(calls.length, before);
});
test('private pokes also poke back silently and do not send a group ID', async t => {
  const { bot, calls, requests } = fixture(t, async () => { throw Error('Model must not run'); }, { ...cfg, allChats: true });
  await bot.verify();
  await bot.receive({ self_id: 1000000001, post_type: 'notice', notice_type: 'notify', sub_type: 'poke',
    user_id: 10002, sender_id: 10002, target_id: 1000000001 });
  assert.equal(requests.length, 0);
  const sent = calls.find(x => x.action === 'send_poke');
  assert.ok(sent); assert.equal(sent.params.user_id, '10002'); assert.equal(sent.params.group_id, undefined);
  assert.equal(calls.filter(x => x.action === 'send_private_msg' || x.action === 'send_group_msg').length, 0);
});
test('ordinary chat does not repeatedly attach old images, but an image question still can', async t => {
  const { bot, requests } = fixture(t, async () => ({ shouldReply: true, text: '好。' }),
    { ...cfg, performance: { selectiveImages: true } });
  await bot.verify();
  await bot.receive(event('大肥龙 看看', 1, { message: [{ type: 'text', data: { text: '大肥龙 看看' } }, image] }));
  assert.equal(requests[0][3].images.length, 1);
  await bot.receive(event('大肥龙，今天聊点别的', 2));
  assert.equal(requests[1][3].images.length, 0);
  await bot.receive(event('大肥龙，刚才图里是什么？', 3));
  assert.equal(requests[2][3].images.length, 1);
});
