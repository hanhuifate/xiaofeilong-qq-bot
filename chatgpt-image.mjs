import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import {createHash,randomBytes,timingSafeEqual} from 'node:crypto';
import {inflateSync} from 'node:zlib';

export const imageFinalStates=new Set(['completed','failed','cancelled','quota_exhausted','attention_required']);
const phases=new Set(['opening','submitting','running','downloading','quota_exhausted','login_required','captcha_required','attention_required','failed']);
export function conversationId(value) {
  try {const u=new URL(value);return u.origin==='https://chatgpt.com'&&/^\/c\/([a-f0-9-]{36})$/.test(u.pathname)?u.pathname.slice(3):null;}catch{return null;}
}
function read(file,fallback){try{return JSON.parse(fs.readFileSync(file,'utf8'));}catch(e){if(e.code!=='ENOENT')throw e;return fallback;}}
function write(file,value){fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file+'.tmp',JSON.stringify(value,null,2));fs.renameSync(file+'.tmp',file);}
const crcTable=Array.from({length:256},(_,n)=>{for(let k=0;k<8;k++)n=n&1?0xedb88320^(n>>>1):n>>>1;return n>>>0;});
export function pngCRC(bytes){let crc=0xffffffff;for(const b of bytes)crc=crcTable[(crc^b)&255]^(crc>>>8);return (crc^0xffffffff)>>>0;}
function validPNG(bytes){
  try {
    let offset=8,ended=false,header=null;const compressed=[];
    while(offset+12<=bytes.length){const size=bytes.readUInt32BE(offset),end=offset+12+size;if(end>bytes.length)return false;
      const type=bytes.toString('ascii',offset+4,offset+8),data=bytes.subarray(offset+8,end-4);
      if(pngCRC(bytes.subarray(offset+4,end-4))!==bytes.readUInt32BE(end-4))return false;
      if(type==='IHDR'){if(offset!==8||size!==13)return false;header=data;}
      if(type==='IDAT')compressed.push(data);
      if(type==='IEND'){ended=size===0&&end===bytes.length;break;}offset=end;
    }
    if(!ended||!header||!compressed.length)return false;
    const w=header.readUInt32BE(0),h=header.readUInt32BE(4),channels={0:1,2:3,3:1,4:2,6:4}[header[9]];
    if(w<64||h<64||w>8192||h>8192||w*h>32*1024*1024||!channels||![1,2,4,8,16].includes(header[8]))return false;
    const pixels=inflateSync(Buffer.concat(compressed),{maxOutputLength:128*1024*1024});
    return header[12]===1?pixels.length>0:pixels.length===h*(1+Math.ceil(w*channels*header[8]/8));
  }catch{return false;}
}
export function imageExtension(bytes) {
  if(bytes.length<128||bytes.length>32*1024*1024)throw Error('IMAGE_BYTES_INVALID');
  if(bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))&&validPNG(bytes))return 'png';
  if(bytes[0]===255&&bytes[1]===216&&bytes[2]===255&&bytes.at(-2)===255&&bytes.at(-1)===217)return 'jpg';
  if(bytes.toString('ascii',0,4)==='RIFF'&&bytes.toString('ascii',8,12)==='WEBP')return 'webp';
  throw Error('IMAGE_BYTES_INVALID');
}

