import {randomUUID} from 'node:crypto';
/** Social state is scoped to a QQ conversation. It is data, never instructions. */
export class SocialEngine {
  constructor(cfg,memory) {
    this.cfg=cfg;this.memory=memory;this.store=memory.store;
    this.fallback=new Map();
    this.boundaries=new Map();
  }
  state(chat){return this.store?.state(chat)||this.fallback.get(String(chat))||{};}
  save(chat,value){if(this.store)this.store.state(chat,value);else this.fallback.set(String(chat),value);return value;}
  observe(chat,record) {
    const state=this.state(chat);
    const optedOut=this.store?.setting(String(chat),'memory:'+record.user)===false;
    const addressed=record.audience?.kind==='bot'||!!record.relation;
    let followup=state.followup;
    if(followup&&['pending','queued'].includes(followup.status)&&record.audience?.reason==='public_topic'&&record.at>followup.createdAt)
      followup={...followup,status:'cancelled',reason:'topic_changed',finishedAt:record.at};
    this.save(chat,{...state,lastHumanAt:record.at,lastHumanId:optedOut?'':record.id,
      initiativeUnanswered:addressed?false:!!state.initiativeUnanswered,followup,
      ...(followup?.status==='cancelled'?{followupAt:0}:{})});
    if(optedOut)return;
    if(!this.store||!record.user)return;
    const relation=this.store.relationship(chat,record.user);
    this.store.relationship(chat,record.user,{name:record.speaker,lastSeen:record.at,humanMessages:relation.humanMessages+1});
  }
  snapshot(chat,query,messages,requester) {
    const ids=new Set(messages.filter(x=>x.role==='user').slice(-30).map(x=>x.user));ids.add(String(requester));
    const state=this.state(chat);
    return {summary:state.summary||'',topic:state.topic||'',openLoops:state.openLoops||[],
      lastHumanAt:state.lastHumanAt||0,lastBotAt:state.lastBotAt||0,
      relationships:(this.store?.relationships(chat)||[]).filter(x=>ids.has(x.user)).slice(-12),
      memoryOptOutUsers:[...ids].filter(id=>this.store?.setting(String(chat),'memory:'+id)===false),
      learnedMemories:this.store?.memories(chat,query,10)||[],
      longTermEnabled:!!this.cfg.memory?.longTermEnabled,
      quietUntil:state.quietUntil||0,
      participation:{initiativeUnanswered:!!state.initiativeUnanswered,
        lastBotReplies:messages.filter(x=>x.role==='assistant').slice(-3).map(x=>({at:x.at,text:x.text,forUser:x.forUser||x.replyToUser})),
        followup:state.followup?{status:state.followup.status,topic:state.followup.topic,sourceId:state.followup.sourceId}:null}};
  }
  distance(chat,user){return this.store?this.store.relationship(chat,user).distanceUntil||0:this.boundaries.get(`${chat}:${user}`)||0;}
  withdraw(chat,user,seconds=600) {
    const until=Date.now()+Math.max(60,Math.min(86400,seconds))*1000;
    if(this.store)this.store.relationship(chat,user,{distanceUntil:until});else this.boundaries.set(`${chat}:${user}`,until);
  }
  resumeUser(chat,user){if(this.store&&this.distance(chat,user))this.store.relationship(chat,user,{distanceUntil:0});else this.boundaries.delete(`${chat}:${user}`);}
  apply(chat,response,messages,requester,{delivered=false,initiative=false}={}) {
    const state=this.state(chat),update=response.socialUpdate||{},now=Date.now();
    const evidence=new Map(messages.filter(x=>x.id).map(x=>[x.id,x]));
    const participants=new Set(messages.filter(x=>x.role==='user').map(x=>String(x.user)));
    const boundary=response.interactionBoundary;
    const latest=messages.filter(x=>x.role==='user'&&String(x.user)===String(requester)).at(-1);
    const withdrawing=boundary?.withdraw&&latest?.id===boundary.sourceId;
    if(withdrawing) {
      this.withdraw(chat,requester,Number(boundary.seconds)||600);
      state.openLoops=(state.openLoops||[]).filter(x=>x.userId!==String(requester));
      state.followupAt=0;
    }
    const consent=user=>this.store?.setting(String(chat),'memory:'+user)!==false;
    const correctionKeys=[];
    if(this.store&&this.cfg.memory?.longTermEnabled)for(const item of (response.memoryUpdates||[]).slice(0,8)) {
      if(!['episodic','longterm','correction','preference'].includes(item.kind)||item.sensitive||!item.text?.trim())continue;
      const sourceIds=Array.isArray(item.sourceIds)?[...new Set(item.sourceIds)].slice(0,12):[];
      const sources=sourceIds.map(id=>evidence.get(id));
      if(!sources.length||sources.some(x=>!x)||!sources.some(x=>x.role==='user'))continue;
      const user=String(item.userId||'');
      if(user&&(!participants.has(user)||!sources.some(x=>x.role==='user'&&String(x.user)===user)))continue;
      if(sources.some(x=>x.role==='user'&&!consent(String(x.user))))continue;
      if(/(?:sk-[a-z0-9_-]{16,}|-----BEGIN .*PRIVATE KEY-----|(?:api[_ -]?key|密码|验证码)\s*[:：=]\s*\S{4,})/i.test(item.text))continue;
      if(item.kind==='correction') {
        const firstSourceAt=Math.min(...sources.filter(x=>x.role==='user').map(x=>Number(x.at)||0));
        const target=messages.filter(x=>x.role==='assistant'&&(Number(x.at)||0)<=firstSourceAt).at(-1);
        if(!target?.id)continue;
        const memoryKey=String(item.key||item.text).trim().slice(0,160);
        this.store.recordFeedback({chat,user,targetId:target.id,sourceId:sources[0].id,kind:'correction',
          strength:Number(item.importance)>=80?'strong':'weak',memoryKey,text:item.text,
          sourceIds:[sources[0].id]});
        correctionKeys.push(memoryKey);
        this.store.audit(chat,requester,'feedback_evidence',{targetId:target.id,sourceId:sources[0].id,
          memoryKey,strength:Number(item.importance)>=80?'strong':'weak'});
        continue;
      }
      const id=this.store.learn(chat,{...item,userId:user,sourceIds});
      this.store.audit(chat,requester,'memory_learned',{id,kind:item.kind,sourceIds});
    }
    for(const memoryKey of new Set(correctionKeys)) {
      const promoted=this.store?.promoteFeedback(chat,memoryKey);
      if(promoted?.promoted)this.store.audit(chat,requester,'feedback_promoted_via_chat',promoted);
    }
    // A summary is accepted only with actual message provenance; this avoids
    // treating a model's stale draft as a new event in the group.
    const sourceIds=Array.isArray(update.sourceIds)?update.sourceIds.filter(id=>evidence.has(id)).slice(-24):[];
    let next={...state};
    if(sourceIds.length&&update.summary?.trim()&&!sourceIds.some(id=>{const source=evidence.get(id);return source.role==='user'&&!consent(String(source.user));})) {
      next.summary=update.summary.slice(0,2400);
      next.summarySources=sourceIds;
      next.topic=String(update.topic||state.topic||'').slice(0,180);
      next.openLoops=(update.openLoops||[]).filter(x=>evidence.has(x.sourceId)&&participants.has(String(x.userId)))
        .slice(0,8).map(x=>({userId:String(x.userId),question:String(x.question).slice(0,300),sourceId:x.sourceId}));
      next.updatedAt=now;
    }
    if(delivered) {
      next.lastBotAt=now;next.initiativeUnanswered=initiative;
      const delay=Number(update.followupAfterSeconds)||0;
      const topic=String(update.followupTopic||'').trim().slice(0,300);
      const source=messages.filter(x=>x.role==='user'&&x.speaker!=='图片内容摘要'&&String(x.user)===String(requester)).at(-1);
      const same=state.followup?.sourceId===source?.id&&state.followup?.topic===topic;
      if(!initiative&&delay>0&&topic&&source?.id&&!withdrawing&&consent(String(requester))&&!same) {
        const dueAt=now+Math.max(90,Math.min(7200,delay))*1000;
        next.followup={id:randomUUID(),status:'pending',createdAt:now,dueAt,expiresAt:dueAt+Math.max(60,Math.min(1800,this.cfg.social?.followupGraceSeconds||600))*1000,
          sourceId:source.id,userId:String(requester),topic,attempts:0,leaseUntil:0};
        next.followupAt=dueAt;next.followupTopic=topic;
      } else {
        next.followupAt=0;next.followupTopic='';
        if(state.followup)next.followup={...state.followup,status:initiative?'completed':'cancelled',reason:initiative?'delivered':'conversation_resolved',finishedAt:now};
      }
      if(this.store&&consent(String(requester))) {
        const relation=this.store.relationship(chat,requester);
        const topics=Array.isArray(update.topics)?update.topics.filter(x=>typeof x==='string'&&x.length<=80).slice(0,6):[];
        this.store.relationship(chat,requester,{lastBotReplyAt:now,botReplies:relation.botReplies+1,
          sharedTopics:[...new Set([...relation.sharedTopics,...topics])].slice(-20)});
      }
    }
    if(withdrawing){next.openLoops=(next.openLoops||[]).filter(x=>x.userId!==String(requester));next.followupAt=0;
      if(next.followup)next.followup={...next.followup,status:'cancelled',reason:'withdrawn',finishedAt:now};}
    this.save(chat,next);
  }
  silence(chat,seconds) {
    const state=this.state(chat);
    return this.save(chat,{...state,quietUntil:Date.now()+Math.max(60,seconds)*1000,followupAt:0,
      followup:state.followup?{...state.followup,status:'cancelled',reason:'silenced',finishedAt:Date.now()}:undefined});
  }
  resume(chat){const state=this.state(chat);return this.save(chat,{...state,quietUntil:0});}
  audit(chat,user,action,details){this.store?.audit(chat,user,action,details);}
}
