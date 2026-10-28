import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {deflateSync} from 'node:zlib';
import {ChatGPTImageService,conversationId,imageExtension,pngCRC} from './chatgpt-image.mjs';
import {ImageGenerationService} from './image-generation.mjs';
import {startViewer} from './viewer.mjs';

const clientId='test-client-00000001',url='https://chatgpt.com/c/12345678-1234-1234-1234-123456789abc';
function png(){
  const chunk=(type,data)=>{const typeBytes=Buffer.from(type),out=Buffer.alloc(data.length+12);out.writeUInt32BE(data.length);typeBytes.copy(out,4);data.copy(out,8);out.writeUInt32BE(pngCRC(Buffer.concat([typeBytes,data])),out.length-4);return out;};
  const header=Buffer.alloc(13);header.writeUInt32BE(512,0);header.writeUInt32BE(512,4);header[8]=8;header[9]=6;
  return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk('IHDR',header),chunk('IDAT',deflateSync(Buffer.alloc(512*(512*4+1)))),chunk('IEND',Buffer.alloc(0))]);
}
function setup(t){const root=fs.mkdtempSync(path.join(os.tmpdir(),'qq-chatgpt-images-'));const service=new ChatGPTImageService({capabilities:{imageGeneration:{waitTimeoutSeconds:180}}},root);t.after(()=>{service.close();fs.rmSync(root,{recursive:true,force:true});});return {root,service};}

test('image worker API rejects missing credentials, foreign origins and invalid job leases',async t=>{
  const {service}=setup(t);await service.start(0);const base='http://127.0.0.1:'+service.server.address().port;
  const headers={'Content-Type':'application/json',Authorization:'Bearer '+service.token};
  const post=(route,input,h=headers)=>fetch(base+route,{method:'POST',headers:h,body:JSON.stringify(input)});
  assert.equal((await post('/worker/heartbeat',{}, {'Content-Type':'application/json'})).status,401);
  assert.equal((await post('/worker/heartbeat',{}, {...headers,Origin:'https://chatgpt.com'})).status,403);
  assert.equal((await post('/worker/heartbeat',{pageReady:true})).status,200);
  const created=await service.generate('private:123',{prompt:'画白发龙角少女',ratio:'1:1'});
  const claimed=await(await post('/worker/claim',{clientId})).json();
  assert.equal(claimed.job.id,created.job_id);assert.equal(claimed.job.prompt,'画白发龙角少女');assert.equal(claimed.job.chatHash,undefined);
  assert.equal((await post('/worker/update',{id:created.job_id,clientId,lease:'forged',status:'running'})).status,400);
  assert.equal((await post('/worker/claim',{clientId:'another-client-000001'})).status,200);
  assert.equal((await(await post('/worker/claim',{clientId:'another-client-000001'})).json()).job,null);
  assert.equal((await post('/worker/update',{...claimed.job,clientId,status:'running',conversationUrl:url})).status,200);
  assert.equal((await post('/worker/image',{...claimed.job,clientId,base64:png().toString('base64')})).status,200);
  assert.equal(service.jobStatus(created.job_id).status,'completed');
  await post('/worker/heartbeat',{pageReady:true,quotaRequired:true});await assert.rejects(service.generate('123',{prompt:'不要在限额后继续提交'}),/QUOTA/);
});

test('jobs survive service restart and cannot reuse a previous image conversation or move backwards',async t=>{
  const {root,service}=setup(t);service.worker={at:Date.now(),pageReady:true};service.server={listening:true,close(){}};
  const one=await service.generate('123',{prompt:'第一张'}),job=service.claim(clientId);
  await service.updateJob({...job,clientId,status:'running',conversationUrl:url});
  await assert.rejects(service.updateJob({...job,clientId,status:'submitting'}),/REGRESSION/);
  const restored=new ChatGPTImageService(service.cfg,root);assert.equal(restored.claim(clientId).id,one.job_id);assert.equal(restored.claim(clientId).status,'running');
  service.cancel(one.job_id);
  const two=await service.generate('123',{prompt:'第二张'}),next=service.claim(clientId);assert.equal(next.id,two.job_id);
  await assert.rejects(service.updateJob({...next,clientId,status:'running',conversationUrl:url}),/REUSED/);
  assert.equal(conversationId('https://evil.example/c/12345678-1234-1234-1234-123456789abc'),null);
});

