import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readConfig, buildPrompt } from './bridge.mjs';
import { CodexSessions } from './sessions.mjs';
import { createSidebarOrganizer } from './sidebar.mjs';

const root=path.dirname(fileURLToPath(import.meta.url)), cfg=readConfig();
const unified=fs.existsSync(path.join(root,'data','codex-conversations.json'));
const sessions=new CodexSessions(cfg,root,buildPrompt,{unified});
let moved=0,sidebarMoved=0,sidebarError=null;
const organize=createSidebarOrganizer(cfg,patch=>{if(patch.lastSidebarError)sidebarError=patch.lastSidebarError;else sidebarMoved++;});
try {
  await sessions.connect();
  let cursor=null;
  const found=new Map();
  for(const name of unified?['codex-conversations.json']:['codex-sessions.json','codex-web-search-sessions.json']) {
    const file=path.join(root,'data',name);
    if(!fs.existsSync(file))continue;
    for(const [chat,entry] of Object.entries(JSON.parse(fs.readFileSync(file,'utf8')).sessions)) {
      if(/^(?:private:)?\d+$/.test(chat))found.set(entry.threadId,chat);
    }
  }
  if(!unified)do {
    const page=await sessions.rpc('thread/list',{limit:100,...(cursor?{cursor}:{})});
    for(const thread of page.data||[]) {
      const match=/^大肥龙 · (私聊 |群 )(\d+)$/.exec(thread.name||'');
      if(match)found.set(thread.id,(match[1]==='私聊 '?'private:':'')+match[2]);
    }
    cursor=page.nextCursor;
  }while(cursor);
  for(const [threadId,chat] of found) {
    await sessions.rpc('thread/metadata/update',{threadId,projectId:cfg.performance.groupProjectId});
    moved++;
    await organize(chat,threadId);
  }
  console.log(JSON.stringify({projectMoved:moved,sidebarMoved,sidebarError,deleted:0}));
}finally{sessions.close();}
