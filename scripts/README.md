# 脚本说明

本目录是仓库所有者在运维过程中自用的脚本，**不是上游项目的一部分**。它们只调用
《QQ机器人-运维速查.md》里已经记录过的命令，不包含任何账号、地址、令牌等敏感值。

## ops.sh

在服务器上以 `admin` 用户运行，把常用操作收成一条命令：

```bash
bash ops.sh status            # 服务、容器与登录态总览
bash ops.sh login             # 查询 QQ 登录态
bash ops.sh ports             # 端口监听
bash ops.sh res               # 内存与磁盘
bash ops.sh logs 200          # 最近 200 行日志
bash ops.sh health            # 项目自带健康检查
bash ops.sh token             # 打印控制台 token
bash ops.sh version           # 程序版本与协议端镜像
bash ops.sh restart-agent     # 重启机器人主体（不影响登录态）
bash ops.sh pause / activate  # 暂停 / 恢复发言
bash ops.sh backup-config [后缀]      # 备份 config.json
bash ops.sh restore-config <后缀>     # 从备份恢复并重启主体
bash ops.sh qr-steps          # 只打印扫码恢复流程，不执行任何操作
```

路径默认按部署文档的约定（`/mnt/data/qq-agent`），可用环境变量
`QQBOT_APP_DIR`、`QQBOT_DATA_DIR`、`QQBOT_ACCESS_FILE`、`QQBOT_SERVICE`、`QQBOT_CONTAINER` 覆盖。

### 安全边界

脚本**不包含**重启协议端容器、重启服务器、删除 dpkg 锁文件、清理 SSH 凭据这类操作——
它们要么会掉 QQ 登录态，要么风险不可控。需要时按《QQ机器人-运维速查.md》第七节的红线
与第六节的流程人工执行。

## verify-deployment.sh

只读自检：逐项检查服务、容器、登录态、OneBot 端口与程序版本，最后给出通过 / 注意 / 失败计数。

```bash
bash verify-deployment.sh
```

账号处于养号期时，"服务"与"登录态"两项显示为未运行属于**预期状态**，不是故障。

## apply-patches.sh

**升级后重新打本地补丁**。`deploy-all.sh` 的 `rsync --delete` 会整树替换 `app/src/`，
本仓库 `patches/` 里记录的那几条改动每次升级都会被覆盖回去。

```bash
bash apply-patches.sh                 # 检查并补齐缺的补丁，不重启
bash apply-patches.sh --restart       # 补齐后重启机器人主体
DRY_RUN=1 bash apply-patches.sh       # 只看会做什么，不落盘
```

它逐条判断：反向 dry-run 通过 = 已经生效（跳过）；正向 dry-run 通过 = 补上，改完跑一次
`node --check`；两边都对不上 = 报冲突并**原样留着不动**，绝不硬打。只要有一条需要人工处理，
脚本就以非 0 退出且不重启服务。

可用 `APP_DIR`、`PATCH_DIR`、`NODE` 覆盖默认路径。它不改任何配置、不碰容器、不动登录态——
唯一的写操作是给 `src/` 里的目标文件打补丁。

## console-tunnel.ps1

在**本机 Windows** 上运行。通过 SSH 隧道把服务器上的控制台（3210）与 SnowLuma 面板（5099）
映射到本机回环地址，这样 3210 与 5099 就不必对公网开放。

```powershell
.\console-tunnel.ps1 -ServerHost <SERVER_IP>
```

可选参数：`-User`（默认 `admin`）、`-KeyPath`（默认 `~/.ssh/qqbot_deploy`）、
`-ConsolePort` / `-PanelPort`（默认 3210 / 5099）、`-NoBrowser`（不自动打开浏览器）。

脚本会通过 SSH 读取一次控制台 token 并打印出来，然后建立隧道；按 `Ctrl+C` 结束并关闭隧道。
它不修改任何服务器配置，也不改动本机代理设置。

## usage-daily.mjs

**服务器侧**的小工具：每天 9:00 给管理员**发一封邮件**，内容是"昨天的机器人用量 + DeepSeek 余额"。

> 为什么是邮件而不是 QQ 私聊：机器人账号发的私聊会落在"和角色的私聊"里，既出戏、又会被角色
> 自己的上下文读到并接茬（2026-10-16 实测反馈）。邮件不碰 QQ，聊天里干干净净。

为什么需要它：各家平台都**没有"查用量"的接口**（实测 DeepSeek 只有 `/user/balance` 余额接口，
`/user/usage` 之类全 404；硅基流动的老接口已废弃返回 410；博查没有这类接口），
而机器人自己每次都记着 token——程序会写 `data/usage-today.json`，**但它每天覆盖、不留历史**。
所以这个脚本靠"每 10 分钟快照一次"攒出按天历史，早上再合成一条消息发出去。

