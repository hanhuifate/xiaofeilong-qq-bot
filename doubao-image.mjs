import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';

const finalStates = new Set(['completed', 'failed', 'cancelled', 'quota_exhausted', 'attention_required', 'login_required', 'captcha_required']);
const ratios = new Set(['1:1', '16:9', '9:16', '4:3', '3:4', '3:2', '2:3']);

function resultData(result) {
  if (result?.structuredContent && typeof result.structuredContent === 'object') return result.structuredContent;
  const item = result?.content?.find(entry => entry?.type === 'text' && typeof entry.text === 'string');
  if (!item) throw new Error('DOUBAO_MCP_RESULT_INVALID');
  return JSON.parse(item.text);
}

export class DoubaoImageService {
  constructor(cfg, root) {
    this.cfg = cfg;
    this.enabled = cfg.capabilities?.doubaoImage?.enabled === true;
    this.url = cfg.capabilities?.doubaoImage?.mcpUrl || 'http://127.0.0.1:8878/mcp';
    this.outputRoot = path.resolve(root, cfg.capabilities?.doubaoImage?.outputRoot || 'runtime/autodoubao/outputs');
    this.browserManager = path.join(root, 'Manage-Doubao-Browser.ps1');
    this.watchdogEnabled = cfg.capabilities?.doubaoImage?.browserWatchdog !== false;
    this.session = '';
    this.nextId=10;
    this.deliveryFile=path.join(root,'data','doubao-deliveries.json');
    this.deliveries={};
    this.pollDelay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
    try {this.deliveries=JSON.parse(fs.readFileSync(this.deliveryFile,'utf8'));}catch{}
  }
  manageBrowser(action = 'Ensure') {
    if (!this.enabled || !fs.existsSync(this.browserManager)) return Promise.resolve({ enabled: false, running: false });
    return new Promise((resolve, reject) => {
      const proc = spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', this.browserManager, '-Action', action],
        { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
      let output = '';
      const timer = setTimeout(() => { proc.kill(); reject(new Error('DOUBAO_BROWSER_MANAGER_TIMEOUT')); }, 15_000);
      proc.stdout.setEncoding('utf8'); proc.stdout.on('data', data => { output += data; });
      proc.on('error', () => { clearTimeout(timer); reject(new Error('DOUBAO_BROWSER_MANAGER_FAILED')); });
      proc.on('close', code => {
        clearTimeout(timer);
        try {
          if (code !== 0) throw Error();
          resolve(JSON.parse(output.trim().split(/\r?\n/).at(-1)));
        } catch { reject(new Error('DOUBAO_BROWSER_MANAGER_FAILED')); }
      });
    });
  }
  async request(payload, { initialize = false } = {}) {
    const headers = { Accept: 'application/json, text/event-stream', 'Content-Type': 'application/json' };
    if (this.session && !initialize) headers['Mcp-Session-Id'] = this.session;
    const response = await fetch(this.url, { method: 'POST', headers, body: JSON.stringify(payload), signal: AbortSignal.timeout(12_000) });
    if (!response.ok && response.status !== 202) {
      const error=new Error('DOUBAO_SERVICE_UNAVAILABLE');error.httpStatus=response.status;throw error;
    }
    const session = response.headers.get('mcp-session-id');
    if (session) this.session = session;
    const body = await response.text();
    if (!body.trim()) return null;
    const blocks = body.split(/\r?\n\r?\n/);
    for (const block of blocks) {
      const line = block.split(/\r?\n/).find(value => value.startsWith('data:'));
      if (!line) continue;
      const message = JSON.parse(line.slice(5).trim());
      if (message.id === payload.id) {
        if (message.error) throw new Error('DOUBAO_MCP_ERROR');
        return message.result;
      }
    }
    try { return JSON.parse(body).result; } catch { throw new Error('DOUBAO_MCP_RESULT_INVALID'); }
  }
  async connect() {
    if (this.session) return;
    if(this.connecting)return this.connecting;
    this.connecting=this.initialize();
    try{await this.connecting;}finally{this.connecting=null;}
  }
  async initialize() {
    const result = await this.request({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {
      protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'qq-bridge', version: '1.0' }
    } }, { initialize: true });
    if (!result || !this.session) throw new Error('DOUBAO_SERVICE_UNAVAILABLE');
    await this.request({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} });
  }
  async tool(name, arguments_) {
    await this.connect();
    try {
      return resultData(await this.request({ jsonrpc: '2.0', id: ++this.nextId, method: 'tools/call', params: { name, arguments: arguments_ } }));
    } catch (error) {
      // A restarted local bridge invalidates the streamable-HTTP session once.
      this.session = '';
      // A missing MCP session is rejected before dispatch and can be recreated.
      // Never re-submit generation after an ambiguous network/HTTP failure.
      if (name==='doubao_generate'&&error.httpStatus!==404) throw new Error('DOUBAO_SUBMISSION_UNCERTAIN');
      if (error.message !== 'DOUBAO_SERVICE_UNAVAILABLE') throw error;
      await this.connect();
      return resultData(await this.request({ jsonrpc: '2.0', id: ++this.nextId, method: 'tools/call', params: { name, arguments: arguments_ } }));
    }
  }
  async available() {
    if (!this.enabled) return false;
    const state = await this.tool('doubao_status', {});
    return state?.service === 'ok' && state.browser_connected === true && state.doubao_page_ready === true;
  }
  async generate(chat, request) {
    if (!this.enabled || !await this.available()) throw new Error('DOUBAO_NOT_READY');
    const prompt = String(request?.prompt || '').trim().slice(0, 3000);
    if (!prompt) throw new Error('DOUBAO_PROMPT_EMPTY');
    const ratio = ratios.has(request?.ratio) ? request.ratio : '1:1';
    const chatHash = createHash('sha256').update(String(chat)).digest('hex').slice(0, 16);
    const created = await this.tool('doubao_generate', {
      prompt, ratio, candidate_count: 1, output_subdir: `qq/${chatHash}`, agent_id: `qq-${chatHash}`
    });
    if (!created?.ok || !created.job_id) throw new Error('DOUBAO_QUEUE_REJECTED');
    return created;
  }
  imagePath(value) {
    if (typeof value !== 'string' || !value) return null;
    const candidate = path.resolve(value);
    const root = fs.existsSync(this.outputRoot) ? fs.realpathSync(this.outputRoot) : this.outputRoot;
    let real;
    try { real = fs.realpathSync(candidate); } catch { return null; }
    if (!real.startsWith(root + path.sep) || !/\.(?:png|jpe?g|webp|gif)$/i.test(real)) return null;
    return real;
  }
  saveDelivery(jobId,patch) {
    this.deliveries[jobId]={...this.deliveries[jobId],...patch,updatedAt:Date.now()};
    const entries=Object.entries(this.deliveries).sort((a,b)=>b[1].updatedAt-a[1].updatedAt).slice(0,200);
    this.deliveries=Object.fromEntries(entries);
    fs.mkdirSync(path.dirname(this.deliveryFile),{recursive:true});
    const temp=this.deliveryFile+'.tmp';fs.writeFileSync(temp,JSON.stringify(this.deliveries,null,2));fs.renameSync(temp,this.deliveryFile);
  }
  async waitFor(jobId, timeoutMs = (Number(this.cfg.capabilities?.doubaoImage?.waitTimeoutSeconds) || 1200) * 1000) {
    const queuedAt=Date.now();
    const queueTimeout=(Number(this.cfg.capabilities?.doubaoImage?.queueTimeoutSeconds)||1800)*1000;
    let runningAt=null;
    while (Date.now()-queuedAt<queueTimeout+timeoutMs) {
      let state;
      try {state = await this.tool('doubao_job_status', { job_id: jobId });}
      catch {
        if(runningAt!==null&&Date.now()-runningAt>timeoutMs)throw new Error('DOUBAO_RESULT_UNCERTAIN');
        await this.pollDelay(5000);continue;
      }
      if (!state?.ok) throw new Error('DOUBAO_JOB_NOT_FOUND');
      if (finalStates.has(state.status)) return { ...state, imagePaths: (state.images || []).map(value => this.imagePath(value)).filter(Boolean) };
      if(state.status!=='queued'&&runningAt===null)runningAt=Date.now();
      if(runningAt!==null&&Date.now()-runningAt>timeoutMs)throw new Error('DOUBAO_RESULT_UNCERTAIN');
      if(runningAt===null&&Date.now()-queuedAt>queueTimeout)throw new Error('DOUBAO_QUEUE_STILL_WAITING');
      await this.pollDelay(5000);
    }
    throw new Error('DOUBAO_RESULT_UNCERTAIN');
  }
}
