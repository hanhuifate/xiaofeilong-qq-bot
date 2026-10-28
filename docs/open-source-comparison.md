# 开源项目对比与借鉴边界

核对日期：2026-10-27。仓库元数据以 GitHub API 为准；代码形态来自当前默认分支源码，不把 README 声称等同于本项目可用性。

本报告只提炼机制。没有复制外部源代码。

## 对比

| 项目 | 当前状态与许可 | 实际源码中的可用思路 | 本地对应 | 决定 |
| --- | --- | --- | --- | --- |
| `wangkant/personagent` | 22 stars，MIT；2026-10-26 有推送 | `decision.py` 先做说话门控，再由角色生成；`evidence.py` 把反应定义为可重放事件；`reactions.py` 保存待回应回复并用单次裁决器判断纠正、拒绝、正向或中性；`decision_log.py` 只保存短摘录 | `social.mjs`、`memory.mjs`、`sessions.mjs`、相关测试 | P1 借鉴证据、撤销和离线评测，不整库替换 |
| `Pancakes-Labs/astrbot_plugin_proactive_chat` | 463 stars，AGPL-3.0；2026-10-26 有推送 | `scheduler_service.py` 持久任务、取消和清理；`sender_service.py` 区分发送启动、失败和成功；上下文来源可切换 | `initiative.mjs`、`wake.mjs`、SQLite、Windows 守护 | 借鉴持久任务与状态，不安装第二套主动消息插件 |
| `w1ndys/astrbot_plugin_qq_agent` | 0 stars；仓库 API 未识别 SPDX，README 声明 AGPL-3.0；2026-09-18 推送 | `auth.py` 在模型请求前隐藏无权工具，工具内再次鉴权；`history.py` 本地记录与协议端实时历史结合；工具返回模型，不直接发送 | `moderation.mjs`、`moderation-worker.py`、AstrBot gateway、SQLite | 借鉴双重权限与历史来源；不采用模型直接执行高风险写操作 |
| `YuanYeYouTao/Yuki` | 25 stars，README 和 LICENSE 为 AGPL-3.0-only；2026-10-27 有推送 | `work_recovery_schema.py` 保存可恢复 delivery intent；`effect_outcomes.py` 明确区分 pending、uncertain、mutation committed；`source_keys.py` 绑定来源身份；测试覆盖增量上下文与发送恢复 | `sessions.mjs`、`bridge.mjs`、SQLite、社交历史 | P2 借鉴持久发送意图和来源键；不迁移其 Linux/多平台运行栈 |

## 逐项分析

### personagent

优点：

- 把“是否开口”和“怎么开口”分成两个阶段；
- 反应必须有来源、方向、强度和作用域，纠错不是直接覆盖事实；
- 待回应回复有限数量的保存和过期控制；
- 有明确的人工标注回放评测。

本地差异：

- 本地已有 `WakeManager`、主题变化检测、群聊对象判断和拒绝互动；
- 本地记忆已要求来源消息 ID，但还没有“两次同群反应晋升、单条证据冲突、可撤销账本”的完整门槛；
- 不能把外部项目直接接入，否则会形成第二个消息消费者。

拟采用：

- 在现有 `SocialEngine` 增加反馈事件和证据强度；
- 纠错先保留冲突，达到阈值后再更新当前事实；
- 读取或回滚都保留审计记录；
- 用脱敏群聊回放评分“该沉默时是否沉默”。

### astrbot_plugin_proactive_chat

优点：

- 主动消息任务不用进程内计时器作为唯一事实来源；
- 会话级任务可以取消和重建；
- 真实平台历史与模型会话历史区分；
- 免打扰与失败/成功回执被拆开。

本地差异：

- `InitiativeScheduler` 已有群活跃、冷却、安静时段、未回应和唯一调度入口；
- 任务到期时间和回访原因主要散落在 `wake-state.json` 与会话状态；
- 当前没有 SQLite 任务租约、死信和跨重启延迟回访。

拟采用：

