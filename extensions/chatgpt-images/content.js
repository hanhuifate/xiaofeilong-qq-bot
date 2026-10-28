(()=>{
  const visible=e=>!!e&&e.getClientRects().length>0;
  const composer=()=>[...document.querySelectorAll('#prompt-textarea,[role="textbox"][contenteditable="true"],textarea')].find(visible);
  const button=(pattern)=>[...document.querySelectorAll('button,[role="button"]')].find(e=>visible(e)&&pattern.test((e.getAttribute('aria-label')||'')+' '+e.innerText));
  const imageAllowed=value=>{try{const u=new URL(value,location.href);return u.protocol==='https:'&&(u.hostname==='chatgpt.com'||u.hostname.endsWith('.oaiusercontent.com'));}catch{return false;}};
  function state(){
    const text=document.body?.innerText||'',box=composer();
    const loginRequired=!!button(/^\s*(Log in|Sign in|登录|登陆)\s*$/i)||/^\/(auth|login)(\/|$)/.test(location.pathname);
    const captchaRequired=/Verify you are human|确认您是真人|验证您是人类/i.test(text);
    const assistants=[...document.querySelectorAll('[data-message-author-role="assistant"],article[data-turn="assistant"]')];
    const last=assistants.at(-1),lastText=last?.innerText||'';
    const generated=[...(last?.querySelectorAll('img')||[])].filter(img=>visible(img)&&img.complete&&img.naturalWidth>=512&&img.naturalHeight>=512&&imageAllowed(img.currentSrc||img.src));
    const img=generated.at(-1);
    const url=/^\/c\/[a-f0-9-]{36}$/.test(location.pathname)?location.origin+location.pathname:'';
    return {pageReady:!!box&&!loginRequired&&!captchaRequired,loginRequired,captchaRequired,
      fresh:location.pathname==='/'&&!document.querySelector('[data-message-author-role]')&&!(box?.innerText||box?.value||'').trim(),
      conversationUrl:url,generating:!!button(/Stop generating|停止生成|停止流式传输/i)||last?.getAttribute('aria-busy')==='true',
      quotaRequired:/image generation limit|reached.*image.*limit|图片生成.*(?:上限|限额)|生图.*额度不足/i.test(lastText),
      refused:!img&&/I (?:can't|cannot) (?:help|generate)|无法生成这张|不能生成这类/i.test(lastText),
      image:img?{url:img.currentSrc||img.src,width:img.naturalWidth,height:img.naturalHeight}:null};
  }
  async function handle(message){
    if(message.kind==='inspect')return state();
    if(message.kind==='submit'){
      if(!state().fresh||!state().pageReady)return {ok:false,error:'PAGE_NOT_FRESH'};
      const box=composer(),prompt=String(message.prompt||'').trim();if(!prompt||prompt.length>3000)return {ok:false,error:'PROMPT_INVALID'};
      const value=prompt+'\n请直接生成一张新图片，不要搜索已有图片或只给提示词。画面比例 '+message.ratio+'。';
      box.focus();
      if(box.tagName==='TEXTAREA'){const setter=Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set;setter.call(box,value);box.dispatchEvent(new Event('input',{bubbles:true}));}
      else {document.execCommand('insertText',false,value);box.dispatchEvent(new InputEvent('input',{bubbles:true,inputType:'insertText',data:value}));}
      // Background tabs suspend animation frames. A bounded timer allows
      // React to render without requiring a visible/foreground browser.
      // Synthetic Enter is deliberately not a fallback for a missing button.
      await new Promise(r=>setTimeout(r,500));
      if(!(box.innerText||box.value||'').includes(prompt))return {ok:false,error:'COMPOSER_INPUT_UNSUPPORTED'};
      const send=document.querySelector('[data-testid="send-button"]')||button(/^(?:\s*)(?:Send prompt|Send message|发送提示|发送消息|发送)(?:\s*)$/i);
      if(!send||send.disabled)return {ok:false,error:'SEND_CONTROL_UNAVAILABLE'};
      send.click();return {ok:true};
    }
    if(message.kind==='read-image'){
      const current=state();if(!current.image||current.generating||current.image.url!==message.url||!imageAllowed(message.url))return {ok:false,error:'IMAGE_NOT_READY'};
      try{
        const response=await fetch(message.url,{credentials:'include',signal:AbortSignal.timeout(90000)});
        if(!response.ok||!response.headers.get('content-type')?.startsWith('image/'))return {ok:false,error:'IMAGE_READ_FAILED'};
        const blob=await response.blob();if(blob.size>32*1024*1024)return {ok:false,error:'IMAGE_TOO_LARGE'};
        const base64=await new Promise((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(String(reader.result).split(',')[1]);reader.onerror=reject;reader.readAsDataURL(blob);});
        return {ok:true,base64};
      }catch{return {ok:false,error:'IMAGE_READ_FAILED'};}
    }
    return {ok:false,error:'UNKNOWN_ACTION'};
  }
  chrome.runtime.onMessage.addListener((message,sender,respond)=>{if(sender.id!==chrome.runtime.id)return;handle(message).then(respond,()=>respond({ok:false,error:'PAGE_ACTION_FAILED'}));return true;});
  const pulse=()=>{try{chrome.runtime.sendMessage({kind:'pulse'}).catch(()=>{});}catch{}};setInterval(pulse,5000);pulse();
})();
