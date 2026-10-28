import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { ModerationService } from './moderation.mjs';
import { GroupBot } from './bridge.mjs';
const root=path.dirname(fileURLToPath(import.meta.url));
const event=(user='111',text='禁言222',id=1,mention=true)=>({post_type:'message',message_type:'group',self_id:1000000001,
  group_id:123,user_id:Number(user),message_id:id,message:[...(mention?[{type:'at',data:{qq:'1000000001'}}]:[]),{type:'text',data:{text}}]});
function fixture(t) {
  const temp=fs.mkdtempSync(path.join(os.tmpdir(),'dfl-moderation-'));
  const cfg={botQQ:'1000000001',groups:['123'],allChats:true,moderation:{enabled:true},maxQuestionChars:6000,
    maxReplyChars:3000,maxQueue:20,cooldownSeconds:0,historyTurns:2,historyTtlMinutes:30,persona:{name:'大肥龙'},
    social:{enabled:true,directDebounceMs:0},media:{enabled:false},speech:{enabled:false},memory:{enabled:false}};
  const calls=[];
  const api={call:async(action,params)=>{
    calls.push({action,params});
    if(action==='get_login_info')return {user_id:1000000001};
    if(action==='get_group_list')return [];
    if(action==='get_group_member_info')return {role:[111,1000000001].includes(Number(params.user_id))?'admin':'member'};
    if(action==='get_group_member_list')return [{user_id:111,nickname:'管理员',role:'admin'},{user_id:222,nickname:'群友',role:'member'}];
    return {message_id:100+calls.length};
  }};
  const service=new ModerationService(cfg,api,root,{database:path.join(temp,'db.sqlite3'),settingsFile:path.join(temp,'settings.json')});
  t.after(async()=>{const proc=service.proc;service.close();if(proc&&proc.exitCode===null)await once(proc,'exit');fs.rmSync(temp,{recursive:true,force:true,maxRetries:3,retryDelay:80});});
  return {cfg,api,calls,service};
}
const proposal={operation:'propose',kind:'mute',targetUser:'222',messageId:'',duration:600,content:'',requestKey:'',approve:false};

test('real Python worker validates proposal and allows only original admin confirmation once',async t=>{
  const {service,calls}=fixture(t);
  const result=await service.decision(event(),proposal);
  assert.match(result.text,/确认/);
  assert.equal(calls.filter(x=>x.action==='set_group_ban').length,0);
  assert.equal(service.hasPending(event()),true);
  await service.decision(event('222'),{operation:'confirm'});
  assert.equal(calls.filter(x=>x.action==='set_group_ban').length,0);
  await service.decision(event(),{operation:'confirm'});
  await service.decision(event(),{operation:'confirm'});
  assert.equal(calls.filter(x=>x.action==='set_group_ban').length,1);
  assert.equal(service.hasPending(event()),false);
});

test('normal group member cannot create an actionable proposal',async t=>{
  const {service,calls}=fixture(t);
  const result=await service.decision(event('222'),proposal);
  assert.match(result.text,/管理员/);
  assert.equal(calls.filter(x=>x.action==='set_group_ban').length,0);
});

test('replying 对 without another mention reaches the actual group moderation pipeline',async t=>{
  const {cfg,api,calls,service}=fixture(t);
  const bot=new GroupBot(cfg,api,async(c,q,h,x)=>({shouldReply:true,text:'',management:x.managementContext.pending?{operation:'confirm'}:proposal}),()=>{},{moderation:service});
  try {
    await bot.verify();
    await bot.receive(event());
    assert.equal(calls.filter(x=>x.action==='set_group_ban').length,0);
    await bot.receive(event('111','对',2,false));
    assert.equal(calls.filter(x=>x.action==='set_group_ban').length,1);
  }finally{bot.disconnect();}
});

test('emergency disable blocks dispatch and can be changed without restarting',async t=>{
  const {service,calls}=fixture(t);
  await service.decision(event(),proposal);
  fs.writeFileSync(service.settingsFile,JSON.stringify({enabled:false}));
  const result=await service.decision(event(),{operation:'confirm'});
  assert.match(result.text,/关闭/);
  assert.equal(calls.filter(x=>x.action==='set_group_ban').length,0);
});

test('ordinary speaker still receives the bots real owner role and same-group member context',async t=>{
  const {service,api}=fixture(t);
  const original=api.call;
  api.call=async(action,params)=>action==='get_group_member_info'
    ?{role:Number(params.user_id)===1000000001?'owner':'member'}
    :action==='get_group_member_list'?[{user_id:1000000001,role:'owner',nickname:'大肥龙'},{user_id:222,role:'member',nickname:'小明'}]
    :original(action,params);
  const context=await service.context(event('222'));
  assert.equal(context.administrator,false);
  assert.equal(context.botRole,'owner');
  assert.equal(context.soleAdministrator,true);
  assert.equal(context.members.length,2);
  assert.ok(context.supportedActions.includes('kick'));
});

test('kick is authorized and confirmed once, never blocks rejoining automatically',async t=>{
  const {service,calls}=fixture(t);
  await service.decision(event(),{...proposal,kind:'kick'});
  assert.equal(calls.filter(x=>x.action==='set_group_kick').length,0);
  await service.decision(event(),{operation:'confirm'});
  const sent=calls.filter(x=>x.action==='set_group_kick');
  assert.equal(sent.length,1);
  assert.equal(sent[0].params.user_id,222);
  assert.equal(sent[0].params.reject_add_request,false);
});
