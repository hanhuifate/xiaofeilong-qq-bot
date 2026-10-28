import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {ChatMemory} from './memory.mjs';
import {GroupBot} from './bridge.mjs';
import {BotStorage} from './storage.mjs';

test('zero context TTL restores old messages and known bot replies after restart',t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'dfl-history-'));
  t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const cfg={memory:{enabled:true,retentionDays:30},social:{enabled:true,contextTtlMinutes:0,contextMessages:200,contextChars:32000}};
  const file=path.join(dir,'memory.jsonl'),memory=new ChatMemory(cfg,{file});
  memory.add('123',{id:'123:77:assistant',at:Date.now()-3*86400000,role:'assistant',text:'周五下午三点集合',speaker:'大肥龙'});
  memory.add('123',{id:'123:78:user',at:Date.now()-2*86400000,role:'user',text:'我会带羽毛球拍',speaker:'小明'});
  const reloaded=new ChatMemory(cfg,{file});
  const bot=new GroupBot(cfg,{},undefined,undefined,{memory:reloaded});
  assert.equal(bot.contextFor('123').length,2);
  assert.ok(bot.group('123').sentIds.has('77'));
  assert.equal(reloaded.recent('123',200,60).length,0);
});

test('local retrieval finds records outside the input window without crossing chat boundaries',t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'dfl-recall-'));
  t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const memory=new ChatMemory({memory:{enabled:true,crossSearch:false}},{file:path.join(dir,'memory.jsonl')});
  memory.add('123',{id:'old',at:Date.now()-86400000,role:'user',text:'羽毛球比赛约在周五',speaker:'小明'});
  memory.add('123',{id:'now',role:'user',text:'羽毛球比赛还记得吗',speaker:'小明'});
  memory.add('456',{id:'elsewhere',role:'user',text:'羽毛球比赛在另一个群',speaker:'小王'});
  const found=memory.searchLocal('羽毛球比赛','123',['now']);
  assert.deepEqual(found.map(x=>x.id),['old']);
  assert.equal(found[0].source,'当前对话');
});

test('FTS5 indexes long Chinese terms and stays consistent across update and deletion',t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'dfl-fts-'));
  const store=new BotStorage(path.join(dir,'bot.sqlite3'));
  t.after(()=>{store.close();fs.rmSync(dir,{recursive:true,force:true});});
  const record={id:'123:1:user',at:Date.now(),user:'456',role:'user',text:'羽毛球比赛约在周五放学后举行',speaker:'小明'};
  store.addEvent('123',record);
  assert.equal(store.fts5,true);
  assert.deepEqual(store.searchEvents(['羽毛球比赛'],{chat:'123'}).map(x=>x.id),['123:1:user']);

  store.updateEvent('123',{...record,text:'网球比赛约在周一放学后举行'});
  assert.equal(store.searchEvents(['羽毛球比赛'],{chat:'123'}).length,0);
  assert.deepEqual(store.searchEvents(['网球比赛'],{chat:'123'}).map(x=>x.id),['123:1:user']);

  store.forget('123','456');
  assert.equal(store.searchEvents(['网球比赛'],{chat:'123'}).length,0);
  assert.equal(store.db.prepare('SELECT COUNT(*) n FROM chat_events_fts').get().n,0);
  assert.equal(store.stats().schemaVersion,4);
});
