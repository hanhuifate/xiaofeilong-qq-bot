/** One scheduler; followup/lease state lives in SQLite conversation_state. */
export class InitiativeScheduler {
  constructor(bot){this.bot=bot;this.running=false;}
  cancel(g,reason,status='cancelled') {
    const state=this.bot.society.state(g.id);
    if(!state.followup)return;
    this.bot.society.save(g.id,{...state,followupAt:0,followup:{...state.followup,status,reason,finishedAt:Date.now()}});
    this.bot.society.audit(g.id,'','initiative_finished',{id:state.followup.id,status,reason});
  }
  reconcile(g) {
    const bot=this.bot,state=bot.society.state(g.id),task=state.followup,now=Date.now();
    if(!task||!['pending','queued','running'].includes(task.status))return;
    if(task.expiresAt<=now){this.cancel(g,'expired','expired');return;}
    if(!bot.memory.has(g.id,task.sourceId)||bot.society.distance(g.id,task.userId)>now){this.cancel(g,'source_unavailable');return;}
    if(['queued','running'].includes(task.status)&&task.leaseUntil<=now) {
      if(bot.memory.store?.attemptedDeliverySource(g.id,`initiative:${task.id}`)) {
        this.cancel(g,'delivery_already_attempted','completed');return;
      }
      if(task.attempts>=2){this.cancel(g,'retry_limit','failed');return;}
      bot.society.save(g.id,{...state,followup:{...task,status:'pending',leaseUntil:0}});
    }
  }
  eligible(g) {
    const bot=this.bot,state=bot.society.state(g.id),task=state.followup,now=Date.now(),social=bot.socialFor(g);
    if(!bot.ready||!/^\d+$/.test(g.id)||!social.enabled||social.initiativeEnabled===false||social.proactiveEnabled===false||bot.paused(g.id))return false;
    if(!g.latest?.ambientAllowed||g.processing||g.pendingDirect||g.evaluating||g.inFlight||bot.queue.some(x=>String(x.event.group_id)===g.id))return false;
    if(!task||task.status!=='pending'||task.dueAt>now||task.expiresAt<=now||state.initiativeUnanswered||state.quietUntil>now)return false;
    if(!state.lastHumanAt||state.lastHumanAt<=state.lastBotAt||now-state.lastHumanAt>300000)return false;
    if(now-(state.lastInitiativeAt||0)<300000||now-g.lastReplyAt<social.proactiveCooldownSeconds*1000)return false;
    const wake=bot.wake.get(g.id);
    if(wake.mode==='diving'&&wake.until>now)return false;
    const hour=Number(new Intl.DateTimeFormat('en-GB',{timeZone:'Asia/Shanghai',hour:'2-digit',hourCycle:'h23'}).format(new Date()));
    const [start,end]=social.quietHours||[0,0];
    if(start!==end&&(start<end?hour>=start&&hour<end:hour>=start||hour<end))return false;
    const initiatives=(state.initiatives||[]).filter(t=>now-t<3600000);
    return initiatives.length<Math.max(0,social.maxInitiativesPerHour??4)&&
      g.evalTimes.filter(t=>now-t<3600000).length<social.maxEvaluationsPerHour&&
      g.replyTimes.filter(t=>now-t<3600000).length<social.maxProactivePerHour;
  }
  start(g,id) {
    const state=this.bot.society.state(g.id),task=state.followup;
    if(!task||task.id!==id||task.status!=='queued'||task.expiresAt<=Date.now()||
      !this.bot.ready||g.pendingDirect||!g.latest?.ambientAllowed||this.bot.paused(g.id)||state.quietUntil>Date.now()||
      Date.now()-(state.lastHumanAt||0)>300000||this.bot.society.distance(g.id,task.userId)>Date.now()||
      !this.bot.memory.has(g.id,task.sourceId))return false;
    const wake=this.bot.wake.get(g.id);if(wake.mode==='diving'&&wake.until>Date.now())return false;
    this.bot.society.save(g.id,{...state,followup:{...task,status:'running',leaseUntil:Date.now()+240000}});return true;
  }
  finish(g,id,delivered) {
    const task=this.bot.society.state(g.id).followup;
    if(task?.id===id&&['queued','running'].includes(task.status))this.cancel(g,delivered?'delivered':'no_longer_relevant',delivered?'completed':'skipped');
  }
  async tick() {
    if(this.running)return;this.running=true;
    const bot=this.bot;
    try {
    for(const g of bot.groupStates.values()) {
      this.reconcile(g);
      if(!this.eligible(g)||bot.queue.length>=bot.cfg.maxQueue)continue;
      const state=bot.society.state(g.id),task=state.followup,now=Date.now();
      bot.society.save(g.id,{...state,lastInitiativeAt:now,followup:{...task,status:'queued',attempts:task.attempts+1,leaseUntil:now+240000},
        initiatives:[...(state.initiatives||[]).filter(t=>now-t<3600000),now]});
      bot.society.audit(g.id,task.userId,'initiative_considered',{id:task.id,sourceId:task.sourceId});
      g.evaluating=true;
      bot.queue.push({event:{...g.latest.event,_initiativeId:task.id},question:task.topic,mode:'ambient',initiative:true,initiativeId:task.id,
        key:`${g.id}:${g.latest.event.user_id}`,epoch:bot.connectionEpoch,enqueuedAt:now});
    }
    await bot.drain();
    }finally{this.running=false;}
  }
}
