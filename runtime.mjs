import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

/** Keep an explicit working executable; recover from a removed app cache. */
export function codexExecutable(configured) {
  if(configured&&fs.existsSync(configured))return configured;
  const base=path.join(process.env.LOCALAPPDATA||path.join(os.homedir(),'AppData','Local'),'OpenAI','Codex','bin');
  let candidates=[];
  try{candidates=fs.readdirSync(base,{withFileTypes:true}).filter(x=>x.isDirectory()).map(x=>path.join(base,x.name,'codex.exe')).filter(x=>fs.existsSync(x));}catch{}
  candidates.sort((a,b)=>fs.statSync(b).mtimeMs-fs.statSync(a).mtimeMs);
  if(!candidates.length)throw Error('CODEX_EXECUTABLE_MISSING');return candidates[0];
}

export function pythonExecutable(configured) {
  if(configured&&fs.existsSync(configured))return configured;
  const managed=path.join(os.homedir(),'.dafeilong-runtime','astrbot-venv','Scripts','python.exe');
  return fs.existsSync(managed)?managed:'python';
}
