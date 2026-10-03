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
