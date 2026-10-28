import {DatabaseSync} from 'node:sqlite';
import {randomUUID} from 'node:crypto';
import path from 'node:path';
import fs from 'node:fs';

/** Buffered metadata only. No prompts, QQ text, API keys, or extra model calls. */
export class ModelDiagnostics {
  constructor(file,options={}) {
    fs.mkdirSync(path.dirname(file),{recursive:true});
    this.db=new DatabaseSync(file,{timeout:1000});this.buffer=[];this.lastError=null;
    this.db.exec(`PRAGMA journal_mode=WAL;PRAGMA synchronous=NORMAL;
      CREATE TABLE IF NOT EXISTS model_requests(id TEXT PRIMARY KEY,at INTEGER NOT NULL,provider TEXT NOT NULL,
        model TEXT NOT NULL,status TEXT NOT NULL,ms INTEGER NOT NULL,data TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS model_requests_at ON model_requests(at);`);
    this.timer=setInterval(()=>{try{this.flush();}catch{this.lastError='DIAGNOSTICS_WRITE_FAILED';}},options.flushMs||5000);
    this.timer.unref?.();
  }
  record(row) {
    if(this.buffer.length>=1000)this.buffer.shift();
    // Whitelist fields; callers cannot accidentally persist a prompt/body.
    const {provider,model,status,ms,error,usage,inputBytes,attempts,estimatedCostUsd,route,effort}=row;
    this.buffer.push({id:randomUUID(),at:Date.now(),provider,model,status,ms:Math.max(0,Math.round(ms||0)),
      data:{error:error?String(error).replace(/[^A-Z0-9_]/g,'').slice(0,100):undefined,usage,inputBytes,attempts,estimatedCostUsd,route,effort}});
  }
  wrap(answer) {
    const wrapped=async(cfg,question,history,context={})=>{
      const at=Date.now(),provider=cfg.llm?.apiBase?.includes('api.deepseek.com')?'deepseek':cfg.llm?.type==='openai_compatible'?'compatible':'codex';
      const base={provider,model:cfg.llm?.model||cfg.model,route:context.mode==='ambient'?'social':context.webSearchAllowed?'web':'chat'};
      try {
        const result=await answer(cfg,question,history,context);
        this.record({...base,status:'ok',ms:Date.now()-at,usage:result.usage,estimatedCostUsd:result.estimatedCostUsd,
          effort:result.diagnostics?.effectiveEffort??cfg.reasoningEffort,
          inputBytes:result.diagnostics?.attempts?.[0]?.inputBytes??result.diagnostics?.inputBytes,attempts:result.diagnostics?.attempts});
        return result;
      }catch(error) {
        this.record({...base,status:'failed',ms:Date.now()-at,error:error.message,usage:error.usage,estimatedCostUsd:error.estimatedCostUsd,
          effort:error.diagnostics?.attempts?.at(-1)?.effort??cfg.reasoningEffort,
          inputBytes:error.diagnostics?.attempts?.[0]?.inputBytes,attempts:error.diagnostics?.attempts});
        throw error;
      }
    };
    Object.assign(wrapped,answer);return wrapped;
  }
  flush() {
    if(!this.buffer.length||!this.db.isOpen)return;
    const batch=this.buffer.splice(0);
    try {
      this.db.exec('BEGIN IMMEDIATE');
      const insert=this.db.prepare('INSERT INTO model_requests VALUES(?,?,?,?,?,?,?)');
      for(const row of batch)insert.run(row.id,row.at,row.provider,row.model,row.status,row.ms,JSON.stringify(row.data));
      this.db.prepare('DELETE FROM model_requests WHERE at<?').run(Date.now()-7*86400000);
      this.db.exec('DELETE FROM model_requests WHERE id IN (SELECT id FROM model_requests ORDER BY at DESC LIMIT -1 OFFSET 20000)');
      this.db.exec('COMMIT');this.lastError=null;
    }catch(error){try{this.db.exec('ROLLBACK');}catch{}this.buffer.unshift(...batch);throw error;}
  }
  summary(hours=24) {
    const since=Date.now()-Math.max(1,Math.min(168,Number(hours)||24))*3600000;
    const rows=this.db.prepare('SELECT at,provider,model,status,ms,data FROM model_requests WHERE at>=? ORDER BY at').all(since)
      .map(row=>({...row,data:JSON.parse(row.data)})).concat(this.buffer.filter(row=>row.at>=since));
    const groups=new Map();
    for(const row of rows) {
      const key=`${row.provider}:${row.model}:${row.data.effort||'unknown'}`,g=groups.get(key)||{provider:row.provider,model:row.model,effort:row.data.effort||'unknown',requests:0,failures:0,
        actualAttempts:0,retries:0,attemptFailures:0,inputTokens:0,cachedTokens:0,outputTokens:0,reasoningTokens:0,unknownUsage:0,
        inputBytesTotal:0,inputBytesSamples:0,estimatedCostUsd:0,costMeasuredCalls:0,latencies:[],errors:{},attemptErrors:{}};
      g.requests++;g.latencies.push(row.ms);if(row.status!=='ok')g.failures++;
      if(row.data.error)g.errors[row.data.error]=(g.errors[row.data.error]||0)+1;
      const attempts=row.data.attempts||[];g.actualAttempts+=attempts.length||1;g.retries+=Math.max(0,attempts.length-1);
      for(const attempt of attempts)if(attempt.status!=='ok'){g.attemptFailures++;if(attempt.error)g.attemptErrors[attempt.error]=(g.attemptErrors[attempt.error]||0)+1;}
      if(Number.isFinite(row.data.inputBytes)){g.inputBytesTotal+=row.data.inputBytes;g.inputBytesSamples++;}
      const u=row.data.usage;
      if(u){g.inputTokens+=u.input_tokens||0;g.cachedTokens+=u.cached_input_tokens||0;g.outputTokens+=u.output_tokens||0;g.reasoningTokens+=u.reasoning_output_tokens||0;}
      else g.unknownUsage++;
      if(Number.isFinite(row.data.estimatedCostUsd)){g.estimatedCostUsd+=row.data.estimatedCostUsd;g.costMeasuredCalls++;}
      groups.set(key,g);
    }
    const providers=[...groups.values()].map(g=>{
      g.latencies.sort((a,b)=>a-b);const p=f=>g.latencies[Math.max(0,Math.ceil(g.latencies.length*f)-1)]||0;
      const {latencies,...rest}=g;return {...rest,p50Ms:p(.5),p95Ms:p(.95),failureRate:g.failures/g.requests,
        averageInputBytes:g.inputBytesSamples?Math.round(g.inputBytesTotal/g.inputBytesSamples):null,
        cacheRate:g.inputTokens?g.cachedTokens/g.inputTokens:0};
    });
    return {hours,providers,buffered:this.buffer.length,lastError:this.lastError,retentionDays:7,
      note:'仅元数据；费用为标价估算，DeepSeek 按工作日峰谷计算，未自动识别中国法定节假日。未知用量不会记为零消耗。'};
  }
  close(){clearInterval(this.timer);try{this.flush();}catch{this.lastError='DIAGNOSTICS_WRITE_FAILED';}finally{if(this.db.isOpen)this.db.close();}}
}
