import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {readConfig,buildPrompt} from '../bridge.mjs';
import {CodexSessions} from '../sessions.mjs';
import {createApiModel} from '../deepseek.mjs';
import {hostIdentity,dialogueContext} from '../dialogue.mjs';
import {ChatMemory} from '../memory.mjs';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const outputDir=path.resolve(root,process.env.DFL_TOKEN_OUTPUT||'work/tokentest');
const runId=new Date().toISOString().replace(/[:.]/g,'-');
fs.mkdirSync(outputDir,{recursive:true});
const questions=[
  '请用一句话解释为什么晴朗的天空通常呈蓝色。',
  '候选人的三项成绩是82、91、76，权重依次为0.4、0.4、0.2。计算加权总分，只给结果和一步算式。',
  'Python 中 items=[1,2,3]，执行 items.append(items) 后，len(items) 和 items[3] is items 分别是什么？',
  '比较 SQLite 全文检索和向量检索，在小型单机聊天机器人中的适用场景。用三点回答。',
  '设计一个最小测试，验证 Codex 持久会话不会在下一轮重复注入已经提交的旧消息。列出步骤和关键断言。'
];
const requester={id:'1000000002',name:'tokentest'};
const now=()=>new Date();
const stamp=()=>now().toISOString();
const num=value=>Number.isFinite(value)?value:0;
const totals=rows=>rows.reduce((sum,row)=>({
  input_tokens:sum.input_tokens+num(row.usage?.input_tokens),
  cached_input_tokens:sum.cached_input_tokens+num(row.usage?.cached_input_tokens),
  output_tokens:sum.output_tokens+num(row.usage?.output_tokens),
  reasoning_output_tokens:sum.reasoning_output_tokens+num(row.usage?.reasoning_output_tokens),
  model_ms:sum.model_ms+num(row.ms)
}),{input_tokens:0,cached_input_tokens:0,output_tokens:0,reasoning_output_tokens:0,model_ms:0});

function priceLuna(usage) {
  const input=num(usage.input_tokens),cached=Math.min(input,num(usage.cached_input_tokens)),output=num(usage.output_tokens);
  return ((input-cached)*0.10+cached*0.01+output*0.50)/1_000_000;
}
function deepseekPrices() {
  const at=now(),utcHour=at.getUTCHours(),day=at.getUTCDay();
  const peak=day>=1&&day<=5&&((utcHour>=1&&utcHour<4)||(utcHour>=6&&utcHour<10));
  return {peak,flash:peak?{hit:0.006,miss:0.30,output:1.20}:{hit:0.003,miss:0.15,output:0.60},
    pro:peak?{hit:0.044,miss:1.32,output:3.96}:{hit:0.022,miss:0.66,output:1.98}};
}
function priceDeepSeek(usage,prices) {
  const input=num(usage.input_tokens),cached=Math.min(input,num(usage.cached_input_tokens)),output=num(usage.output_tokens);
  return ((input-cached)*prices.miss+cached*prices.hit+output*prices.output)/1_000_000;
}

async function runCodex(cfg,effort) {
  const local={...cfg,reasoningEffort:effort};
  const sessions=new CodexSessions(local,root,buildPrompt,{
    file:path.join(outputDir,`codex-${effort}-${runId}-sessions.json`),
    threadName:()=>`tokentest · codex ${effort}`
  });
  const chat=`probe-tokentest-codex-${effort}`,recent=[],rows=[];
  const memory=new ChatMemory({memory:{enabled:false}});
  try {
    for(const [index,question] of questions.entries()) {
      const started=Date.now(),id=`${chat}:q${index+1}`,at=Date.now();
      recent.push({id,role:'user',user:requester.id,speaker:requester.name,text:question,at});
      const event={user_id:Number(requester.id),_quote:null};
      const context={mode:'direct',chatKey:chat,requesterId:requester.id,requesterName:requester.name,
        recentMessages:recent,hostIdentity:hostIdentity(local.botQQ,[requester.id],requester.id),
        dialogueContext:dialogueContext(memory,chat,recent,event),managementContext:{enabled:false},
        webSearchAllowed:false,browserAllowed:false,doubaoImageAllowed:false};
      const result=await sessions.answer(local,question,[],context);
      recent.push({id:`${chat}:a${index+1}`,role:'assistant',forUser:requester.id,text:result.text||'',at:Date.now()});
      rows.push({index:index+1,question,ok:!!result.text,text:result.text||'',threadId:result.threadId,
        usage:result.usage||{},ms:Date.now()-started});
      fs.writeFileSync(path.join(outputDir,`codex-${effort}-progress.json`),JSON.stringify({model:local.model,effort,rows},null,2));
      console.error(`codex-${effort}: ${index+1}/${questions.length}`);
    }
    return {backend:'codex-app-server',model:local.model,effort,rows};
  } finally {sessions.close();memory.close();}
}

