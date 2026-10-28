import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';

const dir=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../work/tokentest');
const read=name=>JSON.parse(fs.readFileSync(path.join(dir,name,'results.json'),'utf8'));
const names=['retest-20261027-xhigh','retest-20261027-flash-high-complete','retest-20261027-flash-nonthinking'];
const num=n=>Number.isFinite(n)?n:0;
function summarize(name) {
  const report=read(name),run=report.runs[0];
  assert.equal(run.rows.length,5);
  const usage={};
  for(const key of ['input_tokens','cached_input_tokens','output_tokens','reasoning_output_tokens']) {
    usage[key]=run.rows.reduce((sum,row)=>sum+num(row.usage?.[key]),0);
    assert.equal(usage[key],run.usage[key]);
  }
  const codex=run.backend==='codex-app-server';
  const price=codex?{miss:.1,hit:.01,output:.5}:report.deepseekPricing.flash;
  const cost=((usage.input_tokens-usage.cached_input_tokens)*price.miss+
    usage.cached_input_tokens*price.hit+usage.output_tokens*price.output)/1e6;
  assert.ok(Math.abs(cost-run.priceUsd)<1e-12);
  return {source:`${name}/results.json`,model:run.model,effort:run.effort,
    validResponses:run.rows.filter(row=>row.ok).length,requests:5,usage,
    totalTokens:usage.input_tokens+usage.output_tokens,costUsd:cost,
    noCacheCostUsd:(usage.input_tokens*price.miss+usage.output_tokens*price.output)/1e6,
    modelSeconds:run.rows.reduce((sum,row)=>sum+row.ms,0)/1000,
    attemptsPerDollar:1/cost};
}
const summary=names.map(summarize);
const diagnosisNames=['retest-20261027-flash-high','retest-20261027-flash-example-high'];
const diagnosticAttempts=diagnosisNames.map(name=>{
  const report=read(name),error=report.errors[0],u=error.usage,p=report.deepseekPricing.flash;
  return {source:`${name}/results.json`,requests:error.rows.length,usage:u,
    costUsd:((u.input_tokens-u.cached_input_tokens)*p.miss+u.cached_input_tokens*p.hit+u.output_tokens*p.output)/1e6};
});
const output={createdAt:new Date().toISOString(),summary,diagnosticAttempts,
  costIncludingDiagnosticsUsd:[...summary,...diagnosticAttempts].reduce((sum,row)=>sum+row.costUsd,0),
  caveat:'List-price estimate; no subscription quota conversion. OpenAI cache-write token counts are not reported by this App Server usage stream, so separate cache-write charges are not included.'};
