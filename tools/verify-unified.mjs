import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {readConfig,buildPrompt} from '../bridge.mjs';
import {CodexSessions} from '../sessions.mjs';
import {hostIdentity} from '../dialogue.mjs';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..'),cfg=readConfig(),rows=[],events=[],tools=[];
const chat='probe-unified-'+Date.now(),dir=path.join(root,'work/unified-acceptance');fs.mkdirSync(dir,{recursive:true});
const owner='1000000002';
const client=new CodexSessions(cfg,root,buildPrompt,{unified:true,webSearch:true,canSearch:()=>true,
 file:path.join(dir,chat+'.json'),threadName:()=> '统一会话协议验收',onTool:async(name,args)=>{
   tools.push({name,args});if(name!=='qq_context'||args.kind!=='identity')throw Error('READ_ONLY_ACCEPTANCE');
   return {data:hostIdentity(cfg.botQQ,[owner],owner)};
 }});
const consume=client.consume.bind(client);client.consume=m=>{if(m.method==='item/started'||m.method==='item/completed')events.push({method:m.method,type:m.params?.item?.type,tool:m.params?.item?.tool});consume(m);};
const packets=[],rpc=client.rpc.bind(client);client.rpc=(method,params,...rest)=>{if(method==='turn/start')packets.push(JSON.parse(params.input[0].text));return rpc(method,params,...rest);};
const recent=[];
try{
 for(const [index,question]of [
  '请调用qq_context的identity读取我的部署主人QQ号，只回答工具实际返回的QQ号。',
  '不要调用任何工具，只根据上一轮已经返回的结果说出主人QQ号。',
  '请实际联网搜索OpenAI Prompt caching官方文档，给出网页标题与官方链接即可。'
 ].entries()){
  recent.push({id:chat+':'+index,role:'user',user:owner,speaker:'本机验收',text:question,at:Date.now()});
  const before=tools.length;
  try{
   const r=await client.answer(cfg,question,[],{chatKey:chat,mode:'direct',requesterId:owner,requesterName:'本机验收',recentMessages:recent,webSearchAllowed:true});
   rows.push({index:index+1,text:r.text,usage:r.usage,inputBytes:r.diagnostics?.inputBytes,toolCalls:tools.length-before,usedWebSearch:r.usedWebSearch,threadId:r.threadId});
   recent.push({id:chat+':a'+index,role:'assistant',text:r.text,at:Date.now()});
  }catch(e){rows.push({index:index+1,error:e.message,rpcMessage:e.rpcMessage});break;}
  fs.writeFileSync(path.join(dir,'result.json'),JSON.stringify({rows,events,tools,packets},null,2));
  console.log(JSON.stringify(rows.at(-1)));
 }
}finally{
 const entry=client.state.sessions[chat];
 if(entry)try{await client.rpc('thread/archive',{threadId:entry.threadId});}catch{}
 fs.writeFileSync(path.join(dir,'result.json'),JSON.stringify({rows,events,tools,packets},null,2));client.close();
}
if(rows.length!==3||rows.some(r=>r.error)||!rows[0]?.toolCalls||rows[1]?.toolCalls||!rows[1]?.text.includes(owner)||!rows[2]?.usedWebSearch)process.exitCode=1;
