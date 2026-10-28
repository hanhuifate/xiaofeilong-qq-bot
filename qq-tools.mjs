import {createHash} from 'node:crypto';
const canonical=value=>Array.isArray(value)?value.map(canonical):value&&typeof value==='object'?Object.fromEntries(Object.keys(value).sort().map(k=>[k,canonical(value[k])])):value;
/** Model arguments never supply an actor, target chat, login, permission or file path. */
export function createQQToolDispatcher(bot) {
 const execute=async(name,args,context,call)=>{
  const host=context._host,event=host?.event,chat=String(call.chat),g=bot.group(chat);
  if(!host||!event||host.chat!==chat||!bot.ready||host.epoch!==bot.connectionEpoch||host.contextEpoch!==(g.contextEpoch||0)||bot.paused(chat))throw Error('QQ_CONTEXT_EXPIRED');
  const direct=context.mode==='direct';
  switch(name) {
   case 'qq_memory':{
    if(!bot.memory.enabled)throw Error('MEMORY_DISABLED');
    const query=String(args.query).trim().slice(0,180);
    if(!query)throw Error('MEMORY_QUERY_EMPTY');
    const local=bot.memory.searchLocal(query,chat);
    const learned=bot.memory.store?.memories(chat,query,6)||[];
    const other=args.scope==='authorized'&&!event._mixedBatch?await bot.authorizedMemorySearch(query,chat,event):[];
    return {data:{local,learned,other,notice:'仅为本机真实保留且当前发言人获准访问的资料，日期与来源见各记录。'}};
   }
   case 'qq_context':{
    let data;
    if(args.kind==='identity')data=context.hostIdentity;
    if(args.kind==='permissions')data=direct&&!event._mixedBatch&&bot.moderation.enabled?await bot.moderation.context(event):{enabled:false};
    if(args.kind==='relationships')data=(bot.memory.store?.relationships(chat)||[]).filter(x=>!args.userId||String(x.user)===args.userId).slice(-12);
    if(args.kind==='images')data=bot.media.enabled?bot.media.catalog(chat):[];
    if(args.kind==='poke_targets')data=context.pokeTargets;
    if(args.kind==='first_message')data={record:bot.memory.firstUserMessage(chat,args.userId||String(event.user_id))||null,
      notice:'只代表本机保留的最早消息，不是QQ账号创建以来第一句。'};
 return {data:data??{}};
   }
   case 'qq_image':{
    if(!bot.media.enabled||!bot.media.get(chat,args.imageId))throw Error('IMAGE_NOT_AVAILABLE');
    const images=bot.media.attachments(chat,[args.imageId]);
    return {data:{imageId:args.imageId,status:images.length?'loaded':'unavailable'},images,patch:{_toolImageIds:[args.imageId]}};
   }
   case 'qq_avatar':{
    if(!context.avatarAllowed||!context.avatarTargets.some(x=>x.id===args.userId))throw Error('AVATAR_TARGET_NOT_ALLOWED');
    const imageId=await bot.avatars.read(chat,args.userId,bot.media);
    const images=bot.media.attachments(chat,[imageId]);
    return {data:{userId:args.userId,imageId,status:images.length?'loaded':'unavailable'},images,
      patch:{imageNotes:[],_avatarImageIds:[imageId],_toolImageIds:[imageId]}};
   }
   case 'qq_browser':{
    if(!direct||!context.browserAllowed||args.type==='none')throw Error('BROWSER_NOT_ALLOWED');
    const result=await bot.browser.act(chat,args,{allowTest:context.browserTestAllowed});
    return {data:{status:'completed',url:result?.url,title:result?.title},
      images:result?.imagePath?[{path:result.imagePath}]:[],patch:{_browserImagePath:result?.imagePath||''}};
   }
   case 'qq_draw':{
    if(!direct||!context.doubaoImageAllowed||!args.prompt?.trim())throw Error('DRAW_NOT_ALLOWED');
    const result=await bot.queueDoubaoImage(event,chat,args);
    return {data:{jobId:result.job_id,provider:result.provider||bot.doubao.provider||'doubao',status:'queued',notice:'尚未生成完成，后台等待图片后会发送，不要再次提交。'}};
   }
   case 'qq_manage':{
    if(!direct||event._mixedBatch||!bot.moderation.enabled)throw Error('MANAGEMENT_NOT_ALLOWED');
    const result=await bot.moderation.decision(event,args);
    return {data:result||{handled:false},patch:{_managementResult:result}};
   }
   case 'qq_prepare_reply':{
    if(args.imageId&&!bot.media.get(chat,args.imageId))throw Error('IMAGE_NOT_AVAILABLE');
    if(args.pokeTarget&&!context.pokeTargets.some(x=>String(x.id||x)===args.pokeTarget))throw Error('POKE_TARGET_NOT_ALLOWED');
    if(!direct&&(args.memoryControl?.operation&&args.memoryControl.operation!=='none'))throw Error('MEMORY_CONTROL_NOT_ALLOWED');
    if(event._mixedBatch&&(args.memoryControl?.operation&&args.memoryControl.operation!=='none'))throw Error('MEMORY_CONTROL_NOT_ALLOWED');
    return {data:{status:'prepared',notice:'提议已收取，尚未实际发出；宿主在最终答复后再次验权。'},patch:args};
   }
   default:throw Error('QQ_TOOL_UNKNOWN');
  }
 };
 let receiptsReady=false;
 return async(name,args,context,call)=>{
  if(!['qq_draw','qq_manage'].includes(name))return execute(name,args,context,call);
  const host=context._host,event=host?.event,chat=String(call.chat),db=bot.memory.store?.db;
  if(!db||!event||host.chat!==chat||!bot.ready||host.epoch!==bot.connectionEpoch||host.contextEpoch!==(bot.group(chat).contextEpoch||0)||bot.paused(chat))throw Error('QQ_CONTEXT_EXPIRED');
  if(!receiptsReady){db.exec('CREATE TABLE IF NOT EXISTS qq_tool_receipts(id TEXT PRIMARY KEY,chat TEXT NOT NULL,actor TEXT NOT NULL,at INTEGER NOT NULL,state TEXT NOT NULL,payload TEXT NOT NULL)');
   db.prepare('DELETE FROM qq_tool_receipts WHERE at<?').run(Date.now()-30*86400000);receiptsReady=true;}
  const source=String(event.message_id||context.batchSourceIds?.join(',')||call.turnId);
  const id=createHash('sha256').update(JSON.stringify([chat,String(event.user_id),source,name,canonical(args)])).digest('hex');
  const previous=db.prepare('SELECT state,payload FROM qq_tool_receipts WHERE id=?').get(id);
  if(previous){if(previous.state==='completed')return JSON.parse(previous.payload);throw Error('TOOL_PREVIOUS_RESULT_UNCERTAIN');}
  db.prepare('INSERT INTO qq_tool_receipts VALUES(?,?,?,?,?,?)').run(id,chat,String(event.user_id),Date.now(),'pending','{}');
  try{const result=await execute(name,args,context,call);db.prepare("UPDATE qq_tool_receipts SET state='completed',payload=? WHERE id=?").run(JSON.stringify(result),id);return result;}
  catch(error){db.prepare("UPDATE qq_tool_receipts SET state='uncertain' WHERE id=?").run(id);throw error;}
 };
}
