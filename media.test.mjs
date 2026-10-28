import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { MediaStore, safeImageUrl, downloadImage, imageSegments, normalizeImage } from './media.mjs';
import { PokeController, pokeNotice } from './pokes.mjs';

const cfg = { botQQ: '1000000001', groups: ['200000001', '200000002'],
  pythonPath: 'D:\\tools\\Python 3.11.9\\python.exe', persona: { name: '大肥龙' },
  media: { enabled: true }, pokes: { enabled: true, probability: 1 } };
function scratch(t) {
  const base = path.resolve('work'), dir = path.join(base, 'qq-media-test-' + randomUUID());
  fs.mkdirSync(dir, { recursive: true });
  t.after(() => {
    const resolved = path.resolve(dir);
    if (!resolved.startsWith(base + path.sep)) throw new Error('Unsafe test cleanup');
    fs.rmSync(resolved, { recursive: true, force: true });
  });
  return dir;
}
function store(t, patch = {}) {
  return new MediaStore({ ...cfg, media: { ...cfg.media, ...patch } }, {}, { dir: scratch(t),
    normalize: async (_c, input, preview) => { fs.copyFileSync(input, preview); return { extension: 'png', width: 1, height: 1 }; } });
}
test('QQ image URL validation excludes local files, internal networks and lookalike domains', () => {
  assert.equal(safeImageUrl('http://gchat.qpic.cn/image.png'), 'https://gchat.qpic.cn/image.png');
  for (const url of ['file:///C:/secret.png', 'http://127.0.0.1/a', 'https://qq.com.evil.test/a',
    'https://gchat.qpic.cn:123/a', 'https://user:pass@gchat.qpic.cn/a', 'data:image/png;base64,AA']) {
    assert.throws(() => safeImageUrl(url), /REJECTED/);
  }
});
test('image download size limits apply without Content-Length and redirects cannot reach localhost', async () => {
  await assert.rejects(downloadImage('https://gchat.qpic.cn/a', 2, async () => new Response('abc')), /TOO_LARGE/);
  let calls = 0;
  await assert.rejects(downloadImage('https://gchat.qpic.cn/a', 10, async () => {
    calls++; return new Response(null, { status: 302, headers: { location: 'http://127.0.0.1:4202/' } });
  }), /REJECTED/);
  assert.equal(calls, 1);
});
test('fed image libraries persist, stay within their original group and never accept arbitrary outgoing paths', async t => {
  const media = store(t);
  const item = await media.addBytes('200000001', Buffer.from('image a'), { saved: true, label: '开心', owner: '10001' });
  assert.equal(media.catalog('200000001')[0].label, '开心');
  assert.equal(media.catalog('200000002').length, 0);
  assert.equal(media.outgoing('200000002', item.id), null);
  assert.equal(media.outgoing('200000001', '../../secret'), null);
  assert.match(media.outgoing('200000001', item.id).data.file, /^file:/);
  const loaded = new MediaStore(cfg, {}, { dir: media.dir });
  assert.equal(loaded.catalog('200000001')[0].id, item.id);
  assert.throws(() => media.catalog('999'), /GROUP_REJECTED/);
});
test('normal images are temporary and require explicit feeding before reuse', async t => {
  const media = store(t);
  const item = await media.addBytes('200000001', Buffer.from('temporary'), { owner: '10001' });
  assert.equal(media.catalog('200000001').length, 0);
  assert.equal(media.outgoing('200000001', item.id), null);
  media.feedExisting('200000001', [item.id], '惊讶', '10002');
  assert.equal(media.get('200000001', item.id).owner, '10002');
  assert.equal(media.catalog('200000001')[0].label, '惊讶');
});
test('only current attachments can receive model captions and only the feeding owner can delete', async t => {
  const media = store(t);
  const a = await media.addBytes('200000001', Buffer.from('first'), { saved: true, owner: '10001' });
  const b = await media.addBytes('200000001', Buffer.from('second'), { saved: true, owner: '10002' });
  media.describe('200000001', [{ id: a.id, description: '开心的小龙' }, { id: b.id, description: '伪造的说明' }], [a.id]);
  assert.equal(media.get('200000001', a.id).description, '开心的小龙');
  assert.equal(media.get('200000001', b.id).description, '');
  assert.equal(media.deleteOwned('200000001', a.id, '10002'), false);
  assert.equal(media.deleteOwned('200000001', a.id, '10001'), true);
});
test('saved image and byte limits are enforced', async t => {
  const media = store(t, { maxSavedPerGroup: 1, maxBytes: 10, maxGroupBytes: 15 });
  await media.addBytes('200000001', Buffer.from('12345'), { saved: true });
  await assert.rejects(media.addBytes('200000001', Buffer.from('67890'), { saved: true }), /LIBRARY_FULL/);
  await assert.rejects(media.addBytes('200000001', Buffer.alloc(11)), /TOO_LARGE/);
});
test('feeding uses validated QQ downloads and supports image and mface segments', async t => {
  const dir = scratch(t);
  const media = new MediaStore(cfg, {}, { dir, fetcher: async () => new Response('image bytes'),
    normalize: async (_c, input, preview) => { fs.copyFileSync(input, preview); return { extension: 'gif', width: 2, height: 2, animated: true }; } });
  const event = { group_id: 200000001, user_id: 10001, message: [{ type: 'image', data: { url: 'https://gchat.qpic.cn/a' } }] };
  const result = await media.ingest(event, '大肥龙 投喂 开心');
  assert.equal(result.items.length, 1); assert.equal(result.items[0].saved, true); assert.equal(result.items[0].label, '开心');
  assert.equal(imageSegments({ message: [{ type: 'mface', data: { url: 'https://gchat.qpic.cn/a' } }] }).length, 1);
});
test('the real image worker rejects a non-image file', async t => {
  const dir = scratch(t), source = path.join(dir, 'not-image.bin');
  fs.writeFileSync(source, 'this is not an image');
  await assert.rejects(normalizeImage(cfg, source, path.join(dir, 'preview.jpg')), /IMAGE_VALIDATION_FAILED/);
});

