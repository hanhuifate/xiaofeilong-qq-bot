import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { startViewer } from './viewer.mjs';

test('panel chat settings persist allowed frequencies and reject invalid values',async t=>{
  const temp=fs.mkdtempSync(path.join(os.tmpdir(),'qq-settings-')),values=new Map();
  const store={setting:(chat,key,...value)=>{const id=chat+':'+key;if(value.length)values.set(id,structuredClone(value[0]));return structuredClone(values.get(id));},audit(){}};
  const server=await startViewer(temp,{state:{sessions:{}}},{store},0,null,{bot:{cfg:{social:{proactiveCooldownSeconds:18}}}});
  t.after(()=>{server.close();fs.rmSync(temp,{recursive:true,force:true});});
  const base=`http://127.0.0.1:${server.address().port}`,headers={Authorization:'Bearer '+fs.readFileSync(path.join(temp,'data/viewer-token.txt'),'utf8').trim(),'Content-Type':'application/json'};
  const saved=await fetch(base+'/api/settings',{method:'POST',headers,body:JSON.stringify({chat:'global',proactiveCooldownSeconds:25,maxProactivePerHour:30,evaluationIntervalSeconds:15,minIntervalSeconds:15,avatarRecognitionEnabled:false})});
  assert.equal(saved.status,200);
  const settings=await(await fetch(base+'/api/settings?chat=global',{headers})).json();
  assert.equal(settings.social.proactiveCooldownSeconds,25);assert.equal(settings.social.avatarRecognitionEnabled,false);assert.equal(settings.defaults.proactiveCooldownSeconds,18);
  assert.equal((await fetch(base+'/api/settings',{method:'POST',headers,body:JSON.stringify({chat:'global',proactiveCooldownSeconds:0})})).status,400);
  assert.equal(values.get('global:social').proactiveCooldownSeconds,25);
});
test('viewer requires its own token, rejects foreign Host and restricts records to selected chat', async t => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-viewer-'));
  const sessions = { state: { sessions: { '123': { threadId: 'abc', lastUsedAt: new Date().toISOString(), lastCachePercent: 95 } } } };
  const memory = { records: [{ chat: '123', text: '<script>unsafe()</script>', role: 'user' }, { chat: 'private:456', text: '私聊内容' }] };
  const server = await startViewer(temp, sessions, memory, 0);
  t.after(() => { server.close(); fs.rmSync(temp, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const token = fs.readFileSync(path.join(temp, 'data', 'viewer-token.txt'), 'utf8');
  assert.equal((await fetch(base + '/api/sessions')).status, 401);
  const headers = { Authorization: `Bearer ${token}` };
  const list = await (await fetch(base + '/api/sessions', { headers })).json();
  assert.equal(list[0].lastCachePercent, 95); assert.equal(JSON.stringify(list).includes(token), false);
  const foreign = await new Promise((resolve, reject) => {
    const request = http.get(base + '/api/sessions', { headers: { ...headers, Host: 'attacker.example' } }, response => {
      response.resume(); resolve(response.statusCode);
    }); request.on('error', reject);
  });
  assert.equal(foreign, 403);
  const rows = await (await fetch(base + '/api/messages?chat=123', { headers })).json();
  assert.equal(rows.length, 1); assert.equal(rows[0].text, '<script>unsafe()</script>');
  assert.equal((await fetch(base + '/api/messages?chat=123', { method: 'POST', headers })).status, 403);
  assert.equal((await fetch(base + '/config.json', { headers })).status, 404);
});

test('memory evidence is scoped and rollback requires the exact memory id', async t => {
  const temp=fs.mkdtempSync(path.join(os.tmpdir(),'qq-evidence-')),id='a'.repeat(64),calls=[];
  const store={
    feedbackCandidates:chat=>[{id:'e1',chat,text:'更喜欢网球',status:'adopted',strength:'strong',user:'456',source_id:'m2',target_id:'bot1'}],
    memoryRevisions:chat=>[{id:'r1',chat,memory_id:id,reverted_at:0,before_data:{text:'喜欢羽毛球'},after_data:{text:'更喜欢网球'}}],
    rollbackMemory:(chat,memoryId,actor)=>{calls.push({chat,memoryId,actor});return {rolledBack:true,restored:true};},
    audit(){}
  };
  const server=await startViewer(temp,{state:{sessions:{}}},{store},0,null,{});
  t.after(()=>{server.close();fs.rmSync(temp,{recursive:true,force:true});});
  const base=`http://127.0.0.1:${server.address().port}`,token=fs.readFileSync(path.join(temp,'data/viewer-token.txt'),'utf8').trim(),
    headers={Authorization:'Bearer '+token,'Content-Type':'application/json'};
  const evidence=await(await fetch(base+'/api/memory-evidence?chat=123',{headers})).json();
  assert.equal(evidence.candidates[0].source_id,'m2');
  assert.equal((await fetch(base+'/api/memory-rollback',{method:'POST',headers,body:JSON.stringify({chat:'123',memoryId:id,confirm:'wrong'})})).status,400);
  assert.equal(calls.length,0);
  const rolled=await(await fetch(base+'/api/memory-rollback',{method:'POST',headers,body:JSON.stringify({chat:'123',memoryId:id,confirm:id})})).json();
  assert.equal(rolled.restored,true);assert.deepEqual(calls[0],{chat:'123',memoryId:id,actor:'local-panel'});
});
