# 小肥龙 · QQ 机器人（本机版）

基于 NapCat + AstrBot + Codex App Server 的本机 QQ 聊天机器人。每个群/私聊使用一个持久 Codex Thread，具备人格、长期记忆、自然社交、图片识别、语音转写、群管理与图片生成等能力，并提供仅监听 `127.0.0.1` 的网页面板。

本项目按“本机单账号运行”设计，不做云端部署。所有登录、验证码和账号敏感操作由本人完成。

## 架构

```
QQ ←→ NapCat（OneBot v11）
        ↕ 正向 WebSocket
   AstrBot + astrbot_plugin_dfl_gateway（官方事件管线/转发插件）
        ↕ 本机 HTTP（127.0.0.1）
   Node 回复桥 bridge.mjs ←→ Codex App Server（持久 Thread）
        ├─ SQLite 记忆 / 关系 / 发送意图（schema v4 + FTS5）
        ├─ 媒体、语音、头像、戳戳、表情
        ├─ 群管理提议 + 独立 Python 执行层（权限与审计）
        ├─ 图片生成（ChatGPT 网页普通聊天 / 豆包备用）
        └─ 网页面板 viewer.mjs（127.0.0.1:6098）
```

- `bridge.mjs`：事件接入、聚合、社交判断、工具调用、发送与回执。
- `sessions.mjs` / `conversation.mjs`：每群/私聊单一主会话、原生历史与自动压缩。
- `storage.mjs` / `memory.mjs`：SQLite 事件、记忆、关系、纠错与备份。
- `persona.json` / `social.mjs` / `wake.mjs`：人格、主动接话、潜水与延迟回访。
- `chatgpt-image.mjs` / `image-generation.mjs`：生图队列与来源切换。
- `moderation.mjs` / `moderation-worker.py`：管理提议与权限执行。
- `control`/`Start`/`Stop`/`Supervise` 系列 PowerShell：守护、心跳、账号与风控面板。

## 主要功能

| 范围 | 说明 |
| --- | --- |
| 单一主会话 | 每群/私聊一个持久 Thread，合并日常与联网；增量事件、避免重复正文 |
| 人格与社交 | 独立人格文件、消息聚合、主动接话、潜水/唤醒、重复抑制、持久延迟回访 |
| 记忆 | SQLite + FTS5、来源与关系、纠错回滚、删除/拒绝记忆、备份恢复 |
| 按需工具 | 记忆、身份/权限、图片/头像、隔离浏览器、豆包、管理及发送提议 |
| 群管理与申请 | 自然语言提议、真实身份核验、原发起人限时确认、好友/入群申请、审计 |
| 媒体 | 图片识别/图库、引用与前图、头像、语音转写、QQ 表情、戳戳 |
| 图片生成 | 默认 ChatGPT 网页普通聊天：每任务新建聊天、按实际图片文件完成、桌面“图片”分组收纳；豆包可手动切回 |
| 模型 | Codex 主线；可手动切换 OpenAI/DeepSeek 兼容 API（密钥仅从环境变量读取） |
| 运维 | 预算、P50/P95、缓存与失败统计、持久发送意图、心跳与掉线检测 |

## 快速开始（仅 Windows 本机）

前置：QQ、NapCat、AstrBot、Node.js 22+、Codex 登录环境。

1. 复制 `api-config.example.json`、`deepseek-config.example.json` 为实际配置时只写环境变量名，密钥放在系统环境变量，不要写进仓库。
2. 首次运行需自行创建 `config.json`（模板字段见 `使用说明.md`），其中 OneBot 地址与令牌只在本机使用。
3. 运行 `setup-astrbot.py` 把转发插件安装到 AstrBot 用户目录并写入桥接路径。
4. 双击 `大肥龙控制面板.cmd`（或 `Start.cmd`）启动；`Stop.cmd` 停止回复。
5. 打开 `查看后台.cmd` 进入控制中心，核对 QQ、OneBot、AstrBot 与回复桥状态。

图片生成：首次双击 `ChatGPT生图登录.cmd` 创建独立浏览器配置，在窗口内登录同一 ChatGPT 账号；若官方测试版浏览器在本机启动失败，脚本会改用已安装 Chrome 的独立配置（不复用日常浏览器资料），随后需手动加载一次本机扩展。之后在控制中心“图片生成”确认服务在线、扩展已连接、网页就绪。

## 测试

```powershell
node --test *.test.mjs
```

AstrBot 插件测试在 AstrBot 部署目录执行（该插件不在本仓库内）：

```powershell
.\.venv\Scripts\python.exe -m unittest discover -s tests -v
```

当前 Node 测试 147 项通过。测试使用临时数据和受控接口，不操作真实群成员、不向真实 QQ 群发测试消息。

## 文档

| 文档 | 内容 |
| --- | --- |
| [IMPLEMENTATION-STATE.md](IMPLEMENTATION-STATE.md) | 总进度、已实现范围与待验收项（最新入口） |
| [使用说明.md](使用说明.md) | 启动、账号、聊天、面板与风控的实际操作说明 |
| [docs/unified-conversation.md](docs/unified-conversation.md) | 单一主会话与动态工具方案 |
| [docs/chatgpt-image-provider.md](docs/chatgpt-image-provider.md) | ChatGPT 网页生图接入、等待与恢复边界 |
| [docs/deepseek-social-completion.md](docs/deepseek-social-completion.md) | DeepSeek 与社交改进交付 |
| [docs/qq-risk-audit.md](docs/qq-risk-audit.md) | QQ 风控证据与恢复步骤 |
| [docs/context-audit.md](docs/context-audit.md) / [docs/social-eval.md](docs/social-eval.md) | 上下文与社交评估 |
| [FINAL-ACCEPTANCE.md](FINAL-ACCEPTANCE.md) / [LOCAL-PROGRESS.md](LOCAL-PROGRESS.md) | 验收记录与较早阶段快照 |

## 安全与隐私

- `config.json`、`status.json`、`validation.json`、`*process.json` 已加入 `.gitignore`，绝不随仓库上传。
- `data/`、`runtime/`、`logs/`、`work/`、`outputs/`、`sandbox/`、`.venv/` 与浏览器配置均被忽略；仓库只包含源码、文档和示例配置。
- 模型密钥通过环境变量读取（参考 `api-config.example.json`），面板不回传密钥。
- 网页接口只监听 `127.0.0.1`，图片工作接口使用独立随机连接码与任务租约；扩展不读取 Cookie 或令牌。
- 聊天记录、群号、账号与生成图片全部留在本机。
- 公开版本已脱敏：QQ 号、群号、成员号码与消息编号均替换为占位值（如 `1000000001`、`200000001`），配置示例不含真实号码。

## 状态边界

核心功能已在本机运行，但没有完成全部真实场景验收：ChatGPT 网页首次登录后的真实出图回传、真实群成员管理写操作、长上下文持续运行与节费量化仍在待验收清单中。详见 `IMPLEMENTATION-STATE.md`，不要据“服务在线”推断链路完全可用。

## 免责声明

本项目仅用于个人学习与本机自用。使用第三方 QQ 协议实现可能违反平台服务条款并带来账号风险；请自行评估并遵守当地法律法规与平台规则。
