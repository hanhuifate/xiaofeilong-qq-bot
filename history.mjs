/** Backfill stores history only; recovered text never becomes a new command. */
export async function backfillGroup(bot,chat,count=40) {
  chat=String(chat);
  if(!/^\d+$/.test(chat)||!bot.memory.enabled)return {added:0};
  const data=await bot.api.call('get_group_msg_history',{group_id:Number(chat),count:Math.max(1,Math.min(100,count))});
  let added=0;
  for(const raw of (data?.messages||[]).slice().sort((a,b)=>Number(a.time)-Number(b.time))) {
    if(raw.message_id===undefined||String(raw.group_id||chat)!==chat||raw.self_id&&String(raw.self_id)!==bot.cfg.botQQ)continue;
    const self=String(raw.user_id)===bot.cfg.botQQ,role=self?'assistant':'user';
    const id=`${chat}:${raw.message_id}:${role}`;
    if(bot.memory.has(chat,id)||bot.memory.store?.setting(chat,'memory:'+raw.user_id)===false)continue;
    const segments=Array.isArray(raw.message)?raw.message:[];
    let text=segments.map(item=>item.type==='text'?String(item.data?.text||''):
      item.type==='at'?`[@${item.data?.qq}]`:item.type==='face'?`[QQ表情 id=${item.data?.id}]`:
      item.type==='image'?'[图片]':item.type==='record'?'[历史语音，未转写]':item.type==='reply'?`[引用消息 id=${item.data?.id}]`:'').join('');
    if(!text)text=String(raw.raw_message||'[历史非文字消息]');
    const at=Number(raw.time)>0?Number(raw.time)*1000:Date.now();
    const user=String(raw.user_id),speaker=String(raw.sender?.card||raw.sender?.nickname||user).slice(0,60);
    const record={id,role,user:self?'':user,speaker:self?(bot.cfg.persona?.name||'大肥龙'):speaker,text,at,
      replyToMessage:String(segments.find(x=>x.type==='reply')?.data?.id||''),
      addressedToOthers:segments.some(x=>x.type==='at'&&String(x.data?.qq)!==bot.cfg.botQQ),imageIds:[],backfilled:true};
    bot.memory.add(chat,record);added++;
    if(bot.memory.store&&!self) {
      const relationship=bot.memory.store.relationship(chat,user);
      bot.memory.store.relationship(chat,user,{firstSeen:Math.min(relationship.firstSeen,at),lastSeen:Math.max(relationship.lastSeen||0,at),
        name:at>=(relationship.lastSeen||0)?speaker:relationship.name,humanMessages:relationship.humanMessages+1});
    }
  }
  const g=bot.group(chat);g.messages=bot.memory.recent(chat,bot.social.contextMessages,bot.social.contextTtlMinutes);
  bot.society.audit(chat,'','history_backfilled',{added,requested:count});return {added};
}
