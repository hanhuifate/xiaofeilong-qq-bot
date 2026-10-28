import { readConfig } from './bridge.mjs';
import { DoubaoImageService } from './doubao-image.mjs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const service=new DoubaoImageService(readConfig(),path.dirname(fileURLToPath(import.meta.url)));
try{
  const state=await service.tool('doubao_status',{});
  const jobs=await service.tool('doubao_list_jobs',{limit:5});
  console.log(`本机服务：${state.service}\n浏览器扩展：${state.browser_connected?'已连接':'未连接'}\n豆包页面：${state.doubao_page_ready?'已就绪':'未就绪'}\n当前任务：${state.active_job_id||'无'}`);
  for(const job of jobs.jobs||[])console.log(`${job.job_id}: ${job.status} / ${job.stage}${job.error?' / '+job.error:''}`);
}catch{console.log('本机生图服务暂时无法连接，请先从主面板启动机器人。');process.exitCode=1;}
