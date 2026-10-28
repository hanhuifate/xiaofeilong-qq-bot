export function chatKey(event) {
  return event.message_type === 'private' || event._private === true ? `private:${event.user_id}` : String(event.group_id);
}
export function allowedChat(cfg, key) {
  return cfg.allChats === true ? /^(?:private:)?\d+$/.test(String(key)) : cfg.groups.includes(String(key));
}
export function normalizedChat(event) {
  return event.message_type === 'private' ? { ...event, group_id: `private:${event.user_id}`, _private: true } : event;
}
