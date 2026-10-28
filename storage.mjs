import fs from 'node:fs';
import path from 'node:path';
import {DatabaseSync, backup} from 'node:sqlite';
import {createHash, randomUUID} from 'node:crypto';

const json = value => JSON.stringify(value);
const parse = value => JSON.parse(value);
function recoverRestore(file) {
  const directory=path.dirname(file),journal=path.join(directory,'restore-journal.json');
  if(!fs.existsSync(journal))return;
  const info=parse(fs.readFileSync(journal,'utf8'));
  if(path.resolve(info.live)!==file)return;
  const previous=path.resolve(info.previous),relative=path.relative(path.join(directory,'backups'),previous);
  if(relative.startsWith('..')||path.isAbsolute(relative)||!path.basename(previous).startsWith('pre-restore-')||!fs.existsSync(previous))throw Error('RESTORE_RECOVERY_REQUIRES_ATTENTION');
  for(const suffix of ['-wal','-shm'])if(fs.existsSync(file+suffix))fs.unlinkSync(file+suffix);
  fs.copyFileSync(previous,file);fs.unlinkSync(journal);
}

/** Local durable storage. Model content never supplies SQL or database paths. */
export class BotStorage {
  constructor(file) {
    this.file=path.resolve(file);
    fs.mkdirSync(path.dirname(this.file),{recursive:true});
    recoverRestore(this.file);
    this.db=new DatabaseSync(this.file,{timeout:5000});
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON;
      CREATE TABLE IF NOT EXISTS bot_meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS chat_events(chat TEXT NOT NULL,id TEXT NOT NULL,at INTEGER NOT NULL,
        user TEXT NOT NULL,role TEXT NOT NULL,text TEXT NOT NULL,data TEXT NOT NULL,PRIMARY KEY(chat,id));
      CREATE INDEX IF NOT EXISTS chat_events_recent ON chat_events(chat,at);
      CREATE TABLE IF NOT EXISTS event_receipts(id TEXT PRIMARY KEY,at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS learned_memories(id TEXT PRIMARY KEY,chat TEXT NOT NULL,user TEXT NOT NULL,
        kind TEXT NOT NULL,memory_key TEXT NOT NULL,text TEXT NOT NULL,importance REAL NOT NULL,
        at INTEGER NOT NULL,updated_at INTEGER NOT NULL,expires INTEGER NOT NULL,sources TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS learned_memories_scope ON learned_memories(chat,user,memory_key);
      CREATE TABLE IF NOT EXISTS social_feedback_evidence(id TEXT PRIMARY KEY,chat TEXT NOT NULL,user TEXT NOT NULL,
        target_id TEXT NOT NULL,source_id TEXT NOT NULL,kind TEXT NOT NULL,strength TEXT NOT NULL,
        memory_key TEXT NOT NULL,text TEXT NOT NULL,status TEXT NOT NULL,memory_id TEXT NOT NULL,
        at INTEGER NOT NULL,updated_at INTEGER NOT NULL,data TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS social_feedback_scope ON social_feedback_evidence(chat,memory_key,status);
      CREATE TABLE IF NOT EXISTS memory_revisions(id TEXT PRIMARY KEY,memory_id TEXT NOT NULL,chat TEXT NOT NULL,
        action TEXT NOT NULL,before_data TEXT,after_data TEXT,sources TEXT NOT NULL,at INTEGER NOT NULL,reverted_at INTEGER NOT NULL DEFAULT 0);
      CREATE INDEX IF NOT EXISTS memory_revisions_scope ON memory_revisions(chat,memory_id,at);
      CREATE TABLE IF NOT EXISTS social_relationships(chat TEXT NOT NULL,user TEXT NOT NULL,data TEXT NOT NULL,PRIMARY KEY(chat,user));
      CREATE TABLE IF NOT EXISTS conversation_state(chat TEXT PRIMARY KEY,data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS local_settings(scope TEXT NOT NULL,key TEXT NOT NULL,value TEXT NOT NULL,PRIMARY KEY(scope,key));
      CREATE TABLE IF NOT EXISTS bot_audit(id TEXT PRIMARY KEY,at INTEGER NOT NULL,chat TEXT NOT NULL,user TEXT NOT NULL,action TEXT NOT NULL,data TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS bot_audit_recent ON bot_audit(at);
      CREATE TABLE IF NOT EXISTS model_usage(id TEXT PRIMARY KEY,at INTEGER NOT NULL,chat TEXT NOT NULL,
        input_tokens INTEGER NOT NULL,cached_tokens INTEGER NOT NULL,output_tokens INTEGER NOT NULL,cost REAL NOT NULL,data TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS model_usage_time ON model_usage(at);
      CREATE TABLE IF NOT EXISTS delivery_intents(id TEXT PRIMARY KEY,chat TEXT NOT NULL,target TEXT NOT NULL,
        source_id TEXT NOT NULL,kind TEXT NOT NULL,payload_hash TEXT NOT NULL,status TEXT NOT NULL,
        provider_message_id TEXT NOT NULL,error TEXT NOT NULL,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL,
        accepted_at INTEGER NOT NULL DEFAULT 0,data TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS delivery_intents_scope ON delivery_intents(chat,status,updated_at);
      CREATE INDEX IF NOT EXISTS delivery_intents_source ON delivery_intents(chat,source_id);
      CREATE TABLE IF NOT EXISTS model_reservations(id TEXT PRIMARY KEY,at INTEGER NOT NULL,tokens INTEGER NOT NULL,cost REAL NOT NULL);`);
    this.fts5=false;
    try {
      this.db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS chat_events_fts USING fts5(
          chat UNINDEXED,id UNINDEXED,text,tokenize='trigram');
        INSERT INTO chat_events_fts(chat,id,text)
          SELECT e.chat,e.id,e.text FROM chat_events e
          WHERE NOT EXISTS(SELECT 1 FROM chat_events_fts f WHERE f.chat=e.chat AND f.id=e.id);
        CREATE TRIGGER IF NOT EXISTS chat_events_fts_insert AFTER INSERT ON chat_events BEGIN
          INSERT INTO chat_events_fts(chat,id,text) VALUES(new.chat,new.id,new.text);
        END;
        CREATE TRIGGER IF NOT EXISTS chat_events_fts_update AFTER UPDATE OF text ON chat_events BEGIN
          DELETE FROM chat_events_fts WHERE chat=old.chat AND id=old.id;
          INSERT INTO chat_events_fts(chat,id,text) VALUES(new.chat,new.id,new.text);
        END;
        CREATE TRIGGER IF NOT EXISTS chat_events_fts_delete AFTER DELETE ON chat_events BEGIN
          DELETE FROM chat_events_fts WHERE chat=old.chat AND id=old.id;
        END;`);
      this.fts5=true;
    } catch {
      // Older bundled SQLite builds may not include FTS5. Keyword scoring
      // below remains available as a deterministic fallback.
    }
    const version=this.meta('schema_version');
    if(version&&Number(version)>4)throw Error('DATABASE_VERSION_TOO_NEW');
    this.meta('schema_version','4');
  }
  meta(key,value) {
    if(value===undefined)return this.db.prepare('SELECT value FROM bot_meta WHERE key=?').get(key)?.value;
    this.db.prepare('INSERT INTO bot_meta VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key,String(value));
  }
  transaction(fn) {
    this.db.exec('BEGIN IMMEDIATE');
    try{const value=fn();this.db.exec('COMMIT');return value;}catch(error){this.db.exec('ROLLBACK');throw error;}
  }
  importLegacy(file) {
    if(this.meta('jsonl_imported'))return;
    let input;
    try{input=fs.readFileSync(file,'utf8');}catch(error){if(error.code==='ENOENT'){this.meta('jsonl_imported','empty');return;}throw error;}
    const rows=input.split('\n').filter(Boolean).map((line,index)=>{
      try{return parse(line);}catch{throw Error(`LEGACY_MEMORY_INVALID_LINE_${index+1}`);}
    });
    const backupFile=file+'.before-sqlite-'+Date.now()+'.bak';
    fs.copyFileSync(file,backupFile,fs.constants.COPYFILE_EXCL);
    this.transaction(()=>{
      for(const row of rows) {
        if(typeof row.chat!=='string'||typeof row.id!=='string'||typeof row.text!=='string')throw Error('LEGACY_MEMORY_INVALID_RECORD');
        if(!this.addEvent(row.chat,row))continue;
        const user=String(row.user||row.forUser||'');
        if(/^\d+$/.test(user)&&!row.id.includes(':image:')) {
          const relationship=this.relationship(row.chat,user);
          this.relationship(row.chat,user,{firstSeen:Math.min(relationship.firstSeen,row.at),lastSeen:Math.max(relationship.lastSeen||0,row.at),
            ...(row.role==='user'?{name:row.speaker,humanMessages:relationship.humanMessages+1}:{botReplies:relationship.botReplies+1})});
        }
        const state=this.state(row.chat);
        if(row.role==='user'&&!row.id.includes(':image:'))this.state(row.chat,{...state,lastHumanAt:Math.max(state.lastHumanAt||0,row.at)});
        if(row.role==='assistant')this.state(row.chat,{...state,lastBotAt:Math.max(state.lastBotAt||0,row.at)});
      }
      this.meta('jsonl_imported',json({at:Date.now(),count:rows.length,backup:path.basename(backupFile)}));
    });
  }
  addEvent(chat,record) {
    const item={...record,chat:String(chat),user:String(record.user||record.forUser||''),at:Number(record.at)||Date.now()};
    if(this.hasEvent(chat,item.id))return false;
    if(item.user&&this.setting(String(chat),'memory:'+item.user)===false){this.receipt(chat,item.id);return false;}
    const result=this.db.prepare('INSERT OR IGNORE INTO chat_events VALUES(?,?,?,?,?,?,?)')
      .run(item.chat,item.id,item.at,item.user,item.role,item.text,json(item));
    return result.changes>0;
  }
  importModeration(file) {
    if(this.meta('moderation_imported')||!fs.existsSync(file)||path.resolve(file)===this.file)return;
    this.db.exec(`CREATE TABLE IF NOT EXISTS approvals(id TEXT PRIMARY KEY,scope TEXT,user TEXT,payload TEXT,expires REAL,status TEXT);
      CREATE TABLE IF NOT EXISTS requests(id TEXT PRIMARY KEY,scope TEXT,payload TEXT,at REAL);
      CREATE TABLE IF NOT EXISTS audit(id INTEGER PRIMARY KEY,scope TEXT,user TEXT,action TEXT,result TEXT,at REAL);`);
    this.db.prepare('ATTACH DATABASE ? AS previous_moderation').run(path.resolve(file));
    try {
      this.transaction(()=>{
        const tables=new Set(this.db.prepare("SELECT name FROM previous_moderation.sqlite_master WHERE type='table'").all().map(x=>x.name));
        for(const table of ['approvals','requests','audit'])if(tables.has(table))this.db.exec(`INSERT OR IGNORE INTO main.${table} SELECT * FROM previous_moderation.${table}`);
        this.meta('moderation_imported',String(Date.now()));
      });
    }finally{this.db.exec('DETACH DATABASE previous_moderation');}
  }
  updateEvent(chat,record) {
    this.db.prepare('UPDATE chat_events SET text=?,data=? WHERE chat=? AND id=?').run(record.text,json(record),String(chat),record.id);
  }
  events(chat,count=200) {
    if(chat===undefined)return this.db.prepare('SELECT data FROM chat_events ORDER BY at DESC,rowid DESC LIMIT ?').all(Math.max(1,Math.min(100000,count))).reverse().map(x=>parse(x.data));
    return this.db.prepare('SELECT data FROM chat_events WHERE chat=? ORDER BY at DESC,rowid DESC LIMIT ?').all(String(chat),Math.max(1,Math.min(100000,count))).reverse().map(x=>parse(x.data));
  }
  receipt(chat,id){const key=createHash('sha256').update(String(chat)+'\0'+id).digest('hex');this.db.prepare('INSERT OR IGNORE INTO event_receipts VALUES(?,?)').run(key,Date.now());}
  firstUserMessage(chat,user) {
    const row=this.db.prepare("SELECT data FROM chat_events WHERE chat=? AND user=? AND role='user' AND instr(id,':image:')=0 AND instr(id,':poke:')=0 ORDER BY at ASC,rowid ASC LIMIT 1").get(String(chat),String(user));
    return row?parse(row.data):null;
  }
  around(chat,messageId,radius=3) {
    const target=this.db.prepare('SELECT at,rowid FROM chat_events WHERE chat=? AND id IN (?,?) LIMIT 1')
      .get(String(chat),`${chat}:${messageId}:user`,`${chat}:${messageId}:assistant`);
    if(!target)return [];
    const count=Math.max(1,Math.min(5,radius));
    const before=this.db.prepare('SELECT data FROM chat_events WHERE chat=? AND (at<? OR at=? AND rowid<=?) ORDER BY at DESC,rowid DESC LIMIT ?')
      .all(String(chat),target.at,target.at,target.rowid,count+1).reverse();
    const after=this.db.prepare('SELECT data FROM chat_events WHERE chat=? AND (at>? OR at=? AND rowid>?) ORDER BY at ASC,rowid ASC LIMIT ?')
      .all(String(chat),target.at,target.at,target.rowid,count);
    return [...before,...after].map(x=>parse(x.data));
  }
  hasEvent(chat,id){const key=createHash('sha256').update(String(chat)+'\0'+id).digest('hex');return !!this.db.prepare('SELECT 1 FROM chat_events WHERE chat=? AND id=?').get(String(chat),id)||!!this.db.prepare('SELECT 1 FROM event_receipts WHERE id=?').get(key);}
  privateMatches(input) {
    return this.db.prepare("SELECT DISTINCT chat,json_extract(data,'$.speaker') AS speaker FROM chat_events WHERE chat LIKE 'private:%' AND role='user'")
      .all().filter(x=>typeof x.speaker==='string'&&x.speaker.trim().length>=2&&input.includes(x.speaker.trim().toLowerCase()));
  }
  searchEvents(terms,{chat,excludeChat,privateOnly=false,excludeIds=[],role,limit=6,cutoff=0,allowZero=false}={}) {
    const words=terms.slice(0,40),params=[];
    const score=words.length?words.map(word=>{params.push(word,word.length);return '(CASE WHEN instr(lower(text),?)>0 THEN ? ELSE 0 END)';}).join('+'):'0';
    const conditions=['at>=?'];params.push(Math.max(0,cutoff));
    if(chat!==undefined){conditions.push('chat=?');params.push(String(chat));}
    if(excludeChat!==undefined){conditions.push('chat<>?');params.push(String(excludeChat));}
    if(role){conditions.push('role=?');params.push(role);}
    if(privateOnly)conditions.push("chat LIKE 'private:%'");
    if(excludeIds.length){conditions.push(`id NOT IN (${excludeIds.map(()=>'?').join(',')})`);params.push(...excludeIds);}
    const ftsTerms=[...new Set(words.filter(word=>Array.from(word).length>=3))];
    if(this.fts5&&ftsTerms.length){
      const query=ftsTerms.map(word=>`"${word.replaceAll('"','""')}"`).join(' OR ');
      conditions.push('EXISTS(SELECT 1 FROM chat_events_fts f WHERE f.chat=chat_events.chat AND f.id=chat_events.id AND chat_events_fts MATCH ?)');
      params.push(query);
    }
    const sql=`SELECT data,${score} AS score FROM chat_events WHERE ${conditions.join(' AND ')}`;
    return this.db.prepare(`SELECT data FROM (${sql}) WHERE score>0 OR ? ORDER BY score DESC,json_extract(data,'$.at') DESC LIMIT ?`)
      .all(...params,allowZero?1:0,Math.min(100,limit)).map(x=>parse(x.data));
  }
  setting(scope,key,value) {
    if(value===undefined){const row=this.db.prepare('SELECT value FROM local_settings WHERE scope=? AND key=?').get(scope,key);return row?parse(row.value):undefined;}
    this.db.prepare('INSERT INTO local_settings VALUES(?,?,?) ON CONFLICT(scope,key) DO UPDATE SET value=excluded.value').run(scope,key,json(value));
    return value;
  }
  state(chat,value) {
    if(value===undefined){const row=this.db.prepare('SELECT data FROM conversation_state WHERE chat=?').get(String(chat));return row?parse(row.data):{};}
    this.db.prepare('INSERT INTO conversation_state VALUES(?,?) ON CONFLICT(chat) DO UPDATE SET data=excluded.data').run(String(chat),json(value));
    return value;
  }
  relationships(chat) {
    return this.db.prepare('SELECT user,data FROM social_relationships WHERE chat=?').all(String(chat)).map(x=>({user:x.user,...parse(x.data)}));
  }
  relationship(chat,user,update) {
    const row=this.db.prepare('SELECT data FROM social_relationships WHERE chat=? AND user=?').get(String(chat),String(user));
    const current=row?parse(row.data):{firstSeen:Date.now(),humanMessages:0,botReplies:0,sharedTopics:[],preferences:[],distanceUntil:0};
    if(!update)return current;
    const value={...current,...update};
    this.db.prepare('INSERT INTO social_relationships VALUES(?,?,?) ON CONFLICT(chat,user) DO UPDATE SET data=excluded.data').run(String(chat),String(user),json(value));
    return value;
  }
  learn(chat,item) {
    const at=Date.now(),user=String(item.userId||''),key=String(item.key||item.text).trim().slice(0,160);
    const id=createHash('sha256').update([chat,user,item.kind,key].join('\0')).digest('hex');
    const days=Number(item.expiresDays)||0;
    const expires=days>0?at+Math.min(days,3650)*86400000:0;
    const importance=Math.max(0,Math.min(1,Number(item.importance)/100));
    this.transaction(()=>{
      if(item.kind==='correction'&&key)this.db.prepare('DELETE FROM learned_memories WHERE chat=? AND user=? AND memory_key=?').run(String(chat),user,key);
      this.db.prepare(`INSERT INTO learned_memories VALUES(?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET
        text=excluded.text,importance=excluded.importance,updated_at=excluded.updated_at,expires=excluded.expires,sources=excluded.sources`)
        .run(id,String(chat),user,item.kind,key,String(item.text).slice(0,1200),importance,at,at,expires,json(item.sourceIds));
    });
    return id;
  }
  recordFeedback(item) {
    const chat=String(item.chat),user=String(item.user||''),target=String(item.targetId||''),
      source=String(item.sourceId||''),kind=String(item.kind||''),strength=String(item.strength||''),
      key=String(item.memoryKey||'').trim().slice(0,160),text=String(item.text||'').trim().slice(0,1200);
    if(!chat||!user||!target||!source||!key||!text||!['correction','rejection','positive'].includes(kind)||
      !['weak','strong'].includes(strength))throw Error('INVALID_FEEDBACK_EVIDENCE');
    const at=Date.now(),id=createHash('sha256').update([chat,user,target,source,kind,key,text].join('\0')).digest('hex');
    this.db.prepare(`INSERT INTO social_feedback_evidence VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET strength=CASE WHEN excluded.strength='strong' THEN 'strong' ELSE strength END,
      text=excluded.text,updated_at=excluded.updated_at,data=excluded.data`)
      .run(id,chat,user,target,source,kind,strength,key,text,'candidate','',at,at,json(item));
    return id;
  }
  feedbackCandidates(chat,key,limit=20) {
    const rows=key
      ?this.db.prepare('SELECT * FROM social_feedback_evidence WHERE chat=? AND memory_key=? ORDER BY updated_at DESC LIMIT ?').all(String(chat),String(key),Math.min(100,limit))
      :this.db.prepare('SELECT * FROM social_feedback_evidence WHERE chat=? ORDER BY updated_at DESC LIMIT ?').all(String(chat),Math.min(100,limit));
    return rows.map(row=>({...row,data:parse(row.data)}));
  }
  memoryRevisions(chat,limit=50) {
    return this.db.prepare('SELECT * FROM memory_revisions WHERE chat=? ORDER BY at DESC LIMIT ?')
      .all(String(chat),Math.min(100,limit)).map(row=>({...row,
        before_data:row.before_data?parse(row.before_data):null,after_data:row.after_data?parse(row.after_data):null}));
  }
  promoteFeedback(chat,key) {
    const scope=String(chat),memoryKey=String(key),at=Date.now();
    return this.transaction(()=>{
      const candidates=this.db.prepare(`SELECT * FROM social_feedback_evidence
        WHERE chat=? AND memory_key=? AND kind='correction' AND status='candidate'
        ORDER BY updated_at DESC`).all(scope,memoryKey);
      const byText=new Map();
      for(const row of candidates){
        const text=row.text.trim();
        if(!text)continue;
        const group=byText.get(text)||{text,rows:[]};group.rows.push(row);byText.set(text,group);
      }
      const accepted=[...byText.values()].find(group=>new Set(group.rows.map(x=>x.source_id)).size>=2&&
        group.rows.some(x=>x.strength==='strong'));
      if(!accepted)return {promoted:false,evidence:candidates.length};
      const user=accepted.rows.at(-1).user;
      const previous=this.db.prepare('SELECT * FROM learned_memories WHERE chat=? AND memory_key=? ORDER BY updated_at DESC LIMIT 1')
        .get(scope,memoryKey)||null;
      const memoryId=previous?.id||createHash('sha256').update([scope,user,'correction',memoryKey].join('\0')).digest('hex');
      const sources=[...new Set(accepted.rows.map(x=>x.source_id))];
      const importance=Math.max(...accepted.rows.map(x=>x.strength==='strong'?0.9:0.6));
      this.db.prepare(`INSERT INTO learned_memories VALUES(?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET
        text=excluded.text,importance=excluded.importance,updated_at=excluded.updated_at,sources=excluded.sources`)
        .run(memoryId,scope,user,'correction',memoryKey,accepted.text,importance,previous?.at||at,at,0,json(sources));
      this.db.prepare('INSERT INTO memory_revisions VALUES(?,?,?,?,?,?,?,?,0)')
        .run(randomUUID(),memoryId,scope,'promote_feedback',previous?json(previous):null,
          json({text:accepted.text,importance,user,memoryKey,sources}),json(sources),at);
      for(const row of accepted.rows)this.db.prepare('UPDATE social_feedback_evidence SET status=?,memory_id=?,updated_at=? WHERE id=?')
        .run('adopted',memoryId,at,row.id);
      this.audit(scope,user,'feedback_promoted',{memoryId,memoryKey,sources,text:accepted.text});
      return {promoted:true,memoryId,memoryKey,text:accepted.text,evidence:accepted.rows.length,sources};
    });
  }
  rollbackMemory(chat,memoryId,actor='local-panel') {
    const scope=String(chat),id=String(memoryId);
    return this.transaction(()=>{
      const revision=this.db.prepare(`SELECT * FROM memory_revisions
        WHERE chat=? AND memory_id=? AND reverted_at=0 ORDER BY at DESC LIMIT 1`).get(scope,id);
      if(!revision)throw Error('MEMORY_REVISION_NOT_FOUND');
      if(revision.before_data){
        const before=parse(revision.before_data);
        this.db.prepare(`INSERT INTO learned_memories VALUES(?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET
          user=excluded.user,kind=excluded.kind,memory_key=excluded.memory_key,text=excluded.text,
          importance=excluded.importance,at=excluded.at,updated_at=excluded.updated_at,
          expires=excluded.expires,sources=excluded.sources`)
          .run(before.id,before.chat,before.user,before.kind,before.memory_key,before.text,before.importance,
            before.at,before.updated_at,before.expires,before.sources);
      }else this.db.prepare('DELETE FROM learned_memories WHERE id=?').run(id);
      this.db.prepare('UPDATE memory_revisions SET reverted_at=? WHERE id=?').run(Date.now(),revision.id);
      this.db.prepare("UPDATE social_feedback_evidence SET status='rolled_back',updated_at=? WHERE chat=? AND memory_id=? AND status='adopted'")
        .run(Date.now(),scope,id);
      this.audit(scope,actor,'memory_rollback',{memoryId:id,revisionId:revision.id});
      return {rolledBack:true,memoryId:id,restored:!!revision.before_data};
    });
  }
  memories(chat,query='',limit=12) {
    const terms=[...new Set((String(query).toLowerCase().match(/[a-z0-9_]{2,}|[\p{Script=Han}]/gu)||[]))].slice(0,100);
    const rows=this.db.prepare('SELECT * FROM learned_memories WHERE chat=? AND (expires=0 OR expires>?)').all(String(chat),Date.now());
    const scored=rows.map(row=>{
      const overlap=terms.reduce((sum,x)=>sum+Number(row.text.toLowerCase().includes(x)),0)/Math.max(1,terms.length);
      const age=(Date.now()-row.updated_at)/86400000;
      return {...row,sourceIds:parse(row.sources),score:overlap*2+row.importance*Math.exp(-age/180)};
    });
    return scored.sort((a,b)=>b.score-a.score||b.updated_at-a.updated_at).slice(0,limit);
  }
  forget(chat,user) {
    this.transaction(()=>{
      if(user) {
        const identifiers=this.db.prepare('SELECT id FROM chat_events WHERE chat=? AND user=?').all(String(chat),String(user)).map(x=>x.id);
        const memories=this.db.prepare('SELECT id,user,sources FROM learned_memories WHERE chat=?').all(String(chat));
        const deleted=new Set(identifiers),memoryIds=new Set();
        for(const id of identifiers)this.receipt(chat,id);
        for(const row of memories)if(row.user===String(user)||parse(row.sources).some(id=>deleted.has(id))){memoryIds.add(row.id);this.db.prepare('DELETE FROM learned_memories WHERE id=?').run(row.id);}
        this.db.prepare('DELETE FROM social_feedback_evidence WHERE chat=? AND user=?').run(String(chat),String(user));
        for(const source of identifiers) {
          this.db.prepare('DELETE FROM social_feedback_evidence WHERE chat=? AND source_id=?').run(String(chat),source);
          this.db.prepare('DELETE FROM delivery_intents WHERE chat=? AND source_id=?').run(String(chat),source);
        }
        for(const memoryId of memoryIds)this.db.prepare('DELETE FROM memory_revisions WHERE chat=? AND memory_id=?').run(String(chat),memoryId);
        this.db.prepare('DELETE FROM chat_events WHERE chat=? AND user=?').run(String(chat),String(user));
        this.db.prepare('DELETE FROM social_relationships WHERE chat=? AND user=?').run(String(chat),String(user));
      } else {
        for(const row of this.db.prepare('SELECT id FROM chat_events WHERE chat=?').all(String(chat)))this.receipt(chat,row.id);
        for(const table of ['chat_events','learned_memories','social_relationships','social_feedback_evidence','memory_revisions','delivery_intents'])
          this.db.prepare(`DELETE FROM ${table} WHERE chat=?`).run(String(chat));
      }
      // A summary may mention the deleted person even without a user field.
      this.db.prepare('DELETE FROM conversation_state WHERE chat=?').run(String(chat));
    });
  }
  audit(chat,user,action,data={}) {
    this.db.prepare('INSERT INTO bot_audit VALUES(?,?,?,?,?,?)').run(randomUUID(),Date.now(),String(chat||''),String(user||''),action,json(data));
  }
  beginDelivery({chat,target,sourceId,kind,payload}) {
    const at=Date.now(),payloadText=json(payload),payloadHash=createHash('sha256').update(payloadText).digest('hex'),
      id=createHash('sha256').update([chat,target,sourceId,kind,payloadHash].join('\0')).digest('hex');
    const existing=this.db.prepare('SELECT * FROM delivery_intents WHERE id=?').get(id);
    if(existing)return {...existing,data:parse(existing.data),duplicate:true};
    this.db.prepare(`INSERT INTO delivery_intents VALUES(?,?,?,?,?,?,?,?,?,?,?,0,?)`)
      .run(id,String(chat),String(target),String(sourceId),String(kind),payloadHash,'prepared','','',at,at,payloadText);
    return {id,chat:String(chat),target:String(target),source_id:String(sourceId),kind:String(kind),payload_hash:payloadHash,
      status:'prepared',provider_message_id:'',error:'',created_at:at,updated_at:at,accepted_at:0,data:payload,duplicate:false};
  }
  markDelivery(id,status,{providerMessageId='',error=''}={}) {
    if(!['sending','accepted','uncertain','failed'].includes(status))throw Error('INVALID_DELIVERY_STATUS');
    const at=Date.now();
    this.db.prepare(`UPDATE delivery_intents SET status=?,provider_message_id=?,error=?,updated_at=?,
      accepted_at=CASE WHEN ?='accepted' THEN ? ELSE accepted_at END WHERE id=?`)
      .run(status,String(providerMessageId||''),String(error||'').slice(0,500),at,status,at,String(id));
    return this.deliveryIntent(id);
  }
  deliveryIntent(id) {
    const row=this.db.prepare('SELECT * FROM delivery_intents WHERE id=?').get(String(id));
    return row?{...row,data:parse(row.data)}:null;
  }
  deliveryIntents(chat,limit=50) {
    return this.db.prepare('SELECT * FROM delivery_intents WHERE chat=? ORDER BY updated_at DESC LIMIT ?')
      .all(String(chat),Math.min(200,limit)).map(row=>({...row,data:parse(row.data)}));
  }
  attemptedDeliverySource(chat,sourceId) {
    return !!this.db.prepare("SELECT 1 FROM delivery_intents WHERE chat=? AND source_id=? AND status IN ('sending','accepted','uncertain') LIMIT 1")
      .get(String(chat),String(sourceId));
  }
  totals(since=Date.now()-86400000) {
    const actual=this.db.prepare("SELECT COALESCE(SUM(input_tokens+output_tokens),0) AS tokens,COALESCE(SUM(cost),0) AS cost,COUNT(*) AS calls,COALESCE(SUM(CASE WHEN json_extract(data,'$.estimated') THEN 1 ELSE 0 END),0) AS estimatedCalls FROM model_usage WHERE at>=?").get(since);
    const reserved=this.db.prepare('SELECT COALESCE(SUM(tokens),0) AS tokens,COALESCE(SUM(cost),0) AS cost FROM model_reservations WHERE at>=?').get(since);
    return {...actual,reservedTokens:reserved.tokens,reservedCost:reserved.cost};
  }
  recoverReservations() {
    this.transaction(()=>{
      const rows=this.db.prepare('SELECT * FROM model_reservations').all();
      for(const row of rows)this.db.prepare('INSERT OR IGNORE INTO model_usage VALUES(?,?,?,?,?,?,?,?)')
        .run(row.id,row.at,'recovered',row.tokens,0,0,row.cost,json({estimated:true,reason:'interrupted_turn'}));
      this.db.exec('DELETE FROM model_reservations');
    });
  }
  reserve(tokens,cost,limits) {
    return this.transaction(()=>{
      const hour=this.totals(Date.now()-3600000),day=this.totals();
      if(limits.maxHourlyTokens>0&&hour.tokens+hour.reservedTokens+tokens>limits.maxHourlyTokens)throw Error('HOURLY_TOKEN_BUDGET');
      if(limits.maxDailyTokens>0&&day.tokens+day.reservedTokens+tokens>limits.maxDailyTokens)throw Error('DAILY_TOKEN_BUDGET');
      if(limits.maxDailyCost>0&&day.cost+day.reservedCost+cost>limits.maxDailyCost)throw Error('DAILY_COST_BUDGET');
      const id=randomUUID();this.db.prepare('INSERT INTO model_reservations VALUES(?,?,?,?)').run(id,Date.now(),tokens,cost);return id;
    });
  }
  settle(id,chat,usage,cost,details={}) {
    this.transaction(()=>{
      const pending=this.db.prepare('SELECT * FROM model_reservations WHERE id=?').get(id);
      const measured=usage&&Number.isFinite(usage.input_tokens)&&Number.isFinite(usage.output_tokens);
      if(!pending)return;
      this.db.prepare('INSERT INTO model_usage VALUES(?,?,?,?,?,?,?,?)').run(id,Date.now(),String(chat),
        measured?usage.input_tokens:pending.tokens,measured?(usage.cached_input_tokens||0):0,measured?usage.output_tokens:0,
        measured?cost:pending.cost,json({...details,estimated:!measured}));
      this.db.prepare('DELETE FROM model_reservations WHERE id=?').run(id);
    });
  }
  decisions(chat,limit=50) {
    return this.db.prepare('SELECT at,user,action,data FROM bot_audit WHERE chat=? ORDER BY at DESC LIMIT ?').all(String(chat),Math.min(200,limit)).map(x=>({...x,data:parse(x.data)}));
  }
  stats() {
    const count=table=>this.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n;
    return {backend:'sqlite',events:count('chat_events'),memories:count('learned_memories'),
      feedbackEvidence:count('social_feedback_evidence'),revisions:count('memory_revisions'),
      deliveryIntents:count('delivery_intents'),
      uncertainDeliveries:this.db.prepare("SELECT COUNT(*) n FROM delivery_intents WHERE status='uncertain'").get().n,
      relationships:count('social_relationships'),schemaVersion:4,fts5:this.fts5};
  }
  async backup(directory=path.join(path.dirname(this.file),'backups')) {
    fs.mkdirSync(directory,{recursive:true});
    const target=path.join(directory,'bot-'+new Date().toISOString().replace(/[:.]/g,'-')+'.sqlite3');
    await backup(this.db,target);
    this.meta('last_backup',json({at:Date.now(),file:target}));
    // Keep the latest seven full backups; data itself has no age expiry.
    const files=fs.readdirSync(directory).filter(x=>/^bot-[\dTZ-]+\.sqlite3$/.test(x)).sort().reverse();
    for(const file of files.slice(7))fs.unlinkSync(path.join(directory,file));
    return target;
  }
  close(){if(this.db.isOpen)this.db.close();}
}
