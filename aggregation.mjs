/** Preserve the actual requester and quote boundary when batching QQ events. */
export function aggregateJobs(jobs,maxChars=6000) {
  const groups=[];
  for(const job of jobs) {
    const previous=groups.at(-1),last=previous?.at(-1);
    const quote=event=>event.message?.find(s=>s.type==='reply')?.data?.id||'';
    const casualContinuation=last&&(last.event._conversationRelation||job.event._conversationRelation)&&
      (last.event.message||[]).every(s=>['text','at'].includes(s.type))&&(job.event.message||[]).every(s=>['text','at'].includes(s.type));
    const same=last&&(String(last.event.user_id)===String(job.event.user_id)||casualContinuation)&&last.mode===job.mode&&
      (!quote(last.event)||!quote(job.event)||String(quote(last.event))===String(quote(job.event)))&&
      !last.event._interaction&&!job.event._interaction;
    if(same)previous.push(job);else groups.push([job]);
  }
  return groups.map(batch=>{
    const latest=batch.at(-1);
    const mixed=new Set(batch.map(j=>String(j.event.user_id))).size>1;
    return {...latest,question:batch.map(j=>mixed?`${j.event.sender?.card||j.event.sender?.nickname||j.event.user_id}：${j.question}`:j.question).join('\n').slice(-maxChars),enqueuedAt:batch[0].enqueuedAt,
      event:{...latest.event,_batchSourceIds:batch.flatMap(j=>j.event._batchSourceIds||[`${j.event.group_id}:${j.event.message_id}:user`]),
        _mixedBatch:mixed||batch.some(j=>j.event._mixedBatch),
        _conversationRelation:batch.find(j=>j.event._conversationRelation)?.event._conversationRelation||'',
        _imageIds:[...new Set(batch.flatMap(j=>j.event._imageIds||[]))]}};
  });
}
export function aggregationDelay(social,pending,lastText,now=Date.now()) {
  const base=Math.max(0,Number(social.directDebounceMs)||0),maxWait=Math.max(base,Number(social.directMaxWaitMs)||9000);
  const complete=String(lastText).length>=140||/[。！？!?]$/.test(String(lastText).trim());
  const pause=complete?Math.min(base,1200):base;
  return Math.max(0,Math.min(pause,pending.since+maxWait-now));
}
