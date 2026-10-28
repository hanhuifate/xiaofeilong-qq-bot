import path from 'node:path';
import {spawn} from 'node:child_process';

export function manageService(root,action='Status') {
  if(!['Status','EnableAutostart','DisableAutostart'].includes(action))throw Error('SERVICE_ACTION_INVALID');
  return new Promise((resolve,reject)=>{
    const proc=spawn('powershell.exe',['-NoProfile','-ExecutionPolicy','Bypass','-File',path.join(root,'Manage-Service.ps1'),'-Action',action],{windowsHide:true,stdio:['ignore','pipe','pipe']});
    let output='';proc.stdout.setEncoding('utf8');proc.stdout.on('data',chunk=>{output+=chunk;if(output.length>32768)proc.kill();});proc.stderr.resume();
    const timer=setTimeout(()=>{proc.kill();reject(Error('独立服务设置超时'));},15000);
    proc.on('error',()=>{clearTimeout(timer);reject(Error('无法启动本机服务管理器'));});
    proc.on('exit',code=>{clearTimeout(timer);if(code!==0)return reject(Error('无法更改独立服务设置，请查看本机任务计划程序'));try{resolve(JSON.parse(output.trim().split('\n').at(-1)));}catch{reject(Error('服务状态读取失败'));}});
  });
}