- 给主动任务增加稳定 job ID、due time、lease、cancel token 和终态；
- 重启只恢复未过期且来源仍有效的任务；
- 与现有 `InitiativeScheduler` 合并为一个调度器。

不采用：

- 不直接安装该插件。它和现有 Node 社交调度器会同时决定是否主动发言；
- 不复制 AGPL 代码进入当前非统一许可的混合工程。

### astrbot_plugin_qq_agent

优点：

- 将无权工具在模型请求前移除，模型看不到就不能调用；
- 每个工具执行时再次检查操作者和机器人角色；
- 本地历史记录与协议端实时历史各有用途；
- 工具返回错误给 Agent，避免中途抛出后产生半条回复。

本地差异：

- 本地已有结构化 management proposal、原发起人限时确认和 Python 二次权限检查；
- 本地比该插件多一层高风险操作的发起人确认；
- 仍需把管理工具暴露范围与管理能力声明进一步集中，减少模型误以为能直接执行。

拟采用：

- 保持“模型提议、宿主确认、执行前复检”；
- 每个动作统一返回类型化执行结果；
- 撤回和精华优先使用协议端可定位的真实 message ID。

不采用：

- 不让模型 Function Calling 直接执行禁言、踢人、审批；
- 不引入第二套群聊历史监听器。

### Yuki

优点：

- Work/Turn、来源事件、发送意图和最终回执分别建模；
- 明确把 pending、uncertain 和 mutation committed 分开；
- 增量上下文测试不仅比较文本，还比较来源范围和零重复；
- 人物、平台账号、空间与对话身份解耦。

本地差异：

- 本地刚加入 Codex Thread 的 `in_flight / uncertain / committed` 恢复；
- QQ 发送仍主要依赖即时 API 返回，没有持久 delivery intent；
- 身份目前使用 QQ 号和 `private:QQ号`，尚未形成独立人物 ID；
- 本项目保持 Windows 本机架构，不能直接引入 Yuki 的 Linux 容器与 SnowLuma 路线。

拟采用：

- P2 把真实 QQ 发送改为持久 delivery intent：准备、发送中、已接受、失败、不确定；
- 重启或重连时只查询原意图，不自动重发；
- 群聊、私聊、来源消息和任务使用稳定内部 ID 关联。

不采用：

- 不迁移大型数据库 schema；
- 不替换当前可工作的 Node/Python 分层；
- 不复制 AGPL 代码。

## 与本项目现有架构的取舍

当前保留：

```text
NapCat
  -> AstrBot 4.29.3
  -> dfl_gateway
  -> Node 对话/社交服务
  -> Codex App Server 或兼容 API
```

理由：

- 已有真实图片、语音、戳戳、浏览器、豆包、申请和账号切换链路；
- 已有 SQLite 来源记忆和管理二阶段确认；
- 改换运行栈会把当前 QQ 风控问题与重写风险叠加。

本轮先完成：

- 唯一语义参与入口；
- 200 条窗口去重错位修复；
- Codex 不确定轮次恢复；
- 官方 App Server API 核对。

下一阶段再处理：

- 持久主动任务租约；
- 反馈证据晋升与撤销；
- 持久 delivery intent；
- 模型 Provider 路由与控制面板。

## 许可与安全

- personagent 为 MIT。即使可复用，也应保留版权和许可；本项目本轮未复制。
- proactive_chat、qq_agent、Yuki 为 AGPL-3.0 系列或 README 声明 AGPL。复制进主工程会引入分发义务，非必要不复制。
- 外部项目均不改变本项目权限模型。网页、群消息、外部插件输出都不是可信系统指令。
- 任何主动发言方案都不能与现有 `InitiativeScheduler` 同时成为决策者。

## 仓库

- [personagent](https://github.com/wangkant/personagent)
- [astrbot_plugin_proactive_chat](https://github.com/Pancakes-Labs/astrbot_plugin_proactive_chat)
- [astrbot_plugin_qq_agent](https://github.com/w1ndys/astrbot_plugin_qq_agent)
- [Yuki](https://github.com/YuanYeYouTao/Yuki)
