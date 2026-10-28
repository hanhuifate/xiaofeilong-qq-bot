import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { WakeManager } from './wake.mjs';
const cfg = { social: { autonomousWake: true } };
test('semantic participation considers ordinary banter without a mention, respects limits and explicit silence',()=>{
  let now=1000000;
  const wake=new WakeManager({social:{autonomousWake:true,activeMode:true,semanticParticipation:true,
    minIntervalSeconds:15,maxWakePerHour:90}},{now:()=>now});
  assert.equal(wake.reason('123',{text:'这个表情包也太像你了',user:'2'}),'social_context');
  assert.equal(wake.reason('123',{text:'这个表情包也太像你了',user:'2',addressedToOthers:true}),null);
  wake.evaluated('123','social_context');
  assert.equal(wake.reason('123',{text:'小狗头上还有一只鸡',user:'3'}),null);
  now+=16000;
  assert.equal(wake.reason('123',{text:'小狗头上还有一只鸡',user:'3'}),'social_context');
  wake.dive('123',600);
  assert.equal(wake.reason('123',{text:'小狗头上还有一只鸡',user:'3'}),null);
});
test('unrelated conversations never wake the model, while public help can wake it', () => {
  const wake = new WakeManager(cfg);
  for (const text of ['我到楼下了', '今天吃面', '哈哈哈哈', '你几点到？', '给我打电话']) {
    assert.equal(wake.reason('123', { text, user: '1' }), null);
  }
  assert.equal(wake.reason('123', { text: '请教一下这个编译报错怎么解决', user: '1' }), 'public_help');
  assert.equal(wake.reason('123', { text: '请教一下怎么解决', user: '1', addressedToOthers: true }), null);
});
test('sleep and rate limits survive restart; direct calls always reopen observation', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-wake-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  let now = 1000000; const options = { file: path.join(dir, 'wake.json'), now: () => now };
  const wake = new WakeManager(cfg, options);
  wake.evaluated('123', 'public_help'); wake.settle('123', { shouldReply: false }, '1', '报错怎么解决');
  const restored = new WakeManager(cfg, options);
  assert.equal(restored.reason('123', { text: '怎么安装', user: '2' }), null);
  restored.called('123', '2', '单片机代码');
  assert.equal(restored.get('123').mode, 'observing');
  now += 61000;
  assert.equal(restored.reason('123', { text: '那具体怎么写', user: '2' }), 'followup');
  assert.equal(restored.reason('123', { text: '那具体怎么写', user: '3' }), 'public_help');
});
test('silence backs off and model wake plans are bounded', () => {
  let now = 1000000; const wake = new WakeManager(cfg, { now: () => now });
  wake.settle('123', { shouldReply: false }, '1', '闲聊'); const first = wake.get('123').until - now;
  wake.settle('123', { shouldReply: false }, '1', '闲聊'); assert.ok(wake.get('123').until - now > first);
  wake.settle('123', { shouldReply: true, wakePlan: { mode: 'engage', seconds: 999999 } }, '1', '话题');
  assert.equal(wake.get('123').until - now, 180000);
  wake.settle('123', { shouldReply: false, wakePlan: { mode: 'dive', seconds: 999999 } }, '1', '话题');
  assert.equal(wake.get('123').until - now, 7200000);
});
test('engaged followups are bounded and do not turn every sentence into a wake', () => {
  let now = 1000000;
  const wake = new WakeManager({ social: { autonomousWake: true, wake: { minIntervalSeconds: 0, maxFollowups: 1 } } }, { now: () => now });
  wake.called('123', '1', '程序里这个变量');
  assert.equal(wake.reason('123', { text: '那这个变量呢', user: '1' }), 'followup');
  wake.evaluated('123', 'followup');
  assert.equal(wake.reason('123', { text: '那这个变量呢', user: '1' }), null);
  assert.equal(wake.reason('123', { text: '我去吃饭了', user: '1' }), null);
});

test('active chat uses a short model cooldown without shortening requested quiet',()=>{
  let now=1000000;
  const wake=new WakeManager({social:{autonomousWake:true,activeMode:true,semanticParticipation:true,minIntervalSeconds:0}},{now:()=>now});
  wake.settle('123',{shouldReply:false,wakePlan:{mode:'dive',seconds:300}},'1','猫图');
  assert.equal(wake.get('123').until-now,30000);
  assert.equal(wake.reason('123',{text:'后续接梗',user:'2'}),null);
  now+=31000;assert.equal(wake.reason('123',{text:'后续接梗',user:'2'}),'social_context');
  wake.dive('123',600);now+=31000;
  assert.equal(wake.reason('123',{text:'普通聊天',user:'2'}),null);
});
