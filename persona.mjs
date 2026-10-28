import fs from 'node:fs';
import path from 'node:path';

export function replyCharLimit(cfg) {
  const value=cfg.persona?.maxReplyChars??cfg.maxReplyChars??3500;
  return Number.isInteger(value)&&value>0&&value<=10000?value:3500;
}

export function limitReplyText(text,cfg) {
  return Array.from(String(text||'')).slice(0,replyCharLimit(cfg)).join('');
}

export class PersonaEngine {
  constructor(root){this.file=path.join(root,'persona.json');}
  load(fallback={}) {
    let value={};try{value=JSON.parse(fs.readFileSync(this.file,'utf8').replace(/^\uFEFF/,''));}
    catch(error){if(error.code!=='ENOENT')throw Error('PERSONA_CONFIG_INVALID');}
    return {...fallback,...value};
  }
  save(value,fallback={}) {
    if(typeof value.name!=='string'||!value.name.trim()||value.name.length>30)throw Error('名字请填写 1 到 30 个字');
    if(typeof value.style!=='string'||!value.style.trim()||value.style.length>4000)throw Error('表达风格请填写 1 到 4000 个字');
    const next={...this.load(fallback),name:value.name.trim(),style:value.style.trim()};
    for(const key of ['aliases','interests','preferences'])if(value[key]!==undefined) {
      if(!Array.isArray(value[key])||value[key].length>20||value[key].some(x=>typeof x!=='string'||x.length>100))throw Error('兴趣和偏好请填写简短文本列表');
      next[key]=value[key];
    }
    if(value.maxReplyChars!==undefined) {
      if(!Number.isInteger(value.maxReplyChars)||value.maxReplyChars<50||value.maxReplyChars>10000)throw Error('单次回复上限请填写 50 到 10000 的整数');
      next.maxReplyChars=value.maxReplyChars;
    }
    const temp=this.file+'.tmp';fs.writeFileSync(temp,JSON.stringify(next,null,2));fs.renameSync(temp,this.file);return next;
  }
}
