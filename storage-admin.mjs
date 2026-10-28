import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomUUID,createHash} from 'node:crypto';
import {DatabaseSync,backup} from 'node:sqlite';
import {BotStorage} from './storage.mjs';

const root=path.dirname(fileURLToPath(import.meta.url));
export function inspectBackup(file) {
  const db=new DatabaseSync(path.resolve(file),{readOnly:true});
  try {
    if(db.prepare('PRAGMA integrity_check').get().integrity_check!=='ok')throw Error('BACKUP_INTEGRITY_FAILED');
    const tables=new Set(db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(x=>x.name));
    if(!tables.has('chat_events')||!tables.has('bot_meta'))throw Error('NOT_A_DAFEILONG_BACKUP');
    const expectedTriggers=new Set(['chat_events_fts_insert','chat_events_fts_update','chat_events_fts_delete']);
    const triggers=db.prepare("SELECT name FROM sqlite_master WHERE type='trigger'").all().map(x=>x.name);
    if(triggers.some(name=>!expectedTriggers.has(name)))throw Error('UNEXPECTED_BACKUP_TRIGGERS');
    const version=db.prepare("SELECT value FROM bot_meta WHERE key='schema_version'").get()?.value;
    if(![1,2,3,4].includes(Number(version)))throw Error('UNSUPPORTED_BACKUP_VERSION');
    return {ok:true,file:path.basename(file),schemaVersion:Number(version),
      events:db.prepare('SELECT COUNT(*) AS n FROM chat_events').get().n};
  }finally{db.close();}
}

export async function restoreBackup(source,directory=path.join(root,'data')) {
  inspectBackup(source);
  directory=path.resolve(directory);
  const live=path.join(directory,'bot.sqlite3'),backups=path.join(directory,'backups');
  fs.mkdirSync(backups,{recursive:true});
  const stamp=new Date().toISOString().replace(/[:.]/g,'-');
  const previous=path.join(backups,'pre-restore-'+stamp+'.sqlite3');
  if(fs.existsSync(live)) {
    const current=new DatabaseSync(live,{readOnly:true});try{await backup(current,previous);}finally{current.close();}
  }
  const temporary=path.join(directory,'restore-'+randomUUID()+'.sqlite3');
  fs.copyFileSync(source,temporary,fs.constants.COPYFILE_EXCL);
  const store=new BotStorage(temporary);
  try {
    if(store.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='approvals'").get())store.db.exec('UPDATE approvals SET status=\'cancelled_after_restore\' WHERE status IN (\'pending\',\'executing\')');
    if(fs.existsSync(previous)) {
      store.db.prepare('ATTACH DATABASE ? AS previous').run(previous);
      try {
        store.transaction(()=>{
          store.db.exec('INSERT OR IGNORE INTO model_usage SELECT * FROM previous.model_usage');
          store.db.exec('INSERT OR IGNORE INTO event_receipts SELECT * FROM previous.event_receipts');
          store.db.exec("INSERT INTO local_settings SELECT * FROM previous.local_settings WHERE key LIKE 'memory:%' ON CONFLICT(scope,key) DO UPDATE SET value=excluded.value");
          const tombstones=new Set(store.db.prepare('SELECT id FROM event_receipts').all().map(x=>x.id));
          const deleted=new Map();
          for(const row of store.db.prepare('SELECT chat,id,user FROM chat_events').all()) {
            const key=createHash('sha256').update(row.chat+'\0'+row.id).digest('hex');
            if(!tombstones.has(key))continue;
            if(!deleted.has(row.chat))deleted.set(row.chat,new Set());deleted.get(row.chat).add(row.id);
            store.db.prepare('DELETE FROM chat_events WHERE chat=? AND id=?').run(row.chat,row.id);
            if(row.user)store.db.prepare('DELETE FROM learned_memories WHERE chat=? AND user=?').run(row.chat,row.user);
            store.db.prepare('DELETE FROM social_feedback_evidence WHERE chat=? AND source_id=?').run(row.chat,row.id);
            if(row.user)store.db.prepare('DELETE FROM social_relationships WHERE chat=? AND user=?').run(row.chat,row.user);
          }
          for(const [chat,ids] of deleted) {
            for(const item of store.db.prepare('SELECT id,sources FROM learned_memories WHERE chat=?').all(chat))if(JSON.parse(item.sources).some(id=>ids.has(id)))store.db.prepare('DELETE FROM learned_memories WHERE id=?').run(item.id);
            store.db.prepare('DELETE FROM conversation_state WHERE chat=?').run(chat);
          }
          store.db.exec('INSERT OR IGNORE INTO model_reservations SELECT * FROM previous.model_reservations');
          store.db.exec('DELETE FROM model_reservations WHERE id IN (SELECT id FROM model_usage)');
        });
      }finally{store.db.exec('DETACH DATABASE previous');}
    }
    store.recoverReservations();
    store.meta('jsonl_imported',store.meta('jsonl_imported')||'restored_database');
    store.meta('moderation_imported',store.meta('moderation_imported')||'restored_database');
    store.audit('global','local-panel','database_restored',{file:path.basename(source)});
    store.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  }finally{store.close();}
  const journal=path.join(directory,'restore-journal.json');
  const journalHandle=fs.openSync(journal,'w',0o600);
  try{fs.writeFileSync(journalHandle,JSON.stringify({live,previous,temporary}));fs.fsyncSync(journalHandle);}finally{fs.closeSync(journalHandle);}
  try {
    for(const suffix of ['-wal','-shm'])if(fs.existsSync(live+suffix))fs.unlinkSync(live+suffix);
    fs.renameSync(temporary,live);
    fs.unlinkSync(journal);
  }catch(error) {
    if(fs.existsSync(previous))fs.copyFileSync(previous,live);
    throw error;
  }
  return {ok:true,previous:path.basename(previous),file:path.basename(source)};
}

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  const [action,file]=process.argv.slice(2);
  try {
    if(action==='inspect')console.log(JSON.stringify(inspectBackup(file)));
    else if(action==='restore') {
      let status={};try{status=JSON.parse(fs.readFileSync(path.join(root,'status.json'),'utf8').replace(/^\uFEFF/,''));}catch{}
      if(Number.isSafeInteger(status.pid)&&status.pid!==process.pid){let alive=false;try{process.kill(status.pid,0);alive=true;}catch{}if(alive)throw Error('STOP_REPLY_SERVICE_BEFORE_RESTORE');}
      const result=await restoreBackup(file);
      for(const name of ['codex-sessions.json','codex-web-search-sessions.json']) {
        const index=path.join(root,'data',name);if(fs.existsSync(index)){fs.copyFileSync(index,index+'.before-restore-'+Date.now()+'.bak');fs.writeFileSync(index,JSON.stringify({version:1,sessions:{}}));}
      }
      console.log(JSON.stringify(result));
    }
    else throw Error('UNKNOWN_STORAGE_ACTION');
  }catch(error){console.error(error.message);process.exitCode=1;}
}
