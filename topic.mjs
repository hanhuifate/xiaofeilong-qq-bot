// Conservative, local routing: product discussions must not become bot summons.
export function conversationAudience(event, text, messages, botQQ, explicitBot = false, now = Date.now()) {
  const user = String(event.user_id);
  if (event.message_type === 'private' || explicitBot) return { kind: 'bot', participants: [user, String(botQQ)], reason: 'explicit' };
  const targets = (event.message || []).filter(s => s.type === 'at').map(s => String(s.data?.qq)).filter(x => /^\d+$/.test(x) && x !== String(botQQ));
  const quoted = event.message?.find(s => s.type === 'reply');
  const original = quoted && messages.find(m => m.id === `${event.group_id}:${quoted.data?.id}:user`);
  if (original?.user) targets.push(String(original.user));
  if (targets.length) return { kind: 'other', participants: [...new Set([user, ...targets])], reason: 'mention_or_quote' };
  const value = String(text).split('\n[引用')[0].trim();
  // An explicitly opened public topic breaks the preceding human dialogue.
  if (/^(?:(?:问一下|话说|对了)[，,\s]*)?(?:大家(?:觉得|知道|有没有|谁)|你们觉得|有人知道|有没有人|换个话题|聊点别的)/.test(value)) return { kind: 'group', participants: [], reason: 'public_topic' };
  const recent = messages.filter(m => m.role === 'user' && m.speaker !== '图片内容摘要' && now - m.at <= 180_000);
  const previous = recent.at(-1);
  if (value.length <= 80 && previous &&
      (previous.audience?.kind === 'other' && previous.audience.participants?.includes(user) ||
       previous.addressedToOthers && String(previous.user) === user)) {
    return { kind: 'other', participants: previous.audience?.participants || [user], reason: 'human_dialogue_continues' };
  }
  // A new speaker's terse “you try it” does not establish that “you” is the bot.
  const lastBot = messages.findLast(m => m.role === 'assistant' && now - m.at <= 180_000);
  if (/^你(?:试(?:一?下|试)|去|拉|请|帮)(?:.{0,15})[呗吧呀嘛吗？?！!。\s]*$/.test(value) &&
      lastBot && String(lastBot.forUser || lastBot.replyToUser) !== user && recent.some(m => String(m.user) !== user)) {
    return { kind: 'unclear', participants: [], reason: 'ambiguous_you' };
  }
  return { kind: 'group', participants: [], reason: 'open_chat' };
}

export function repeatedReply(text, messages, now = Date.now()) {
  const normalize = value => String(value).toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
  const candidate = normalize(text);
  if (candidate.length < 18) return false;
  const grams = value => new Set(Array.from({ length: Math.max(0, value.length - 2) }, (_, i) => value.slice(i, i + 3)));
  const a = grams(candidate);
  return messages.filter(m => m.role === 'assistant' && now - m.at <= 300_000).slice(-4).some(m => {
    const previous = normalize(m.text);
    if (previous === candidate) return true;
    const b = grams(previous), common = [...a].filter(x => b.has(x)).length;
    return 2 * common / Math.max(1, a.size + b.size) >= 0.72;
  });
}

export function conversationRelation(event, text, messages, botQQ, now = Date.now()) {
  if (event.message_type !== 'group') return '';
  if (event.message?.some(s => s.type === 'at' && String(s.data?.qq) !== String(botQQ))) return '';
  // A reply to somebody else belongs to that conversation, even if it says GPT.
  if (event.message?.some(s => s.type === 'reply')) return '';
  const recent = messages.filter(m => m.at <= now && now - m.at <= 180_000).slice(-12);
  const lastBot = recent.findLastIndex(m => m.role === 'assistant');
  if (lastBot < 0 || recent.slice(lastBot + 1).filter(m => m.role === 'user').length > 6) return '';
  if (recent.slice(lastBot + 1).some(m => m.addressedToOthers)) return '';
  const value = String(text).replace(/^\s*\[(?:引用)?语音转写\]\s*/, '').trim();
  if (/别(?:回|说|接|插)|不用(?:回|接)|不要(?:回|接|插)|不和你玩|闭嘴|潜水|安静/.test(value)) return '';
  // These expressions explicitly describe another model/product/person.
  if (/别人(?:的)?|另一个|其他|我(?:的|用的)|官网|API|接口|价格|收费|订阅|安装|下载|对比|相比|和.{0,12}(?:比|哪个)|比.{0,12}(?:好|强|差)/i.test(value)) return '';
  // Bare “GPT” is deliberately insufficient. A question/evaluation directed at
  // this recently speaking bot is needed; speaker identity may change in a group.
  if (/^(?:哎[，,\s]*|诶[，,\s]*)?(?:chat\s*gpt|gpt)(?:[-\s]*\d+(?:\.\d+)?)?[，,：:\s]*(?:你|怎么|为啥|为什么|这么|那么|别|能不能|可以|说|刚才)/i.test(value)) return 'bot_reference';
  if (/^(?:你(?:刚才|刚刚|上面|这句|这话|怎么|为啥|为什么)|刚才你|刚刚你|你也太|你这么)/.test(value) &&
      /刚才|刚刚|上面|这句|这话|谨慎|客气|谦虚|认真|保守|承认|回答|说的|说得/.test(value)) return 'reply_followup';
  return '';
}
