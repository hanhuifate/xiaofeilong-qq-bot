import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import {backfillGroup} from './history.mjs';
import {manageService} from './service.mjs';

export async function startViewer(root, sessions, memory, port = 6098, wake = null, controls = {}) {
  const tokenFile = path.join(root, 'data', 'viewer-token.txt');
  fs.mkdirSync(path.dirname(tokenFile), { recursive: true });
  let token;
  try { token = fs.readFileSync(tokenFile, 'utf8').trim(); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  if (!token) { token = randomBytes(32).toString('hex'); fs.writeFileSync(tokenFile, token, { mode: 0o600 }); }
  const secret = Buffer.from(token);
  const server = http.createServer(async(req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    const send = (code, type, body) => {
      res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
        'Referrer-Policy': 'no-referrer', 'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; frame-ancestors 'none'; base-uri 'none'" });
      res.end(body);
    };
    const origin=`http://127.0.0.1:${server.address().port}`;
    if (!['GET','POST'].includes(req.method) || req.headers.host !== `127.0.0.1:${server.address().port}` || req.headers.origin&&req.headers.origin!==origin) return send(403, 'text/plain', 'Forbidden');
    try {
    if (url.pathname.startsWith('/api/')) {
      const supplied = Buffer.from(String(req.headers.authorization || '').replace(/^Bearer /, ''));
      if (supplied.length !== secret.length || !timingSafeEqual(secret, supplied)) return send(401, 'application/json', '{"error":"请双击 查看后台.cmd 打开"}');
      const reply=value=>send(200,'application/json; charset=utf-8',JSON.stringify(value));
      const store=memory.store,bot=controls.bot;
      const chat=url.searchParams.get('chat')||'';
      if(req.method==='POST') {
        const allowed=new Set(['/api/settings','/api/backup','/api/forget','/api/memory-rollback','/api/moderation','/api/budget','/api/doubao','/api/image-generation','/api/persona','/api/provider','/api/requests','/api/history','/api/model-check','/api/service']);
        if(!allowed.has(url.pathname)||!req.headers['content-type']?.startsWith('application/json'))return send(403,'text/plain','Forbidden');
        let raw='';for await(const chunk of req){raw+=chunk;if(Buffer.byteLength(raw)>32768)return send(413,'text/plain','Request too large');}
        let body;try{body=JSON.parse(raw);}catch{return send(400,'application/json','{"error":"数据格式不正确"}');}
        if(!body||Array.isArray(body)||typeof body!=='object')return send(400,'application/json','{"error":"数据格式不正确"}');
        if(url.pathname==='/api/service')return reply(await manageService(root,body.action||'Status'));
        if(url.pathname==='/api/model-check') {
          if(!controls.onModelCheck)throw Error('模型检查未接入');
          return reply(await controls.onModelCheck());
        }
        if(url.pathname==='/api/history') {
          if(!bot||!/^\d{5,12}$/.test(body.chat||''))throw Error('请选择群聊');
          const groups=await bot.api.call('get_group_list');
          if(!groups.some(x=>String(x.group_id)===body.chat))throw Error('机器人不在这个群里');
          const result=await backfillGroup(bot,body.chat,40);return reply({ok:true,message:`已补录 ${result.added} 条消息，没有执行历史消息里的请求。`});
        }
        if(url.pathname==='/api/requests') {
          const owner=bot?.moderation.settings().owners[0];if(!owner)throw Error('请先配置主人QQ号');
          const event={self_id:Number(bot.cfg.botQQ),user_id:Number(owner),message_type:'private',_private:true};
          let decision;
          if(body.operation==='propose') {
            const context=await bot.moderation.context(event),item=context.requests?.find(x=>x.request_key===body.requestKey);
            if(!item||typeof body.approve!=='boolean')throw Error('申请不存在或已经处理');
            decision={operation:'propose',kind:item.type==='friend'?'friend_request':'group_request',requestKey:item.request_key,approve:body.approve};
          } else if(['confirm','cancel'].includes(body.operation)&&typeof body.approvalId==='string'&&body.approvalId)decision={operation:body.operation,approvalId:body.approvalId};
          else throw Error('请选择明确的申请操作');
          const result=await bot.moderation.decision(event,decision),context=await bot.moderation.context(event);
          if(body.operation==='propose'&&!context.pending)throw Error(result?.text||'未创建待确认操作');
          return reply({ok:true,message:result?.text,pending:context.pending||null});
        }
        if(url.pathname==='/api/backup') {
          if(!store)throw Error('尚未启用 SQLite 存储');
          const file=await store.backup();return reply({ok:true,file:path.basename(file)});
        }
        if(url.pathname==='/api/settings') {
          if(!store||!/^global$|^(?:private:)?\d+$/.test(body.chat||''))throw Error('请选择有效的对话');
          if(typeof body.paused==='boolean')store.setting(body.chat,'paused',body.paused);
          const social=store.setting(body.chat,'social')||{};
          for(const key of ['activeMode','proactiveEnabled','avatarRecognitionEnabled'])if(typeof body[key]==='boolean')social[key]=body[key];
          for(const [key,min,max] of [['proactiveCooldownSeconds',5,600],['maxProactivePerHour',1,120],['evaluationIntervalSeconds',5,600],['minIntervalSeconds',5,600]])if(body[key]!==undefined){if(!Number.isInteger(body[key])||body[key]<min||body[key]>max)throw Error('接话频率超出允许范围');social[key]=body[key];}
          if(body.quietHours!==undefined){if(!Array.isArray(body.quietHours)||body.quietHours.length!==2||body.quietHours.some(x=>!Number.isInteger(x)||x<0||x>23))throw Error('安静时段必须是 0 到 23 的两个小时');social.quietHours=body.quietHours;}
          store.setting(body.chat,'social',social);
          if(body.sharedSources!==undefined){if(!Array.isArray(body.sharedSources)||body.sharedSources.some(x=>!/^\d{5,12}$/.test(String(x))))throw Error('共享来源请填写群号');store.setting(body.chat,'sharedSources',[...new Set(body.sharedSources.map(String))]);}
          store.audit(body.chat,'local-panel','settings_changed',{...body});return reply({ok:true});
        }
        if(url.pathname==='/api/forget') {
          if(!store||! /^(?:private:)?\d+$/.test(body.chat||''))throw Error('请选择有效的对话');
          if(body.user&&!/^\d{5,12}$/.test(body.user))throw Error('QQ号格式不正确');
          if(body.confirm!==body.chat)throw Error('删除尚未确认');
          await bot?.forgetConversation(body.chat,body.user||null);
          store.audit(body.chat,'local-panel','memory_deleted',{user:body.user||'all'});return reply({ok:true});
        }
        if(url.pathname==='/api/memory-rollback') {
          if(!store||! /^(?:private:)?\d+$/.test(body.chat||'')||!/^[a-f0-9]{64}$/.test(body.memoryId||''))throw Error('记忆回滚参数不正确');
          if(body.confirm!==body.memoryId)throw Error('回滚尚未确认');
          return reply({ok:true,...store.rollbackMemory(body.chat,body.memoryId,'local-panel')});
        }
        if(url.pathname==='/api/moderation') {
          if(!bot)throw Error('机器人未连接');
          if(!Array.isArray(body.owners)||body.owners.some(x=>!/^\d{5,12}$/.test(String(x))))throw Error('主人QQ号格式不正确');
          const value={...bot.moderation.settings(),owners:[...new Set(body.owners.map(String))]};
          for(const key of ['enabled','dryRun'])if(typeof body[key]==='boolean')value[key]=body[key];
          const target=bot.moderation.settingsFile,temp=target+'.tmp';fs.writeFileSync(temp,JSON.stringify(value,null,2));fs.renameSync(temp,target);
          store?.audit('global','local-panel','moderation_settings_changed',{ownerCount:value.owners.length,enabled:value.enabled,dryRun:value.dryRun});
          return reply({ok:true});
        }
        if(url.pathname==='/api/budget') {
          if(!store||!controls.budget)throw Error('预算系统未启用');
          const value={...controls.budget.settings};
          for(const key of ['maxHourlyTokens','maxDailyTokens','maxDailyCost','inputPerMillion','cachedPerMillion','outputPerMillion'])if(body[key]!==undefined){if(!Number.isFinite(body[key])||body[key]<0||body[key]>1e10)throw Error('预算必须是非负数');value[key]=body[key];}
          if(typeof body.enabled==='boolean')value.enabled=body.enabled;
          if(value.maxDailyCost>0&&!(value.inputPerMillion>0||value.outputPerMillion>0))throw Error('启用费用限额前请先填写参考单价');
          store.setting('global','budget',value);controls.budget.settings=value;return reply({ok:true});
        }
        if(url.pathname==='/api/persona') {
          if(!controls.onPersona)throw Error('人格编辑暂不可用');
          await controls.onPersona(body);return reply({ok:true});
        }
        if(url.pathname==='/api/provider') {
          if(!controls.onModelSettings)throw Error('模型设置暂不可用');
          return reply({ok:true,...await controls.onModelSettings(body),
            message:'模型提供商配置已保存；重启回复服务后生效。'});
        }
        if(url.pathname==='/api/image-generation') {
          if(!bot?.doubao?.summary)throw Error('图片服务尚未接入');
          if(body.action==='save') {
            const settings=bot.doubao.saveSettings(body);
            store?.audit('global','local-panel','image_provider_changed',{provider:settings.provider,enabled:settings.enabled});
            return reply({ok:true,settings,message:'生图设置已保存，下次请求立即生效；进行中的任务沿用原来源。'});
          }
          if(body.action==='cancel'){bot.doubao.chatgpt.cancel(body.jobId);return reply({ok:true,message:'已停止等待这个任务，网页聊天和已经生成的图片仍保留。'});}
          if(body.action==='resumeExisting'){
            const result=bot.doubao.chatgpt.resumeExisting(body.jobId);
            store?.audit('global','local-panel','image_existing_export_resumed',{jobId:body.jobId});
            return reply({...result,message:'将继续读取原来的图片聊天，不会再次提交提示词。'});
          }
          if(body.action==='test'){
            if(bot.doubao.provider!=='chatgpt')throw Error('请先选择 ChatGPT 生图来源');
            if(typeof body.prompt!=='string'||!body.prompt.trim()||body.prompt.length>3000||! /^(?:[a-f0-9-]{36})$/.test(body.requestId||''))throw Error('请填写测试提示词');
            const created=await bot.doubao.generate('local-panel',{prompt:body.prompt,ratio:'1:1',requestId:body.requestId});
            return reply({ok:true,jobId:created.job_id,message:'已提交一张 ChatGPT 测试图，会占用网页额度；结果只保存在本机，不发送到 QQ。'});
          }
          if(body.action==='sendToOwner'){
            const owner=String(bot.moderation?.settings().owners[0]||'');
            if(!/^\d{5,12}$/.test(owner))throw Error('请先配置主人QQ号');
            const job=bot.doubao.chatgpt.jobs[body.jobId];
            const testHash=createHash('sha256').update('local-panel').digest('hex').slice(0,16);
            if(!job||job.chatHash!==testHash||job.status!=='completed'||!bot.doubao.imagePath(job.images?.[0]))throw Error('请先等本机测试图保存完成');
            const target='private:'+owner,old=bot.doubao.deliveries[job.id];
            if(old&&old.chat!==target)throw Error('此图片已有其他交付目标');
            if(!old){
              bot.doubao.saveDelivery(job.id,{provider:'chatgpt',chat:target,user:owner,prompt:job.prompt,status:'ready',createdAt:Date.now(),
                event:{message_type:'private',group_id:target,user_id:Number(owner),message_id:'image-job:'+job.id}});
              store?.audit('global','local-panel','image_test_send_requested',{jobId:job.id,owner});
            }
            bot.watchDoubaoDelivery(job.id);
            return reply({ok:true,jobId:job.id,owner,deliveryStatus:bot.doubao.deliveries[job.id].status,message:'图片已加入主人私聊的交付队列；QQ离线时保留，恢复后补发。'});
          }
          if(!['Start','Stop','Restart','Status','Login','InstallExtension'].includes(body.action))throw Error('请选择明确的图片服务操作');
          if(body.action==='Status')return reply(bot.doubao.summary());
          if(body.action==='Stop')bot.doubao.saveSettings({browserEnabled:false});
          else bot.doubao.saveSettings({browserEnabled:true});
          const value=await (['Login','InstallExtension'].includes(body.action)?bot.doubao.manageChatGPTBrowser(body.action):bot.doubao.manageBrowser(body.action));return reply({ok:true,...value,message:body.action==='Login'?'已打开网页登录，请使用与桌面端相同的账号。':body.action==='InstallExtension'?'已打开扩展页与源码文件夹；请加载一次本机扩展，然后点击打开 ChatGPT 登录。':'浏览器操作已完成。'});
        }
        if(url.pathname==='/api/doubao') {
          if(!bot||!['Start','Stop','Restart','Status'].includes(body.action))throw Error('豆包操作不正确');
          if(body.action==='Status') {
            const value=await (bot.doubao.legacy||bot.doubao).tool('doubao_status',{});
            return reply({service:value.service,browserConnected:value.browser_connected,pageReady:value.doubao_page_ready,activeJob:value.active_job_id});
          }
          const result=await (bot.doubao.legacy||bot.doubao).manageBrowser(body.action);
          return reply({ok:true,running:result.running,enabled:result.enabled});
        }
      }
      if(url.pathname==='/api/image-generation')return reply(bot?.doubao?.summary?.()||{settings:{},chatgpt:{service:'offline'}});
      if(url.pathname==='/api/diagnostics')return reply(controls.diagnostics?.summary(Number(url.searchParams.get('hours'))||24)||{providers:[],note:'尚未接入本轮统计'});
      if(url.pathname==='/api/overview')return reply({ready:bot?.ready,state:controls.status?.state,model:bot?.cfg.model,
        storage:store?.stats(),budget:controls.budget?.summary(),moderation:bot?.moderation.settings(),persona:bot?.cfg.persona,
        lastBackupAt:controls.status?.lastBackupAt,lastBackupError:controls.status?.lastBackupError,
        lastError:controls.status?.lastError,lastDecision:controls.status?.lastDecision,transport:controls.status?.transport,
        lastModelCheckAt:controls.status?.lastModelCheckAt,lastModelCheckError:controls.status?.lastModelCheckError,
        providerUnavailable:controls.status?.providerUnavailable,providerCooldownUntil:controls.status?.providerCooldownUntil});
      if(url.pathname==='/api/provider') {
        let raw={};try{raw=JSON.parse(fs.readFileSync(path.join(root,'config.json'),'utf8').replace(/^\uFEFF/,''));}catch{}
        const llm=raw.llm||{},keyEnv=String(llm.apiKeyEnv||'DFL_API_KEY');
        return reply({backend:llm.type==='openai_compatible'?'openai_compatible':'codex',
          codexModel:String(raw.model||''),reasoningEffort:String(raw.reasoningEffort||'high'),
          apiBase:String(llm.apiBase||''),model:String(llm.model||raw.model||''),apiKeyEnv:keyEnv,
          keyConfigured:!!process.env[keyEnv],supportsImages:llm.supportsImages!==false,
          maxTokens:Number(llm.maxTokens)||3000,maxTokensField:String(llm.maxTokensField||'max_tokens'),
          timeoutSeconds:Number(llm.timeoutSeconds)||90,savedRequiresRestart:!!controls.status?.modelSettingsPendingRestart});
      }
      if(url.pathname==='/api/requests') {
        const owner=bot?.moderation.settings().owners[0];if(!owner)return reply({requests:[],needsOwner:true});
        const context=await bot.moderation.context({self_id:Number(bot.cfg.botQQ),user_id:Number(owner),message_type:'private',_private:true});
        return reply({requests:context.requests||[],pending:context.pending||null});
      }
      if(url.pathname==='/api/social')return reply(bot?.society.snapshot(chat,'',bot?.contextFor(chat)||[],'')||{});
      if(url.pathname==='/api/memory-evidence') {
        if(!store||! /^(?:private:)?\d+$/.test(chat))throw Error('请选择有效的对话');
        return reply({candidates:store.feedbackCandidates(chat),revisions:store.memoryRevisions(chat)});
      }
      if(url.pathname==='/api/decisions')return reply(store?.decisions(chat)||[]);
      if(url.pathname==='/api/deliveries')return reply(store?.deliveryIntents(chat)||[]);
      if(url.pathname==='/api/settings')return reply({chat,paused:store?.setting(chat,'paused')||false,social:store?.setting(chat,'social')||{},defaults:bot?.cfg.social||{},sharedSources:store?.setting(chat,'sharedSources')||[],globalPaused:store?.setting('global','paused')||false});
      if (url.pathname === '/api/sessions') {
        const chats = new Set([...Object.keys(sessions.state.sessions), ...Object.keys(wake?.state.chats || {})]);
        const list = [...chats].map(chat => { const entry = sessions.state.sessions[chat] || {}; const state = wake?.state.chats[chat];
          return { chat, threadId: entry.threadId, protocol:entry.protocol,compactions:entry.compactions||0,lastCompactedAt:entry.lastCompactedAt||'',
          lastSubmittedBytes:entry.lastSubmittedBytes,lastToolCalls:entry.lastToolCalls,
          wake: state ? { mode: state.until <= Date.now() ? 'diving' : state.mode, until: state.until, silentStreak: state.silentStreak,
            hourlyWakes: state.calls.filter(t => Date.now() - t < 3600000).length, lastReason: state.lastReason } : null,
          model: entry.model, turns: entry.turns || 0, lastUsedAt: entry.lastUsedAt || '', lastCachePercent: entry.lastCachePercent,
          lastModelMs: entry.lastModelMs, lastUsage: entry.lastUsage, totalInputTokens: entry.totalInputTokens, totalCachedTokens: entry.totalCachedTokens }; });
        return send(200, 'application/json; charset=utf-8', JSON.stringify(list.sort((a, b) => b.lastUsedAt.localeCompare(a.lastUsedAt))));
      }
      if (url.pathname === '/api/messages') {
        const chat = url.searchParams.get('chat');
        const records = (memory.recent?memory.recent(chat,150,0):memory.records.filter(x => x.chat === chat).slice(-150)).map(({ at, role, speaker, text }) => ({ at, role, speaker, text }));
        return send(200, 'application/json; charset=utf-8', JSON.stringify(records));
      }
      return send(404, 'text/plain', 'Not found');
    }
    const assets = { '/': ['viewer.html', 'text/html; charset=utf-8'], '/viewer.js': ['viewer.js', 'text/javascript; charset=utf-8'],
      '/viewer.css': ['viewer.css', 'text/css; charset=utf-8'] };
    const asset = assets[url.pathname];
    if (!asset) return send(404, 'text/plain', 'Not found');
    send(200, asset[1], fs.readFileSync(path.join(root, asset[0])));
    }catch(error){if(!res.headersSent)send(400,'application/json; charset=utf-8',JSON.stringify({error:String(error.message).slice(0,200)}));else res.end();}
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
  return server;
}
