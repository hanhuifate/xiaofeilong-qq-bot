import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { allowedChat } from './chats.mjs';

const root = path.dirname(fileURLToPath(import.meta.url));
export function safeImageUrl(value) {
  let url; try { url = new URL(value); } catch { throw new Error('IMAGE_URL_REJECTED'); }
  const host = url.hostname.toLowerCase();
  if (!['qpic.cn', 'qq.com', 'qq.com.cn'].some(domain => host === domain || host.endsWith('.' + domain)) ||
      url.username || url.password || (url.port && url.port !== '443')) throw new Error('IMAGE_URL_REJECTED');
  if (url.protocol === 'http:') url.protocol = 'https:';
  if (url.protocol !== 'https:') throw new Error('IMAGE_URL_REJECTED');
  url.hash = ''; return url.href;
}
export async function downloadImage(value, maxBytes, fetcher = fetch) {
  let url = safeImageUrl(value);
  for (let redirects = 0; redirects < 4; redirects++) {
    const response = await fetcher(url, { redirect: 'manual', signal: AbortSignal.timeout(20000) });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      await response.body?.cancel();
      url = safeImageUrl(new URL(response.headers.get('location'), url).href); continue;
    }
    if (!response.ok || !response.body) throw new Error('IMAGE_DOWNLOAD_FAILED');
    if (Number(response.headers.get('content-length') || 0) > maxBytes) {
      await response.body.cancel(); throw new Error('IMAGE_TOO_LARGE');
    }
    const chunks = []; let size = 0;
    for await (const chunk of response.body) {
      size += chunk.length;
      if (size > maxBytes) throw new Error('IMAGE_TOO_LARGE');
      chunks.push(chunk);
    }
    if (!size) throw new Error('EMPTY_IMAGE');
    return Buffer.concat(chunks);
  }
  throw new Error('IMAGE_TOO_MANY_REDIRECTS');
}
export function imageSegments(event) {
  return (Array.isArray(event.message) ? event.message : []).filter(s => s.type === 'image' || (s.type === 'mface' && s.data?.url));
}
export function feedingLabel(text, cfg) {
  let body = String(text).trim();
  const name = cfg.persona?.name || '大肥龙';
  if (body.startsWith(name)) body = body.slice(name.length).replace(/^[，,：:\s]+/, '');
  const match = /^(?:投喂|收藏图片|收图)(.*)$/s.exec(body);
  return match ? match[1].replace(/^[，,：:\s]+/, '').trim().slice(0, 80) : null;
}
export function normalizeImage(cfg, input, preview) {
  return new Promise((resolve, reject) => {
    const p = spawn(cfg.pythonPath || 'python.exe', [path.join(root, 'image-worker.py'), input, preview],
      { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
    let output = '';
    const timer = setTimeout(() => { p.kill(); reject(new Error('IMAGE_VALIDATION_TIMEOUT')); }, 15000);
    p.stdout.on('data', data => { if (output.length < 4096) output += data; });
    p.on('error', () => { clearTimeout(timer); reject(new Error('IMAGE_WORKER_FAILED')); });
    p.on('close', code => {
      clearTimeout(timer);
      try { if (code !== 0) throw new Error(); resolve(JSON.parse(output)); }
      catch { reject(new Error('IMAGE_VALIDATION_FAILED')); }
    });
  });
}

export class MediaStore {
  constructor(cfg, api, options = {}) {
    this.cfg = cfg; this.api = api; this.enabled = !!cfg.media?.enabled;
    this.dir = options.dir || path.join(root, 'data', 'images');
    this.fetcher = options.fetcher || fetch; this.normalize = options.normalize || normalizeImage;
    this.settings = { maxBytes: 10 * 1024 * 1024, maxSavedPerGroup: 100, maxTransientPerGroup: 40,
      maxGroupBytes: 200 * 1024 * 1024, transientMinutes: 45, maxImagesPerTurn: 2, ...cfg.media };
    this.indexes = new Map(); this.serial = Promise.resolve();
  }
  directory(group) {
    const id = String(group);
    if (!allowedChat(this.cfg, id) || !/^(?:private:)?\d+$/.test(id)) throw new Error('MEDIA_GROUP_REJECTED');
    return path.join(this.dir, id.replace(':', '-'));
  }
  index(group) {
    const key = String(group), dir = this.directory(key);
    if (!this.indexes.has(key)) {
      fs.mkdirSync(dir, { recursive: true });
      let items = [];
      try { const data = JSON.parse(fs.readFileSync(path.join(dir, 'index.json'), 'utf8')); if (Array.isArray(data)) items = data; } catch { /* new library */ }
      this.indexes.set(key, items.filter(x => /^[a-f0-9]{24}$/.test(x.id) && ['jpg', 'png', 'gif', 'webp'].includes(x.extension)));
      this.prune(key);
    }
    return this.indexes.get(key);
  }
  save(group) {
    const dir = this.directory(group), dest = path.join(dir, 'index.json'), temp = dest + '.tmp';
    fs.writeFileSync(temp, JSON.stringify(this.indexes.get(String(group)), null, 2)); fs.renameSync(temp, dest);
  }
  prune(group) {
    if (!this.indexes.has(String(group))) { this.index(group); return; }
    const key = String(group), items = this.indexes.get(key) || [];
    const cutoff = Date.now() - this.settings.transientMinutes * 60000;
    const transient = items.filter(x => !x.saved && x.createdAt >= cutoff).slice(-this.settings.maxTransientPerGroup);
    const keep = new Set([...items.filter(x => x.saved), ...transient].map(x => x.id));
    const retained = [];
    for (const item of items) {
      const files = this.files(group, item);
      if (keep.has(item.id) && fs.existsSync(files.original) && fs.existsSync(files.preview)) retained.push(item);
      else { for (const file of Object.values(files)) { try { fs.unlinkSync(file); } catch { /* absent */ } } }
    }
    this.indexes.set(key, retained); this.save(group);
  }
  files(group, item) {
    const dir = this.directory(group);
    if (!/^[a-f0-9]{24}$/.test(item.id) || !['jpg', 'png', 'gif', 'webp'].includes(item.extension)) throw new Error('MEDIA_ID_REJECTED');
    return { original: path.join(dir, `${item.id}.${item.extension}`), preview: path.join(dir, `${item.id}.vision.jpg`) };
  }
  get(group, id) { return this.index(group).find(x => x.id === id); }
  async addBytes(group, bytes, { label = '', saved = false, owner = '' } = {}) {
    if (bytes.length > this.settings.maxBytes) throw new Error('IMAGE_TOO_LARGE');
    this.index(group); this.prune(group);
    const id = createHash('sha256').update(bytes).digest('hex').slice(0, 24);
    const items = this.index(group), existing = items.find(x => x.id === id);
    const savedCount = items.filter(x => x.saved).length;
    if (saved && !existing?.saved && savedCount >= this.settings.maxSavedPerGroup) throw new Error('IMAGE_LIBRARY_FULL');
    if (existing) {
      if (saved && !existing.saved) { existing.saved = true; existing.owner = String(owner); }
      if (label.trim()) existing.label = label.trim().slice(0, 80);
      existing.createdAt = Date.now(); this.save(group); return existing;
    }
    if (items.reduce((n, x) => n + x.bytes, 0) + bytes.length > this.settings.maxGroupBytes) throw new Error('IMAGE_LIBRARY_FULL');
    const dir = this.directory(group), input = path.join(dir, `${randomUUID()}.download`), preview = path.join(dir, `${id}.vision.jpg`);
    fs.writeFileSync(input, bytes);
    try {
      const info = await this.normalize(this.cfg, input, preview);
      if (!['jpg', 'png', 'gif', 'webp'].includes(info.extension)) throw new Error('IMAGE_VALIDATION_FAILED');
      const item = { id, extension: info.extension, width: info.width, height: info.height, animated: info.animated,
        bytes: bytes.length, saved, label: label.trim().slice(0, 80), description: '', owner: String(owner), createdAt: Date.now() };
      fs.renameSync(input, this.files(group, item).original); items.push(item); this.save(group); return item;
    } catch (err) { try { fs.unlinkSync(preview); } catch { /* absent */ } throw err; }
    finally { try { fs.unlinkSync(input); } catch { /* moved */ } }
  }
  ingest(event, text = '') {
    const operation = async () => {
      if (!this.enabled) return { items: [], errors: [] };
      const parsed = feedingLabel(text, this.cfg), feed = parsed !== null, label = parsed || '';
      const items = [], errors = [];
      for (const segment of imageSegments(event).slice(0, this.settings.maxImagesPerTurn)) {
        try {
          let url = segment.data?.url;
          if (!url && typeof segment.data?.file === 'string' && segment.data.file.length < 4096) {
            const info = await this.api.call('get_image', { file: segment.data.file }); url = info.url;
          }
          const bytes = await downloadImage(url, this.settings.maxBytes, this.fetcher);
          items.push(await this.addBytes(String(event.group_id), bytes, { saved: feed, label, owner: event.user_id }));
        } catch (err) { errors.push(err.message); }
      }
      return { items, errors, feed };
    };
    const pending = this.serial.then(operation); this.serial = pending.catch(() => {}); return pending;
  }
  sharedEntries(group) {
    this.index(group);
    let keys = [String(group)];
    if (this.settings.shared) {
      keys = fs.readdirSync(this.dir, { withFileTypes: true }).filter(x => x.isDirectory() && /^(?:private-)?\d+$/.test(x.name))
        .map(x => x.name.replace('private-', 'private:')).filter(x => allowedChat(this.cfg, x));
    }
    return keys.flatMap(chat => this.index(chat).filter(item => item.saved).map(item => ({ chat, item })));
  }
  catalog(group, query = '') {
    const all = this.sharedEntries(group).map(({ item: x }) => ({ id: x.id, label: x.label, description: x.description }));
    const unique = [...new Map(all.map(x => [x.id, x])).values()];
    if (query) unique.sort((a, b) => Number(query.includes(a.label) && !!a.label) - Number(query.includes(b.label) && !!b.label));
    return unique.slice(-50);
  }
  attachments(group, ids, { freshOnly = false } = {}) {
    const selected = [];
    for (const id of [...new Set(ids)].reverse()) {
      const item = this.get(group, id);
      if (!item || (freshOnly && item.description)) continue;
      selected.push({ id, label: item.label, description: item.description, path: this.files(group, item).preview });
      if (selected.length >= this.settings.maxImagesPerTurn) break;
    }
    return selected.reverse();
  }
  describe(group, notes, attachedIds) {
    if (!Array.isArray(notes)) return;
    let changed = false;
    for (const note of notes) {
      if (!attachedIds.includes(note.id) || typeof note.description !== 'string') continue;
      const item = this.get(group, note.id);
      if (item) { item.description = note.description.slice(0, 240); changed = true; }
    }
    if (changed) this.save(group);
  }
  outgoing(group, id) {
    const shared = this.settings.shared ? this.sharedEntries(group).find(x => x.item.id === id) : null;
    const item = shared?.item || this.get(group, id);
    if (!item?.saved) return null;
    return { type: 'image', data: { file: pathToFileURL(this.files(shared?.chat || group, item).original).href } };
  }
  feedExisting(group, ids, label, owner) {
    const selected = ids.map(id => this.get(group, id)).filter(Boolean);
    if (this.index(group).filter(x => x.saved).length + selected.filter(x => !x.saved).length > this.settings.maxSavedPerGroup) throw new Error('IMAGE_LIBRARY_FULL');
    for (const item of selected) {
      if (!item.saved) item.owner = String(owner);
      item.saved = true;
      if (label.trim()) item.label = label.trim().slice(0, 80);
    }
    if (selected.length) this.save(group);
    return selected;
  }
  deleteOwned(group, id, owner) {
    const shared = this.settings.shared ? this.sharedEntries(group).find(x => x.item.id === id && x.item.owner === String(owner)) : null;
    group = shared?.chat || group;
    const item = shared?.item || this.get(group, id);
    if (!item || item.owner !== String(owner)) return false;
    for (const file of Object.values(this.files(group, item))) { try { fs.unlinkSync(file); } catch { /* absent */ } }
    this.indexes.set(String(group), this.index(group).filter(x => x.id !== id)); this.save(group); return true;
  }
}