test('completion requires a real validated image and duplicate uploads do not replace the saved file',async t=>{
  const {service}=setup(t);service.worker={at:Date.now(),pageReady:true};service.server={listening:true,close(){}};
  await service.generate('123',{prompt:'一张图片'});const job=service.claim(clientId),input={...job,clientId};
  await service.updateJob({...input,status:'running',conversationUrl:url});
  await assert.rejects(service.acceptImage({...input,base64:Buffer.from('<html>生成中</html>'.repeat(50)).toString('base64')}),/INVALID/);
  assert.equal(service.jobStatus(job.id).status,'running');
  const bytes=png();assert.equal(imageExtension(bytes),'png');const broken=Buffer.from(bytes);broken[100]^=255;assert.throws(()=>imageExtension(broken),/INVALID/);
  await service.acceptImage({...input,base64:bytes.toString('base64')});
  const saved=service.jobStatus(job.id);assert.equal(saved.status,'completed');assert.deepEqual(fs.readFileSync(saved.images[0]),bytes);
  await service.acceptImage({...input,base64:bytes.toString('base64')});assert.equal(service.imagePath(saved.images[0]),saved.images[0]);assert.equal(service.imagePath(process.execPath),null);
});

test('a slow result stays observable and login verification resumes the same job without another prompt',async t=>{
  const {service}=setup(t);service.worker={at:Date.now(),pageReady:true};service.server={listening:true,close(){}};
  await service.generate('123',{prompt:'慢一点的图片'});const job=service.claim(clientId),input={...job,clientId};
  await service.updateJob({...input,status:'running',conversationUrl:url});
  await service.updateJob({...input,status:'login_required'});assert.equal(service.claim(clientId).status,'running');
  await service.updateJob({...input,status:'running'});service.jobs[job.id].startedAt=Date.now()-3600000;
  service.pollDelay=async()=>{assert.equal(service.jobs[job.id].late,true);assert.equal(service.jobs[job.id].status,'running');await service.acceptImage({...input,base64:png().toString('base64')});};
  const result=await service.waitFor(job.id);assert.equal(result.status,'completed');assert.equal(Object.keys(service.jobs).length,1);
});

test('switching providers keeps old deliveries bound and settings persist without restarting QQ',async t=>{
  const {root}=setup(t),cfg={capabilities:{doubaoImage:{enabled:true}}};const images=new ImageGenerationService(cfg,root);
  assert.equal(images.provider,'chatgpt');images.saveDelivery('job_123',{provider:'chatgpt',status:'waiting'});
  images.saveSettings({provider:'doubao',waitTimeoutSeconds:600,sectionName:'图片'});
  assert.equal(images.engine('job_123'),images.chatgpt);assert.equal(images.engine(),images.legacy);
  assert.equal(new ImageGenerationService(cfg,root).provider,'doubao');
  assert.throws(()=>images.saveSettings({provider:'unknown'}));assert.equal(images.provider,'doubao');
});

test('panel saves image source without exposing worker credentials and can cancel a queued local job',async t=>{
  const {root}=setup(t),images=new ImageGenerationService({capabilities:{}},root);
  const server=await startViewer(root,{state:{sessions:{}}},{},0,null,{bot:{doubao:images}});t.after(()=>server.close());
  const base='http://127.0.0.1:'+server.address().port,headers={'Content-Type':'application/json',Authorization:'Bearer '+fs.readFileSync(path.join(root,'data/viewer-token.txt'),'utf8').trim()};
  const r=await fetch(base+'/api/image-generation',{method:'POST',headers,body:JSON.stringify({action:'save',provider:'chatgpt',enabled:true,sectionName:'图片',waitTimeoutSeconds:1200})});assert.equal(r.status,200);
  const state=await(await fetch(base+'/api/image-generation',{headers})).json();assert.equal(state.settings.provider,'chatgpt');assert.equal(JSON.stringify(state).includes(images.chatgpt.token),false);
  images.chatgpt.server={listening:true,close(){}};images.chatgpt.worker={at:Date.now(),pageReady:true};
  const request={action:'test',prompt:'只在本机验证',requestId:'12345678-0000-0000-0000-123456789abc'};
  const once=await(await fetch(base+'/api/image-generation',{method:'POST',headers,body:JSON.stringify(request)})).json();
  const twice=await(await fetch(base+'/api/image-generation',{method:'POST',headers,body:JSON.stringify(request)})).json();
  assert.equal(once.jobId,twice.jobId);assert.equal(Object.keys(images.chatgpt.jobs).length,1);
  images.chatgpt.jobs.job_test={id:'job_test',status:'queued'};
  const cancelled=await fetch(base+'/api/image-generation',{method:'POST',headers,body:JSON.stringify({action:'cancel',jobId:'job_test'})});assert.equal(cancelled.status,200);assert.equal(images.chatgpt.jobs.job_test.status,'cancelled');
});
