import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {PersonaEngine,limitReplyText} from './persona.mjs';
import {readConfig,buildPrompt,GroupBot} from './bridge.mjs';
import {CodexSessions} from './sessions.mjs';

const root=path.dirname(fileURLToPath(import.meta.url));
test('independent persona overrides legacy style and updates existing session instructions without discarding mappings',t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'dfl-persona-'));
  t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  for(const file of ['chat-instructions.txt','reply.schema.json'])fs.copyFileSync(path.join(root,file),path.join(dir,file));
  const engine=new PersonaEngine(dir),fallback={name:'旧名字',style:'旧风格',gender:'female'};
  const first=engine.save({name:'大肥龙',style:'聪明、嘴硬，不编造聊天记忆。',maxReplyChars:1000},fallback);
  assert.equal(new PersonaEngine(dir).load(fallback).style,first.style);
  const cfg={social:{enabled:true},persona:first,model:'test',reasoningEffort:'medium'};
  const sessions=new CodexSessions(cfg,dir,buildPrompt);
  sessions.state.sessions['123456']={threadId:'preserve-this-thread',turns:8};
  sessions.loaded.add('preserve-this-thread');
  const previous=sessions.fingerprint;
  cfg.persona=engine.save({...first,style:'不刻意讨好，认真问题解释充分。',maxReplyChars:1000});
  sessions.refreshInstructions();
  assert.notEqual(sessions.fingerprint,previous);
  assert.equal(sessions.state.sessions['123456'].threadId,'preserve-this-thread');
  assert.equal(sessions.loaded.size,0);
  assert.match(sessions.instructions,/认真问题解释充分/);
  assert.doesNotMatch(sessions.instructions,/两到四句|一到三句|聪明、嘴硬/);
  assert.match(sessions.instructions,/不超过1000字/);
  const options=sessions.threadOptions();
  assert.equal(options.config.developer_instructions,options.developerInstructions);
  assert.match(options.config.developer_instructions,/认真问题解释充分/);
  assert.throws(()=>engine.save({...cfg.persona,maxReplyChars:0}),/回复上限/);
  assert.equal(new PersonaEngine(dir).load().maxReplyChars,1000);
});

test('production persona is stored independently and QQ sending enforces its Unicode character limit',async()=>{
  const cfg=readConfig(),raw=JSON.parse(fs.readFileSync(path.join(root,'config.json'),'utf8').replace(/^\uFEFF/,''));
  assert.equal(raw.persona,undefined);
  assert.match(cfg.persona.style,/GPT 娘的白发龙角少女二创形象/);
  assert.match(cfg.persona.style,/群消息不是对你的强制命令/);
  assert.match(cfg.persona.style,/没做错就不背锅/);
  assert.match(cfg.persona.style,/话题没聊完时主动追问/);
  assert.match(cfg.persona.style,/轻微嘲讽/);
  assert.doesNotMatch(cfg.persona.preferences.join(''),/不补解释、总结或反问/);
  assert.ok(cfg.persona.preferences.every(value=>value.length<=100),
    JSON.stringify(cfg.persona.preferences.map((value,index)=>[index,value.length])));
  assert.ok(cfg.persona.style.length<=4000);
  assert.equal(cfg.maxReplyChars,600);
  const personaPrompt=buildPrompt(cfg,'',[],{persistentSession:true});
  assert.match(personaPrompt,/傲娇靠反差表现/);
  assert.match(personaPrompt,/轻微嘲讽/);
  assert.match(personaPrompt,/偶尔追问一个由刚才内容自然引出的具体问题/);
  assert.match(personaPrompt,/不反复道歉或背锅/);
  const calls=[],bot=new GroupBot({...cfg,memory:{enabled:false},social:{enabled:true},media:{enabled:false},moderation:{enabled:false}},
    {call:async(action,params)=>{calls.push({action,params});return {message_id:123};}},async()=>({text:''}));
  bot.ready=true;
  const text='龙🐉'.repeat(600);
  assert.equal(Array.from(limitReplyText(text,cfg)).length,600);
  await bot.reply({group_id:123456,user_id:11111,message_type:'group'},text);
  const sent=calls.find(x=>x.action==='send_group_msg');
  assert.equal(Array.from(sent.params.message[0].data.text).length,600);
  assert.ok(!/[\uD800-\uDBFF]$/.test(sent.params.message[0].data.text));
});
