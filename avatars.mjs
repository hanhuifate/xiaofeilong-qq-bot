/** Public QQ avatars only: model output supplies a QQ number, never a URL. */
export function avatarUrl(user) {
  if(!/^[1-9]\d{4,11}$/.test(String(user)))throw Error('AVATAR_ACCOUNT_INVALID');
  return `https://thirdqq.qlogo.cn/g?b=sdk&s=640&nk=${user}`;
}
export async function downloadAvatar(user,fetcher=fetch,maxBytes=3_000_000) {
  let url=avatarUrl(user);
  for(let attempt=0;attempt<3;attempt++) {
    const parsed=new URL(url);
    if(parsed.protocol!=='https:'||parsed.username||parsed.password||parsed.port||
       !(parsed.hostname==='qlogo.cn'||parsed.hostname.endsWith('.qlogo.cn')))throw Error('AVATAR_URL_REJECTED');
    const response=await fetcher(url,{redirect:'manual',signal:AbortSignal.timeout(8000)});
    if([301,302,303,307,308].includes(response.status)) {
      await response.body?.cancel();url=new URL(response.headers.get('location'),url).href;continue;
    }
    if(!response.ok||!response.body||!response.headers.get('content-type')?.startsWith('image/'))throw Error('AVATAR_UNAVAILABLE');
    if(Number(response.headers.get('content-length')||0)>maxBytes){await response.body.cancel();throw Error('AVATAR_TOO_LARGE');}
    const chunks=[];let length=0;
    for await(const part of response.body){length+=part.length;if(length>maxBytes)throw Error('AVATAR_TOO_LARGE');chunks.push(part);}
    if(!length)throw Error('AVATAR_EMPTY');return Buffer.concat(chunks);
  }
  throw Error('AVATAR_REDIRECT_LIMIT');
}
export class AvatarReader {
  constructor({fetcher=fetch}={}){this.fetcher=fetcher;this.cache=new Map();}
  async read(chat,user,media) {
    const key=chat+':'+user,previous=this.cache.get(key);
    if(previous&&Date.now()-previous.at<180000&&media.get(chat,previous.id))return previous.id;
    const bytes=await downloadAvatar(user,this.fetcher);
    const image=await media.addBytes(chat,bytes,{saved:false,owner:String(user),label:`QQ用户${user}的公开头像（不是群聊发送的图片）`});
    this.cache.set(key,{id:image.id,at:Date.now()});
    if(this.cache.size>300)this.cache.delete(this.cache.keys().next().value);
    return image.id;
  }
}
