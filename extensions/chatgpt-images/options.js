const input=document.querySelector('#token'),status=document.querySelector('#status');
const supplied=location.hash.slice(1);history.replaceState(null,'',location.pathname);
if(/^[a-f0-9]{64}$/.test(supplied))input.value=supplied;
document.querySelector('#connect').onclick=async()=>{
  const token=input.value.trim();if(!/^[a-f0-9]{64}$/.test(token)){status.textContent='请输入面板提供的本机连接码。';return;}
  try {const result=await chrome.runtime.sendMessage({kind:'configure',token});if(!result.ok)throw Error(result.error);status.textContent='已连接。请在新页面登录与桌面端相同的 ChatGPT 账号。';input.value='';}
  catch {status.textContent='本机图片服务未连接，请先启动机器人。';}
};
if(supplied)document.querySelector('#connect').click();
