import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import dns from 'node:dns/promises';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';

const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const dangerousText = /登录|注册|密码|支付|付款|购买|下单|删除|提交|发布|发送|确认|授权|允许|下载|安装|退出|sign\s*in|log\s*in|password|pay|buy|delete|submit|post|send|confirm|authorize|allow|download|install|sign\s*out/i;
function privateAddress(ip) {
  if (net.isIP(ip) === 4) return /^(?:0\.|10\.|127\.|169\.254\.|172\.(?:1[6-9]|2\d|3[01])\.|192\.168\.|100\.(?:6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.)/.test(ip);
  const v = ip.toLowerCase(); return v === '::1' || v.startsWith('fc') || v.startsWith('fd') || v.startsWith('fe80:');
}
async function publicUrl(value) {
  let url; try { url = new URL(String(value)); } catch { throw new Error('BROWSER_URL_INVALID'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || (url.port && !['80', '443'].includes(url.port))) throw new Error('BROWSER_URL_REJECTED');
  const host = url.hostname.toLowerCase();
  if (host === 'localhost' || host.endsWith('.local') || net.isIP(host) && privateAddress(host)) throw new Error('BROWSER_URL_REJECTED');
  const records = await dns.lookup(host, { all: true, verbatim: true });
  if (!records.length || records.some(x => privateAddress(x.address))) throw new Error('BROWSER_URL_REJECTED');
  return url.href;
}
function edgePath(cfg) {
  const choices = [cfg.capabilities?.browserExecutable, 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe', 'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe'];
  return choices.find(x => x && fs.existsSync(x));
}

export class IsolatedBrowser {
  constructor(cfg, root) {
    this.cfg = cfg; this.root = root;
    this.groups = new Set((cfg.capabilities?.browserGroups || []).map(String));
    this.port = Number(cfg.capabilities?.browserDebugPort || 19333);
    this.dir = path.join(root, 'data', 'browser'); this.pending = new Map(); this.nextId = 0; this.freshScreenshots = new Set();
    this.testIntents = new Map(); this.testsFile = path.join(this.dir, 'completed-tests.json');
  }
  enabledFor(group) { return this.groups.has(String(group)); }
  authorizeTest(group) { if (this.enabledFor(group)) this.testIntents.set(String(group), Date.now() + 30 * 60000); }
  testAllowed(group) { return (this.testIntents.get(String(group)) || 0) > Date.now(); }
  completedTests() {
    try { const items = JSON.parse(fs.readFileSync(this.testsFile, 'utf8')); return Array.isArray(items) ? items.filter(x => /^[a-f0-9]{64}$/.test(x.id)) : []; }
    catch { return []; }
  }
  recordTest(id, url, title) {
    const entries = this.completedTests(); entries.push({ id, url, title, at: new Date().toISOString() });
    fs.mkdirSync(this.dir, { recursive: true });
    const temp = `${this.testsFile}.tmp`; fs.writeFileSync(temp, JSON.stringify(entries.slice(-500), null, 2)); fs.renameSync(temp, this.testsFile);
  }
  async testIdentity() {
    const result = await this.call('Runtime.evaluate', { expression: 'JSON.stringify({title:document.title.slice(0,160),url:location.href})', returnByValue: true });
    let page = {}; try { page = JSON.parse(result.result?.value || '{}'); } catch { /* rejected below */ }
    const url = await publicUrl(page.url); const parsed = new URL(url); parsed.search = ''; parsed.hash = '';
    return { url: parsed.href, title: String(page.title || '').slice(0, 160), id: createHash('sha256').update(parsed.href).digest('hex') };
  }
  async start() {
    if (this.ws?.readyState === WebSocket.OPEN) return;
    const endpoint = `http://127.0.0.1:${this.port}/json/version`;
    let info;
    try { info = await (await fetch(endpoint, { signal: AbortSignal.timeout(700) })).json(); } catch { /* launch below */ }
    if (!info) {
      const executable = edgePath(this.cfg); if (!executable) throw new Error('BROWSER_EDGE_NOT_FOUND');
      fs.mkdirSync(this.dir, { recursive: true });
      this.proc = spawn(executable, [`--remote-debugging-port=${this.port}`, `--user-data-dir=${path.join(this.dir, 'profile')}`,
        '--headless=new', '--no-first-run', '--no-default-browser-check', '--disable-sync', '--disable-extensions', 'about:blank'],
        { windowsHide: true, stdio: 'ignore' });
      for (let i = 0; i < 30; i++) {
        await pause(250);
        try { info = await (await fetch(endpoint, { signal: AbortSignal.timeout(700) })).json(); break; } catch { /* keep waiting */ }
      }
    }
    if (!info?.webSocketDebuggerUrl) throw new Error('BROWSER_START_FAILED');
    const ws = this.ws = new WebSocket(info.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => { const timer = setTimeout(() => reject(new Error('BROWSER_CONNECT_TIMEOUT')), 6000);
      ws.addEventListener('open', () => { clearTimeout(timer); resolve(); }, { once: true });
      ws.addEventListener('error', () => { clearTimeout(timer); reject(new Error('BROWSER_CONNECT_FAILED')); }, { once: true }); });
    ws.addEventListener('message', event => this.consume(String(event.data)));
    ws.addEventListener('close', () => { this.ws = null; for (const entry of this.pending.values()) entry.reject(new Error('BROWSER_CLOSED')); this.pending.clear(); });
    const target = await this.call('Target.createTarget', { url: 'about:blank' });
    const attached = await this.call('Target.attachToTarget', { targetId: target.targetId, flatten: true });
    this.sessionId = attached.sessionId;
    await this.call('Page.enable'); await this.call('Runtime.enable');
  }
  consume(raw) {
    let event; try { event = JSON.parse(raw); } catch { return; }
    if (event.id === undefined) return;
    const pending = this.pending.get(event.id); if (!pending) return;
    this.pending.delete(event.id); clearTimeout(pending.timer);
    event.error ? pending.reject(new Error(`BROWSER_CDP_${event.error.code}`)) : pending.resolve(event.result || {});
  }
  call(method, params = {}) {
    return new Promise((resolve, reject) => {
      const id = ++this.nextId, timer = setTimeout(() => { this.pending.delete(id); reject(new Error('BROWSER_CDP_TIMEOUT')); }, 10000);
      this.pending.set(id, { resolve, reject, timer });
      this.ws.send(JSON.stringify({ id, method, params, ...(this.sessionId && !method.startsWith('Target.') ? { sessionId: this.sessionId } : {}) }));
    });
  }
  async elementAt(x, y) {
    if (!Number.isInteger(x) || !Number.isInteger(y) || x < 0 || y < 0 || x > 2400 || y > 1800) throw new Error('BROWSER_COORDINATES_REJECTED');
    const expression = `(()=>{const e=document.elementFromPoint(${x},${y});if(!e)return null;return {tag:e.tagName,type:e.type||'',text:(e.innerText||e.value||e.getAttribute('aria-label')||'').slice(0,120),href:e.href||'',editable:!!e.isContentEditable,action:e.form?.action||''}})()`;
    const result = await this.call('Runtime.evaluate', { expression, returnByValue: true }); return result.result?.value || null;
  }
  safeElement(element, typing = false) {
    if (!element || dangerousText.test(`${element.text} ${element.action}`) || /password|file|submit|reset/i.test(element.type || '')) throw new Error('BROWSER_SENSITIVE_ACTION_BLOCKED');
    if (typing && !['INPUT', 'TEXTAREA'].includes(element.tag) && !element.editable) throw new Error('BROWSER_TEXT_TARGET_REJECTED');
  }
  safeTestSubmit(element) {
    if (!element || /登录|注册|密码|支付|付款|购买|删除|授权|login|sign\s*in|password|pay|buy|delete|authoriz/i.test(`${element.text} ${element.action}`) || /password|file/i.test(element.type || '')) throw new Error('BROWSER_SENSITIVE_ACTION_BLOCKED');
    if (!/提交|交卷|完成|检查答案|submit|finish|check\s*answers/i.test(element.text || '') && !/submit/i.test(element.type || '')) throw new Error('BROWSER_TEST_SUBMIT_REJECTED');
  }
  async snapshot(group) {
    if (!/^\d+$/.test(String(group))) throw new Error('BROWSER_GROUP_REJECTED');
    const [shot, meta] = await Promise.all([
      this.call('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false }),
      this.call('Runtime.evaluate', { expression: 'JSON.stringify({title:document.title.slice(0,120),url:location.href})', returnByValue: true })
    ]);
    const dir = path.join(this.dir, String(group)); fs.mkdirSync(dir, { recursive: true });
    const imagePath = path.join(dir, 'latest.png'); fs.writeFileSync(imagePath, Buffer.from(shot.data, 'base64'));
    let page = {}; try { page = JSON.parse(meta.result?.value || '{}'); } catch { /* display remains optional */ }
    this.freshScreenshots.add(String(group));
    return { imagePath, title: String(page.title || '').slice(0, 120), url: String(page.url || '').slice(0, 1000) };
  }
  attachment(group) {
    const imagePath = path.join(this.dir, String(group), 'latest.png');
    return this.freshScreenshots.has(String(group)) && fs.existsSync(imagePath)
      ? [{ id: 'browser-latest', label: '隔离浏览器当前截图', description: '这是当前网页截图，只能据图回答。', path: imagePath }] : [];
  }
  async act(group, action, options = {}) {
    if (!this.enabledFor(group)) throw new Error('BROWSER_NOT_ALLOWED');
    await this.start();
    const type = action?.type || 'none';
    if (type === 'none') return null;
    if (type === 'open') await this.call('Page.navigate', { url: await publicUrl(action.url) });
    else if (type === 'click') {
      const el = await this.elementAt(action.x, action.y); this.safeElement(el);
      await this.call('Input.dispatchMouseEvent', { type: 'mousePressed', x: action.x, y: action.y, button: 'left', clickCount: 1 });
      await this.call('Input.dispatchMouseEvent', { type: 'mouseReleased', x: action.x, y: action.y, button: 'left', clickCount: 1 });
    } else if (type === 'type') {
      const text = String(action.text || ''); if (!text || text.length > 300 || dangerousText.test(text)) throw new Error('BROWSER_TEXT_REJECTED');
      const el = await this.elementAt(action.x, action.y); this.safeElement(el, true);
      await this.call('Input.dispatchMouseEvent', { type: 'mousePressed', x: action.x, y: action.y, button: 'left', clickCount: 1 });
      await this.call('Input.dispatchMouseEvent', { type: 'mouseReleased', x: action.x, y: action.y, button: 'left', clickCount: 1 });
      await this.call('Input.insertText', { text });
    } else if (type === 'scroll') {
      const deltaY = Number(action.deltaY); if (!Number.isFinite(deltaY) || Math.abs(deltaY) > 1600) throw new Error('BROWSER_SCROLL_REJECTED');
      await this.call('Input.dispatchMouseEvent', { type: 'mouseWheel', x: 640, y: 450, deltaX: 0, deltaY });
    } else if (type === 'submitTest') {
      if (!options.allowTest || !this.testAllowed(group)) throw new Error('BROWSER_TEST_NOT_AUTHORIZED');
      const element = await this.elementAt(action.x, action.y); this.safeTestSubmit(element);
      const test = await this.testIdentity();
      if (this.completedTests().some(item => item.id === test.id)) throw new Error('BROWSER_TEST_ALREADY_COMPLETED');
      // Persist before dispatch: if the page accepts the click but disconnects before its reply,
      // never retry the same test submission.
      this.recordTest(test.id, test.url, test.title);
      await this.call('Input.dispatchMouseEvent', { type: 'mousePressed', x: action.x, y: action.y, button: 'left', clickCount: 1 });
      await this.call('Input.dispatchMouseEvent', { type: 'mouseReleased', x: action.x, y: action.y, button: 'left', clickCount: 1 });
      this.testIntents.delete(String(group));
    } else if (type === 'back') {
      const history = await this.call('Page.getNavigationHistory'); const entry = history.entries.at(-2);
      if (!entry) throw new Error('BROWSER_BACK_UNAVAILABLE'); await this.call('Page.navigateToHistoryEntry', { entryId: entry.id });
    }
    else if (type !== 'screenshot') throw new Error('BROWSER_ACTION_REJECTED');
    await pause(900); return this.snapshot(group);
  }
  close() { this.freshScreenshots.clear(); try { this.ws?.close(); } catch { /* ignore */ } try { this.proc?.kill(); } catch { /* ignore */ } }
}
