import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {readConfig,buildPrompt} from '../bridge.mjs';
import {CodexSessions} from '../sessions.mjs';
import {ChatMemory} from '../memory.mjs';
import {hostIdentity} from '../dialogue.mjs';
import {createSidebarOrganizer} from '../sidebar.mjs';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..'),cfg=readConfig();
const status=JSON.parse(fs.readFileSync(path.join(root,'status.json'),'utf8'));
if(status.state!=='stopped')throw Error('STOP_REPLY_SERVICE_BEFORE_MIGRATION');
const memory=new ChatMemory(cfg),results=[],chats=new Set(),errors=[];
for(const file of ['codex-sessions.json','codex-web-search-sessions.json']){
 const index=JSON.parse(fs.readFileSync(path.join(root,'data',file),'utf8'));
 for(const chat of Object.keys(index.sessions))if(/^(?:private:)?\d+$/.test(chat))chats.add(chat);
}
const canSearch=chat=>chat.startsWith('private:')?cfg.capabilities?.webSearchAllChats===true:
 cfg.capabilities?.webSearchAllGroups===true||(cfg.capabilities?.webSearchGroups||[]).map(String).includes(chat);
const client=new CodexSessions(cfg,root,buildPrompt,{unified:true,webSearch:true,canSearch,
 onThreadReady:createSidebarOrganizer(cfg,p=>{if(p.lastSidebarError)errors.push(p.lastSidebarError);}),
 onTool:async()=>{throw Error('BOOTSTRAP_HAS_NO_TOOLS');}});
client.onMigrated=async(chat,threadId,oldIds)=>{
 let ok=true;for(const old of oldIds)if(old!==threadId)try{await client.rpc('thread/archive',{threadId:old});}catch(e){ok=false;errors.push('ARCHIVE_PENDING:'+old);}
 return ok;
};
try{
 for(const chat of chats){
  if(client.state.sessions[chat]?.turns){results.push({chat,status:'already_migrated',threadId:client.state.sessions[chat].threadId});continue;}
  const recent=memory.recent(chat,cfg.social?.contextMessages||200,0);
  let localModeration={};try{localModeration=JSON.parse(fs.readFileSync(path.join(root,'data/moderation-settings.json'),'utf8').replace(/^\uFEFF/,''));}catch{}
  const owners=(localModeration.owners||cfg.moderation?.owners||[]).map(String);
  try{
   const r=await client.answer(cfg,'',[],{chatKey:chat,mode:'ambient',bootstrapOnly:true,recentMessages:recent,
    hostIdentity:hostIdentity(cfg.botQQ,owners,''),webSearchAllowed:false,requesterId:'',requesterName:'',images:[]});
   results.push({chat,status:'migrated',threadId:r.threadId,historyEvents:recent.length,usage:r.usage,inputBytes:r.diagnostics?.inputBytes});
  }catch(e){results.push({chat,status:'failed',error:e.message,rpcMessage:e.rpcMessage});}
  fs.writeFileSync(path.join(root,'work/unified-migration.json'),JSON.stringify({at:new Date().toISOString(),results,errors},null,2));
  console.log(JSON.stringify(results.at(-1)));
 }
}finally{client.close();memory.close();}
if(results.some(r=>r.status==='failed'))process.exitCode=1;
