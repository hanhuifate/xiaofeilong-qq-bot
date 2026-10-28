import fs from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {fileURLToPath} from 'node:url';

const root=path.dirname(fileURLToPath(import.meta.url));
const read=file=>JSON.parse(fs.readFileSync(file,'utf8').replace(/^\uFEFF/,''));
function atomic(file,value){const tmp=file+'.'+randomUUID()+'.tmp';fs.writeFileSync(tmp,JSON.stringify(value,null,2));fs.renameSync(tmp,file);}
function number(value){if(typeof value!=='string'||! /^[1-9]\d{4,11}$/.test(value))throw Error('QQ号请填写5到12位数字，不能以0开头');return value;}

export function accountStatus(directory=root) {
  const cfg=read(path.join(directory,'config.json')),configDir=path.join(directory,'runtime','napcat','config');
  const known=fs.existsSync(configDir)?fs.readdirSync(configDir).flatMap(name=>/^napcat_(\d+)\.json$/.exec(name)?.slice(1)||[]):[];
  let change=null;try{change=read(path.join(directory,'data','account-change-status.json'));}catch{}
  return {botQQ:cfg.botQQ,configuredAccounts:[...new Set([cfg.botQQ,...known])],change};
}

function plan(directory,target,expected) {
  number(target);number(expected);
  const file=path.join(directory,'config.json'),cfg=read(file);
  if(cfg.botQQ!==expected)throw Error('机器人QQ号已被其他窗口修改，请刷新后再保存');
  const configDir=path.join(directory,'runtime','napcat','config');
  const targetNapcat=path.join(configDir,`napcat_${target}.json`),targetOnebot=path.join(configDir,`onebot11_${target}.json`);
  const napcat=read(fs.existsSync(targetNapcat)?targetNapcat:path.join(configDir,'napcat.json'));
  const onebot=read(fs.existsSync(targetOnebot)?targetOnebot:path.join(configDir,`onebot11_${expected}.json`));
  if(!onebot.network||typeof onebot.network!=='object'||Array.isArray(onebot.network))throw Error('NapCat网络配置无效，当前账号未更改');
  const url=new URL(cfg.onebotUrl);if(!['127.0.0.1','localhost','[::1]'].includes(url.hostname))throw Error('账号切换仅支持本机QQ接口');
  if(!cfg.onebotToken||!url.port)throw Error('机器人QQ接口配置不完整');
  const servers=onebot.network.websocketServers||[];if(!Array.isArray(servers))throw Error('NapCat网络配置无效');
  const index=servers.findIndex(x=>Number(x.port)===Number(url.port));
  const server={...(index>=0?servers[index]:{}),name:'dafeilong',enable:true,host:'127.0.0.1',port:Number(url.port),token:cfg.onebotToken,
    messagePostFormat:'array',reportSelfMessage:false};
  if(index>=0)servers[index]=server;else servers.push(server);
  onebot.network.websocketServers=servers;
  return {file,cfg,targetNapcat,targetOnebot,napcat,onebot};
}

export function inspectAccountChange(directory,target,expected) {
  plan(directory,target,expected);
  return {oldQQ:expected,botQQ:target,changed:target!==expected};
}

/** Call only after the owned reply/adapter services have been stopped. */
export function configureAccount(directory,target,expected) {
  const p=plan(directory,target,expected);
  if(target===expected)return {changed:false,botQQ:target};
  const backup=path.join(directory,'data','account-changes',new Date().toISOString().replace(/[:.]/g,'-')+'-'+randomUUID());
  fs.mkdirSync(backup,{recursive:true});
  for(const file of [p.file,p.targetNapcat,p.targetOnebot])if(fs.existsSync(file))fs.copyFileSync(file,path.join(backup,path.basename(file)),fs.constants.COPYFILE_EXCL);
  // Only application/network settings are reused. Never clone an account's
  // protocol, device identifiers, password, verification, or QQ login cache.
  atomic(p.targetNapcat,p.napcat);atomic(p.targetOnebot,p.onebot);
  atomic(p.file,{...p.cfg,botQQ:target});
  return {changed:true,oldQQ:expected,botQQ:target,backup:path.relative(directory,backup)};
}

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  try {
    const [action,target,expected]=process.argv.slice(2);
    const value=action==='status'?accountStatus():action==='inspect'?inspectAccountChange(root,target,expected):action==='apply'?configureAccount(root,target,expected):null;
    if(!value)throw Error('未知的账号操作');console.log(JSON.stringify(value));
  } catch(error){console.error(error.message);process.exitCode=1;}
}
