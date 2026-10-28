import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

export class WakeManager {
  constructor(cfg, options = {}) {
    this.cfg = cfg;
    this.enabled = !!cfg.social?.autonomousWake;
    this.settings = { minIntervalSeconds: 60, maxWakePerHour: 12, engageSeconds: 180,
      maxFollowups: 3, defaultDiveSeconds: 120, ...cfg.social?.wake };
    this.file = options.file;
    this.now = options.now || Date.now;
    this.state = { version: 1, chats: {} };
    if (this.enabled && this.file) {
      try {
        const data = JSON.parse(fs.readFileSync(this.file, 'utf8'));
        if (data.version !== 1 || !data.chats || typeof data.chats !== 'object' || Array.isArray(data.chats)) throw Error();
        this.state = data;
      } catch (e) { if (e.code !== 'ENOENT') throw new Error('WAKE_STATE_INVALID'); }
    }
  }
  save() {
    if (!this.file || !this.enabled) return;
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const temp = this.file + '.' + randomUUID() + '.tmp';
    fs.writeFileSync(temp, JSON.stringify(this.state, null, 2)); fs.renameSync(temp, this.file);
  }
  get(chat) {
    return this.state.chats[String(chat)] ||= { mode: 'diving', until: 0, user: '', topic: '',
      followups: 0, silentStreak: 0, calls: [], lastReason: 'initial' };
  }
  reason(chat, message) {
    if (!this.enabled || !message || message.addressedToOthers) return null;
    const s = this.get(chat), now = this.now();
    const activity = message.social || this.cfg.social?.groupOverrides?.[String(chat)] ||
      (this.cfg.social?.activeMode ? this.cfg.social : null);
    if (s.until > now && s.mode === 'diving') return null;
    s.calls = s.calls.filter(t => now - t < 3600000);
    const minInterval = activity?.activeMode ? (activity.minIntervalSeconds ?? this.settings.minIntervalSeconds) : this.settings.minIntervalSeconds;
    const hourlyLimit = activity?.activeMode ? (activity.maxWakePerHour ?? this.settings.maxWakePerHour) : this.settings.maxWakePerHour;
    if (s.calls.length >= hourlyLimit) return null;
    const text = message.text || '';
    if ((s.mode === 'engaged' || s.mode === 'observing') && s.until > now &&
        s.user === String(message.user) && s.followups < this.settings.maxFollowups) {
      const words = (s.topic.match(/[a-zA-Z0-9_]{3,}|[\p{Script=Han}]{2,}/gu) || [])
        .flatMap(w => w.length > 3 ? Array.from({ length: w.length - 1 }, (_, i) => w.slice(i, i + 2)) : [w]);
      if (/那(?:么|这个|怎么|为什么)|所以|刚才|上面|还是|具体|继续|没懂|不明白|再说|还有|对了/.test(text) || words.some(w => text.includes(w))) return 'followup';
    }
    if (now - (s.calls.at(-1) || 0) < minInterval * 1000) return null;
    // Let the conversation model judge social relevance, rather than a
    // keyword list or random lottery excluding ordinary banter upfront.
    if (activity?.activeMode && activity.semanticParticipation && text.trim()) return 'social_context';
    if (/(?:有谁|谁知道|有没有人|有人会|求助|请教|帮忙|如何|为什么|怎么(?:做|用|写|修|解决|安装|配置)|报错|编译失败)/.test(text) &&
        !/(?:你(?:们)?(?:几点|在哪|到哪|到了|吃了|回家)|给我打电话)/.test(text)) return 'public_help';
    if (activity?.activeMode && message.messageId !== undefined && activity.activeProbability > 0) {
      // Keep this social wake decision stable across repeated dispatch checks
      // for the same QQ message.
      let hash = 2166136261;
      for (const ch of `${chat}:${message.messageId}`) hash = Math.imul(hash ^ ch.charCodeAt(0), 16777619) >>> 0;
      if (hash / 0x100000000 < Math.min(1, activity.activeProbability)) return 'active_chat';
    }
    return null;
  }
  called(chat, user, topic) {
    if (!this.enabled) return;
    const s = this.get(chat);
    Object.assign(s, { mode: 'observing', until: this.now() + this.settings.engageSeconds * 1000,
      user: String(user), topic: String(topic).slice(0, 300), followups: 0, silentStreak: 0, lastReason: 'explicit' });
    this.save();
  }
  evaluated(chat, reason) {
    if (!this.enabled) return;
    const s = this.get(chat); s.calls = s.calls.filter(t => this.now() - t < 3600000);
    s.calls.push(this.now()); s.lastReason = reason;
    if (reason === 'public_help') s.followups = 0;
    if (reason === 'followup') s.followups++;
    this.save();
  }
  settle(chat, response, user, topic, activity = {}) {
    if (!this.enabled) return;
    const s = this.get(chat), plan = response.wakePlan || {};
    if (s.user !== String(user) || s.until <= this.now()) s.followups = 0;
    if (response.shouldReply === false) s.silentStreak++; else s.silentStreak = 0;
    const mode = ['dive', 'observe', 'engage'].includes(plan.mode) ? plan.mode : response.shouldReply === false ? 'dive' : 'engage';
    let seconds = Number(plan.seconds) || (mode === 'dive' ? this.settings.defaultDiveSeconds * 2 ** Math.min(4, s.silentStreak - 1) : this.settings.engageSeconds);
    const active=activity.activeMode??this.cfg.social?.groupOverrides?.[String(chat)]?.activeMode??this.cfg.social?.activeMode;
    const cap=mode==='dive'&&active?Math.max(5,Math.min(120,activity.modelDiveMaxSeconds??this.cfg.social?.modelDiveMaxSeconds??30)):
      mode==='dive'?7200:this.settings.engageSeconds;
    seconds = Math.max(Math.min(60,cap), Math.min(cap, seconds));
    Object.assign(s, { mode: { dive: 'diving', observe: 'observing', engage: 'engaged' }[mode],
      until: this.now() + seconds * 1000, user: String(user), topic: String(topic).slice(0, 300),lastReason:'model_plan' });
    this.save();
  }
  dive(chat, seconds = 600) {
    if (!this.enabled) return;
    Object.assign(this.get(chat), { mode: 'diving', until: this.now() + Math.max(60, Math.min(7200, seconds)) * 1000, lastReason: 'requested' });
    this.save();
  }
}
