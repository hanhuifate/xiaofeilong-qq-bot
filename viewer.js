let token = location.hash.slice(1) || sessionStorage.getItem('qq-viewer-token');
if (location.hash) { sessionStorage.setItem('qq-viewer-token', token); history.replaceState(null, '', '/'); }
let selected = '', busy = false;
let initialized=false,settingsChat='';
const label = chat => chat.startsWith('private:') ? `私聊 ${chat.slice(8)}` : `群 ${chat}`;
async function get(url) {
  const response = await fetch(url, { headers: { Authorization: `Bearer ${token || ''}` }, cache: 'no-store' });
  if (!response.ok) throw Error(response.status === 401 ? '请双击“查看后台.cmd”打开面板' : '后台暂未连接');
  return response.json();
}
async function post(url,value) {
  const response=await fetch(url,{method:'POST',headers:{Authorization:`Bearer ${token||''}`,'Content-Type':'application/json'},body:JSON.stringify(value)});
  const result=await response.json();if(!response.ok)throw Error(result.error||'保存失败');return result;
}
function fill(id,value){document.getElementById(id).value=value??'';}
function article(box,title,text,bot=false) {
  const node=document.createElement('article');if(bot)node.className='bot';
  const heading=document.createElement('small'),body=document.createElement('p');heading.textContent=title;body.textContent=text;
  node.append(heading,body);box.append(node);return node;
}
async function control(fn) {
  const output=document.querySelector('#control-result');output.textContent='正在处理…';
  try{const result=await fn();output.textContent=result?.message||'已完成。';await refresh();}
  catch(error){output.textContent=error.message;}
}
document.querySelector('#view').onchange=()=>refresh();
for(const [id,value] of [['pause-chat',true],['resume-chat',false]])document.getElementById(id).onclick=()=>control(()=>post('/api/settings',{chat:selected,paused:value}));
for(const [id,value] of [['pause-all',true],['resume-all',false]])document.getElementById(id).onclick=()=>control(()=>post('/api/settings',{chat:'global',paused:value}));
for(const [id,value] of [['proactive-on',true],['proactive-off',false]])document.getElementById(id).onclick=()=>control(()=>post('/api/settings',{chat:selected,proactiveEnabled:value}));
document.querySelector('#backup').onclick=()=>control(async()=>{const value=await post('/api/backup',{});return {message:`备份完成：${value.file}`};});
document.querySelector('#backfill').onclick=()=>control(()=>post('/api/history',{chat:selected}));
document.querySelector('#model-check').onclick=()=>control(()=>post('/api/model-check',{}));
document.querySelector('#refresh-diagnostics').onclick=async()=>{
  const output=document.querySelector('#diagnostics-result');
  try{
    const value=await get('/api/diagnostics');
    output.textContent=value.providers.length?value.providers.map(p=>
      `${p.provider} / ${p.model} / ${p.effort}\n调用 ${p.requests} 次，失败 ${p.failures} 次（${(100*p.failureRate).toFixed(1)}%），重试 ${p.retries} 次\n`+
      `P50 ${(p.p50Ms/1000).toFixed(1)} 秒 / P95 ${(p.p95Ms/1000).toFixed(1)} 秒\n`+
      `输入 ${p.inputTokens}，缓存 ${p.cachedTokens}（${(100*p.cacheRate).toFixed(1)}%），输出 ${p.outputTokens}，其中推理 ${p.reasoningTokens}\n`+
      `未知用量 ${p.unknownUsage} 次；${p.costMeasuredCalls?'参考费用 $'+p.estimatedCostUsd.toFixed(6):'参考费用未配置'}\n`+
      (Object.keys(p.errors).length?'错误：'+JSON.stringify(p.errors):'')).join('\n\n')+'\n\n'+value.note:'本轮尚无调用记录。';
  }catch(error){output.textContent=error.message;}
};
for(const node of document.querySelectorAll('[data-service]'))node.onclick=()=>control(async()=>{
  const value=await post('/api/service',{action:node.dataset.service});
  return {message:value.installed?value.components.map(x=>`${x.name}：${x.state}，登录自启${x.autostart?'已启用':'未启用'}`).join('\n'):'尚未安装独立服务。'};
});
document.querySelector('#save-quiet').onclick=()=>control(()=>post('/api/settings',{chat:selected,quietHours:document.querySelector('#quiet-hours').value.split(/[,，]/).map(x=>Number(x.trim()))}));
document.querySelector('#save-sharing').onclick=()=>control(()=>post('/api/settings',{chat:selected,sharedSources:document.querySelector('#shared-sources').value.split(/[,，;；\s]+/).filter(Boolean)}));
document.querySelector('#refresh-requests').onclick=()=>control(async()=>{
  const data=await get('/api/requests'),box=document.querySelector('#requests');box.replaceChildren();
  for(const item of data.requests) {
    article(box,`${item.type==='friend'?'好友申请':'群申请'} · ${item.user}${item.group?' · 群 '+item.group:''}`,item.comment||'没有填写申请说明');
    const row=box.lastElementChild;
    for(const [text,approve] of [['同意',true],['拒绝',false]]) {
      const button=document.createElement('button');button.textContent=text;row.append(button);
      button.onclick=()=>control(async()=>{
        const proposal=await post('/api/requests',{operation:'propose',requestKey:item.request_key,approve});
        const operation=confirm(proposal.message)?'confirm':'cancel';
        const result=await post('/api/requests',{operation,approvalId:proposal.pending.id});
        if(operation==='confirm')row.remove();return result;
      });
    }
  }
  return {message:data.needsOwner?'请先配置主人QQ号。':data.requests.length?'已读取待处理申请。':'没有待处理申请。'};
});
document.querySelector('#save-moderation').onclick=()=>control(()=>post('/api/moderation',{
  owners:document.querySelector('#owners').value.split(/[,，;；\s]+/).filter(Boolean),enabled:document.querySelector('#moderation-enabled').checked,dryRun:document.querySelector('#moderation-dry').checked}));
