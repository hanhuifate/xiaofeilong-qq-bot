import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import {randomBytes,timingSafeEqual} from 'node:crypto';
import {EventEmitter} from 'node:events';

export function frameworkToken(root) {
  const file=path.join(root,'data','framework-token.txt');fs.mkdirSync(path.dirname(file),{recursive:true});
  try{fs.writeFileSync(file,randomBytes(32).toString('hex'),{flag:'wx',mode:0o600});}catch(error){if(error.code!=='EEXIST')throw error;}
  const token=fs.readFileSync(file,'utf8').trim();if(!/^[a-f0-9]{64}$/.test(token))throw Error('FRAMEWORK_TOKEN_INVALID');return token;
}

/** AstrBot owns QQ I/O; the existing conversation/extension engine is reused. */
export class AstrBotAdapter extends EventEmitter {
  constructor(cfg,root) {
    super();this.cfg=cfg;this.token=frameworkToken(root);this.connected=false;this.closed=false;
    this.port=Number(cfg.framework?.eventPort||6101);this.rpcPort=Number(cfg.framework?.rpcPort||6102);
    this.events=[];this.dispatchReady=false;
  }
  async connect() {
    const secret=Buffer.from(this.token);
    this.server=http.createServer(async(req,res)=>{
      const respond=(code,value)=>{res.writeHead(code,{'Content-Type':'application/json','Cache-Control':'no-store'});res.end(JSON.stringify(value));};
      const supplied=Buffer.from(String(req.headers.authorization||'').replace(/^Bearer /,''));
      if(req.method!=='POST'||req.headers.host!==`127.0.0.1:${this.port}`||secret.length!==supplied.length||!timingSafeEqual(secret,supplied))return respond(403,{error:'Forbidden'});
      try {
        let body='';for await(const chunk of req){body+=chunk;if(Buffer.byteLength(body)>2000000)return respond(413,{error:'Too large'});}
        const value=JSON.parse(body);
        if(String(value.self_id)!==this.cfg.botQQ)return respond(403,{error:'Wrong account'});
        if(req.url==='/heartbeat') {
          this.lastHeartbeat=Date.now();
          if(value.online===true&&!this.connected){this.connected=true;this.emit('connected');}
          if(value.online!==true&&this.connected){this.connected=false;this.dispatchReady=false;this.emit('disconnected');}
          return respond(200,{ok:true});
        }
        if(req.url==='/event') {
          if(this.connected&&this.dispatchReady)this.emit('event',value);
          else{this.events.push(value);if(this.events.length>200)this.events.shift();}
          return respond(202,{ok:true});
        }
        return respond(404,{error:'Not found'});
      }catch{respond(400,{error:'Invalid event'});}
    });
    await new Promise((resolve,reject)=>{this.server.once('error',reject);this.server.listen(this.port,'127.0.0.1',resolve);});
    this.timer=setInterval(()=>{if(this.connected&&Date.now()-(this.lastHeartbeat||0)>35000){this.connected=false;this.dispatchReady=false;this.emit('disconnected');}},10000);this.timer.unref?.();
  }
  async call(action,params={}) {
    const response=await fetch(`http://127.0.0.1:${this.rpcPort}/action`,{method:'POST',headers:{Authorization:'Bearer '+this.token,'Content-Type':'application/json'},
      body:JSON.stringify({action,params}),signal:AbortSignal.timeout(22000)});
    const body=await response.json();if(!response.ok||body.error)throw Error('ASTRBOT_ONEBOT_CALL_FAILED');return body.data;
  }
  flush(){this.dispatchReady=true;for(const event of this.events.splice(0))if(!event.time||Date.now()-Number(event.time)*1000<120000)this.emit('event',event);}
  close(){this.closed=true;clearInterval(this.timer);this.server?.close();}
}
