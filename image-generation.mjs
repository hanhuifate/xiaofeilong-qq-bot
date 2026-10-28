import fs from 'node:fs';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {DoubaoImageService} from './doubao-image.mjs';
import {ChatGPTImageService} from './chatgpt-image.mjs';
import {organizeImageConversation} from './image-sidebar.mjs';

export class ImageGenerationService {
  constructor(cfg,root) {
    this.cfg=cfg;this.root=root;this.legacy=new DoubaoImageService(cfg,root);
    this.settingsFile=path.join(root,'data','image-generation-settings.json');
    this.deliveryFile=path.join(root,'data','image-deliveries.json');
    let saved={};try{saved=JSON.parse(fs.readFileSync(this.settingsFile,'utf8'));}catch(e){if(e.code!=='ENOENT')throw e;}
    cfg.capabilities??={};cfg.capabilities.imageGeneration={enabled:true,provider:'chatgpt',sectionName:'图片',waitTimeoutSeconds:1200,...cfg.capabilities.imageGeneration,...saved};
    this.chatgpt=new ChatGPTImageService(cfg,root,{onConversation:j=>organizeImageConversation(root,this.settings(),j)});
    this.deliveries={...this.legacy.deliveries};try{Object.assign(this.deliveries,JSON.parse(fs.readFileSync(this.deliveryFile,'utf8')));}catch(e){if(e.code!=='ENOENT')throw e;}
  }
  settings(){return {...this.cfg.capabilities.imageGeneration,freshChatPerJob:true};}
  get provider(){return this.settings().provider;}
  get providerLabel(){return this.provider==='chatgpt'?'ChatGPT':'豆包';}
  get enabled(){return this.settings().enabled!==false;}
  get watchdogEnabled(){return this.enabled&&this.provider==='doubao'&&this.legacy.watchdogEnabled;}
  get url(){return this.legacy.url;}
  start(){return this.chatgpt.start();}
  close(){this.chatgpt.close();}
  engine(jobId){const provider=jobId?(this.deliveries[jobId]?.provider||(this.chatgpt.jobs[jobId]?'chatgpt':'doubao')):this.provider;return provider==='chatgpt'?this.chatgpt:this.legacy;}
  async available(){return this.enabled&&await this.engine().available();}
  async generate(chat,request){if(!this.enabled)throw Error('IMAGE_GENERATION_DISABLED');const provider=this.provider;return {...await this.engine().generate(chat,request),provider};}
  waitFor(id){return this.engine(id).waitFor(id);}
  imagePath(value){return this.chatgpt.imagePath(value)||this.legacy.imagePath(value);}
  tool(name,args){if(name==='doubao_job_status'&&this.engine(args.job_id)===this.chatgpt)return Promise.resolve(this.chatgpt.jobStatus(args.job_id));return this.legacy.tool(name,args);}
  saveDelivery(id,patch){this.deliveries[id]={...this.deliveries[id],...patch,updatedAt:Date.now()};fs.mkdirSync(path.dirname(this.deliveryFile),{recursive:true});fs.writeFileSync(this.deliveryFile+'.tmp',JSON.stringify(this.deliveries,null,2));fs.renameSync(this.deliveryFile+'.tmp',this.deliveryFile);}
  saveSettings(input) {
    const next=this.settings();
    if(input.provider!==undefined){if(!['chatgpt','doubao'].includes(input.provider))throw Error('请选择 ChatGPT 或豆包');next.provider=input.provider;}
    if(input.enabled!==undefined){if(typeof input.enabled!=='boolean')throw Error('启用设置不正确');next.enabled=input.enabled;}
    if(input.sectionName!==undefined){if(typeof input.sectionName!=='string'||!input.sectionName.trim()||input.sectionName.length>30)throw Error('分组名称为 1 到 30 个字');next.sectionName=input.sectionName.trim();}
    if(input.waitTimeoutSeconds!==undefined){if(!Number.isInteger(input.waitTimeoutSeconds)||input.waitTimeoutSeconds<180||input.waitTimeoutSeconds>3600)throw Error('等待时间为 180 到 3600 秒');next.waitTimeoutSeconds=input.waitTimeoutSeconds;}
    if(input.browserEnabled!==undefined){if(typeof input.browserEnabled!=='boolean')throw Error('浏览器守护设置不正确');next.browserEnabled=input.browserEnabled;}
    fs.mkdirSync(path.dirname(this.settingsFile),{recursive:true});fs.writeFileSync(this.settingsFile+'.tmp',JSON.stringify(next,null,2));fs.renameSync(this.settingsFile+'.tmp',this.settingsFile);
    this.cfg.capabilities.imageGeneration=next;return next;
  }
  summary(){const state=this.chatgpt.status();return {settings:this.settings(),providerLabel:this.providerLabel,chatgpt:{...state,jobs:state.jobs.map(j=>({...j,deliveryStatus:this.deliveries[j.id]?.status||''}))}};}
  manageBrowser(action='Ensure') {
    if(this.provider==='doubao')return this.legacy.manageBrowser(action);
    return this.manageChatGPTBrowser(action);
  }
  manageChatGPTBrowser(action='Ensure') {
    if(!['Start','Stop','Restart','Status','Ensure','Login','InstallExtension'].includes(action))return Promise.reject(Error('IMAGE_BROWSER_ACTION_INVALID'));
    return new Promise((resolve,reject)=>{
      const child=spawn('powershell.exe',['-NoProfile','-ExecutionPolicy','Bypass','-File',path.join(this.root,'Manage-ChatGPT-Image.ps1'),'-Action',action],{windowsHide:true,stdio:['ignore','pipe','pipe']});
      let output='';child.stdout.setEncoding('utf8');child.stdout.on('data',d=>output+=d);child.stderr.resume();
      const timer=setTimeout(()=>{child.kill();reject(Error('IMAGE_BROWSER_MANAGER_TIMEOUT'));},20000);
      child.on('error',()=>{clearTimeout(timer);reject(Error('IMAGE_BROWSER_MANAGER_FAILED'));});
      child.on('close',code=>{clearTimeout(timer);try{if(code)throw Error();resolve(JSON.parse(output.trim().split(/\r?\n/).at(-1)));}catch{reject(Error('IMAGE_BROWSER_MANAGER_FAILED'));}});
    });
  }
}
