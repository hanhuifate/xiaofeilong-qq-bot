/** Host identity comes from local settings, never from a chat's claimed role. */
export function hostIdentity(botId,owners,requesterId) {
  const ownerUserIds=[...new Set((owners||[]).map(String).filter(id=>/^\d{5,12}$/.test(id)))];
  return {botId:String(botId),ownerUserIds,requesterIsOwner:ownerUserIds.includes(String(requesterId)),
    ownerMeaning:'机器人主人和部署管理者，不是模型厂商；管理动作仍须独立验权和确认'};
}

function messageView(item) {
  if(!item)return null;
  return {id:item.id,at:item.at,user:item.user||item.forUser||'',speaker:item.speaker||'',role:item.role,
    text:String(item.text||'').slice(0,1000),...(item.quote?{quote:item.quote}:{}),
    ...(item.replyToMessage?{replyToMessage:item.replyToMessage}:{})};
}

/** A bounded recent exchange accompanies delta packets to keep referents local. */
export function dialogueContext(memory,chat,recent,event) {
  const quote=event._quote||null;
  const ordinary=recent.filter(item=>!/:image:|:poke:/.test(item.id||''));
  return {recentExchange:ordinary.slice(-12).map(messageView),
    quotedMessage:quote,
    quotedExchange:quote?(memory.around?.(chat,quote.id,3)||[]).map(messageView):[],
    firstRecordedUserMessage:messageView(memory.firstUserMessage?.(chat,String(event.user_id))),
    historyBoundary:'firstRecordedUserMessage只是当前对话中本机实际保留的最早用户消息；不证明是QQ账号创建以来的第一句话。'};
}