document.querySelector('#save-persona').onclick=()=>control(()=>post('/api/persona',{name:document.querySelector('#persona-name').value,style:document.querySelector('#persona-style').value,
  aliases:document.querySelector('#persona-aliases').value.split(/[,，]/).map(x=>x.trim()).filter(Boolean),
  preferences:document.querySelector('#persona-preferences').value.split(/\r?\n/).map(x=>x.trim()).filter(Boolean),
  maxReplyChars:Number(document.querySelector('#persona-max-chars').value),
  interests:document.querySelector('#persona-interests').value.split(/[,，]/).map(x=>x.trim()).filter(Boolean)}));
document.querySelector('#save-social').onclick=()=>control(()=>post('/api/settings',{chat:'global',
  proactiveCooldownSeconds:Number(document.querySelector('#social-cooldown').value),
  maxProactivePerHour:Number(document.querySelector('#social-hourly').value),
  evaluationIntervalSeconds:Number(document.querySelector('#social-evaluation').value),
  minIntervalSeconds:Number(document.querySelector('#social-evaluation').value),
  avatarRecognitionEnabled:document.querySelector('#avatar-enabled').checked}));
document.querySelector('#save-provider').onclick=()=>control(()=>post('/api/provider',{
  backend:document.querySelector('#provider-backend').value,
  model:document.querySelector('#provider-model').value.trim(),
  reasoningEffort:document.querySelector('#provider-effort').value,
  apiBase:document.querySelector('#provider-api-base').value.trim(),
  apiKeyEnv:document.querySelector('#provider-key-env').value.trim(),
  supportsImages:document.querySelector('#provider-images').checked,
  maxTokens:Number(document.querySelector('#provider-max-tokens').value),
  maxTokensField:document.querySelector('#provider-token-field').value}));
document.querySelector('#save-budget').onclick=()=>control(()=>post('/api/budget',{maxDailyTokens:Number(document.querySelector('#daily-tokens').value),maxHourlyTokens:Number(document.querySelector('#hourly-tokens').value)}));
document.querySelector('#save-pricing').onclick=()=>control(()=>post('/api/budget',{inputPerMillion:Number(document.querySelector('#input-price').value),cachedPerMillion:Number(document.querySelector('#cache-price').value),outputPerMillion:Number(document.querySelector('#output-price').value),maxDailyCost:Number(document.querySelector('#daily-cost').value)}));
document.querySelector('#save-image-provider').onclick=()=>control(()=>post('/api/image-generation',{action:'save',
  provider:document.querySelector('#image-provider').value,enabled:document.querySelector('#image-enabled').checked,
  sectionName:document.querySelector('#image-section').value,waitTimeoutSeconds:Number(document.querySelector('#image-wait').value)}));
