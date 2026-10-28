import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import crypto from 'node:crypto';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const cfg=JSON.parse(fs.readFileSync(path.join(root,'config.json'),'utf8').replace(/^\uFEFF/,''));
const webui=JSON.parse(fs.readFileSync(path.join(root,'runtime','napcat','config','webui.json'),'utf8').replace(/^\uFEFF/,''));
const port=Number(process.env.DFL_LOGIN_PORT||6113);
const session=String(process.env.DFL_LOGIN_SESSION||crypto.randomBytes(24).toString('hex'));
delete process.env.DFL_LOGIN_SESSION;
let passwordMd5=String(process.env.DFL_QQ_PASSWORD_MD5||'');
delete process.env.DFL_QQ_PASSWORD_MD5;
if(!/^[a-f0-9]{32}$/.test(passwordMd5)){
  process.stdout.write('QQ_PASSWORD_REQUIRED\n');
  const password=await new Promise((resolve,reject)=>{
    if(!process.stdin.isTTY)return reject(Error('QQ_PASSWORD_STDIN_REQUIRED'));
    process.stdin.setEncoding('utf8');
    process.stdin.once('data',value=>resolve(String(value).replace(/[\r\n]+$/,'')));
    process.stdin.once('error',reject);
  });
  if(!password)throw Error('QQ_PASSWORD_EMPTY');
  const childSession=crypto.randomBytes(24).toString('hex');
  const child=spawn(process.execPath,[fileURLToPath(import.meta.url)],{
    cwd:root,windowsHide:true,detached:true,stdio:'ignore',
    env:{...process.env,DFL_LOGIN_PORT:String(port),DFL_LOGIN_SESSION:childSession,
      DFL_QQ_PASSWORD_MD5:crypto.createHash('md5').update(password,'utf8').digest('hex')}
  });
  child.unref();
  process.stdout.write(`QQ_LOGIN_READY http://127.0.0.1:${port}/${childSession}\n`);
  process.exit(0);
}
const endpoint='http://127.0.0.1:6099/api';

async function api(route,body,credential){
  const response=await fetch(endpoint+route,{method:'POST',headers:{'Content-Type':'application/json',...(credential?{Authorization:`Bearer ${credential}`}:{})},
    body:JSON.stringify(body),signal:AbortSignal.timeout(30000)});
  const text=await response.text();
  let payload;
  try{payload=JSON.parse(text);}catch{throw Error('NAPCAT_INVALID_RESPONSE');}
  if(payload.code!==0)throw Error(String(payload.message||'NAPCAT_REQUEST_FAILED'));
  return payload.data;
}

async function authenticate(){
  const hash=crypto.createHash('sha256').update(`${webui.token}.napcat`,'utf8').digest('hex');
  const data=await api('/auth/login',{hash});
  if(!data?.Credential)throw Error('WEBUI_LOGIN_FAILED');
  return data.Credential;
}

function page(state={}) {
  const initial=JSON.stringify(state).replaceAll('<','\\u003c');
  return `<!doctype html><meta charset="utf-8"><title>小肥龙 QQ 安全验证</title>
<style>
body{margin:0;background:#f5f7fb;color:#172033;font:16px/1.55 system-ui,"Microsoft YaHei",sans-serif}
main{max-width:640px;margin:12vh auto;background:white;border:1px solid #e0e5ef;border-radius:12px;padding:28px;box-shadow:0 14px 50px #24324a14}
h1{font-size:24px;margin:0 0 8px}.muted{color:#667085}.state{padding:12px;background:#f8fafc;border-radius:8px;margin:18px 0}
button{border:0;border-radius:8px;padding:10px 18px;background:#1677ff;color:white;font-size:16px;cursor:pointer}
.error{color:#b42318}.ok{color:#067647}</style>
<main><h1>小肥龙 · QQ 安全验证</h1>
<p class="muted">账号 ${cfg.botQQ} 的密码已通过，当前需要完成腾讯安全验证。验证码必须由本人操作。</p>
<div id="state" class="state">正在加载验证码…</div><button id="start" type="button" hidden>打开验证码</button>
<p id="result" class="muted"></p></main>
<script>const initial=${initial};
const qs=new URL(initial.proofWaterUrl||location.href).searchParams;
const aid=qs.get('a')||'2081081773',sid=initial.sid||qs.get('sid')||'';
const load=(src)=>new Promise((resolve,reject)=>{const s=document.createElement('script');s.src=src;s.onload=resolve;s.onerror=reject;document.head.appendChild(s)});
async function start(){
  try{await load('https://captcha.gtimg.com/TCaptcha.js')}catch{await load('https://ssl.captcha.qq.com/TCaptcha.js')}
  document.querySelector('#state').textContent='请在验证码窗口中完成安全验证。';
  const captcha=new TencentCaptcha(aid,async res=>{
    if(res.ret!==0||!res.ticket||!res.randstr){document.querySelector('#result').textContent='验证未完成，可以重新打开验证码。';return}
    document.querySelector('#result').textContent='验证已通过，正在提交登录…';
    const response=await fetch('/captcha-callback',{method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({session:initial.session,ticket:res.ticket,randstr:res.randstr,sid})});
    const result=await response.json();
    document.querySelector('#result').className=result.ok?'ok':'error';
    document.querySelector('#result').textContent=result.message||'登录请求已处理';
  },{type:'popup',showHeader:false,login_appid:qs.get('login_appid')||'',uin:qs.get('uin')||'',sid,enableAged:true});
  captcha.show();
}
document.querySelector('#start').hidden=false;document.querySelector('#start').onclick=start;
if(initial.auto)setTimeout(start,400);
</script>`;
}