// Only image jobs reach the browser. No QQ history, identifiers, local tools or
// browser credentials cross this API. The extension returns bytes, never a URL
// for the server to fetch, so it cannot turn a model's URL into an SSRF request.
export class ChatGPTImageService {
  constructor(cfg,root,{onConversation=async()=>{}}={}) {
    this.cfg=cfg;this.root=root;this.onConversation=onConversation;
    this.outputRoot=path.join(root,'outputs','chatgpt-images');
    this.file=path.join(root,'data','chatgpt-image-jobs.json');this.jobs=read(this.file,{});
    this.tokenFile=path.join(root,'data','chatgpt-image-token.txt');
    fs.mkdirSync(path.dirname(this.tokenFile),{recursive:true});
    try {this.token=fs.readFileSync(this.tokenFile,'utf8').trim();}catch(e){if(e.code!=='ENOENT')throw e;}
    if(!this.token){this.token=randomBytes(32).toString('hex');fs.writeFileSync(this.tokenFile,this.token,{mode:0o600});}
    this.worker={at:0,pageReady:false};this.pollDelay=ms=>new Promise(r=>setTimeout(r,ms));
  }
  persist(){write(this.file,this.jobs);}
  settings(){return this.cfg.capabilities?.imageGeneration||{};}
  status(){const active=Object.values(this.jobs).find(j=>!imageFinalStates.has(j.status)&&j.status!=='queued');return {service:this.server?.listening?'ok':'offline',browserConnected:Date.now()-this.worker.at<45000,
    pageReady:Date.now()-this.worker.at<45000&&this.worker.pageReady===true&&!this.worker.quotaRequired,quotaRequired:this.worker.quotaRequired===true,loginRequired:this.worker.loginRequired===true,
    captchaRequired:this.worker.captchaRequired===true,activeJob:active?.id||'',workerChanged:!!(active&&this.worker.clientId&&active.clientId!==this.worker.clientId),
    workerVersion:this.worker.version||'',generating:this.worker.generating===true,imageDetected:this.worker.imageDetected===true,
    assistantTurns:this.worker.assistantTurns||0,imageCandidates:this.worker.imageCandidates||0,
    lastError:this.lastError||'',jobs:Object.values(this.jobs).slice(-12).reverse().map(j=>({id:j.id,status:j.status,late:!!j.late,createdAt:j.createdAt,conversationUrl:j.conversationUrl||'',groupStatus:j.groupStatus||'pending'}))};}
  async available(){const s=this.status();return s.service==='ok'&&s.pageReady;}
  async generate(chat,request) {
    const s=this.status();
    const prompt=String(request?.prompt||'').trim();if(!prompt||prompt.length>3000)throw Error('IMAGE_PROMPT_INVALID');
    const requestId=String(request.requestId||'');
    if(requestId){
      if(!/^[a-f0-9-]{36}$/.test(requestId))throw Error('IMAGE_REQUEST_ID_INVALID');
      const old=Object.values(this.jobs).find(j=>j.requestId===requestId);
      if(old){if(old.prompt!==prompt)throw Error('IMAGE_REQUEST_ID_REUSED');return {ok:true,job_id:old.id,provider:'chatgpt'};}
    }
    if(!s.pageReady)throw Error(s.quotaRequired?'CHATGPT_QUOTA_EXHAUSTED':s.captchaRequired?'CHATGPT_CAPTCHA_REQUIRED':s.loginRequired?'CHATGPT_LOGIN_REQUIRED':'CHATGPT_NOT_READY');
    if(Object.values(this.jobs).filter(j=>!imageFinalStates.has(j.status)).length>=20)throw Error('IMAGE_QUEUE_FULL');
    const id='job_'+randomBytes(12).toString('hex'),now=Date.now();
    this.jobs[id]={id,provider:'chatgpt',chatHash:createHash('sha256').update(String(chat)).digest('hex').slice(0,16),
      prompt,ratio:['1:1','16:9','9:16','4:3','3:4','3:2','2:3'].includes(request.ratio)?request.ratio:'1:1',
      status:'queued',createdAt:now,updatedAt:now,images:[],...(requestId?{requestId}:{})};this.persist();return {ok:true,job_id:id,provider:'chatgpt'};
  }
  claim(clientId) {
    if(!/^[a-zA-Z0-9-]{16,80}$/.test(clientId))throw Error('WORKER_ID_INVALID');
    const active=Object.values(this.jobs).find(j=>!imageFinalStates.has(j.status)&&j.status!=='queued');
    if(active&&active.clientId!==clientId)return null;
    const job=active||Object.values(this.jobs).find(j=>j.status==='queued');if(!job)return null;
    if(!active){job.status='opening';job.clientId=clientId;job.lease=randomBytes(24).toString('hex');job.startedAt=Date.now();this.persist();}
    return {id:job.id,prompt:job.prompt,ratio:job.ratio,status:job.resumeStatus||job.status,lease:job.lease,
      conversationUrl:job.conversationUrl||'',waitSeconds:this.settings().waitTimeoutSeconds||1200};
  }
  owned(input) {
    const j=this.jobs[input.id];if(!j||!j.lease||input.lease!==j.lease||input.clientId!==j.clientId)throw Error('JOB_LEASE_INVALID');return j;
  }
  async updateJob(input) {
    const j=this.owned(input);if(imageFinalStates.has(j.status))return {ok:true,status:j.status};
    if(!phases.has(input.status))throw Error('JOB_PHASE_INVALID');
    const order=['opening','submitting','running','downloading'];
    if(order.includes(input.status)&&order.indexOf(input.status)<order.indexOf(j.status))throw Error('JOB_PHASE_REGRESSION');
    if(input.conversationUrl) {
      const id=conversationId(input.conversationUrl);if(!id)throw Error('CHATGPT_CONVERSATION_INVALID');
      if(j.conversationUrl&&j.conversationUrl!==input.conversationUrl)throw Error('CHATGPT_CONVERSATION_CHANGED');
      if(Object.values(this.jobs).some(x=>x.id!==j.id&&x.conversationUrl===input.conversationUrl))throw Error('CHATGPT_CONVERSATION_REUSED');
      j.conversationUrl=input.conversationUrl;
    }
    if(['login_required','captcha_required'].includes(input.status)){if(!j.resumeStatus)j.resumeStatus=j.status;}
    else delete j.resumeStatus;
    j.status=input.status;j.updatedAt=Date.now();j.error=String(input.error||'').replace(/[^A-Z0-9_]/g,'').slice(0,80);this.persist();
    if(j.conversationUrl&&!j.groupStatus){j.groupStatus='pending';this.persist();void this.organize(j);}
    return {ok:true,status:j.status};
  }
  async organize(j) {
    if(this.organizing?.has(j.id))return;this.organizing??=new Set();this.organizing.add(j.id);
    try {await this.onConversation(j);j.groupStatus='grouped';}catch{j.groupStatus='pending';}
    this.persist();this.organizing.delete(j.id);
  }
  async acceptImage(input) {
    const j=this.owned(input);if(!j.conversationUrl)throw Error('CHATGPT_CONVERSATION_REQUIRED');
    const text=String(input.base64||'');if(!text||text.length>45*1024*1024||!/^[A-Za-z0-9+/]*={0,2}$/.test(text))throw Error('IMAGE_BYTES_INVALID');
    const bytes=Buffer.from(text,'base64'),ext=imageExtension(bytes),hash=createHash('sha256').update(bytes).digest('hex');
    if(j.status==='completed'){if(j.sha256!==hash)throw Error('JOB_ALREADY_COMPLETED');return {ok:true,status:'completed'};}
    if(imageFinalStates.has(j.status))throw Error('JOB_TERMINAL');
    const dir=path.join(this.outputRoot,j.chatHash);fs.mkdirSync(dir,{recursive:true});
    const file=path.join(dir,j.id+'.'+ext);fs.writeFileSync(file+'.tmp',bytes);fs.renameSync(file+'.tmp',file);
    Object.assign(j,{status:'completed',images:[file],sha256:hash,completedAt:Date.now(),updatedAt:Date.now()});this.persist();
    return {ok:true,status:'completed'};
  }
  jobStatus(id){const j=this.jobs[id];return j?{ok:true,job_id:id,status:j.status,stage:j.error||j.status,images:j.images||[],conversationUrl:j.conversationUrl||''}:{ok:false};}
  cancel(id){const j=this.jobs[id];if(!j)throw Error('IMAGE_JOB_NOT_FOUND');if(!imageFinalStates.has(j.status)){j.status='cancelled';j.updatedAt=Date.now();this.persist();}return {ok:true};}
  resumeExisting(id){
    const j=this.jobs[id];if(!j||!conversationId(j.conversationUrl))throw Error('EXISTING_CONVERSATION_REQUIRED');
    if(j.status==='completed')return {ok:true,status:j.status};
    if(['cancelled','failed','quota_exhausted'].includes(j.status))throw Error('JOB_TERMINAL');
    if(!this.status().pageReady||!this.worker.clientId)throw Error('CHATGPT_NOT_READY');
    // Explicit local recovery only exports the saved conversation. Rotate the
    // lease so a removed/reinstalled worker cannot keep writing to this job.
    j.clientId=this.worker.clientId;j.lease=randomBytes(24).toString('hex');
    j.status='running';j.resumeStatus='opening';j.error='';j.updatedAt=Date.now();j.recoveredAt=Date.now();this.persist();
    return {ok:true,status:'running',conversationUrl:j.conversationUrl};
  }
  imagePath(value) {
    if(typeof value!=='string'||!fs.existsSync(value)||!fs.existsSync(this.outputRoot))return null;
    const real=fs.realpathSync(value),base=fs.realpathSync(this.outputRoot);
    return real.startsWith(base+path.sep)&&/\.(png|jpe?g|webp)$/i.test(real)?real:null;
  }
  async waitFor(id) {
    while(!this.closed) {
      const j=this.jobs[id];if(!j)throw Error('IMAGE_JOB_NOT_FOUND');
      if(imageFinalStates.has(j.status))return {...this.jobStatus(id),imagePaths:(j.images||[]).map(p=>this.imagePath(p)).filter(Boolean)};
      const timeout=(j.status==='queued'?(this.settings().queueTimeoutSeconds||1800):(this.settings().waitTimeoutSeconds||1200))*1000;
      if(Date.now()-(j.startedAt||j.createdAt)>timeout) {
        // The page may still finish later. Keep observing this exact job; never
        // re-submit a prompt or claim that a running image failed on a timer.
        j.late=true;
      }
      await this.pollDelay(2000);
    }
    throw Error('IMAGE_SERVICE_STOPPED');
  }
  async start(port=this.settings().port||6103) {
    if(this.server)return;
    this.server=http.createServer(async(req,res)=>{
      const send=(status,value)=>{res.writeHead(status,{'Content-Type':'application/json','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});res.end(JSON.stringify(value));};
      try {
        const expected='127.0.0.1:'+this.server.address().port;
        if(req.headers.host!==expected||req.method!=='POST')return send(403,{error:'FORBIDDEN'});
        const origin=req.headers.origin;
        if(origin&&!/^chrome-extension:\/\/[a-p]{32}$/.test(origin))return send(403,{error:'FORBIDDEN'});
        const provided=Buffer.from(String(req.headers.authorization||'').replace(/^Bearer /,'')),secret=Buffer.from(this.token);
        if(provided.length!==secret.length||!timingSafeEqual(provided,secret))return send(401,{error:'UNAUTHORIZED'});
        if(!['/worker/heartbeat','/worker/claim','/worker/update','/worker/image'].includes(req.url)||!req.headers['content-type']?.startsWith('application/json'))return send(403,{error:'FORBIDDEN'});
        let size=0;const chunks=[];for await(const chunk of req){size+=chunk.length;if(size>(req.url==='/worker/image'?45*1024*1024:12000))return send(413,{error:'BODY_TOO_LARGE'});chunks.push(chunk);}
        const input=JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if(req.url==='/worker/heartbeat') {
          const count=value=>Number.isInteger(value)&&value>=0&&value<=10000?value:0;
          this.worker={at:Date.now(),pageReady:input.pageReady===true,quotaRequired:input.quotaRequired===true,loginRequired:input.loginRequired===true,captchaRequired:input.captchaRequired===true,
            clientId:/^[a-zA-Z0-9-]{16,80}$/.test(String(input.clientId||''))?String(input.clientId):'',
            version:/^\d+(?:\.\d+){0,3}$/.test(String(input.workerVersion||''))?String(input.workerVersion).slice(0,24):'',
            generating:input.generating===true,imageDetected:!!input.image,assistantTurns:count(input.assistantTurns),imageCandidates:count(input.imageCandidates)};
          return send(200,{ok:true});
        }
        if(req.url==='/worker/claim')return send(200,{ok:true,job:this.claim(input.clientId)});
        if(req.url==='/worker/update')return send(200,await this.updateJob(input));
        return send(200,await this.acceptImage(input));
      }catch(error){send(400,{error:/^[A-Z_]+$/.test(error.message)?error.message:'INVALID_REQUEST'});}
    });
    try {await new Promise((resolve,reject)=>{this.server.once('error',reject);this.server.listen(port,'127.0.0.1',resolve);});}
    catch {this.lastError='IMAGE_BRIDGE_PORT_UNAVAILABLE';this.server.close();this.server=null;return;}
    this.organizerTimer=setInterval(()=>{for(const j of Object.values(this.jobs).filter(j=>j.conversationUrl&&j.groupStatus!=='grouped').slice(-5))void this.organize(j);},30000);this.organizerTimer.unref();
  }
  close(){this.closed=true;clearInterval(this.organizerTimer);this.server?.close();}
}
