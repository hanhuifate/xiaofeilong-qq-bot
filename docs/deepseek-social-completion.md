# DeepSeek 官方 API 与自然社交改进交付

日期：2026-10-27。仅改现有本机工程。按最新要求，保留手动选择模型，不实现自动模型路由、提供商管理平台、其他模型适配或云端部署。

后续参与度修正：真实日志发现两条 shouldReply=true 的猫图玩笑被 addsNewInformation=false 拦截，随后普通潜水达到五分钟。活跃模式现在允许这些非知识类接梗，仍拦截重复内容和明确指向他人的回复；普通模型潜水最多 30 秒，用户明确要求安静的时限保持。被忽略后的冷却改为 45 秒，保留消息聚合。增加两个针对性回归，wake/topic 共 16 项通过。

## DeepSeek 接入

入口为 `deepseek.mjs`，`bridge.mjs` 与原 token 测试脚本通过 `createApiModel()` 使用它；非 DeepSeek 的旧兼容通道保持原状。

- 从官方 `/models` 确认模型存在、读取图像输入及输出上限元数据，缓存十分钟，不按每条消息刷新。
- 采用官方 `/beta/chat/completions` 的严格函数参数模式。唯一输出函数 `submit_qq_reply` 只返回候选 JSON，不执行 QQ、管理或浏览器动作。
- 思考模式启用 `thinking=enabled`，使用 `tool_choice=auto`；非思考模式关闭 thinking，强制唯一输出函数。官方明确禁止思考模式使用 required/named tool choice，本实现没有这样调用。
- DeepSeek 的 xhigh 按官方规则映射 high，并记录请求档位和实际档位；none 关闭思考。没有假装 DeepSeek 支持 Codex 同名的所有档位。
- 按真实 QQ 事件 ID 去重，历史消息采用 user/assistant 角色；当前批次单独携带发言者与来源，不重复叠加 history、recentMessages 和 recentExchange。不继承 Codex Thread。
- 群聊历史中的 assistant 是实际发出的聊天文字；同一次格式修复中，保留 API 真正返回的 reasoning_content 与 tool 消息关系，避免破坏思考模式协议。推理内容不写入日常日志或发给群友。
- 最多两次生成尝试：只对可恢复的服务错误或不完整结构进行有界重试/修复；永久鉴权错误不重试，超时结果不盲目重复。预算层不会再叠加一轮自己的 DeepSeek 重试。
- 密钥缺失时拒绝生成，但保留控制面板和 QQ 接入，便于本机修正配置。
- 每次实际生成，包括格式失败，保留 usage。候选必须通过完整 Schema 才返回宿主；禁止将随意自然语言包装成带管理动作的成功结果。
- Flash 支持图像输入，Pro 按实际能力拒绝图像，避免声称看过未传入的图片。真实合成红方块图片验收通过。

手动切换仍用现有面板：选择兼容 API，Base URL 填 `https://api.deepseek.com`，模型填官方 `/models` 可用 ID（本轮验证 `deepseek-flash`、`deepseek-v4-pro`），环境变量名填 `DEEPSEEK_API_KEY`。保存后重启回复服务。守护程序读取这个指定的用户环境变量传给服务，不打印密钥。

当前生产模型保持 GPT-6 Luna xhigh；开发验收没有替用户把线上模型切为 DeepSeek。示例配置见 `deepseek-config.example.json`，仅为待合并片段，不能直接覆盖完整生产配置。

DeepSeek 通道没有伪装成 Codex 原生联网搜索；它本轮沿用已接入的宿主能力边界。未新增 DeepSeek Search/Fetch 搜索执行器。

## 消息聚合与社交

- `aggregation.mjs` 合并同一人的连续短句；较完整的长问题或带结束标点的问题缩短等待，碎片消息继续短暂等待，始终受最大等待限制。
- 不同人的独立请求保持各自身份与顺序。同一话题里针对机器人的多人接梗可合并为一次回复，并保留各自称呼、事件 ID 和图片。
- 混合发言批次不执行管理操作、不代办他人的记忆删除，也不借最后一位主人的身份跨对话检索，防止普通成员请求继承主人权限。
- 排队满时保留未提交的直接消息批次，稍后处理；不因 flush 时队列满就丢掉整批。
- 模型生成期间到达的补充先尝试 steering；不能 steering 时，短暂等待补充稳定后合并替换未发出的草稿，有等待和重生成轮数上限。
- 不再以“又来了固定条数消息”决定是否丢弃主动回复；根据新公开话题、明确转向别人、直接请求和结果年龄判定过期。
- 模型允许决定沉默；关闭逐条回复模式时，不再强制把沉默改成“嗯，我在”。
- 模型选择的潜水现在与用户要求安静一样会被执行，活跃模式不能绕过。明确找机器人仍可唤醒。旁听中的 observe 与真正退出话题的 dive 在提示中分开。
- 冷却期内保留有时效的观察机会；群里已安静、原事件已过期时不再追着旧消息突然接话。被忽略后的任意无关聊天不被算作正向反馈。

