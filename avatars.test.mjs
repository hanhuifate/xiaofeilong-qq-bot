import test from 'node:test';
import assert from 'node:assert/strict';
import {avatarUrl,downloadAvatar} from './avatars.mjs';

test('QQ avatar download accepts numeric accounts and only follows HTTPS QQ avatar CDN redirects',async()=>{
  assert.match(avatarUrl('1000000002'),/nk=1000000002$/);
  assert.throws(()=>avatarUrl('https://127.0.0.1/'));
  let calls=0;
  await assert.rejects(downloadAvatar('1000000002',async()=>{calls++;return new Response(null,{status:302,headers:{location:'http://127.0.0.1/secret'}});}),/AVATAR_URL_REJECTED/);
  assert.equal(calls,1);
  await assert.rejects(downloadAvatar('1000000002',async()=>new Response('oversized',{headers:{'content-type':'image/png'}}),3),/AVATAR_TOO_LARGE/);
  const bytes=await downloadAvatar('1000000002',async()=>new Response('image',{headers:{'content-type':'image/png'}}));
  assert.equal(bytes.toString(),'image');
});
