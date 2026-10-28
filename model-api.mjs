import fs from 'node:fs';
import path from 'node:path';

export function conforms(schema,value,depth=0) {
  if(depth>32)return false;
  if(schema.enum&&!schema.enum.includes(value))return false;
  if(schema.type==='object') {
    if(!value||typeof value!=='object'||Array.isArray(value))return false;
    if((schema.required||[]).some(key=>!Object.hasOwn(value,key)))return false;
    return Object.entries(value).every(([key,item])=>schema.properties?.[key]
      ?conforms(schema.properties[key],item,depth+1):schema.additionalProperties!==false);
  }
  if(schema.type==='array')return Array.isArray(value)&&value.every(item=>conforms(schema.items,item,depth+1));
  if(schema.type==='integer')return Number.isSafeInteger(value);
  return typeof value===schema.type;
}

export function parseStructuredContent(text) {
  const source=String(text||'').trim().replace(/^```(?:json)?\s*/i,'').replace(/\s*```$/,'');
  try{return JSON.parse(source);}catch{}
  const start=source.indexOf('{');
  if(start<0)throw Error('COMPATIBLE_API_JSON_INVALID');
  let depth=0,inString=false,escaped=false;
  for(let index=start;index<source.length;index++) {
    const char=source[index];
    if(inString){
      if(escaped){escaped=false;continue;}
      if(char==='\\'){escaped=true;continue;}
      if(char==='"')inString=false;
      continue;
    }
    if(char==='"'){inString=true;continue;}
    if(char==='{')depth++;
    else if(char==='}') {
      depth--;
      if(depth===0)return JSON.parse(source.slice(start,index+1));
    }
  }
  throw Error('COMPATIBLE_API_JSON_INVALID');
}

/** OpenAI chat-completions compatible transport; secrets stay in the process. */
export class CompatibleModel {
  constructor(cfg,root,buildPrompt) {
    this.cfg=cfg;this.root=root;this.buildPrompt=buildPrompt;
    const settings=cfg.llm||{};
    this.endpoint=new URL(String(settings.apiBase||'').replace(/\/$/,'')+'/chat/completions');
    if(this.endpoint.username||this.endpoint.password||!['https:','http:'].includes(this.endpoint.protocol)||
      this.endpoint.protocol==='http:'&&!['127.0.0.1','localhost','[::1]'].includes(this.endpoint.hostname))throw Error('COMPATIBLE_API_URL_INVALID');
    const env=settings.apiKeyEnv||'DFL_API_KEY';
    if(!/^[A-Z][A-Z0-9_]{0,79}$/.test(env))throw Error('COMPATIBLE_API_KEY_ENV_INVALID');
    this.key=process.env[env];
    if(!this.key&&!settings.allowAnonymous)throw Error('COMPATIBLE_API_KEY_MISSING');
  }
  async answer(cfg,question,history=[],context={}) {
    const started=Date.now(),settings=cfg.llm||{};
    if(context.images?.length&&settings.supportsImages===false)throw Error('MODEL_VISION_UNAVAILABLE');
    const schema=JSON.parse(fs.readFileSync(path.join(this.root,'reply.schema.json'),'utf8'));
    // Native Codex search is a backend capability, not implied by an API model.
    const prompt=this.buildPrompt(cfg,question,history,{...context,webSearchAllowed:false});
    const split=prompt.lastIndexOf('\n');
    const content=[{type:'text',text:prompt.slice(split+1)}];
    for(const item of context.images||[]) {
      const buffer=fs.readFileSync(item.path);if(buffer.length>12_000_000)throw Error('MODEL_IMAGE_TOO_LARGE');
      const ext=path.extname(item.path).toLowerCase(),mime=ext==='.jpg'||ext==='.jpeg'?'image/jpeg':ext==='.webp'?'image/webp':'image/png';
      content.push({type:'image_url',image_url:{url:`data:${mime};base64,${buffer.toString('base64')}`}});
    }
    const payload={model:settings.model||cfg.model,messages:[{role:'system',content:prompt.slice(0,split)+'\n必须严格符合以下 JSON Schema：'+JSON.stringify(schema)},
      {role:'user',content:content.length===1?content[0].text:content}],response_format:{type:'json_object'},stream:false};
    payload[settings.maxTokensField==='max_completion_tokens'?'max_completion_tokens':'max_tokens']=Math.max(512,Math.min(8000,Number(settings.maxTokens)||3000));
    if(['none','low','medium','high'].includes(settings.reasoningEffort))payload.reasoning_effort=settings.reasoningEffort;
    if(settings.thinking===true)payload.thinking={type:'enabled'};
    else if(settings.thinking===false)payload.thinking={type:'disabled'};
    const response=await fetch(this.endpoint,{method:'POST',headers:{'Content-Type':'application/json',...(this.key?{Authorization:'Bearer '+this.key}:{})},body:JSON.stringify(payload),
      signal:AbortSignal.timeout(Math.max(10000,Math.min(180000,Number(settings.timeoutSeconds||90)*1000)))});
    if(!response.ok)throw Error(`COMPATIBLE_API_HTTP_${response.status}`);
    const text=await response.text();if(text.length>2_000_000)throw Error('COMPATIBLE_API_RESPONSE_TOO_LARGE');
    const body=JSON.parse(text),messageContent=body.choices?.[0]?.message?.content||'';
    const u=body.usage;
    const usage=Number.isFinite(u?.prompt_tokens)&&Number.isFinite(u?.completion_tokens)?{input_tokens:u.prompt_tokens,
      cached_input_tokens:u.prompt_tokens_details?.cached_tokens||u.prompt_cache_hit_tokens||0,output_tokens:u.completion_tokens,reasoning_output_tokens:u.completion_tokens_details?.reasoning_tokens||0}:undefined;
    let result;
    try{
      result=parseStructuredContent(messageContent);
      if(!conforms(schema,result))throw Error('COMPATIBLE_API_SCHEMA_INVALID');
    }
    catch(error){error.usage=usage;error.reportedModel=body.model;
      error.contentLength=String(messageContent).length;error.finishReason=body.choices?.[0]?.finish_reason||'';
      error.responsePreview=String(messageContent).slice(0,1000);throw error;}
    return {...result,usage,reportedModel:body.model,timing:{totalMs:Date.now()-started,turnStartMs:0},provider:'openai_compatible'};
  }
}
