import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {accountStatus,inspectAccountChange,configureAccount} from './accounts.mjs';

function fixture(t){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'dfl-accounts-')),dir=path.join(root,'runtime','napcat','config');fs.mkdirSync(dir,{recursive:true});
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const write=(file,v)=>fs.writeFileSync(path.join(root,file),JSON.stringify(v));
  write('config.json',{botQQ:'111111',model:'unchanged',reasoningEffort:'high',onebotUrl:'ws://127.0.0.1:3001',onebotToken:'local-test-secret',moderation:{owners:['333333']}});
  write('runtime/napcat/config/napcat.json',{bypass:{hook:true},autoTimeSync:true});
  write('runtime/napcat/config/napcat_111111.json',{autoTimeSync:true});
  write('runtime/napcat/config/onebot11_111111.json',{network:{websocketServers:[{host:'127.0.0.1',port:3001,token:'local-test-secret',enable:true}]},parseMultMsg:true});
  write('runtime/napcat/config/napcat_protocol_111111.json',{mustNotClone:'device-identity'});
  return {root,write,read:file=>JSON.parse(fs.readFileSync(path.join(root,file),'utf8'))};
}
test('switch account prepares loopback transport, preserves bot data/settings, and never clones device/login data',t=>{
  const f=fixture(t);fs.mkdirSync(path.join(f.root,'data'));fs.writeFileSync(path.join(f.root,'data','retained-memory'),'keep');
  assert.deepEqual(inspectAccountChange(f.root,'222222','111111'),{oldQQ:'111111',botQQ:'222222',changed:true});
  const changed=configureAccount(f.root,'222222','111111');assert.equal(changed.changed,true);
  assert.equal(f.read('config.json').botQQ,'222222');assert.equal(f.read('config.json').reasoningEffort,'high');
  assert.deepEqual(f.read('config.json').moderation.owners,['333333']);
  const server=f.read('runtime/napcat/config/onebot11_222222.json').network.websocketServers[0];
  assert.equal(server.host,'127.0.0.1');assert.equal(server.port,3001);assert.equal(server.token,'local-test-secret');
  assert.equal(fs.existsSync(path.join(f.root,'runtime/napcat/config/napcat_protocol_222222.json')),false);
  assert.equal(fs.readFileSync(path.join(f.root,'data','retained-memory'),'utf8'),'keep');
  assert.equal(f.read(changed.backup+'/config.json').botQQ,'111111');
  assert.deepEqual(accountStatus(f.root).configuredAccounts.sort(),['111111','222222']);
  assert.ok(!JSON.stringify(changed).includes('local-test-secret'));
});
test('invalid/stale changes are rejected without modifying current configuration and existing target settings survive',t=>{
  const f=fixture(t),original=fs.readFileSync(path.join(f.root,'config.json'),'utf8');
  for(const target of ['../../123456','1234','012345','123456;echo bad'])assert.throws(()=>configureAccount(f.root,target,'111111'));
  assert.throws(()=>configureAccount(f.root,'222222','999999'),/其他窗口/);
  assert.equal(fs.readFileSync(path.join(f.root,'config.json'),'utf8'),original);
  f.write('runtime/napcat/config/napcat_222222.json',{custom:'preserve'});
  f.write('runtime/napcat/config/onebot11_222222.json',{network:{websocketServers:[{port:3001,token:'old'}]},custom:'preserve'});
  configureAccount(f.root,'222222','111111');assert.equal(f.read('runtime/napcat/config/napcat_222222.json').custom,'preserve');
  assert.equal(f.read('runtime/napcat/config/onebot11_222222.json').custom,'preserve');
  assert.equal(configureAccount(f.root,'222222','222222').changed,false);
});
