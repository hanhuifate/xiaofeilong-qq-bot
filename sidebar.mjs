import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';

// The host alone organizes trusted, newly created QQ group threads. QQ content
// cannot choose a tool, destination, caller identity, or arbitrary thread id.
export function createSidebarOrganizer(cfg, update = () => {}) {
  let serverPath;
  return async (chat, threadId) => {
    if (!/^(?:private:)?\d+$/.test(String(chat)) || !cfg.performance?.groupSidebarSectionId) return;
    if (!process.env.CODEX_APP_TOOLS_PIPE_PATH || !process.env.CODEX_THREAD_ID) {
      update({ lastSidebarError: 'APP_TOOLS_NOT_CONNECTED' }); return false;
    }
    try {
      if (!serverPath || !fs.existsSync(serverPath)) {
        const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
          "Get-Process ChatGPT -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Path -Unique | Where-Object { $_ -match 'OpenAI.Codex_' } | Select-Object -First 1"],
          { windowsHide: true, timeout: 5000, encoding: 'utf8' });
        if (result.status !== 0 || !result.stdout.trim()) throw Error();
        serverPath = path.join(path.dirname(result.stdout.trim()), 'resources', 'plugins', 'openai-bundled', 'plugins', 'codex-app-tools', 'server.mjs');
        if (!fs.existsSync(serverPath)) throw Error();
      }
      await move(serverPath, threadId, cfg.performance.groupSidebarSectionId);
      update({ lastSidebarError: null, lastOrganizedThreadId: threadId });
      return true;
    } catch { update({ lastSidebarError: 'SIDEBAR_MOVE_FAILED' }); return false; }
  };
}

async function move(serverPath, threadId, sectionId) {
  if (!/^[a-f0-9-]{36}$/.test(threadId) || !/^[a-f0-9-]{36}$/.test(sectionId)) throw Error();
  const child = spawn(process.execPath, [serverPath], { env: process.env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  const pending = new Map(); let next = 0, buffer = '';
  const fail = () => { for (const p of pending.values()) p.reject(Error('APP_TOOLS_OFFLINE')); pending.clear(); };
  child.once('error', fail); child.once('exit', fail); child.stdin.on('error', fail); child.stderr.resume();
  child.stdout.setEncoding('utf8'); child.stdout.on('data', data => {
    buffer += data; let i;
    while ((i = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, i); buffer = buffer.slice(i + 1);
      let r; try { r = JSON.parse(line); } catch { continue; }
      const p = pending.get(r.id); if (!p) continue;
      pending.delete(r.id); r.error ? p.reject(Error('APP_TOOLS_FAILED')) : p.resolve(r.result);
    }
  });
  const rpc = (method, params) => new Promise((resolve, reject) => {
    const id = ++next; pending.set(id, { resolve, reject }); child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
  const timeout = setTimeout(() => { fail(); child.kill(); }, 10000);
  try {
    await rpc('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'qq-sidebar-organizer', version: '1' } });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
    const result = await rpc('tools/call', { name: 'move_thread_to_sidebar_section', arguments: { threadId, sectionId },
      _meta: { 'openai/threadId': process.env.CODEX_THREAD_ID } });
    if (result.isError) throw Error('APP_TOOLS_MOVE_FAILED');
  } finally { clearTimeout(timeout); child.kill(); }
}
