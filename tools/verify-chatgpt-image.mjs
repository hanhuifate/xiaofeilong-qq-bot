import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomUUID} from 'node:crypto';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const file=path.join(root,'work','chatgpt-image-verification.json');
const prompt='生成一张正方形动漫插画：成年白发龙角少女坐在书桌前，手持蓝色水晶，窗外是夜景。画面不含文字。';
let state;try{state=JSON.parse(fs.readFileSync(file,'utf8'));}catch{}
if(!state||process.argv.includes('--fresh')){state={requestId:randomUUID(),prompt,createdAt:new Date().toISOString()};fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,JSON.stringify(state,null,2));}
const save=()=>fs.writeFileSync(file,JSON.stringify(state,null,2));
const token=fs.readFileSync(path.join(root,'data','viewer-token.txt'),'utf8').trim();
if(!state.jobId){
  const response=await fetch('http://127.0.0.1:6098/api/image-generation',{method:'POST',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},body:JSON.stringify({action:'test',prompt:state.prompt,requestId:state.requestId}),signal:AbortSignal.timeout(15000)});
  const data=await response.json();if(!response.ok)throw Error(data.error||'CHATGPT_TEST_NOT_READY');state.jobId=data.jobId;save();
}
console.log(JSON.stringify({jobId:state.jobId,status:'observing_same_job',note:'one ordinary ChatGPT image; no QQ message is sent'}));
let last='';const deadline=Date.now()+35*60000;
while(Date.now()<deadline){
  const jobs=JSON.parse(fs.readFileSync(path.join(root,'data','chatgpt-image-jobs.json'),'utf8')),j=jobs[state.jobId];
  if(j?.status!==last){last=j?.status;console.log(JSON.stringify({jobId:state.jobId,status:last,groupStatus:j?.groupStatus}));}
  if(j?.status==='completed'){
    const image=j.images?.[0];if(!image||!fs.existsSync(image))throw Error('COMPLETED_WITHOUT_IMAGE');
    state={...state,status:'completed',image,sha256:j.sha256,conversationUrl:j.conversationUrl,groupStatus:j.groupStatus,completedAt:new Date().toISOString()};save();console.log(JSON.stringify(state));break;
  }
  if(['failed','cancelled','quota_exhausted','attention_required'].includes(j?.status)){state.status=j.status;save();throw Error('CHATGPT_TEST_'+j.status.toUpperCase());}
  await new Promise(resolve=>setTimeout(resolve,2000));
}
if(state.status!=='completed')throw Error('CHATGPT_TEST_STILL_RUNNING_RESUME_SAME_JOB');
