# QQ 风控审计与恢复记录

审计时间：2026-10-27 13:45（Asia/Shanghai）

## 结论

QQ 安全中心页面明确显示：

- 设备被下线原因：**“设备存在外挂或其他软件影响 QQ 正常使用”**
- 登录应用：**QQ 桌面版 Windows**
- 页面显示安全中心已对该设备执行下线

当前使用的 NapCat 通过注入并扩展 QQ NT 来实现 OneBot 接入。NapCat 官方文档也明确提示，Bot 账号可能遇到社交风控，建议更换账号或设备；同机同 IP 登录 Bot 号与常用号会扩大对常用号的影响。因此不能把当前告警解释成普通的网络波动。

本机日志同时存在直接且独立的加重因素：2026-10-27 13:32、13:34、13:36、13:38 连续生成登录二维码，约每两分钟重试一次。此前还发生过 55 个 NapCat 启动器、总计约 229 个 QQ 进程的重复拉起。即使初始触发原因来自第三方接入，这种重复登录也会持续触发风险判断。

无法仅凭现有日志认定具体是 IP、账号、设备指纹或 NapCat 哪个信号单独触发。当前没有证据证明“换 IP 就能解决”，也不应通过伪装设备、绕过检测或清除风控标记来恢复。

## 网上找到的办法与取舍

### 已采用

1. **立即停止自动重试。** NapCat 文档建议在解除社交风控后再运行；本次日志已经出现连续二维码，先停止比继续扫码更安全。
2. **通过官方 QQ 安全中心和官方手机 QQ 处理验证。** 设备下线、安全验证、改密和风险确认必须由账号本人在官方入口完成。
3. **关闭反检测开关。** 审计时三份实际账号配置均为：

   ```text
   o3HookMode = 1
   bypass.hook = true
   bypass.window = true
   bypass.module = true
   bypass.process = true
   bypass.container = true
   bypass.js = true
   ```

   NapCat 自身资料将这些选项描述为隐藏 Hook、模块、窗口和容器特征的检测绕行功能。它们不适合作为风控恢复方案。现已改为 `o3HookMode = 0`，并把同账号主配置中的六个 `bypass` 值改为 `false`。

4. **同机隔离 Bot 号和常用号。** NapCat 安全文档建议避免在同一 IP/设备同时登录 Bot 账号与常用账号。当前普通 QQ 仍在运行，本次没有强制关闭它；长期稳定运行应使用独立机器人账号和独立设备/虚拟机，并固定网络出口。
5. **使用本地回环和鉴权。** OneBot 与 WebUI 只监听本机，账号与管理访问继续使用随机令牌。不要将 3001、WebUI 或控制台暴露到公网。
6. **把状态按链路拆开。** 控制面板现在分别显示 QQ 进程、QQ 登录、OneBot、AstrBot、回复服务和真实消息交付，进程存在不会被显示为“已连接”。

### 看到但不建议采用

- 社区 Issue 中有“降级 QQ 和 NapCat 到旧版本”的临时案例，但该 Issue 被维护者关闭为不计划处理，也没有证明适用于当前 QQ 9.9.36。降级还可能引入已知漏洞，本次未采用。
- 社区讨论中的换 IP、重新拨号或代理只能处理特定网络环境问题；当前告警类型是设备和外挂软件，不是单纯网络失败。本次没有更换代理或设备标识。
- 各类“清除设备指纹”“隐藏注入”“关闭风控检测”的教程会继续对抗平台检测，本次不采用。

## 已落地的安全暂停

持久状态文件：`data/qq-risk-state.json`

暂停期间以下入口都会拒绝执行：

- 定时守护和 `Start-QQ.ps1` 自动登录
- `Start.ps1` 启动消息服务
- `Open-QQ-Login.ps1` 打开登录页
- 机器人账号切换
- 主控制面板的启动、重启和登录按钮

`Set-QQ-Risk-Control.ps1 -Action Pause` 会：

