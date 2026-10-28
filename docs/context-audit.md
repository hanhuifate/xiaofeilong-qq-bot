# Codex 固定会话与上下文审计

审计日期：2026-10-27

## 结论

现有项目已经使用 Codex App Server 的持久 Thread。群聊和私聊分别保存 `threadId`，重启后优先 `thread/resume`，没有证据表明它按每条 QQ 消息创建新会话。审计确认并修复了一个真实缺陷：配置的近期窗口是 200 条，但去重账本只保留 120 个消息键，导致同一窗口最旧的 80 条在后续轮次再次作为 `newMessages` 提交。

本轮同时增加了不确定轮次恢复。提交前把消息来源键和本次桥接标识持久化；下一轮先通过官方稳定的 `thread/read` 查询上一轮状态。已完成的轮次登记为已消费，失败或被中断的轮次才允许未读消息重新进入；读取状态失败时停止提交并返回错误，避免盲目重放。

## 源码证据

### 固定 Thread

`sessions.mjs` 的行为：

- `data/codex-sessions.json` 以群号或 `private:QQ号` 为键保存映射；
- 已有映射先调用 `thread/resume`；
- 只有确认原 Thread 不存在时才调用 `thread/start`；
- 桌面端占用同一 Thread 时，走临时回退，不替换原映射；
- Thread 创建映射到现有 QQ 群聊项目，避免重复创建私聊侧栏会话；
- 人格和 schema 更新会刷新后续指令，但继续使用原 Thread。

当前生产索引快照有 4 个对话映射，其中 2 个群聊、2 个私聊；4 个 Thread ID 全部唯一，没有发现重复 Thread。

### 增量消息

成功轮次后，桥接把本 Thread 已看到的 QQ 事件键保存到 `contextKeys`。下一轮把当前近期窗口与账本求差，放入 `newMessages`；机器人自己通过其他线路发送并已入库的消息也会作为观测项同步，避免把模型候选文本误当外部事件。

本轮修复：

```text
旧：contextKeys 固定截断到 120
新：至少保留 max(240, social.contextMessages, 本轮 recent 数量 + 50)
```

对 200 条窗口的单元模拟：

| 场景 | 第三次提交误判为“新”的旧消息 |
| --- | ---: |
| 修复前 | 81 条 |
| 修复后 | 0 条 |

第三次实际新增消息仍会正常提交 1 条。

### 轮次状态

每个 Codex Thread 增加 `turn` 状态：

- `in_flight`：已构造增量包，正在提交或生成；
- `committed`：成功轮次，来源消息已记入去重账本；
- `committed_failed`：模型轮次已消费，但结构化输出无效或动作被宿主拦截；不重复注入同一输入；
- `uncertain`：客户端/服务端中断，无法确认是否已被 Thread 接收；
- `failed`：服务端明确失败或查询确认未形成可消费轮次。

恢复顺序：

1. 下一轮提交前检测 `in_flight` 或 `uncertain`；
2. 调用 `thread/read`，请求包含轮次；
3. 先按记录的真实 `turnId` 匹配；若服务器在 `turn/start` 响应前中断，则按增量包内的桥接标识匹配；
4. `completed` 轮次的来源消息登记为已消费；
5. `failed` / `interrupted` 的来源消息保持未读；
6. 轮次仍 active、读取失败或状态不明时不启动新 Turn。

官方 App Server 文档说明，`thread/read` 读取已存 Thread 而不订阅事件，`thread/turns/list` 可分页读取轮次；`turn/completed` 只有 `completed` 表示成功。本项目采用稳定接口并在现有初始化能力范围内使用。

### 历史事实查询

`dialogueContext` 不依赖近期窗口查找“第一句话”：

- `firstUserMessage` 直接按当前对话、当前用户、非图片/戳戳事件，在 SQLite 中按时间取最早记录；
- 引用消息保留 `id / user / speaker / at / replyToMessage`；
- `around()` 从 SQLite 加载引用前后记录；
- 返回边界明确说明只代表本机实际保留的最早用户消息。

没有证据表明当前“第一句话”逻辑会使用近期窗口第一项冒充账号历史起点。

### 故障与发送边界

`GroupBot.reply()` 区分：

- API 返回成功；
- API 调用抛出、但发送结果不确定；
- 已发送但本地持久化失败。

发送 API 异常会标记 `deliveryUncertain`，上层不会再自动发送一条“刚才没接上”的替代消息。模型生成失败时，只有确认尚未发送才尝试一次私有错误提示。

剩余风险：QQ 发送成功后若进程在写回 SQLite 前崩溃，目前没有“先发查询、再决定是否重发”的独立发送回执查询。因此本项目不自动重放真实发送，也不会在不确定时连续补发。深层发送幂等仍应在后续 P2 使用持久 delivery intent 和可查询回执继续完善。

## 前后指标

### 历史本机快照

`logs/latency.jsonl` 中 110 次记录：

| 指标 | P50 | P95 |
| --- | ---: | ---: |
| 模型生成 | 4315 ms | 9354 ms |
| 排队 | 3504 ms | 3516 ms |
| 端到端 | 7953 ms | 20281 ms |

SQLite 用量快照：

| 项目 | 数值 |
| --- | ---: |
| 模型调用 | 56 |
| 输入 token | 3,304,850 |
| 缓存输入 token | 1,546,752 |
| 输出 token | 14,303 |
| 已配置成本 | 0（未填写单价） |

这些是修复前历史数据。当前 QQ 因安全中心风控处于持久暂停，没有为了比较指标主动恢复登录或向真实群发测试消息；因此不能伪造修复后的真实 token/P95。去重部分用确定性的包内容模拟完成前后比较。

## 测试

修改前基线：

- Node：115 项通过；
- Python：22 项通过。

新增 Codex 会话测试覆盖：

- 200 条窗口不重放旧键；
- 已完成的不确定轮次在下一轮前恢复并登记来源；
- 失败轮次允许未读消息重试；
- Thread 状态读取失败时 fail closed，不调用 `turn/start`。

本轮修改文件：

- `sessions.mjs`
- `sessions.test.mjs`
- `bridge.mjs`
- `all-chats.test.mjs`

同时补齐私聊联网搜索路由：`webSearchAllChats=true` 时私聊使用独立搜索 Thread，关闭时不会从群聊设置继承权限。配置没有按“私聊内容”推断授权，搜索开关仍由宿主精确传入模型包。

## 尚未完成

以下为早期审计遗留清单，部分已在后续阶段落实。最新范围已取消自动模型路由、模型管理扩展及云端部署；DeepSeek、纠错回滚、发送意图与回访持久状态的本轮情况见 [最新交付](deepseek-social-completion.md)，不要把下面历史清单当作当前结论。

- DeepSeek/OpenAI-compatible 仍是单一兼容传输，没有 `ModelProvider` 注册表、界面密钥托管和按任务模型路由；
- 模型路由与 provider usage 需要真实 API 小额验收；
- 社交反应学习、纠错晋升门槛和回滚尚未按 personagent 的 evidence ledger 思路实现；
- 主动任务目前主要在内存和 `wake-state.json`，尚未统一成可租约、可取消、可恢复的 SQLite 调度任务；
- 真实 QQ 发送回执仍缺少独立持久 delivery intent；
- 风控恢复前不执行真实链路模型或群消息验收。

## 官方依据

- [Codex App Server](https://learn.chatgpt.com/docs/app-server)