fs.writeFileSync(path.join(dir,'retest-results.json'),JSON.stringify(output,null,2));
const n=value=>value.toLocaleString('en-US');
const rows=summary.map(r=>`| ${r.model} ${r.effort} | ${r.validResponses}/5 | ${n(r.usage.input_tokens)} | ${n(r.usage.cached_input_tokens)} | ${n(r.usage.output_tokens)} | ${n(r.usage.reasoning_output_tokens)} | $${r.costUsd.toFixed(8)} | ${r.modelSeconds.toFixed(2)} 秒 |`);
const doc=`# tokentest：Flash 补测与 xhigh 重测

测试时间：2026-10-27 16:24–16:27（北京时间）。五题沿用原测试，不向真实 QQ 群或私聊发消息。

## 本轮实测

| 模型/档位 | 通过完整格式校验 | 输入 | 缓存输入（输入子集） | 输出 | 推理（输出子集） | 五次请求参考费用 | 模型请求累计耗时 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
${rows.join('\n')}

以上 totals 已从每题 usage 重新相加，并独立复算费用，包含解析失败但服务端正常返回 usage 的请求。推理 token 和缓存 token 都不重复相加。格式通过率不是答案正确率。

- xhigh：使用全新持久会话，五轮均完成；第二题为 84.4，第三题为 4、True，第五题正确要求第二轮增量不包含 M1。其他回答未发现明显实质错误。
- Flash thinking/high：第三、四、五题无法解析为符合机器人完整 Schema 的结果，其中第五题只返回空白；finish_reason=stop，并非达到 8000 token 输出上限。前两题成功。
- Flash non-thinking：第一、二、三、五题通过格式校验；第四题 JSON 文本内存在未转义双引号，无法解析。第五题虽格式通过，却把完整历史请求和持久会话增量混为一谈，不应视为答对。
- 不能从本轮得出 Flash 模型普遍不支持 JSON 的结论；结论仅限当前完整机器人人设、上下文与适配请求组合。官方文档明确支持 JSON。

## 公平比较的边界

本轮按真实缓存用量折算，缓存命中受执行顺序影响。xhigh 输入约 62K，Flash 约 31K：两后端的固定指令、Schema 传递及历史组织不同，这测的是当前两种接法的开销，不能据此断言同长度提示下哪个模型更省。

按同样 usage、假设全部输入不命中缓存，三组费用依次为 ${summary.map(r=>'$'+r.noCacheCostUsd.toFixed(8)).join('、')}；这只是对照估算，并未额外发送禁用缓存的请求。

按实际缓存费用，1 美元参考额度分别约能支付 ${summary.map(r=>Math.floor(r.attemptsPerDollar)).join('、')} 组这样的五次请求。Flash 数字包含失败请求，不代表能完成同等数量的五问任务，也不能换算成 Codex 订阅的百分比额度。

## 历史对话与隔离

Codex 新会话第一轮提供 bootstrap，此后桥接包使用 newMessages 增量，并清空 dialogueContext.recentExchange，不重复注入整段 recentMessages/history。固定人设、权限事实、摘要及必要引用仍可能随请求携带；Codex 内部会话也保有旧上下文，旧上下文仍可能被计入输入并命中缓存。不是每轮都只计新问题的 token。

DeepSeek 是无服务器持久 Thread 的 Chat Completions 接法，当前适配器把 history 和当前对话数据放进请求 JSON，每轮重传。报告中的 contextPolicy 应按此理解，并非原生 role-history messages 数组。

本轮 xhigh Thread ID：01a17c75-dce6-7781-8828-3f1b60777f51。文件保存在独立 retest 目录，未复用上一轮测试会话、未替换生产机器人模型。

## 排障开销与代码修正

两次先行 Flash 排障各发出三次请求（原格式、补 JSON 示例），共 ${diagnosticAttempts.reduce((s,r)=>s+r.requests,0)} 次，参考费用 $${diagnosticAttempts.reduce((s,r)=>s+r.costUsd,0).toFixed(8)}。补示例仍在第三题失败，该提示改动已撤回。包含这两次排障，本轮三组测试加排障总参考费用为 $${output.costIncludingDiagnosticsUsd.toFixed(8)}，不含本次开发会话本身消耗。

修正了测试脚本遗漏传入 thinking 参数的问题；解析/Schema 失败现在保留服务端 usage、reportedModel 和 finishReason；每题落盘进度，某题失败继续测剩余题。只做了一项针对真实 transport 问题的回归验证（通过），未扩大模拟测试范围。

## 价格依据与限制

- [OpenAI GPT-6 Luna](https://developers.openai.com/api/docs/models/gpt-6-luna)：Standard 普通输入 $0.10/M、缓存读取 $0.01/M、输出 $0.50/M。
- [DeepSeek 官方价格](https://api-docs.deepseek.com/quick_start/pricing/)：本轮处于工作日 Peak，Flash 普通输入 $0.30/M、缓存读取 $0.006/M、输出 $1.20/M；Off-peak 在相同 token 用量下为上述费用一半。
- [DeepSeek JSON Output](https://api-docs.deepseek.com/guides/json_mode/) 与 [Thinking Mode](https://api-docs.deepseek.com/guides/thinking_mode/)：本轮分别请求 enabled/high 和 disabled，非思考组服务端 reasoning_tokens 均为 0。

这是基于 usage 的 API 标价折算，非平台扣费账单。OpenAI 文档另列缓存写入价格，但当前 App Server usage 流未报告可单独核算的缓存写入 token，表格未加入独立缓存写入费；也未计地区/服务档位加价。不提供未经证实的订阅额度换算。

原始数据链接：

${names.map(name=>'- ['+name+']('+name+'/results.json)').join('\n')}

汇总机读数据：[retest-results.json](retest-results.json)。旧报告与原始结果保持保留。
`;
fs.writeFileSync(path.join(dir,'retest.md'),doc);
console.log(JSON.stringify(output,null,2));
