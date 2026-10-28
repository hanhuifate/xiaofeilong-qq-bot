import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

const reads=new Set(['get_group_member_info','get_group_member_list','get_msg','get_group_msg_history']);
const writes=new Set(['set_group_ban','set_group_kick','delete_msg','_send_group_notice','set_essence_msg','delete_essence_msg','set_friend_add_request','set_group_add_request']);

export class ModerationService {
  constructor(cfg,api,root,options={}) {
    this.cfg=cfg;this.api=api;this.root=root;this.pending=new Map();this.nextId=0;
    this.settingsFile=options.settingsFile||path.join(root,'data','moderation-settings.json');
    this.database=options.database||(cfg.memory?.backend==='sqlite'?path.join(root,'data','bot.sqlite3'):undefined);
    this.confirmations=new Map();
    this.python=path.resolve(root,'../QQ群聊/.venv/Scripts/python.exe');
  }
  settings() {
    let local={};
    try{local=JSON.parse(fs.readFileSync(this.settingsFile,'utf8').replace(/^\uFEFF/,''));}catch{}
    return {enabled:true,dryRun:false,owners:[],approvalSeconds:120,...this.cfg.moderation,...local};
  }
  get enabled(){return this.cfg.moderation?.enabled===true&&this.settings().enabled;}
  start() {
    if(this.proc)return;
    if(!fs.existsSync(this.python))throw new Error('MODERATION_PYTHON_MISSING');
    const proc=this.proc=spawn(this.python,['-u',path.join(this.root,'moderation-worker.py')],{windowsHide:true,env:{...process.env,PYTHONUTF8:'1',PYTHONIOENCODING:'utf-8',...(this.database?{DFL_MODERATION_DB:this.database}:{})},stdio:['pipe','pipe','pipe']});
    let buffer='';proc.stderr.resume();proc.stdin.on('error',()=>{});
    proc.stdout.setEncoding('utf8');proc.stdout.on('data',data=>{
      buffer+=data;let index;
      if(buffer.length>2_000_000){proc.kill();return;}
      while((index=buffer.indexOf('\n'))>=0){const line=buffer.slice(0,index);buffer=buffer.slice(index+1);try{this.consume(JSON.parse(line),proc).catch(()=>{});}catch{}}
    });
    const fail=()=>{
      if(this.proc!==proc)return;this.proc=null;
      for(const item of this.pending.values()){clearTimeout(item.timer);item.reject(new Error('MODERATION_WORKER_EXITED'));}
      this.pending.clear();
    };
    proc.once('exit',fail);proc.once('error',fail);
  }
  async consume(message,proc) {
    if(message.type==='pendingSnapshot') {
      this.confirmations.clear();
      for(const row of message.rows||[])this.confirmations.set(`${row.scope}:${row.user}`,row.expires*1000);
      return;
    }
    if(message.type==='api') {
      if(!reads.has(message.action)&&!writes.has(message.action))return;
      // The Python layer validates scope, identity and approvals. Re-check the
      // host's emergency switch immediately before every mutating dispatch.
      if(writes.has(message.action)&&(!this.enabled||this.settings().dryRun||this.guard&& !this.guard(message.action,message.params))) {
        proc.stdin.write(JSON.stringify({type:'apiResult',id:message.id,error:'MODERATION_DISABLED'})+'\n');return;
      }
      let response;
      try{response={type:'apiResult',id:message.id,result:await this.api.call(message.action,message.params)};}
      catch{response={type:'apiResult',id:message.id,error:'ONEBOT_API_FAILED'};}
      if(!proc.killed)proc.stdin.write(JSON.stringify(response)+'\n');
      return;
    }
    const item=this.pending.get(message.id);if(!item)return;
    clearTimeout(item.timer);this.pending.delete(message.id);
    if(message.error){const error=new Error(message.error);error.errorType=message.errorType;item.reject(error);}else item.resolve(message.result);
  }
  call(method,event,extra={}) {
    this.start();
    return new Promise((resolve,reject)=>{
      const id=++this.nextId;
      const timer=setTimeout(()=>{this.pending.delete(id);reject(new Error('管理接口响应超时；结果待核实，不会自动重复执行。'));},65000);
      this.pending.set(id,{resolve,reject,timer});
      this.proc.stdin.write(JSON.stringify({id,method,event,settings:this.settings(),...extra})+'\n');
    });
  }
  async context(event) {
    if(!this.enabled)return {enabled:false};
    return this.call('context',event);
  }
  hasPending(event) {
    const privateChat=event.message_type==='private'||event._private;
    const scope=`local:${event.self_id}:${privateChat?'private':'group'}:${privateChat?event.user_id:event.group_id}`;
    return this.enabled&&(this.confirmations.get(`${scope}:${event.user_id}`)||0)>Date.now();
  }
  async decision(event,decision) {
    if(!decision||decision.operation==='none')return null;
    if(!this.enabled)return {handled:true,text:'群管理目前已关闭，可以在本机控制面板中开启。'};
    try{return await this.call('decision',event,{decision});}
    catch(error){return {handled:true,text:error.message};}
  }
  async request(event){return this.enabled?this.call('request',event):null;}
  close(){
    const proc=this.proc;if(!proc)return;
    // Let the Python worker close SQLite before the Windows venv launcher exits.
    proc.stdin.end();
    const timer=setTimeout(()=>{
      if(proc.exitCode===null&&proc.pid)spawn('taskkill.exe',['/PID',String(proc.pid),'/T','/F'],{windowsHide:true,stdio:'ignore'});
    },3000);
    timer.unref?.();proc.once('exit',()=>clearTimeout(timer));
  }
}