for(const node of document.querySelectorAll('[data-image]'))node.onclick=()=>control(async()=>{
  const result=await post('/api/image-generation',{action:node.dataset.image});
  if(node.dataset.image==='Status'){const s=result.chatgpt;return {message:`ChatGPT 服务：${s.service}；扩展：${s.browserConnected?'已连接':'未连接'}；页面：${s.pageReady?'就绪':s.loginRequired?'需要登录':'未就绪'}`};}return result;
});
document.querySelector('#image-test').onclick=async()=>{
  const button=document.querySelector('#image-test');button.disabled=true;
  try{await control(()=>post('/api/image-generation',{action:'test',prompt:document.querySelector('#image-test-prompt').value,requestId:crypto.randomUUID()}));}
  finally{button.disabled=false;}
};
for(const node of document.querySelectorAll('[data-doubao]'))node.onclick=()=>control(async()=>{
  const result=await post('/api/doubao',{action:node.dataset.doubao});
  return {message:node.dataset.doubao==='Status'?`服务：${result.service}；扩展：${result.browserConnected?'已连接':'未连接'}；页面：${result.pageReady?'就绪':'未就绪'}；任务：${result.activeJob||'无'}`:'操作完成，可检查真实连接。'};
});
for(const [id,person] of [['forget-person',true],['forget-chat',false]])document.getElementById(id).onclick=()=>control(async()=>{
  if(!selected)throw Error('请先选择对话');
  const user=person?prompt('填写需要删除其本机记忆的 QQ 号'):null;
  if(person&&!user)return {message:'已取消。'};
  if(!confirm(`确定删除${label(selected)}${user?'中 QQ '+user+' 的':'的全部'}本机记忆，并重置后续上下文？历史备份和 Codex 旧聊天不会自动删除。`))return {message:'已取消。'};
  return post('/api/forget',{chat:selected,user,confirm:selected});
});
async function refresh() {
  if (busy) return; busy = true;
  try {
    const overview=await get('/api/overview');
    const image=await get('/api/image-generation'),imageState=image.chatgpt||{};
    document.querySelector('#image-status').textContent=`默认来源：${image.providerLabel||'未配置'}\nChatGPT 本机服务：${imageState.service==='ok'?'在线':'未连接'}；浏览器扩展：${imageState.browserConnected?'已连接':'未连接'}；网页：${imageState.pageReady?'就绪':imageState.quotaRequired?'生图额度不足':imageState.captchaRequired?'需要手动验证':imageState.loginRequired?'需要登录':'未就绪'}`;
    const jobs=document.querySelector('#image-jobs');jobs.replaceChildren();
    for(const job of imageState.jobs||[]){const title=({queued:'排队',opening:'打开新聊天',submitting:'提交中',running:'生成中',downloading:'取回图片',completed:'已保存图片',login_required:'等待登录',captcha_required:'等待手动验证',attention_required:'需检查网页',quota_exhausted:'额度不足',cancelled:'已取消等待',failed:'未成图'})[job.status]||job.status;
      const delivery=({waiting:'等待图片',ready:'等待 QQ 连接',sending:'发送中',delivered:'已发回 QQ',delivery_uncertain:'发送结果待核对',uncertain:'仍待确认结果'})[job.deliveryStatus]||'';
      const item=article(jobs,job.id+' · '+title+(job.late?'（继续等待中）':''),`对话收纳：${job.groupStatus==='grouped'?'已归入分组':'待同步'}${delivery?' · '+delivery:''} · ${new Date(job.createdAt).toLocaleString()}`);
      if(job.conversationUrl&&/^https:\/\/chatgpt\.com\/c\/[a-f0-9-]{36}$/.test(job.conversationUrl)){const link=document.createElement('a');link.href=job.conversationUrl;link.target='_blank';link.rel='noreferrer';link.textContent='查看图片聊天';item.append(link);}
      if(!['completed','cancelled','failed','quota_exhausted','attention_required'].includes(job.status)){const cancel=document.createElement('button');cancel.textContent='取消等待';cancel.onclick=()=>control(async()=>{if(!confirm('停止等待此任务？已经提交到网页的生成请求和聊天记录仍然保留。'))return {message:'继续等待。'};return post('/api/image-generation',{action:'cancel',jobId:job.id});});item.append(cancel);}
    }
    const daily=overview.budget?.day,storage=overview.storage;
    document.querySelector('#overview').textContent=`${overview.ready?'QQ 已连接':'QQ 等待连接'}${overview.providerUnavailable?' · 模型额度暂不可用':''} · ${storage?.backend||'本地记录'} · ${storage?.events||0} 条聊天 / ${storage?.memories||0} 条分层记忆 · ${storage?.uncertainDeliveries||0} 条发送结果待核${daily?.estimatedCalls?' · 今日含 '+daily.estimatedCalls+' 次估算':''}${overview.lastBackupError?' · 备份异常':''}`;
    if(!initialized) {
      fill('image-provider',image.settings?.provider||'chatgpt');fill('image-section',image.settings?.sectionName||'图片');fill('image-wait',image.settings?.waitTimeoutSeconds||1200);
      document.querySelector('#image-enabled').checked=image.settings?.enabled!==false;
      fill('owners',(overview.moderation?.owners||[]).join(','));
      document.querySelector('#moderation-enabled').checked=overview.moderation?.enabled===true;
      document.querySelector('#moderation-dry').checked=overview.moderation?.dryRun===true;
      fill('persona-name',overview.persona?.name);fill('persona-style',overview.persona?.style);fill('persona-interests',(overview.persona?.interests||[]).join(','));
      fill('persona-max-chars',overview.persona?.maxReplyChars??3500);
      fill('persona-aliases',(overview.persona?.aliases||[]).join(','));fill('persona-preferences',(overview.persona?.preferences||[]).join('\n'));
      const provider=await get('/api/provider');
      fill('provider-backend',provider.backend);fill('provider-model',provider.backend==='codex'?provider.codexModel:provider.model);
      fill('provider-effort',provider.reasoningEffort);fill('provider-api-base',provider.apiBase);fill('provider-key-env',provider.apiKeyEnv);
      fill('provider-max-tokens',provider.maxTokens);fill('provider-token-field',provider.maxTokensField);
      document.querySelector('#provider-images').checked=provider.supportsImages;
      document.querySelector('#provider-key-status').textContent=provider.backend==='codex'?'当前使用本机 Codex 登录，不需要兼容 API 密钥。':
        `${provider.apiKeyEnv}：${provider.keyConfigured?'已配置':'未配置'}。密钥值不会显示或回传。`;
      const globalSettings=await get('/api/settings?chat=global'),social={...globalSettings.defaults,...globalSettings.social};
      fill('social-cooldown',social.proactiveCooldownSeconds);fill('social-hourly',social.maxProactivePerHour);fill('social-evaluation',social.evaluationIntervalSeconds);
      document.querySelector('#avatar-enabled').checked=social.avatarRecognitionEnabled!==false;
      fill('daily-tokens',overview.budget?.limits.maxDailyTokens);fill('hourly-tokens',overview.budget?.limits.maxHourlyTokens);initialized=true;
      fill('input-price',overview.budget?.limits.inputPerMillion);fill('cache-price',overview.budget?.limits.cachedPerMillion);fill('output-price',overview.budget?.limits.outputPerMillion);fill('daily-cost',overview.budget?.limits.maxDailyCost);
    }
    const sessions = await get('/api/sessions');
    if (!selected && sessions.length) selected = sessions[0].chat;
    const nav = document.querySelector('#sessions'); nav.replaceChildren();
    for (const session of sessions) {
      const button = document.createElement('button'); button.textContent = `${label(session.chat)} · ${session.turns} 轮`;
      button.classList.toggle('selected', selected === session.chat);
      button.onclick = () => { selected = session.chat; refresh(); }; nav.append(button);
    }
    const session = sessions.find(x => x.chat === selected);
    if(selected&&settingsChat!==selected){const value=await get(`/api/settings?chat=${encodeURIComponent(selected)}`);fill('quiet-hours',(value.social?.quietHours||[0,0]).join(','));fill('shared-sources',(value.sharedSources||[]).join(','));settingsChat=selected;}
    if (session) {
      document.querySelector('#title').textContent = label(selected);
      const usage = session.lastUsage || {};
      const wake = session.wake;
      const wakeText = wake ? `\n状态：${({ diving: '潜水', observing: '观察', engaged: '参与当前话题' })[wake.mode]} · 本小时主动唤醒 ${wake.hourlyWakes} 次${wake.until > Date.now() ? ' · 至 ' + new Date(wake.until).toLocaleTimeString() : ''}` : '';
      document.querySelector('#metrics').textContent = `${session.model || '尚未调用模型'} · 会话 ${session.threadId || '未建立'}\n最近耗时 ${((session.lastModelMs || 0) / 1000).toFixed(1)} 秒 · 缓存 ${session.lastCachePercent ?? '—'}%（${usage.cached_input_tokens ?? 0}/${usage.input_tokens ?? 0} 输入 token）${wakeText}`;
      const view=document.querySelector('#view').value;
      const records = view==='messages'?await get(`/api/messages?chat=${encodeURIComponent(selected)}`):[];
      const box = document.querySelector('#messages'); const atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 80;
      box.replaceChildren();
      if(view==='memories'||view==='relationships') {
        const data=await get(`/api/social?chat=${encodeURIComponent(selected)}`);
        if(view==='memories') {
          const evidence=await get(`/api/memory-evidence?chat=${encodeURIComponent(selected)}`);
          article(box,'当前话题与对话摘要',data.summary||'尚未形成摘要。');
          for(const item of data.openLoops||[])article(box,'未完成的对话 · '+item.userId,item.question);
          for(const item of data.learnedMemories||[]) {
            const node=article(box,({episodic:'情景记忆',longterm:'长期记忆',preference:'偏好',correction:'更正'})[item.kind]+' · '+new Date(item.updated_at).toLocaleString(),item.text);
            if(evidence.revisions.some(x=>x.memory_id===item.id&&!x.reverted_at)) {
              const undo=document.createElement('button');undo.textContent='回滚这次更正';undo.onclick=()=>control(async()=>{
                if(!confirm(`确定撤销这条更正并恢复之前的记忆？\n${item.text}`))return {message:'已取消。'};
                const result=await post('/api/memory-rollback',{chat:selected,memoryId:item.id,confirm:item.id});
                return {message:result.restored?'已恢复更正前的记忆。':'已撤销没有旧值的记忆。'};
              });node.append(undo);
            }
          }
          for(const item of evidence.candidates||[])article(box,`纠错证据 · ${item.status==='candidate'?'待验证':item.status==='adopted'?'已采纳':'已回滚'} · ${item.strength==='strong'?'强':'弱'} · 群友 ${item.user}`,
            `${item.text}\n来源消息：${item.source_id}\n目标回复：${item.target_id}`);
        } else for(const item of data.relationships||[])article(box,`${item.name||item.user} · ${item.user}`,`收到 ${item.humanMessages} 条消息，回复 ${item.botReplies} 次\n共同话题：${(item.sharedTopics||[]).join('、')||'尚无'}\n首次互动：${new Date(item.firstSeen).toLocaleString()}`);
      }
      if(view==='decisions') {
        for(const item of await get(`/api/deliveries?chat=${encodeURIComponent(selected)}`))
          article(box,`QQ 发送 · ${item.status} · ${new Date(item.updated_at).toLocaleString()}`,
            `来源：${item.source_id}${item.provider_message_id?'\n回执：'+item.provider_message_id:''}${item.error?'\n错误：'+item.error:''}`);
        for(const item of await get(`/api/decisions?chat=${encodeURIComponent(selected)}`))
          article(box,new Date(item.at).toLocaleString()+' · '+item.action,JSON.stringify(item.data,null,2));
      }
      for (const record of records) {
        const article = document.createElement('article'); article.className = record.role === 'assistant' ? 'bot' : '';
        const small = document.createElement('small'); small.textContent = `${record.speaker || (record.role === 'assistant' ? overview.persona?.name||'机器人' : '群友')} · ${new Date(record.at).toLocaleString()}`;
        const text = document.createElement('p'); text.textContent = record.text; article.append(small, text); box.append(article);
      }
      if (atBottom) box.scrollTop = box.scrollHeight;
    } else document.querySelector('#metrics').textContent = '还没有持久会话，收到下一条 QQ 消息后会出现在这里。';
    document.querySelector('#status').textContent = `已连接 · ${new Date().toLocaleTimeString()}`;
  } catch (error) { document.querySelector('#status').textContent = error.message; }
  finally { busy = false; }
}
refresh(); setInterval(refresh, 3000);