function pokeEvent(patch = {}) {
  return { post_type: 'notice', notice_type: 'notify', sub_type: 'poke', self_id: 1000000001,
    group_id: 200000001, user_id: 10001, target_id: 1000000001, ...patch };
}
function poker(t) {
  const calls = [], p = new PokeController(cfg, { call: async (action, params) => { calls.push({ action, params }); } },
    { file: path.join(scratch(t), 'preferences.json'), random: () => 0 });
  return { p, calls };
}
test('poke notices are accepted only when an authorized group member pokes the bot', () => {
  assert.equal(pokeNotice(pokeEvent(), cfg), true);
  for (const patch of [{ group_id: 999 }, { target_id: 10002 }, { user_id: 1000000001 }, { self_id: 123 }])
    assert.equal(pokeNotice(pokeEvent(patch), cfg), false);
});
test('proactive pokes require familiarity, while reactive pokes may target the person who poked the bot', async t => {
  const { p, calls } = poker(t), event = { group_id: 200000001, user_id: 10001 };
  assert.deepEqual(p.choices(event), []);
  for (let n = 0; n < 3; n++) p.remember(event);
  const choices = p.choices(event); assert.equal(choices[0].id, '10001');
  assert.equal(await p.send(event, '10001', choices), true);
  assert.equal(calls[0].action, 'send_poke'); assert.equal(calls[0].params.group_id, '200000001');
  assert.equal(await p.send(event, '10001', choices), false);
  assert.equal(await p.send(event, '99999', [{ id: '99999' }]), false);
  const other = { group_id: 200000002, user_id: 10002, _interaction: 'poke' };
  assert.equal(await p.send(other, '10002', p.choices(other, { reactive: true })), true);
});
test('opt-outs persist and block both proactive and reactive pokes', async t => {
  const { p, calls } = poker(t);
  p.preference('200000001', '10001', false);
  const event = { group_id: 200000001, user_id: 10001, _interaction: 'poke' };
  assert.deepEqual(p.choices(event, { reactive: true }), []);
  assert.equal(await p.send(event, '10001', [{ id: '10001' }]), false); assert.equal(calls.length, 0);
  const loaded = new PokeController(cfg, {}, { file: p.file, random: () => 0 });
  assert.deepEqual(loaded.choices(event, { reactive: true }), []);
});
test('repeated incoming pokes are throttled before any model call', t => {
  const { p } = poker(t); assert.equal(p.receiveAllowed(pokeEvent()), true); assert.equal(p.receiveAllowed(pokeEvent()), false);
});