- 部署位置：`/mnt/data/qq-agent/usage-daily.mjs`
- 调度：systemd 用户定时器 `usage-daily.timer`（`OnCalendar=*:0/10`），每 10 分钟跑一次
  （`systemctl --user list-timers usage-daily.timer` 看状态，`journalctl --user -u usage-daily.service` 看日志）
- 行为：每次跑都**快照**（幂等，同一个 dayKey 覆盖）；到了 9 点且当天还没发过 → 合成并发邮件
- 邮件排版走**大厂交易邮件那种 HTML 版式**（600px 卡片、彩色页眉、分节标题、
  键值右对齐的表格式数字、异常级别用色块标签、AI 分析是左侧灰条引用块、页脚小字附注），
  同时**带一份纯文本兜底**——发的是 `multipart/alternative`，客户端自己挑；
  主题统一带 `[QQ-bot]` 前缀（因为同地址自收发时收件箱显示的是账号昵称，认不出邮件里的发件人名）
- HTML 的实现约束：**table 布局 + 全部内联样式**。QQ 邮箱 / Outlook / 手机客户端普遍会丢掉
  `<head>` 里的 `<style>`，也不支持 flex/grid，只有内联样式可靠；动态文本一律 HTML 转义
  （异常消息里可能带 `<`、`&`）
- **AI 分析**：那天**确实有异常**时，把异常清单交给模型（用机器人自己那套 provider 与 key，
  temperature 0.3）写一段 200 字以内的分析——①共同说明什么 ②要不要人工处理 ③第一步做什么。
  提示词里明确要求"只依据清单、不编造"，并且**提醒它清单是历史记录、可能已被处理**
  （否则它会把昨天缺 ffmpeg 这种事说成"现在仍然缺失"）。分析失败就跳过，日报照发
- 演练：`node usage-daily.mjs --dry` —— 只打印这条消息，不发送也不落盘
- 落盘：`data/usage-daily.json`（按天台账，保留 120 天）、`data/balance-daily.json`（余额历史，用于"较上次"）
- 邮件凭据：`/mnt/data/qq-agent/mail-cred.json`（600 权限、不进仓库）
  `{ "host": "smtp.qq.com", "port": 465, "user": "xxx@qq.com", "pass": "<SMTP授权码>", "to": "xxx@qq.com" }`
  —— 用**授权码**不是登录密码；`to` 省略就发给自己
- 发件人**显示名**默认 `QQ-bot`（可用环境变量 `QQ_AGENT_MAIL_FROM_NAME` 覆盖）；
  发信**地址**本身改不了——QQ 邮箱要求 `From` 地址必须等于登录的账号
- 口径：**花费是程序自己的估算**（内置官方价 × token，含缓存价与高峰价，与控制台「用量」页同一口径），
  **余额是 DeepSeek 接口给的真实数字**——两者不是一回事，消息里分开写

只读性说明：它**不改任何配置、不碰机器人服务**，只读 `data/usage-today.json` / `config.json`，
并把结果发一封邮件。SMTP 是手写的极简实现（隐式 TLS + AUTH LOGIN），不引第三方依赖。

### 顺带做的第二件事：把新告警转发到邮箱

程序自己的告警本来是**私聊发给管理员 QQ** 的（`incident-pilot.js` 里的 `notify()`），
那会落在"和角色的私聊"里——既出戏、又会被角色自己的上下文读到（2026-10-16 用户反馈）。
上游没有 webhook / 邮件通道，所以这里用**只读**的方式绕开：

- 每次跑的时候读一次控制台的 `GET /api/incidents`（拿控制台 token 鉴权，纯读）
- **分级投递**（2026-10-16 用户定）：
  - **严重级 → 立刻发**：挑出"没见过 + 24 小时内"的严重异常，立即发一封邮件
  - **警告级 → 日汇总**：不单独发，攒进每天 9:00 那封**日报**里（与用量同一封邮件，一天只收一封）
- 转发过的 id 记在 `data/incident-notify.json`，**首次运行只种标记不补发历史**
- 想改"哪些级别立刻发"用环境变量 `QQ_AGENT_INCIDENT_IMMEDIATE`（默认 `severe`）

**注意**：这**没有**关掉程序内部那条 QQ 告警——那是另一件事（要改 `incident-pilot.js`）。
现在两条通道并存：邮箱收到（新的）+ 严重级仍会私聊你（原有）。要彻底关掉 QQ 那条才需要打补丁。
