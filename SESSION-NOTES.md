# 会话归档与复用修复

2026-10-27 21:50 后：当前生产主线已改为单一主会话，不再区分日常/联网。现有 4 个 QQ 对话完成迁移，旧 7 条路线归档保留；映射为 data/codex-conversations.json。普通回复使用精简输出，数据库和扩展按需通过宿主工具读取/调用。详见 [当前会话方案](docs/unified-conversation.md)。下文的双路线及临时回退是历史实现，当前主线遇到写入占用不再用丢失 Thread 历史的临时调用冒充原对话。

2026-10-27：通过桌面应用原生工具归档 18 条未被运行时映射引用的旧聊天、probe 和 tokentest，保留全部内容。保留 7 条当前映射：日常 4 条、联网 3 条，标题统一使用人格配置中的昵称，并标明“日常 / 联网”。日常与联网仍是独立上下文，不能因为原来同名而删除其中一条。两条已不可读取的历史侧栏引用没有恢复或删除；它们不在应用返回的可见聊天中。

会话创建和恢复时同步标题；更改人设、昵称或路由不会因此新增会话。侧栏整理改从正在运行的 ChatGPT 进程获取安装路径。此次清理前后清单和原生工具结果保存在 `work/qq-thread-cleanup-manifest.json`、`work/qq-thread-cleanup-plan.json.results.jsonl`、`work/qq-threads-before.json`、`work/qq-threads-after.json`。

2026-10-26：群聊和私聊均归入已有“QQ 群聊”项目和侧栏分组。已整理 10 个历史会话，没有删除历史内容。

更新人设或回复 JSON 格式后，保留原 thread ID，恢复时传入新指令。明确清空或原会话不存在才建立新会话。

若 Codex 桌面应用暂时持有原会话的写入权，则本轮使用 ephemeral 调用，不新增侧栏聊天，映射仍保留原 ID。下一轮再尝试恢复；临时调用不保证前缀缓存，也不会追加到被占用的后台 thread，但正常本机 QQ 记忆仍保留。状态字段 `lastSessionFallback` 会记录 `ephemeral_writer_busy`。

运行 `node Organize-Sessions.mjs` 可再次整理旧会话。侧栏整理需要当前 Codex 桌面工具通道；缺少通道时仍可更新已有项目归属。

独立 Python/AstrBot 新工程在 `../QQ群聊`，使用外部模型 API，不创建 Codex 开发聊天。详见其中 README。
