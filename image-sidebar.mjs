import fs from 'node:fs';
import path from 'node:path';
import {spawn,execFileSync} from 'node:child_process';
import {conversationId} from './chatgpt-image.mjs';

const locks=new Map();
async function appCall(root,name,args) {
  let connection={};try{connection=JSON.parse(fs.readFileSync(path.join(root,'data','image-app-connection.json'),'utf8'));}catch{}
  const pipe=process.env.CODEX_APP_TOOLS_PIPE_PATH||connection.pipePath,caller=process.env.CODEX_THREAD_ID||connection.callerThreadId;
  if(!pipe||!caller)throw Error('DESKTOP_NOT_CONNECTED');
  const exe=execFileSync('powershell.exe',['-NoProfile','-NonInteractive','-Command',"Get-Process ChatGPT -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Path -Unique | Where-Object { $_ -match 'OpenAI.Codex_' } | Select-Object -First 1"],{windowsHide:true,timeout:5000,encoding:'utf8'}).trim();
  if(!exe)throw Error('DESKTOP_NOT_RUNNING');
  const server=path.join(path.dirname(exe),'resources/plugins/openai-bundled/plugins/codex-app-tools/server.mjs');
  const child=spawn(process.execPath,[server],{env:{...process.env,CODEX_APP_TOOLS_PIPE_PATH:pipe,CODEX_THREAD_ID:caller},windowsHide:true,stdio:['pipe','pipe','pipe']});
  const pending=new Map();let seq=0,buffer='';
  const fail=()=>{for(const p of pending.values())p.reject(Error('DESKTOP_OFFLINE'));pending.clear();};
  child.on('error',fail);child.on('exit',fail);child.stdin.on('error',fail);child.stderr.resume();
  child.stdout.setEncoding('utf8');child.stdout.on('data',data=>{buffer+=data;let n;while((n=buffer.indexOf('\n'))>=0){const line=buffer.slice(0,n);buffer=buffer.slice(n+1);let result;try{result=JSON.parse(line);}catch{continue;}const p=pending.get(result.id);if(!p)continue;pending.delete(result.id);result.error?p.reject(Error('DESKTOP_TOOL_FAILED')):p.resolve(result.result);}});
  const rpc=(method,params)=>new Promise((resolve,reject)=>{const id=++seq;pending.set(id,{resolve,reject});child.stdin.write(JSON.stringify({jsonrpc:'2.0',id,method,params})+'\n');});
  const timer=setTimeout(()=>{fail();child.kill();},12000);
  try {
    await rpc('initialize',{protocolVersion:'2024-11-05',capabilities:{},clientInfo:{name:'qq-image-organizer',version:'1'}});
    child.stdin.write(JSON.stringify({jsonrpc:'2.0',method:'notifications/initialized'})+'\n');
    const result=await rpc('tools/call',{name,arguments:args,_meta:{'openai/threadId':caller}});
    if(result.isError)throw Error('DESKTOP_TOOL_FAILED');
    if(result.structuredContent)return result.structuredContent;
    const text=result.content?.find(x=>x.type==='text')?.text;return text?JSON.parse(text):{};
  }finally{clearTimeout(timer);child.kill();}
}
export async function organizeImageConversation(root,settings,job) {
  const id=conversationId(job.conversationUrl);if(!id)throw Error('IMAGE_CONVERSATION_INVALID');
  const previous=locks.get(root)||Promise.resolve();
  const task=previous.catch(()=>{}).then(async()=>{
    const list=await appCall(root,'list_threads',{limit:50});
    const present=[...(list.threads||[]),...(list.pinnedThreads||[])].some(t=>t.kind==='chatgpt'&&t.id===id);
    if(!present)throw Error('IMAGE_CONVERSATION_NOT_SYNCED');
    let section=(list.sections||[]).find(s=>s.name===settings.sectionName);
    if(!section){const created=await appCall(root,'create_sidebar_section',{name:settings.sectionName});section={sectionId:created.sectionId||created.id||created.section?.sectionId};}
    if(!/^[a-f0-9-]{36}$/.test(section.sectionId))throw Error('IMAGE_SECTION_INVALID');
    await appCall(root,'move_thread_to_sidebar_section',{source:'chatgpt',threadId:id,sectionId:section.sectionId});
  });
  locks.set(root,task);try{await task;}finally{if(locks.get(root)===task)locks.delete(root);}
}
