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

## crawl4ai_render.py

服务器侧的按需动态网页渲染器，由机器人 `render_web_page` 工具调用。它使用独立虚拟环境里的
Crawl4AI 和 Chromium，只处理公开页面；默认启动一次浏览器、自动滚动最多 8 屏、45 秒页面超时，
并向标准输出返回最多 3 万字符的 JSON。

部署路径：

```text
/mnt/data/qq-agent/tools/crawl4ai/fetch_page.py
/mnt/data/qq-agent/tools/crawl4ai/venv
```

普通网页仍优先使用 `web_fetch`；只有 JavaScript 空壳、动态评论区或正文过少时才调用它。

## apply-patches.sh

**按版本重放本地补丁**。部署脚本会整树替换 `app/`，本仓库 `patches/` 里的历史拆分补丁
主要用于回滚参考；当前版本使用部署目录内的单文件集成补丁，实际补丁文件不进入公开仓库。

```bash
bash apply-patches.sh                 # 检查并补齐缺的补丁，不重启
bash apply-patches.sh --restart       # 补齐后重启机器人主体
DRY_RUN=1 bash apply-patches.sh       # 只看会做什么，不落盘
```

入口会按程序版本分流：旧版继续调用保留的分段入口，当前版本使用单文件补丁。单文件补丁
只在版本、路径、data 边界和正向 dry-run 全部通过后才落盘，并在应用后跑
`node --check` 和反向校验；任一步失败都不重启服务。

可用 `APP_DIR`、`ENTRY_DIR`、`PATCH_DIR`、`NODE` 覆盖默认路径。它不改任何配置、不碰容器、不动登录态——
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

**服务器侧**的小工具：每天 08:00 后给管理员**发一封“运行简报”**，以“昨日统计”为主，
并附今日实时趋势参考和当前账户余额。

> 为什么是邮件而不是 QQ 私聊：机器人账号发的私聊会落在"和角色的私聊"里，既出戏、又会被角色
> 自己的上下文读到并接茬（2026-10-16 实测反馈）。邮件不碰 QQ，聊天里干干净净。

为什么需要它：各家平台都**没有"查用量"的接口**（实测 DeepSeek 只有 `/user/balance` 余额接口，
`/user/usage` 之类全 404；硅基流动的老接口已废弃返回 410；博查没有这类接口），
而机器人自己每次都记着 token——程序会写 `data/usage-today.json`，**但它每天覆盖、不留历史**。
所以这个脚本靠"每 10 分钟快照一次"攒出按天历史，早上再合成一条消息发出去。

- 部署位置：`/mnt/data/qq-agent/usage-daily.mjs`
- 调度：systemd 用户定时器 `usage-daily.timer`（`OnCalendar=*:0/10`），每 10 分钟跑一次
  （`systemctl --user list-timers usage-daily.timer` 看状态，`journalctl --user -u usage-daily.service` 看日志）；
  另加 `23:59:30` 定格快照，避免 23:50 后最后一段用量要等次日才能补进历史
- 行为：每次跑都**快照**（幂等，同一个 dayKey 覆盖）；08:00 后检查未发送的日报。
  任务漏跑或 SMTP 临时失败时会在后续 10 分钟检查中补发，最多追最近 2 天；标题和正文会标注"补发"
- 邮件排版走**大厂交易邮件那种 HTML 版式**（自适应全宽、最大 720px 卡片、彩色页眉、分节标题、
  键值右对齐的表格式数字、异常级别用色块标签、AI 分析是左侧灰条引用块、页脚小字附注），
  同时**带一份纯文本兜底**——发的是 `multipart/alternative`，客户端自己挑；
  主题统一带 `[QQ-bot]` 前缀（因为同地址自收发时收件箱显示的是账号昵称，认不出邮件里的发件人名）
- HTML 的实现约束：**table 布局 + 全部内联样式**。QQ 邮箱 / Outlook / 手机客户端普遍会丢掉
  `<head>` 里的 `<style>`，也不支持 flex/grid，只有内联样式可靠；动态文本一律 HTML 转义
  （异常消息里可能带 `<`、`&`）
- **平台与模型调用**：扫描当天会话留档，按"渠道｜模型"列出模型调用次数、总 Token、
  输入缓存命中、输入未命中、输出 Token。没有会话留档的辅助调用会单独列为差额，不硬分摊给模型
- **功能调用**：分别统计搜索工具、网页读取、语音转文字、识图工具的次数，并显示发起工具调用的对话模型。
  搜索和 ASR 会优先使用每次工具结果中记录的实际 service/model/route；旧记录没有元数据时明确写"当时服务未记录"。
  识图另列"含图会话数 / 图片数"
- **趋势与预测**：昨日费用与前一日、近 7 日均值比较，显示 7 日逐日费用、预计月度费用和按近 7 日均值计算的余额可用天数
- **完整数值与柱状图**：Token 不使用 M/k 缩写，统一显示完整整数并加千分位；
  柱状图展示最近 7 个完整自然日 + 今日实时数据，分别堆叠输入命中、输入未命中和输出 Token；
  7 日均值只使用完整自然日，今日半天不会拉低基准；柱状图下方以两列日期卡片固定展示
  每日总 Token、输入命中/未命中、输出、运行次数和估算费用
- **昨日饼图**：固定放在“昨日核心概览”下方；使用昨日台账生成 PNG，通过 `multipart/related` 的 `Content-ID` 内嵌到邮件，
  不依赖 SVG、外部图片或 data URI；左侧显示输入命中/未命中/输出的占比，右侧列出完整 Token 与百分比