let credential;
let captchaState;
let newDeviceState;
let callbackUsed=false;
const server=http.createServer(async(req,res)=>{
  const send=(code,type,body)=>{res.writeHead(code,{'Content-Type':type,'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});res.end(body);};
  try{
    const url=new URL(req.url,'http://127.0.0.1');
    if(req.method==='GET'&&url.pathname==='/go'){
      res.writeHead(302,{Location:`/${session}`,'Cache-Control':'no-store'});
      return res.end();
    }
    if(req.method==='GET'&&url.pathname===`/${session}`){
      credential ||= await authenticate();
      if(!captchaState&&!newDeviceState){
        const login=await api('/QQLogin/PasswordLogin',{uin:String(cfg.botQQ),passwordMd5},credential);
        if(login?.needCaptcha&&login?.proofWaterUrl){
          const proof=new URL(login.proofWaterUrl);
          captchaState={uin:String(cfg.botQQ),proofWaterUrl:login.proofWaterUrl,sid:proof.searchParams.get('sid')||'',session,auto:true};
        }else if(login?.needNewDevice&&login?.jumpUrl)newDeviceState={login};
      }
      if(captchaState)return send(200,'text/html; charset=utf-8',page(captchaState));
      if(newDeviceState)return send(409,'text/html; charset=utf-8',page({session,auto:false,proofWaterUrl:'https://localhost.invalid/'})
        .replace('正在加载验证码…','检测到新设备验证，请回到 NapCat WebUI 扫码验证。'));
      return send(200,'text/html; charset=utf-8',page({session,auto:false,proofWaterUrl:'https://localhost.invalid/'})
        .replace('正在加载验证码…','密码登录请求已提交，正在等待 QQ 完成登录。'));
    }
    if(req.method==='POST'&&url.pathname==='/captcha-callback'){
      if(callbackUsed)return send(409,'application/json',JSON.stringify({ok:false,message:'该验证已经提交过'}));
      let input='';for await(const chunk of req)input+=chunk;
      const body=JSON.parse(input);
      if(body.session!==session||!captchaState||!body.ticket||!body.randstr)return send(400,'application/json',JSON.stringify({ok:false,message:'验证参数无效'}));
      callbackUsed=true;
      credential ||= await authenticate();
      const result=await api('/QQLogin/CaptchaLogin',{uin:captchaState.uin,passwordMd5,ticket:body.ticket,
        randstr:body.randstr,sid:body.sid||captchaState.sid},credential);
      if(result?.needNewDevice&&result?.jumpUrl)return send(200,'application/json',JSON.stringify({ok:true,message:'验证码通过，但 QQ 又要求新设备验证。请回到 NapCat 的 QQ 登录页继续。'}));
      let status=null;
      for(let i=0;i<20&&!status?.isLogin;i++){
        await new Promise(resolve=>setTimeout(resolve,1000));
        status=await api('/QQLogin/CheckLoginStatus',{},credential);
      }
      if(status?.isLogin){
        const script=path.join(root,'Start.ps1');
        const child=spawn('powershell.exe',['-NoProfile','-ExecutionPolicy','Bypass','-File',script,'-ServiceChild','-BridgeOnly'],{cwd:root,windowsHide:true,detached:true,stdio:'ignore'});
        child.unref();
        return send(200,'application/json',JSON.stringify({ok:true,message:'QQ 登录成功，正在启动小肥龙回复服务。'}));
      }
      return send(200,'application/json',JSON.stringify({ok:true,message:'安全验证已提交，QQ 正在初始化。请稍后查看控制面板。'}));
    }
    send(404,'text/plain; charset=utf-8','Not found');
  }catch(error){
    send(500,'text/plain; charset=utf-8',String(error.message||'LOGIN_HELPER_FAILED').slice(0,300));
  }
});
server.listen(port,'127.0.0.1');
setTimeout(()=>server.close(()=>process.exit(0)),10*60*1000).unref();