1. 先写入“暂停”状态，保证后续进程即使启动也 fail closed；
2. 停止 `DafeilongQQ` 与 `DafeilongCore` 守护；
3. 停止本项目 bridge 和 AstrBot；
4. 只终止由本项目指定路径和机器人 QQ 参数启动的 NapCat 进程树；
5. 不关闭或终止用户自己的普通 QQ。

`Start-QQ.ps1` 还会检查本次启动后的二维码次数。同一登录流程出现第二次二维码时会自动进入暂停，避免 NapCat 内部继续重试。

## 当前实机状态

- 风控暂停：已启用
- `DafeilongQQ`：Ready，未运行
- `DafeilongCore`：Ready，未运行
- 本项目 NapCat 启动器：0
- OneBot 3001：未监听
- AstrBot：0
- 回复 bridge：0
- 普通 QQ：暂停开始时仍可见；最终复查时用户侧已无 QQ 进程。本项目只终止了由 `runtime\napcat\NapCatWinBootMain.exe` 和指定 Bot QQ 参数标识的进程树。
- 真实消息交付：本轮未验证，状态面板显示“未本轮验证”

## 本人恢复步骤

1. 在官方手机 QQ 或 QQ 安全中心查看该设备的处理结果，按页面要求完成本人验证。
2. 如果安全中心提示“非本人操作”，立即在官方入口改密并检查其他登录设备。
3. 确认不是恶意软件后，使用独立机器人账号；避免常用账号和 Bot 号在同一设备、同一 IP 同时登录。
4. 不要在验证邮件/链接失效后反复申请。回到发起验证的官方页面重新获取新链接。
5. 在主控制面板点击“解除风控暂停”。该操作只解除本地保护，不会自动登录。
6. 点击“启动机器人”，由本人完成**一次**官方登录或验证。不要连续刷新二维码。
7. 如果再次出现风险设备告警、二维码重试、强制验证或离线，重新启用风控暂停，不要靠反复重登解决。

## 长期建议

如果目标是公开、长期、24 小时运行，应评估 QQ 官方机器人平台。官方接口受应用资质和权限控制，当前个人主体与群聊能力需要以开发者后台实时显示为准，不能保证复现普通 QQ 账号在非 @ 群聊、历史消息、好友管理和群管理方面的全部能力。

如果继续使用 NapCat，应接受第三方注入本身属于平台风险，使用独立 Bot 账号、固定且可信的网络、单实例运行、严格的发送限流和故障自动停止。发送频率低并不能消除注入检测风险。

## 回滚

- 脚本与数据库备份：`data/risk-backup-20261027-133943/`
- NapCat 配置备份：`data/risk-backups/napcat-security-20261027-134254/`
- 当前项目目录原本不是 Git 仓库，因此本次使用带清单的目录备份，没有创建伪造的 Git 分支。

如需回滚 NapCat 配置，先保持风控暂停和所有 QQ 进程停止，再从上述目录恢复 `napcat.json`、账号配置和 `manifest.json` 所记录的文件。不要只恢复反检测开关而不重新评估账号风险。

## 来源

- [NapCat 安全相关：账号、设备、代理及 o3Hook 建议](https://napneko.github.io/other/security)
- [NapCat Issue #2085：风控、掉线、登录失败的集中说明入口](https://github.com/NapNeko/NapCatQQ/issues/2085)
- [NapCat Issue #1728：降级版本的社区案例，维护者关闭为 not planned](https://github.com/NapNeko/NapCatQQ/issues/1728)
- [NapCat 反检测配置字段说明（第三方 DeepWiki 索引）](https://deepwiki.com/NapNeko/NapCatQQ/)
- [QQ 官方机器人文档](https://github.com/tencent-connect/bot-docs/blob/main/docs/README.md)
- [QQ 官方消息发送接口](https://github.com/tencent-connect/bot-docs/blob/main/docs/develop/api-v2/server-inter/message/send-receive/send.md)
