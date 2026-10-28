const BASE='http://127.0.0.1:6103';
let busy=false;
async function config(){const x=await chrome.storage.local.get(['token','clientId','workerTab','active']);if(!x.clientId){x.clientId=crypto.randomUUID();await chrome.storage.local.set({clientId:x.clientId});}return x;}
async function api(route,data={}){
  const c=await config();if(!c.token)throw Error('NOT_PAIRED');
  const r=await fetch(BASE+route,{method:'POST',headers:{Authorization:'Bearer '+c.token,'Content-Type':'application/json'},body:JSON.stringify({...data,clientId:c.clientId}),signal:AbortSignal.timeout(route==='/worker/image'?120000:10000)});
  const result=await r.json();if(!r.ok)throw Error(result.error||'BRIDGE_UNAVAILABLE');return result;
}
async function inspect(tab){try{return await chrome.tabs.sendMessage(tab,{kind:'inspect'});}catch{return {pageReady:false};}}
async function patch(job,status,extra={}){return api('/worker/update',{id:job.id,lease:job.lease,status,...extra});}
async function ensureWorker(c){
  if(c.workerTab){try{await chrome.tabs.get(c.workerTab);return c;}catch{}}
  let target='https://chatgpt.com/';
  if(c.active){
    const {job}=await api('/worker/claim');
    if(job?.id===c.active.id){
      if(job.conversationUrl)target=job.conversationUrl;
      else if(c.active.attempted){await patch(job,'attention_required',{error:'SUBMISSION_UNCERTAIN_AFTER_RESTART'});await chrome.storage.local.remove('active');c.active=null;}
    }else{await chrome.storage.local.remove('active');c.active=null;}
  }
  const tab=await chrome.tabs.create({url:target,active:false});c.workerTab=tab.id;
  if(c.active)c.active.tab=tab.id;
  await chrome.storage.local.set({workerTab:tab.id,...(c.active?{active:c.active}:{})});return c;
}
async function tick(){
  if(busy)return;busy=true;
  try {
    let c=await config();if(!c.token)return;c=await ensureWorker(c);
    let state=await inspect(c.workerTab);await api('/worker/heartbeat',state);
    const {job}=await api('/worker/claim');
    if(!job){if(c.active)await chrome.storage.local.remove('active');return;}
    if(c.active&&c.active.id!==job.id){await chrome.storage.local.remove('active');c.active=null;}
    if(!c.active){
      if(job.status!=='opening') {await patch(job,'attention_required',{error:'WORKER_RECOVERY_NEEDS_EXISTING_TAB'});return;}
      // Persist ownership before opening a page. A failed/restarted worker never
      // submits an uncertain prompt again in a replacement conversation.
      await chrome.storage.local.set({active:{id:job.id,lease:job.lease,tab:null,attempted:false}});
      const tab=await chrome.tabs.create({url:'https://chatgpt.com/',active:false});
      c.active={id:job.id,lease:job.lease,tab:tab.id,attempted:false};
      await chrome.storage.local.set({workerTab:tab.id,active:c.active});return;
    }
    if(!c.active.tab){await patch(job,'attention_required',{error:'WORKER_TAB_UNCERTAIN'});return;}
    state=await inspect(c.active.tab);
    if(state.captchaRequired){await patch(job,'captcha_required');return;}
    if(state.loginRequired){await patch(job,'login_required');return;}
    if(!state.pageReady)return;
    if(state.conversationUrl&&!job.conversationUrl){await patch(job,'running',{conversationUrl:state.conversationUrl});job.conversationUrl=state.conversationUrl;}
    if(!c.active.attempted){
      if(job.status!=='opening'||!state.fresh){await patch(job,'attention_required',{error:'PAGE_NOT_FRESH'});return;}
      c.active.attempted=true;await chrome.storage.local.set({active:c.active});await patch(job,'submitting');
      let result;
      try{result=await chrome.tabs.sendMessage(c.active.tab,{kind:'submit',prompt:job.prompt,ratio:job.ratio});}
      catch{await patch(job,'attention_required',{error:'SUBMISSION_UNCERTAIN'});return;}
      if(!result?.ok){await patch(job,'attention_required',{error:result?.error||'SUBMISSION_UNCERTAIN'});return;}
      return;
    }
    if(state.quotaRequired){await patch(job,'quota_exhausted');return;}
    if(state.refused){await patch(job,'failed',{error:'REQUEST_NOT_GENERATED'});return;}
    if(!state.image||state.generating||!state.conversationUrl)return;
    const signature=state.image.url+'|'+state.image.width+'x'+state.image.height;
    if(c.active.imageSignature!==signature){c.active.imageSignature=signature;c.active.imageSince=Date.now();await chrome.storage.local.set({active:c.active});return;}
    if(Date.now()-c.active.imageSince<15000)return;
    await patch(job,'downloading',{conversationUrl:state.conversationUrl});
    let image=await chrome.tabs.sendMessage(c.active.tab,{kind:'read-image',url:state.image.url});
    if(!image?.ok){
      // A signed CDN URL already observed in the generated image can be read
      // with extension host permissions if the page's CORS policy blocks it.
      // Cookies, auth headers and hidden ChatGPT APIs are never extracted.
      try{
        const url=new URL(state.image.url);
        if(url.protocol==='https:'&&url.hostname.endsWith('.oaiusercontent.com')){
          const response=await fetch(url.href,{credentials:'omit',signal:AbortSignal.timeout(90000)});
          if(response.ok&&response.headers.get('content-type')?.startsWith('image/')){
            const bytes=new Uint8Array(await response.arrayBuffer());
            if(bytes.length<=32*1024*1024){let raw='';for(let offset=0;offset<bytes.length;offset+=32768)raw+=String.fromCharCode(...bytes.subarray(offset,offset+32768));image={ok:true,base64:btoa(raw)};}
          }
        }
      }catch{}
    }
    if(!image?.ok){await patch(job,'attention_required',{error:image?.error||'IMAGE_READ_FAILED'});return;}
    // Upload the verified image bytes directly. No downloads API, download
    // button or OS protocol handler is invoked, so Thunder cannot intercept it.
    await api('/worker/image',{id:job.id,lease:job.lease,base64:image.base64});
    await chrome.storage.local.remove('active');
  }catch { /* A lost local connection is retried by observing the same job. */ }
  finally{busy=false;}
}
chrome.runtime.onMessage.addListener((message,sender,respond)=>{
  if(message.kind==='configure'&&sender.id===chrome.runtime.id&&sender.url?.startsWith(chrome.runtime.getURL('options.html'))){
    (async()=>{if(!/^[a-f0-9]{64}$/.test(message.token))throw Error();await chrome.storage.local.set({token:message.token});await api('/worker/heartbeat',{pageReady:false});const tab=await chrome.tabs.create({url:'https://chatgpt.com/',active:true});await chrome.storage.local.set({workerTab:tab.id});return {ok:true};})().then(respond,()=>respond({ok:false,error:'BRIDGE_UNAVAILABLE'}));return true;
  }
  if(message.kind==='pulse'&&sender.id===chrome.runtime.id&&sender.url?.startsWith('https://chatgpt.com/')){void config().then(c=>{if(c.workerTab===sender.tab?.id)void tick();});respond({ok:true});}
});
chrome.action.onClicked.addListener(()=>chrome.runtime.openOptionsPage());
chrome.alarms.create('qq-images',{periodInMinutes:0.5});
chrome.alarms.onAlarm.addListener(a=>{if(a.name==='qq-images')void tick();});
chrome.runtime.onStartup.addListener(()=>void tick());
