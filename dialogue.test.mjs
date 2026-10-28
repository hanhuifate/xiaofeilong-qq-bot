import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {ChatMemory} from './memory.mjs';
import {SpeechRecognizer} from './speech.mjs';
import {hostIdentity,dialogueContext} from './dialogue.mjs';

test('identity is separate from moderation and archive anchors do not depend on the recent window',t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'dfl-dialogue-'));
  const memory=new ChatMemory({memory:{enabled:true}},{file:path.join(dir,'legacy'),database:path.join(dir,'bot.sqlite3')});
  t.after(()=>{memory.close();fs.rmSync(dir,{recursive:true,force:true});});
  const chat='private:1000000002',actor='1000000002';
  memory.add(chat,{id:chat+':image:1',role:'user',user:actor,text:'图片说明',at:1});
  memory.add(chat,{id:chat+':1:user',role:'user',user:actor,text:'你的主人是谁',at:2});
  memory.add(chat,{id:chat+':2:assistant',role:'assistant',forUser:actor,text:'应该确认当前配置',at:3});
  memory.add(chat,{id:chat+':3:user',role:'user',user:actor,text:'那现在知道了吗',at:4});
  memory.add(chat,{id:chat+':4:assistant',role:'assistant',forUser:actor,text:'知道',at:5});
  const focus=dialogueContext(memory,chat,memory.recent(chat,2),{user_id:actor,_quote:{id:'3',user:actor,text:'那现在知道了吗'}});
  assert.equal(focus.firstRecordedUserMessage.text,'你的主人是谁');
  assert.deepEqual(focus.quotedExchange.slice(1).map(x=>x.text),['你的主人是谁','应该确认当前配置','那现在知道了吗','知道']);
  assert.equal(hostIdentity('1000000001',[actor],actor).requesterIsOwner,true);
  assert.equal(hostIdentity('1000000001',[actor],'99999').requesterIsOwner,false);
  assert.equal(memory.firstUserMessage('private:99999',actor),null);
  memory.forget(chat,actor);assert.equal(memory.firstUserMessage(chat,actor),null);
});

test('text quoting retains source and nested reply links even with speech disabled',async()=>{
  const cfg={botQQ:'1000000001',speech:{enabled:false}};
  const recognizer=new SpeechRecognizer(cfg,{call:async()=>({message_type:'group',group_id:12345,time:100,
    user_id:1000000002,sender:{user_id:1000000002,nickname:'测试用户'},
    message:[{type:'reply',data:{id:'9'}},{type:'text',data:{text:'那现在知道了吗'}}]})});
  const result=await recognizer.prepare({message_type:'group',group_id:12345,user_id:1000000002,
    message:[{type:'reply',data:{id:'10'}},{type:'text',data:{text:'是哪个问题的答案'}}]});
  assert.equal(result._quote.id,'10');assert.equal(result._quote.user,'1000000002');
  assert.equal(result._quote.replyToMessage,'9');assert.equal(result._quote.at,100000);
  assert.equal(result._quote.text,'那现在知道了吗');
  const foreign=await recognizer.prepare({message_type:'group',group_id:54321,user_id:1000000002,
    message:[{type:'reply',data:{id:'10'}},{type:'text',data:{text:'引用'}}]});
  assert.equal(foreign._quote,null);assert.equal(foreign._quotedUser,'');
});