- **平台名称**：配置中能识别的渠道优先显示显示名，已知域名会映射成友好名称，例如 `api.deepseek.com` → `DeepSeek 官方`
- **余额币种**：只把 CNY 账户按 `¥` 展示；接口只返回其他币种时明确报“没有 CNY 账户”，不再把 USD 冒充人民币
- **邮件主题**：压缩为“运行简报｜昨日 MM-DD｜费用 · 次数 · 状态”，避免手机通知栏截断关键信息
- **图表刻度**：柱状图显示峰值、上中下刻度和 0 基线；每日卡片继续采用两列紧凑布局
- **版本兼容**：HTML 和纯文本都会显示预算超限、未计价运行、余额读取失败、通知队列失败、补发状态；
  HTML 不再漏掉这些告警
- **AI 分析**：那天**确实有异常**时，把异常清单交给模型（用机器人自己那套 provider 与 key，
  temperature 0.3）写一段 200 字以内的分析——①共同说明什么 ②要不要人工处理 ③第一步做什么。
  提示词里明确要求"只依据清单、不编造"，并且**提醒它清单是历史记录、可能已被处理**
  （否则它会把昨天缺 ffmpeg 这种事说成"现在仍然缺失"）。分析失败就跳过，日报照发
- 演练：`node usage-daily.mjs --dry` —— 只打印这条消息，不发送也不落盘
- 测试邮件：`node usage-daily.mjs --test-mail` —— 发送一封最新版结构的测试日报
- 自检：`node usage-daily.mjs --self-test` —— 覆盖完整数字、余额币种、昨日饼图 PNG、内嵌图片 MIME、
  未知渠道过滤与差额校正、实际服务元数据、补发顺序和状态保留期
- 落盘：`data/usage-daily.json`（按天台账，保留 120 天）、`data/balance-daily.json`（余额历史）、
  `data/usage-report-state.json`（每日发送状态、补发和失败原因）
  自动清理：用量历史保留 120 天、余额历史保留 365 天、简报发送状态保留 180 天
- 邮件凭据：`/mnt/data/qq-agent/mail-cred.json`（600 权限、不进仓库）
  `{ "host": "smtp.qq.com", "port": 465, "user": "<SMTP_EMAIL>", "pass": "<SMTP授权码>", "to": "<SMTP_EMAIL>" }`
  —— 用**授权码**不是登录密码；`to` 省略就发给自己
- 发件人**显示名**默认 `QQ-bot`（可用环境变量 `QQ_AGENT_MAIL_FROM_NAME` 覆盖）；
  发信**地址**本身改不了——QQ 邮箱要求 `From` 地址必须等于登录的账号
- 口径：**估算费用由程序按官方价格与 Token 计算**，不等同于实际账单；
  **账户余额只在当前服务商支持余额接口时显示**。目前只有 DeepSeek 接入了余额查询，其他服务商不会被误请求
- 邮件头：日报、异常和通知都带稳定的 `Message-ID`、`Auto-Submitted: auto-generated` 和
  `X-Auto-Response-Suppress: All`，降低重试后的重复与自动回复
- 失败诊断：SMTP / 控制台请求失败时保留底层 `code` 和 `cause`，日报会显示脱敏后的失败原因

只读性说明：它**不改任何机器人配置、不碰机器人服务**；读取 `data/usage-today.json`、`data/sessions/`
和 `config.json`，写自己的快照/状态文件并发送邮件。SMTP 是手写的极简实现（隐式 TLS + AUTH LOGIN），
不引第三方依赖。

### 顺带做的第二件事：把新告警转发到邮箱

程序自己的告警本来是**私聊发给管理员 QQ** 的（`incident-pilot.js` 里的 `notify()`），
那会落在"和角色的私聊"里——既出戏、又会被角色自己的上下文读到（2026-10-16 用户反馈）。
上游没有 webhook / 邮件通道，所以这里用**只读**的方式绕开：

- 每次跑的时候读一次控制台的 `GET /api/incidents`（拿控制台 token 鉴权，纯读）
- **分级投递**（2026-10-16 用户定，同日修正等级口径）：
  - **严重 / 错误级 → 立刻发**：挑出"没见过 + 24 小时内"的这两级，立即发一封邮件
  - **警告级 → 日汇总**：不单独发，攒进每天 08:00 那封**日报**里（与用量同一封邮件，一天只收一封）；
    控制台「警告级也通知」勾上就连警告也单发（读 `incidentPilot.notifyWarnings`）
  - 等级标签按真实等级显示（严重 / 错误 / 警告 / 信息）——以前只认 `severe`，把"错误"误标成了"警告"
- 转发过的 id 记在 `data/incident-notify.json`，**首次运行只种标记不补发历史**；
  投递失败会把 `lastFailureAt / lastFailureError` 写进同一个文件，下一天的日报里带一行 ⚠ 提示
- 想改"哪些级别立刻发"用环境变量 `QQ_AGENT_INCIDENT_IMMEDIATE`（默认 `critical,severe,error`）

### 顺带做的第三件事：程序侧的管理员通知也改走邮件

**QQ 私聊通道已经关掉**（`incidentPilot.qqNotify` 默认关；要恢复成私聊告警得显式打开，
见 `patches/patch-admin-notify-mail-2026-10-16.diff`）。现在所有给管理员的通知都走邮件：

- **异常告警**：见上一节
- **更新提示**（有新版本 / 更新结果失败）
- **好友申请 / 好友候选 / 审批回执**
- **每日花费超限**：不再私聊，改成程序写 `data/budget-alert.json`，
  由本脚本在日报的"需要你注意"分节里显示

做法：程序不再自己连 SMTP，而是把通知**排进 `data/mail-outbox.json`**（最多留 50 条），
本脚本每 10 分钟跑的时候读一次队列、逐条发信、发完清掉；失败留在队列里重试，
连续 6 次失败就放弃并留下错误信息。所以通知的**最长延迟约 10 分钟**（等于定时器间隔）。