## 延迟回访

回访状态保存在 SQLite 的 conversation_state，不引入第二个主动聊天插件。

- 每个任务记录 ID、来源消息、发起人、主题、到期时间、过期时间、尝试次数、租约和终态。
- tick 防重入；取任务、排队和实际执行前分别检查。过期、明确换话题、拒绝互动、删除来源或安静要求会取消任务。
- 重启后读取持久状态，但必须收到新的真实 QQ 聊天事件，且群聊仍活跃、适合插话，才考虑继续；长时间无人聊天不会被自动打扰。
- 发送来源绑定 initiative ID。重启遇到已发送、发送中或结果不明的发送意图时不重复回访；按来源直接查数据库，不依赖最近 N 条发送记录。
- 模型仍可判断没有值得说的内容，任务以 skipped 结束；回访不能无限产生下一次同主题回访。

## 后台统计

`diagnostics.mjs` 独立存储到 `data/diagnostics.sqlite3`：

- 按提供商、模型和实际思考档位统计请求、失败、重试、实际尝试失败、错误类别、输入/缓存/输出/推理 token、缓存率、提示体积、P50/P95 与可得的参考费用。
- 仅存技术元数据，不存聊天正文、提示词、图片或凭据；未知 usage 明确保留为未知。
- 聊天路径只把小记录放入内存，后台每五秒批量落盘，保留七天、最多两万条。
- 现有面板“后台调用统计”按按钮读取，认证接口为 `/api/diagnostics`；不增加模型调用，不向 QQ 群播报统计，不循环轮询诊断视图。
- 统计数据库异常时降级为不可用状态，不阻断聊天或服务退出。
- DeepSeek 费用是官方峰谷标价估算，不是账单；未自动识别中国法定节假日。Codex 没有用未知的订阅换算比例假装给出费用。

## 验证与边界

- Node 最终回归：131 项通过、0 失败；Python 原有权限核心：22 项通过、0 失败；JavaScript 与守护 PowerShell 语法检查通过。
- 真实 DeepSeek：Flash 思考和非思考各五轮、Pro 一轮、图片一轮、聚合与前文指代一轮，均得到有效结构；另有两次初始问题定位调用也通过。
- 共 15 个真实 API 检查，实际生成请求 16 次；其中一次 thinking/auto 未输出候选函数，经受限修复成功。不能承诺模型永远不需要修复。
- 格式验收不等于知识正确率；样例中仍观察到模型额外解释存在事实错误，未将其计作“答案全部正确”。
- 没有向真实 QQ 群发送测试消息，也没有对真实成员执行管理写入。真实群聊自然度仍需结合正常使用反馈持续调整。
- 原始证据：`work/deepseek-social/acceptance.json`、`live-full.json`、`live-batch.json`、`node-final.log`、`python-final.log`。

## 回滚

本机已建立 Git 分支 `improvement/deepseek-social`，基线提交 `af65054`；改动前数据库、配置和人设备份在 `data/change-backups/deepseek-social-*`。可先用 `git diff` 审阅，再按基线恢复本轮代码并重启核心服务。

无需回滚 QQ 登录或恢复旧数据库；本轮原数据库只增加发送来源查询索引。诊断数据库为独立文件，旧代码会忽略它。不要为回滚代码覆盖最近新增的真实聊天记录。

## 核对的官方协议

- [DeepSeek 严格函数参数与限制](https://api-docs.deepseek.com/guides/tool_calls/)
- [Chat Completions 的 tool_choice 与响应字段](https://api-docs.deepseek.com/api/create-chat-completion/)
- [思考模式及多轮工具消息](https://api-docs.deepseek.com/guides/thinking_mode/)
- [模型元数据](https://api-docs.deepseek.com/api/list-models/)
- [图像输入](https://api-docs.deepseek.com/guides/vision/)
