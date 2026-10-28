// Opt-in real model acceptance. Uses the owner's existing local records,
// an ephemeral model thread, and no QQ send/management API whatsoever.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';
import {readConfig,buildPrompt} from '../bridge.mjs';
import {CodexSessions} from '../sessions.mjs';
import {ChatMemory} from '../memory.mjs';
import {UsageBudget} from '../budget.mjs';
import {hostIdentity,dialogueContext} from '../dialogue.mjs';

if(!process.argv.includes('--live'))throw Error('请显式添加 --live；该验收会消耗真实模型额度，不向QQ发信。');
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..'),cfg=readConfig();
const owner=String(JSON.parse(fs.readFileSync(path.join(root,'data','moderation-settings.json'),'utf8')).owners[0]||'');
if(!/^\d{5,12}$/.test(owner))throw Error('OWNER_REQUIRED');
const chat='private:'+owner,memory=new ChatMemory(cfg),records=memory.recent(chat,200);
const firstQuestionIndex=records.findIndex(m=>m.role==='user'&&m.text==='你好，你是谁，我们说的第一句话是什么');
const recent=(firstQuestionIndex>=0?records.slice(0,firstQuestionIndex):records).map(x=>({...x}));
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'dfl-live-social-'));
const client=new CodexSessions(cfg,root,buildPrompt,{file:path.join(dir,'probe.json')});
// Preserve reservations owned by the live reply process.
const probeStore=Object.create(memory.store);probeStore.recoverReservations=()=>{};
const budget=new UsageBudget(cfg,probeStore),answer=budget.wrap(client.answer.bind(client));
const report={at:new Date().toISOString(),model:cfg.model,reasoning:cfg.reasoningEffort,ephemeral:true,qqMessagesSent:0,results:[]};
try {
  await client.connect();
  const options=client.threadOptions();
  assert.equal(options.config.developer_instructions,options.developerInstructions);
  assert.ok(options.developerInstructions.includes(cfg.persona.style));
  let started,baseline;
  if(process.argv.includes('--fork-current')) {
    const index=JSON.parse(fs.readFileSync(path.join(root,'data','codex-sessions.json'),'utf8'));
    const previous=index.sessions[chat]?.threadId;if(!previous)throw Error('CURRENT_OWNER_THREAD_MISSING');
    started=await client.rpc('thread/fork',{...options,threadId:previous,ephemeral:true,excludeTurns:true});
    baseline=index.sessions[chat]?.threadTotals;
    report.forkedExistingThread=true;
  } else started=await client.rpc('thread/start',{...options,ephemeral:true});
  const key='probe-social';client.state.sessions[key]={threadId:started.thread.id,turns:0,model:cfg.model,...(baseline?{threadTotals:baseline}:{})};client.loaded.add(started.thread.id);
  for(const [i,question] of ['你好，你是谁，我们说的第一句话是什么','那现在知道了吗','是哪个问题的答案','你的主人是谁'].entries()) {
    const at=Date.now(),id=chat+':live-probe-'+i+':user';
    const quote=i===2?{id:'live-probe-1',user:owner,speaker:records.find(x=>x.user===owner)?.speaker||'',text:'那现在知道了吗',at:recent.at(-2)?.at}:null;
    const event={user_id:owner,_quote:quote};
    recent.push({id,role:'user',user:owner,speaker:records.find(x=>x.user===owner)?.speaker||owner,text:question,at,...(quote?{quote}:{})});
    const dialogue=dialogueContext(memory,chat,recent,event);
    if(quote)dialogue.quotedExchange=recent.slice(-7);
    const context={mode:'direct',chatKey:key,requesterId:owner,requesterName:recent.at(-1).speaker,recentMessages:recent,
      hostIdentity:hostIdentity(cfg.botQQ,[owner],owner),dialogueContext:dialogue,memorySearched:true,
      managementContext:{enabled:false},forceProbe:true};
    const result=await answer(cfg,question,[],context);
    if(result.providerUnavailable||result.budgetBlocked)throw Error('MODEL_OR_BUDGET_UNAVAILABLE');
    report.results.push({question,text:result.text,ms:Date.now()-at,usage:result.usage});
    console.log(JSON.stringify(report.results.at(-1)));
    recent.push({id:chat+':live-probe-'+i+':assistant',role:'assistant',forUser:owner,speaker:cfg.persona.name,text:result.text,at:Date.now()});
  }
  assert.ok(report.results[0].text.includes(memory.firstUserMessage(chat,owner).text));
  assert.match(report.results.at(-1).text,/主人/);assert.doesNotMatch(report.results.at(-1).text,/没有主人|没主人/);
  assert.ok(report.results.at(-1).text.includes(owner)||/你|测试用户/.test(report.results.at(-1).text));
  assert.doesNotMatch(report.results[2].text,/咕咕嘎嘎/);
  report.passed=true;
}catch(error){report.passed=false;report.error=error.message;throw error;}
finally{
  fs.writeFileSync(path.join(root,'data','social-live-acceptance.json'),JSON.stringify(report,null,2));
  client.close();memory.close();fs.rmSync(dir,{recursive:true,force:true,maxRetries:3,retryDelay:100});
}
