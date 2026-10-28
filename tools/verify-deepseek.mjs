import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {readConfig,buildPrompt} from '../bridge.mjs';
import {DeepSeekModel} from '../deepseek.mjs';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..'),original=readConfig();
const full=process.argv.includes('--full'),batchOnly=process.argv.includes('--batch-only'),questions=JSON.parse(fs.readFileSync(path.join(root,'work/tokentest/results.json'),'utf8')).questions;
const selected=full?questions:[questions[2]],rows=[];
const started=Date.now();
const modes=batchOnly?[]:[{id:'deepseek-flash',thinking:false},{id:'deepseek-flash',thinking:true},...(full?[{id:'deepseek-v4-pro',thinking:true}]:[])];
for(const {id,thinking} of modes) {
  const cfg={...original,model:id,llm:{apiBase:'https://api.deepseek.com',model:id,apiKeyEnv:'DEEPSEEK_API_KEY',
    thinking,reasoningEffort:'high',maxTokens:8192,timeoutSeconds:90,supportsImages:true}};
  const model=new DeepSeekModel(cfg,root,buildPrompt),recent=[];
  for(const [index,question] of (id==='deepseek-v4-pro'?[questions[2]]:selected).entries()) {
    const user={id:`probe:${thinking}:${index}:user`,at:Date.now(),role:'user',user:'1000000002',speaker:'本机验收',text:question};
    recent.push(user);
    try {
      const answer=await model.answer(cfg,question,[],{mode:'direct',chatKey:'probe-deepseek',requesterId:'1000000002',requesterName:'本机验收',
        recentMessages:recent,managementContext:{enabled:false},hostIdentity:{ownerUserIds:['1000000002'],requesterIsOwner:true}});
      rows.push({model:id,thinking,index,question,ok:true,text:answer.text,usage:answer.usage,diagnostics:answer.diagnostics,ms:answer.timing.totalMs});
      recent.push({id:`probe:${thinking}:${index}:assistant`,at:Date.now(),role:'assistant',text:answer.text,forUser:'1000000002'});
    }catch(error){rows.push({model:id,thinking,index,question,ok:false,error:error.message,usage:error.usage,diagnostics:error.diagnostics});}
    console.log(JSON.stringify(rows.at(-1)));
  }
}
if(full&&process.env.DFL_PROBE_IMAGE) {
  const cfg={...original,model:'deepseek-flash',llm:{apiBase:'https://api.deepseek.com',model:'deepseek-flash',apiKeyEnv:'DEEPSEEK_API_KEY',thinking:false,supportsImages:true,maxTokens:2048}};
  try {
    const answer=await new DeepSeekModel(cfg,root,buildPrompt).answer(cfg,'描述图片中方块的颜色，只说颜色。',[],
      {mode:'direct',chatKey:'probe-image',images:[{id:'synthetic-red-square',path:process.env.DFL_PROBE_IMAGE}],managementContext:{enabled:false}});
    rows.push({model:'deepseek-flash',vision:true,ok:answer.text.includes('红'),text:answer.text,usage:answer.usage,diagnostics:answer.diagnostics});
  }catch(error){rows.push({model:'deepseek-flash',vision:true,ok:false,error:error.message});}
  console.log(JSON.stringify(rows.at(-1)));
}
if(batchOnly) {
  const cfg={...original,model:'deepseek-flash',llm:{apiBase:'https://api.deepseek.com',model:'deepseek-flash',apiKeyEnv:'DEEPSEEK_API_KEY',thinking:true,maxTokens:8192}};
  const recent=[{id:'old-1',role:'user',user:'1000000002',text:'我给猫取名叫土豆。'},
    {id:'old-2',role:'assistant',text:'这个名字挺合适。'},
    {id:'new-1',role:'user',user:'1000000002',text:'刚才说猫叫什么？'},
    {id:'new-2',role:'user',user:'1000000002',text:'顺便告诉我这个名字的英文。'}];
  try {
    const answer=await new DeepSeekModel(cfg,root,buildPrompt).answer(cfg,'刚才说猫叫什么？\n顺便告诉我这个名字的英文。',[],
      {mode:'direct',chatKey:'probe-batch',requesterId:'1000000002',recentMessages:recent,batchSourceIds:['new-1','new-2'],managementContext:{enabled:false}});
    rows.push({model:'deepseek-flash',batch:true,ok:answer.text.includes('土豆')&&/potato/i.test(answer.text),text:answer.text,usage:answer.usage,diagnostics:answer.diagnostics});
  }catch(error){rows.push({batch:true,ok:false,error:error.message});}
  console.log(JSON.stringify(rows.at(-1)));
}
const target=path.join(root,'work/deepseek-social');fs.mkdirSync(target,{recursive:true});
fs.writeFileSync(path.join(target,full?'live-full.json':batchOnly?'live-batch.json':'live-smoke.json'),JSON.stringify({at:new Date().toISOString(),durationMs:Date.now()-started,qqMessagesSent:0,rows},null,2));
if(rows.some(row=>!row.ok))process.exitCode=1;
