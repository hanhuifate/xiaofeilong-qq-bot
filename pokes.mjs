import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { allowedChat } from './chats.mjs';

const root = path.dirname(fileURLToPath(import.meta.url));
export function pokeNotice(event, cfg) {
  return cfg.pokes?.enabled && event.post_type === 'notice' && event.notice_type === 'notify' &&
    event.sub_type === 'poke' && String(event.self_id) === cfg.botQQ &&
    allowedChat(cfg, event.group_id ? String(event.group_id) : `private:${event.sender_id || event.user_id}`) && String(event.target_id) === cfg.botQQ &&
    /^\d+$/.test(String(event.user_id)) && String(event.user_id) !== cfg.botQQ;
}
export class PokeController {
  constructor(cfg, api, options = {}) {
    this.cfg = cfg; this.api = api; this.enabled = !!cfg.pokes?.enabled;
    this.settings = { familiarMessages: 3, familiarMinutes: 30, groupCooldownSeconds: 180,
      userCooldownSeconds: 600, reactiveCooldownSeconds: 45, maxPerHour: 6, probability: 0.18, ...cfg.pokes };
    this.random = options.random || Math.random;
    this.file = options.file || path.join(root, 'data', 'poke-preferences.json');
    this.groups = new Map(); this.optouts = {};
    try { this.optouts = JSON.parse(fs.readFileSync(this.file, 'utf8')); } catch { /* no preferences */ }
  }
  group(id) {
    const key = String(id);
    if (!allowedChat(this.cfg, key)) throw new Error('POKE_GROUP_REJECTED');
    if (!this.groups.has(key)) this.groups.set(key, { members: new Map(), sent: [], lastGroup: 0, lastUsers: new Map(), received: new Map() });
    return this.groups.get(key);
  }
  remember(event) {
    if (!this.enabled || String(event.user_id) === this.cfg.botQQ) return;
    const g = this.group(event.group_id), id = String(event.user_id);
    if (!/^\d+$/.test(id)) return;
    const old = g.members.get(id), now = Date.now();
    const fresh = old && now - old.last < this.settings.familiarMinutes * 60000;
    g.members.delete(id);
    g.members.set(id, { id, name: String(event.sender?.card || event.sender?.nickname || `群友${id}`).slice(0, 30),
      count: fresh ? old.count + 1 : 1, last: now });
    if (g.members.size > 200) g.members.delete(g.members.keys().next().value);
  }
  preference(group, user, allow) {
    if (!/^\d+$/.test(String(user))) return;
    this.group(group);
    const key = `${group}:${user}`;
    if (allow) delete this.optouts[key]; else this.optouts[key] = true;
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(this.file, JSON.stringify(this.optouts, null, 2));
  }
  receiveAllowed(event) {
    if (!pokeNotice(event, this.cfg)) return false;
    const g = this.group(event.group_id || `private:${event.sender_id || event.user_id}`), id = String(event.sender_id || event.user_id), now = Date.now();
    if (now - (g.received.get(id) || 0) < this.settings.reactiveCooldownSeconds * 1000) return false;
    g.received.set(id, now);
    if (g.received.size > 200) g.received.delete(g.received.keys().next().value);
    return true;
  }
  eligible(group, user, { actor = '', reactive = false } = {}) {
    if (!this.enabled || !/^\d+$/.test(String(user)) || String(user) === this.cfg.botQQ || this.optouts[`${group}:${user}`]) return false;
    const g = this.group(group), now = Date.now();
    g.sent = g.sent.filter(t => now - t < 3600000);
    if (g.sent.length >= this.settings.maxPerHour) return false;
    const backPoke = reactive && String(user) === String(actor);
    const minGroup = backPoke ? this.settings.reactiveCooldownSeconds : this.settings.groupCooldownSeconds;
    const minUser = backPoke ? this.settings.reactiveCooldownSeconds : this.settings.userCooldownSeconds;
    if (now - g.lastGroup < minGroup * 1000 || now - (g.lastUsers.get(String(user)) || 0) < minUser * 1000) return false;
    if (backPoke) return true;
    const member = g.members.get(String(user));
    return !!member && member.count >= this.settings.familiarMessages && now - member.last < this.settings.familiarMinutes * 60000;
  }
  choices(event, { reactive = false } = {}) {
    if (!this.enabled) return [];
    const group = String(event.group_id), g = this.group(group), actor = String(event.user_id);
    if (!reactive && this.random() >= this.settings.probability) return [];
    const candidates = reactive ? [actor] : [...g.members.keys()];
    return candidates.filter(id => this.eligible(group, id, { actor, reactive })).slice(-8)
      .map(id => ({ id, name: g.members.get(id)?.name || '刚戳你的群友' }));
  }
  async send(event, target, allowed) {
    const reactive = event._interaction === 'poke' || event._requestedPoke === true, group = String(event.group_id), id = String(target);
    if (!allowed.some(x => x.id === id) || !this.eligible(group, id, { actor: String(event.user_id), reactive })) return false;
    if (group.startsWith('private:') && id !== group.slice(8)) return false;
    await this.api.call('send_poke', { ...(group.startsWith('private:') ? {} : { group_id: group }), user_id: id, target_id: id });
    const g = this.group(group), now = Date.now();
    g.sent.push(now); g.lastGroup = now; g.lastUsers.delete(id); g.lastUsers.set(id, now);
    if (g.lastUsers.size > 200) g.lastUsers.delete(g.lastUsers.keys().next().value);
    return true;
  }
  mood() { return ['嘴贫但友好，像被打扰的小懒龙', '温和、略带惊讶', '一本正经地开一个无害的小玩笑', '俏皮地回一句，不讽刺不攻击人'][Math.floor(this.random() * 4) % 4]; }
}
