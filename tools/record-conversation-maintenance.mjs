import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {BotStorage} from '../storage.mjs';
import {readConfig} from '../bridge.mjs';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..'),cfg=readConfig();
const store=new BotStorage(path.join(root,'data/bot.sqlite3'));let added=0,tokens=0;
try{
 const settings={...cfg.budget,...store.setting('global','budget')};
 for(const [file,route]of [['work/unified-migration.json','migration'],['work/unified-acceptance/result.json','verification']]) {
  const report=JSON.parse(fs.readFileSync(path.join(root,file),'utf8'));
  for(const [index,row]of (report.results||report.rows||[]).entries()) {
   if(!row.usage||!row.threadId)continue;
   const u=row.usage,input=u.input_tokens||0,cached=Math.min(input,u.cached_input_tokens||0),output=u.output_tokens||0;
   const priced=Number(settings.inputPerMillion)>0||Number(settings.outputPerMillion)>0;
   const cost=priced?((input-cached)*(settings.inputPerMillion||0)+cached*(settings.cachedPerMillion||0)+output*(settings.outputPerMillion||0))/1000000:0;
   const result=store.db.prepare('INSERT OR IGNORE INTO model_usage VALUES(?,?,?,?,?,?,?,?)').run(
    `unified-maintenance:${route}:${row.threadId}:${index}`,Date.now(),row.chat||'local-verification',input,cached,output,cost,
    JSON.stringify({model:cfg.model,provider:'codex',route,maintenance:true,estimated:false,pricingConfigured:priced}));
   added+=result.changes;if(result.changes)tokens+=input+output;
  }
 }
 console.log(JSON.stringify({added,tokens,pricingConfigured:Number(settings.inputPerMillion)>0||Number(settings.outputPerMillion)>0}));
}finally{store.close();}
