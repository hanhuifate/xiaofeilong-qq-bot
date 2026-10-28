# 2026-10-27 本机 QQ 接入排障

> 后续状态（2026-10-27 13:45）：QQ 安全中心出现“设备存在外挂或其他软件影响 QQ 正常使用”后，本文早先开启的六个反检测开关已全部关闭，`o3HookMode` 已设为 0；`DafeilongQQ` 守护、NapCat、OneBot、AstrBot 和回复 bridge 已进入持久风控暂停。以 `docs/qq-risk-audit.md` 的当前状态为准。

## 已确认的问题

08:12 左右发现同一机器人的 55 个 NapCatWinBootMain 启动器、总计约 229 个 QQ 进程。Start-QQ.ps1 只检查 OneBot 3001 端口，未考虑 QQ 未登录时该端口尚不开放。QQ 守护每 20 秒重复拉起一次实例。

停止 QQ 守护后，按程序完整路径及 -q 1000000001 参数确认归属，清理 54 个重复启动器及其子进程，保留一个机器人实例。用户自行打开、非本守护创建的 QQ 实例未处理，账号和登录数据未删除。之后只重启本机器人的一个实例加载新配置。

## 已修改并验证

- 模型仍是 gpt-6-luna，reasoningEffort 改为 high，回复服务已重启加载。
- NapCat 全局与 1000000001 专属配置的 hook/window/module/process/container/js 六个 bypass 开关开启。修改前两份文件备份于 data/adapter-recovery-时间戳目录；通过实际 GetConfig 接口确认六项均为 true。它们不能替代账号登录、验证码或保证解除风控。
- Start-QQ 增加账户互斥锁、现有机器人启动器检测及 120 秒启动冷却。正式守护恢复运行；连续调用启动脚本仍只有一个启动器，没有重复发起账号登录。
- 控制面板区分“QQ 进程在运行但等待账号登录/验证”与“QQ 消息接口已连接”；原生窗口实际启动检查 PANEL_SMOKE_OK，脚本解析通过。
- QQ 登录按钮改为当前 WebUI 支持的本机登录路由，预填本机密钥，不在日志打印带凭据的 URL。

## 当前账号和网络证据

实际 CheckLoginStatus 返回 isLogin=false、loginPhase=waiting_qrcode、coreReady=false、loginError为空。当前两种快速登录列表均没有机器人 QQ 1000000001，没有对其他已保存账号执行快速登录。无法在这个状态下声称机器人已恢复收发，后续需要本人完成该账号的官方登录或验证。

Windows 系统代理为本机 7897；被检查 QQ 进程存在到外部 443/8080 的 TCP 连接，没有连接本机代理端口；系统默认路由经 WLAN，未发现启用的 TUN/TAP 类适配器。没有取得腾讯登录错误码或成功登录时的出口对照，不能证明或排除 IP 风控，也没有改代理、换 IP 或改设备标识。

用户已明确：失效的是 QQ 邮箱收到的验证邮件链接。它与 NapCat WebUI 管理凭据不同；需要从发起验证的官方页面重新申请并使用新邮件，不能靠 NapCat 的开关恢复旧验证链接。目前不能据此认定账号已被封禁或 IP 已被限制。

本机不含凭据的登录核对数据见 data/adapter-login-check.json。[NapCat 官方配置说明](https://napneko.github.io/config/basic) 区分管理页与 OneBot 网络端口；具体配置字段及登录状态接口以当前安装版本的实际代码和接口为准。
