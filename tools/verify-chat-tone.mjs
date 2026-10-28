// Explicit real-model check, isolated from QQ delivery and persistent threads.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {fileURLToPath} from 'node:url';
import {readConfig,buildPrompt} from '../bridge.mjs';
import {CodexSessions} from '../sessions.mjs';
import {ChatMemory} from '../memory.mjs';
import {UsageBudget} from '../budget.mjs';
import {hostIdentity,dialogueContext} from '../dialogue.mjs';
if(!process.argv.includes('--live'))throw Error('需要 --live；检查消耗真实模型额度，不向QQ发消息。');
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..'),cfg=readConfig(),chat='200000003';
cfg.timeoutSeconds=45;
const memory=new ChatMemory(cfg),recent=memory.recent(chat,35);
const settings=JSON.parse(fs.readFileSync(path.join(root,'data/moderation-settings.json'),'utf8').replace(/^\uFEFF/,''));
const temp=fs.mkdtempSync(path.join(os.tmpdir(),'dfl-tone-'));
const client=new CodexSessions(cfg,root,buildPrompt,{file:path.join(temp,'index.json')});
const store=Object.create(memory.store);store.recoverReservations=()=>{};
const budget=new UsageBudget(cfg,store),answer=budget.wrap(client.answer.bind(client));
const report={at:new Date().toISOString(),model:cfg.model,effort:cfg.reasoningEffort,qqMessagesSent:0,results:[]};
try {
  await client.connect();
  for(const [i,question] of ['你是奶龙','不是','gpt说话这么理性'].entries()) {
    if(process.argv.includes('--one')&&i>0)break;
    const result=await client.rpc('thread/start',{...client.threadOptions(),ephemeral:true});
    const key='probe-tone-'+i;client.state.sessions[key]={threadId:result.thread.id,turns:0,model:cfg.model};client.loaded.add(result.thread.id);
    const user=i===1?'1000000003':'1000000002';
    const matching=recent.findLastIndex(x=>x.role==='user'&&x.text.split('\n')[0].trim()===question);
    const contextMessages=matching>=0?recent.slice(0,matching+1):[...recent,{id:'probe:'+i,role:'user',user,text:question,at:Date.now()}];
    const started=Date.now(),response=await answer(cfg,question,[],{mode:i===1?'ambient':'direct',chatKey:key,requesterId:user,
      recentMessages:contextMessages,hostIdentity:hostIdentity(cfg.botQQ,settings.owners,user),
      dialogueContext:dialogueContext(memory,chat,contextMessages,{user_id:user}),
      conversationAudience:{kind:i===1?'group':'bot',participants:[],reason:'tone_acceptance'},
      activeGroup:true,memorySearched:true,forceProbe:true});
    if(response.budgetBlocked||response.providerUnavailable)throw Error('MODEL_OR_BUDGET_UNAVAILABLE');
    report.results.push({question,shouldReply:response.shouldReply,text:response.text,chars:Array.from(response.text||'').length,ms:Date.now()-started,usage:response.usage});
    console.log(JSON.stringify(report.results.at(-1)));
  }
}finally{
  fs.writeFileSync(path.join(root,'data','chat-tone-acceptance.json'),JSON.stringify(report,null,2));
  client.close();memory.close();fs.rmSync(temp,{recursive:true,force:true,maxRetries:3,retryDelay:100});
}