async function runDeepSeek(cfg,model,maxTokens=3000,thinking=true) {
  const local={...cfg,model,reasoningEffort:'high',llm:{type:'openai_compatible',apiBase:'https://api.deepseek.com',
    model,apiKeyEnv:'DEEPSEEK_API_KEY',supportsImages:false,maxTokens,timeoutSeconds:180,
    thinking,reasoningEffort:thinking?'high':undefined}};
  const memory=new ChatMemory({memory:{enabled:false}}),client=createApiModel(local,root,buildPrompt);
  const chat=`probe-tokentest-${model}`,recent=[],history=[],rows=[];
  try {
    for(const [index,question] of questions.entries()) {
      const started=Date.now(),at=Date.now();
      recent.push({id:`${chat}:q${index+1}`,role:'user',user:requester.id,speaker:requester.name,text:question,at});
      const context={mode:'direct',chatKey:chat,requesterId:requester.id,requesterName:requester.name,
        recentMessages:recent,hostIdentity:hostIdentity(local.botQQ,[requester.id],requester.id),
        dialogueContext:dialogueContext(memory,chat,recent,{user_id:Number(requester.id),_quote:null}),
        managementContext:{enabled:false},webSearchAllowed:false,browserAllowed:false,doubaoImageAllowed:false};
      let result;
      try { result=await client.answer(local,question,history,context); }
      catch(error) {
        rows.push({index:index+1,question,ok:false,error:error.message,usage:error.usage||{},
          reportedModel:error.reportedModel,finishReason:error.finishReason,responsePreview:error.responsePreview,ms:Date.now()-started});
        fs.writeFileSync(path.join(outputDir,`${model}-progress.json`),JSON.stringify({model,thinking,rows},null,2));
        console.error(`${model}: ${index+1}/${questions.length} failed (${error.message}); usage retained`);
        continue;
      }
      const text=result.text||'';
      history.push({role:'user',content:question},{role:'assistant',content:text});
      recent.push({id:`${chat}:a${index+1}`,role:'assistant',forUser:requester.id,text,at:Date.now()});
      rows.push({index:index+1,question,ok:!!text,text,usage:result.usage||{},reportedModel:result.reportedModel,ms:Date.now()-started});
      fs.writeFileSync(path.join(outputDir,`${model}-progress.json`),JSON.stringify({model,thinking,rows},null,2));
      console.error(`${model}: ${index+1}/${questions.length}`);
    }
    return {backend:'openai-compatible-api',model,effort:thinking?'thinking/high':'non-thinking',rows,
      successfulQuestions:rows.filter(row=>row.ok).length,failedQuestions:rows.filter(row=>!row.ok).length};
  } finally {memory.close();}
}

const cfg=readConfig(),runs=[],errors=[],only=String(process.env.DFL_TOKEN_ONLY||''),
  deepseekMaxTokens=Number(process.env.DFL_DEEPSEEK_MAX_TOKENS)||3000,
  deepseekThinking=process.env.DFL_DEEPSEEK_THINKING!=='false';
for(const effort of ['low','medium','high','xhigh']) {
  if(only&&only!==`codex-${effort}`)continue;
  try{const run=await runCodex(cfg,effort);run.usage=totals(run.rows);run.priceUsd=priceLuna(run.usage);runs.push(run);}
  catch(error){errors.push({backend:'codex',effort,error:error.message});}
}
for(const model of ['deepseek-flash','deepseek-v4-pro']) {
  if(only&&only!==model)continue;
  try{const run=await runDeepSeek(cfg,model,deepseekMaxTokens,deepseekThinking);run.usage=totals(run.rows);runs.push(run);}
  catch(error){errors.push({backend:'deepseek',model,error:error.message,
    contentLength:error.contentLength,finishReason:error.finishReason,responsePreview:error.responsePreview,
    rows:error.rows,usage:totals(error.rows||[])});}
}
const dsPrices=deepseekPrices();
for(const run of runs) {
  if(run.backend==='openai-compatible-api')run.priceUsd=priceDeepSeek(run.usage,run.model==='deepseek-v4-pro'?dsPrices.pro:dsPrices.flash);
}
let previous={runs:[],errors:[]};
try{previous=JSON.parse(fs.readFileSync(path.join(outputDir,'results.json'),'utf8'));}catch{}
const runKey=run=>`${run.backend}:${run.model}:${run.effort}`;
const merged=new Map((previous.runs||[]).map(run=>[runKey(run),run]));
for(const run of runs)merged.set(runKey(run),run);
const mergedErrors=[...(previous.errors||[]),...errors].filter(error=>!runs.some(run=>
  run.backend===error.backend&&(error.model?run.model===error.model:run.effort===error.effort)));
const report={createdAt:stamp(),model:cfg.model,codexPriceUsdPerMillion:{input:0.10,cachedInput:0.01,output:0.50},
  deepseekPricing:dsPrices,questions,contextPolicy:{codex:'fresh persistent thread per effort; newMessages delta after bootstrap',
    deepseek:'fresh history per model; history embedded in prompt JSON with current conversation data; no persistent server Thread'},
  runs:[...merged.values()],errors:mergedErrors,notes:['reasoning_output_tokens is included in output_tokens and is not charged twice',
    'API list prices are used; this is not a ChatGPT/Codex subscription quota conversion']};
fs.writeFileSync(path.join(outputDir,'results.json'),JSON.stringify(report,null,2));
console.log(JSON.stringify(report,null,2));
