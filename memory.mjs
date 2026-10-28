import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {BotStorage} from './storage.mjs';
const root = path.dirname(fileURLToPath(import.meta.url));
function snippet(text,terms,limit=1000) {
  if(text.length<=limit)return text;
  const lower=text.toLowerCase(),positions=terms.map(term=>lower.indexOf(term)).filter(x=>x>=0);
  let start=0,score=-1;
  for(const candidate of [0,...positions.map(x=>Math.max(0,x-250))]) {
    const window=lower.slice(candidate,candidate+limit),weight=terms.reduce((sum,term)=>sum+(window.includes(term)?term.length:0),0);
    if(weight>score){start=candidate;score=weight;}
  }
  return (start?'…':'')+text.slice(start,start+limit)+(start+limit<text.length?'…':'');
}
export class ChatMemory {
  constructor(cfg, options = {}) {
    this.enabled = !!cfg.memory?.enabled; this.crossSearch = !!cfg.memory?.crossSearch;
    this.file = options.file || path.join(root, 'data', 'chat-memory.jsonl');
    this.settings = { maxRecords: 30000, retentionDays: 30, maxResults: 6, ...cfg.memory };
    this.maxTextChars=Math.max(6000,Math.min(32768,Number(cfg.maxQuestionChars)||6000));
    this.records = []; this.keys = new Set();
    if(this.enabled && (options.database || cfg.memory?.backend==='sqlite')) {
      this.store=new BotStorage(options.database || path.join(root,'data','bot.sqlite3'));
      this.store.importLegacy(this.file);
      this.store.importModeration(path.join(path.dirname(this.store.file),'moderation.sqlite3'));
      this.records=this.store.events(undefined,10000);
      this.keys=new Set(this.records.map(x=>x.id));
      return;
    }
    if (this.enabled) {
      try {
        this.records = fs.readFileSync(this.file, 'utf8').split('\n').filter(Boolean).flatMap(line => {
          try { return [JSON.parse(line)]; } catch { return []; }
        });
      } catch { /* new archive */ }
      this.compact(false);
    }
  }
  compact(write = true) {
    const cutoff = Number(this.settings.retentionDays)>0 ? Date.now()-this.settings.retentionDays*86400000 : -Infinity;
    this.records = this.records.filter(x => x.at >= cutoff && typeof x.text === 'string').slice(-this.settings.maxRecords);
    this.keys = new Set(this.records.map(x => x.id));
    if (write && this.enabled && !this.store) {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const temp = this.file + '.tmp';
      fs.writeFileSync(temp, this.records.map(x => JSON.stringify(x)).join('\n') + '\n'); fs.renameSync(temp, this.file);
    }
  }
  add(chat, record) {
    if (!this.enabled) return;
    const entry = { ...record, chat: String(chat), text: String(record.text).slice(0, this.maxTextChars), at: record.at || Date.now() };
    const subject=String(entry.user||entry.forUser||'');
    if(this.store&&subject&&this.store.setting(String(chat),'memory:'+subject)===false){this.store.receipt(chat,entry.id);return;}
    if (this.keys.has(entry.id)) return;
    if(this.store && !this.store.addEvent(chat,entry))return;
    this.records.push(entry); this.keys.add(entry.id);
    if(this.store){if(this.records.length>10200){this.records.splice(0,200);this.keys=new Set(this.records.map(x=>x.id));}return;}
    fs.mkdirSync(path.dirname(this.file), { recursive: true }); fs.appendFileSync(this.file, JSON.stringify(entry) + '\n');
    if (this.settings.maxRecords>0 && this.records.length > this.settings.maxRecords + 100) this.compact();
  }
  attachImages(chat, id, imageIds) {
    if (!this.enabled || !imageIds.length) return;
    const entry = this.records.find(x => x.chat === String(chat) && x.id === id);
    if (!entry) return;
    entry.imageIds = [...new Set(imageIds)];
    if(this.store){this.store.updateEvent(chat,entry);return;}
    this.compact(); // Persist the association completed after image download.
  }
  recent(chat, count = 60, minutes = 0) {
    if (!this.enabled) return [];
    const cutoff = Number(minutes) > 0 ? Date.now() - Number(minutes) * 60000 : -Infinity;
    const records=this.store?this.store.events(chat,count):this.records;
    return records.filter(x => x.chat === String(chat) && x.at >= cutoff).slice(-count).map(x => ({ ...x }));
  }
  searchLocal(query, chat, excludedIds = []) {
    if (!this.enabled) return [];
    const input=String(query).slice(0,180).toLowerCase();
    const words=input.match(/[a-z0-9_]{2,}|[\p{Script=Han}]{2,}/gu)||[];
    const terms=[...new Set(words.flatMap(w=>/^[\p{Script=Han}]+$/u.test(w)&&w.length>2
      ?Array.from({length:w.length-1},(_,i)=>w.slice(i,i+2)):[w]))]
      .filter(w=>!['之前','上次','记得','什么','一下','群里','说过','这个','那个'].includes(w));
    const excluded=new Set(excludedIds);
    if(this.store)return this.store.searchEvents(terms,{chat,excludeIds:excludedIds,limit:this.settings.maxResults})
      .map(x=>({source:'当前对话',id:x.id,role:x.role,speaker:x.speaker,text:snippet(x.text,terms),at:new Date(x.at).toISOString()}));
    return this.records.filter(x=>x.chat===String(chat)&&!excluded.has(x.id))
      .map(record=>({record,score:terms.reduce((sum,t)=>sum+(record.text.toLowerCase().includes(t)?t.length:0),0)}))
      .filter(x=>x.score>0).sort((a,b)=>b.score-a.score||b.record.at-a.record.at)
      .slice(0,this.settings.maxResults).map(({record:x})=>({source:'当前对话',id:x.id,role:x.role,
        speaker:x.speaker,text:snippet(x.text,terms),at:new Date(x.at).toISOString()}));
  }
  firstUserMessage(chat,user) {
    if(!this.enabled)return null;
    if(this.store)return this.store.firstUserMessage(chat,user);
    return this.records.filter(x=>x.chat===String(chat)&&x.role==='user'&&String(x.user)===String(user)&&!/:image:|:poke:/.test(x.id))
      .sort((a,b)=>a.at-b.at)[0]||null;
  }
  around(chat,messageId,radius=3) {
    if(!this.enabled)return [];
    if(this.store)return this.store.around(chat,messageId,radius);
    const records=this.records.filter(x=>x.chat===String(chat)).sort((a,b)=>a.at-b.at);
    const i=records.findIndex(x=>x.id===`${chat}:${messageId}:user`||x.id===`${chat}:${messageId}:assistant`);
    return i<0?[]:records.slice(Math.max(0,i-radius),i+radius+1);
  }
  search(query, currentChat) {
    if (!this.enabled || !this.crossSearch) return [];
    const input = String(query).slice(0, 180).toLowerCase();
    const groupMatch = /群\s*(\d{5,12})|(\d{5,12})\s*群/.exec(input);
    const targetGroup = groupMatch?.[1] || groupMatch?.[2];
    const privateIntent = !targetGroup && /私聊|私人聊天|私信|private:/.test(input);
    let targetPrivate = null;
    if (privateIntent) {
      const ids = [...new Set(input.match(/\d{5,12}/g) || [])];
      if (ids.length > 1) return [];
      if (ids.length === 1) targetPrivate = `private:${ids[0]}`;
      else {
        const matches = this.store?this.store.privateMatches(input):this.records.filter(x => x.chat.startsWith('private:') && x.role === 'user' &&
          typeof x.speaker === 'string' && x.speaker.trim().length >= 2 && input.includes(x.speaker.trim().toLowerCase()));
        const longest = Math.max(0, ...matches.map(x => x.speaker.trim().length));
        const chats = [...new Set(matches.filter(x => x.speaker.trim().length === longest).map(x => x.chat))];
        if (chats.length > 1) return []; // Ambiguous nickname: let the bot ask for a QQ number.
        targetPrivate = chats[0] || null;
        if (!targetPrivate && /(?:和|跟|与).{1,30}(?:私聊|私人聊天)/.test(input)) return [];
      }
    }
    const targetChat = targetGroup || targetPrivate;
    const words = input.match(/[a-z0-9_]{2,}|[\p{Script=Han}]{2,}/gu) || [];
    const terms = [...new Set(words.flatMap(w => /^[\p{Script=Han}]+$/u.test(w) && w.length > 2
      ? [...Array(w.length - 1)].map((_, i) => w.slice(i, i + 2)) : [w]))]
      .filter(w => !['之前', '上次', '记得', '其他', '别的', '群里', '私聊', '什么', '哪里', '说过', '一下'].includes(w));
    if (!terms.length && !targetChat) return [];
    const cutoff = Number(this.settings.retentionDays)>0 ? Date.now()-this.settings.retentionDays*86400000 : -Infinity;
    if(this.store)return this.store.searchEvents(terms,{chat:targetChat||undefined,excludeChat:currentChat,
      privateOnly:privateIntent,role:'user',cutoff,allowZero:!!targetChat,limit:this.settings.maxResults})
      .map(x=>({source:x.chat.startsWith('private:')?`私聊${x.chat.slice(8)}`:`群${x.chat}`,speaker:x.speaker,text:snippet(x.text,terms),at:new Date(x.at).toISOString()}));
    return this.records.filter(x => x.chat !== String(currentChat) && (!targetChat || x.chat === targetChat) &&
        (!privateIntent || x.chat.startsWith('private:')) && x.at >= cutoff && x.role === 'user')
      .map(x => ({ record: x, score: terms.reduce((n, term) => n + (x.text.toLowerCase().includes(term) ? term.length : 0), 0) }))
      .filter(x => x.score > 0 || targetChat).sort((a, b) => b.score - a.score || b.record.at - a.record.at)
      .slice(0, this.settings.maxResults).map(({ record: x }) => ({ source: x.chat.startsWith('private:') ? `私聊${x.chat.slice(8)}` : `群${x.chat}`,
        speaker: x.speaker, text: snippet(x.text,terms), at: new Date(x.at).toISOString() }));
  }
  forget(chat, user) {
    if (!this.enabled) return;
    if(this.store){this.store.forget(chat,user);this.records=this.store.events(undefined,10000);this.keys=new Set(this.records.map(x=>x.id));return;}
    this.records = this.records.filter(x => x.chat !== String(chat) || (x.user !== String(user) && x.forUser !== String(user)));
    this.compact();
  }
  close(){this.store?.close();}
  has(chat,id){return this.store?this.store.hasEvent(chat,id):this.keys.has(id);}
}
