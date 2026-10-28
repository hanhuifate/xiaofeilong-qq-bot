import { chatKey } from './chats.mjs';
import { imageSegments } from './media.mjs';

export function voiceSegments(event) {
  return (Array.isArray(event.message) ? event.message : []).filter(s => s.type === 'record');
}

export class SpeechRecognizer {
  constructor(cfg, api, update = () => {}) {
    this.cfg = cfg; this.api = api; this.update = update; this.enabled = !!cfg.speech?.enabled;
    this.settings = { maxConcurrent: 2, maxQueue: 24, maxDurationSeconds: 120,
      maxTextChars: 6000, retryDelayMs: 600, ...cfg.speech };
    this.active = 0; this.waiters = []; this.chats = new Map(); this.cache = new Map(); this.inflight = new Map();
  }
  prepare(event) {
    const key = chatKey(event), voice = this.enabled&&voiceSegments(event).length > 0;
    const quoted = event.message?.some(s => s.type === 'reply');
    if (!voice && !quoted && !this.chats.has(key)) return Promise.resolve(event);
    const previous = this.chats.get(key) || Promise.resolve();
    // Only intake/transcription is serialized. Release this chain before model
    // generation so later messages can still join the live followup buffer.
    const work = previous.then(async () => {
      const prepared = voice ? await this.convert(event) : event;
      return quoted ? this.prepareQuote(prepared) : prepared;
    });
    const tail = work.catch(() => {}); this.chats.set(key, tail);
    tail.then(() => { if (this.chats.get(key) === tail) this.chats.delete(key); });
    return work;
  }
  async prepareQuote(event) {
    const id = event.message.find(s => s.type === 'reply')?.data?.id;
    if (!/^-?\d+$/.test(String(id))) return event;
    let note,quotedUser='',quote=null,quotedImageEvent=null,quoteUnavailable=false;
    try {
      const original = await this.api.call('get_msg', { message_id: id });
      if (!Array.isArray(original?.message)) throw Error('missing quote');
      if (event.message_type === 'group' && String(original.group_id) !== String(event.group_id)) throw Error('quote scope mismatch');
      if (event.message_type === 'private' && (original.message_type !== 'private' ||
          ![String(event.user_id), this.cfg.botQQ].includes(String(original.user_id || original.sender?.user_id)))) throw Error('quote scope mismatch');
      quotedUser=String(original.sender?.user_id||original.user_id||'');
      if(event.message_type==='private'&&quotedUser===this.cfg.botQQ) {
        const peer=String(original.target_id||original.peer_id||original.receiver_id||'');
        if(peer!==String(event.user_id)&&!this.ownsPrivateQuote?.(event,id))throw Error('unverified private quote scope');
      }
      if (voiceSegments(original).length&&this.enabled) {
        const result = await this.recognize({ ...original, message_id: id, message_type: event.message_type,
          group_id: event.group_id, user_id: event.user_id });
        note = result.text ? `[引用语音转写] ${result.text}` : '[引用语音暂时无法转写，请如实说明。]';
      } else {
        const text = original.message.filter(s => s.type === 'text').map(s => s.data?.text || '').join('').slice(0, 3000);
        note = text ? `[引用消息内容] ${text}` : imageSegments(original).length
          ? '[引用消息含图片，必须以实际图片附件为依据，不能猜测。]'
          : '[引用消息不含可读取文字，不能声称已理解。]';
      }
      if(imageSegments(original).length)quotedImageEvent={...original,post_type:'message',self_id:event.self_id,
        message_type:event.message_type,group_id:event.group_id,
        user_id:event.message_type==='private'?event.user_id:original.user_id||quotedUser,
        message_id:id,message:imageSegments(original)};
      quote={id:String(id),user:quotedUser,speaker:String(original.sender?.card||original.sender?.nickname||quotedUser).slice(0,60),
        at:Number(original.time)>0?Number(original.time)*1000:null,text:note.replace(/^\[[^\]]+\]\s*/,''),
        replyToMessage:String(original.message.find(s=>s.type==='reply')?.data?.id||'')};
    } catch { quotedUser='';quotedImageEvent=null;quoteUnavailable=true;note = '[引用消息读取失败，不能声称已经听过引用的语音或看过图片。]'; }
    return { ...event,_quotedUser:quotedUser,_quote:quote,_quotedImageEvent:quotedImageEvent,_quoteUnavailable:quoteUnavailable,
      _unquotedText:event.message.filter(s=>s.type==='text').map(s=>s.data?.text||'').join('').trim(),
      message: [...event.message, { type: 'text', data: { text: '\n' + note } }] };
  }
  async acquire() {
    const max = Math.max(1, Math.min(4, this.settings.maxConcurrent));
    if (this.active < max) { this.active++; return; }
    if (this.waiters.length >= this.settings.maxQueue) throw new Error('SPEECH_QUEUE_FULL');
    await new Promise(resolve => this.waiters.push(resolve));
  }
  release() { const next = this.waiters.shift(); if (next) next(); else this.active--; }
  async recognize(event) {
    const id = `${chatKey(event)}:${event.message_id}`;
    const cached = this.cache.get(id);
    if (cached && Date.now() - cached.at < 600000) return cached.value;
    if (this.inflight.has(id)) return this.inflight.get(id);
    const work = this.transcribe(event).then(value => {
      this.cache.set(id, { at: Date.now(), value });
      if (this.cache.size > 200) this.cache.delete(this.cache.keys().next().value);
      return value;
    }).finally(() => this.inflight.delete(id));
    this.inflight.set(id, work); return work;
  }
  async transcribe(event) {
    const duration = Number(voiceSegments(event)[0]?.data?.duration || voiceSegments(event)[0]?.data?.time || 0);
    if (duration > this.settings.maxDurationSeconds) return { error: 'SPEECH_TOO_LONG' };
    let acquired = false;
    try {
      await this.acquire(); acquired = true;
      let text = '';
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          // Only the incoming message ID is passed. User-controlled file names,
          // URLs and paths are never downloaded or opened by the bridge.
          const result = await this.api.call('fetch_ptt_text', { message_id: event.message_id });
          if (typeof result?.text === 'string') text = result.text.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').trim();
          if (text) break;
        } catch { /* QQ sometimes needs a short delay before text is available. */ }
        if (!attempt) await new Promise(resolve => setTimeout(resolve, this.settings.retryDelayMs));
      }
      if (!text) throw new Error('SPEECH_RECOGNITION_FAILED');
      this.update({ lastSpeechError: null, lastSpeechRecognizedAt: new Date().toISOString() });
      return { text: text.slice(0, Math.min(this.cfg.maxQuestionChars || 6000, this.settings.maxTextChars)) };
    } catch (e) {
      const error = e.message === 'SPEECH_QUEUE_FULL' ? e.message : 'SPEECH_RECOGNITION_FAILED';
      this.update({ lastSpeechError: error }); return { error };
    } finally { if (acquired) this.release(); }
  }
  async convert(event) {
    const value = await this.recognize(event);
    if (value.error) return { ...event, _speechError: value.error };
    return { ...event, _voiceTranscript: value.text,
      message: [...event.message, { type: 'text', data: { text: `\n[语音转写] ${value.text}` } }] };
  }
}
