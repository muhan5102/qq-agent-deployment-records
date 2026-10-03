# QQ 群聊机器人：部署与运维记录

本仓库记录在一台阿里云轻量应用服务器上部署 QQ 群聊机器人的过程，包括运行环境、
运维手册、踩坑记录，以及配套的角色扮演人设文本。

这套环境由以下组件构成：开源项目 [qq-agent-plus](https://github.com/sakurawwwxh/qq-agent-plus)
作为机器人主体，SnowLuma 容器提供 OneBot 协议端，模型使用 DeepSeek。

**仓库性质**：个人自用记录，与所涉任何公司或项目均无关联，不接受 Pull Request。
第三方权利归属与致谢见 [NOTICE.md](NOTICE.md)，授权条款见 [LICENSE](LICENSE)。

部署日期：2026-09-21　|　最后更新：2026-10-03

## 敏感信息说明

仓库中的服务器地址、账号号码、群号、本机路径等信息**已全部替换为占位符**，
例如 `<SERVER_IP>`、`<BOT_QQ>`。真实值保存在本地未纳入版本控制的 `LOCAL-NOTES.md` 中。

仓库内不含任何密钥、令牌、密码或凭证，也不含真实的聊天记录与群成员信息。
`scripts/` 与 `tools/` 中的脚本同样不含账号、服务器地址或令牌——运行时会从服务器上的凭据文件读取。
详细说明见 NOTICE.md 的「隐私说明」一节。

阅读本仓库时，若命令中出现占位符（如 `ssh admin@<SERVER_IP>`），执行前需替换为实际值。

## 目录结构

### 文档

| 文件 | 说明 |
|---|---|
| [README.md](README.md) | 项目概览、运行环境、当前状态与本仓库导航（入口） |
| [整体流程.md](整体流程.md) | 从部署到运维的完整流程 |
| [QQ机器人-运维速查.md](QQ机器人-运维速查.md) | 运维手册：常用命令与常见问题处理 |
| [踩坑总结.md](踩坑总结.md) | 部署与调优过程中遇到的问题、原因与处理方式 |

### 人设

| 文件 | 说明 |
|---|---|
| [千早爱音-角色卡.md](千早爱音-角色卡.md) | 人设正文 |
| [爱音-附加规则.md](爱音-附加规则.md) | 人设的附加约束规则，优先级高于角色卡 |

### 声明与许可

| 文件 | 说明 |
|---|---|
| [NOTICE.md](NOTICE.md) | 仓库性质、第三方权利归属与致谢、合规提示、隐私与免责声明 |
| [SECURITY.md](SECURITY.md) | 适用版本、部署默认暴露的入口，以及安全问题的报告方式 |
| [CONTRIBUTING.md](CONTRIBUTING.md) | 贡献说明（本仓库不接受外部贡献） |
| [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md) | 行为准则 |
| [LICENSE](LICENSE) | MIT，仅覆盖本仓库自行创作的内容 |

### 脚本与工具

| 路径 | 说明 |
|---|---|
| [scripts/ops.sh](scripts/ops.sh) | 服务器常用运维命令封装：状态、日志、登录态、端口、资源、备份与恢复配置 |
| [scripts/verify-deployment.sh](scripts/verify-deployment.sh) | 只读部署自检，输出通过 / 注意 / 失败计数 |
| [scripts/README.md](scripts/README.md) | 脚本用法与安全边界 |
| [tools/console-tunnel.ps1](tools/console-tunnel.ps1) | 本机通过 SSH 隧道访问控制台，避免把 3210 暴露到公网 |

### 仓库配置

| 文件 | 说明 |
|---|---|
| [.gitignore](.gitignore) | 排除本地真实值、SSH 私钥与临时文件 |
| [.gitattributes](.gitattributes) | 统一换行符（仓库以 LF 存储） |

### 仅本地，不纳入版本控制

| 路径 | 说明 |
|---|---|
| `LOCAL-NOTES.md` | 真实值对照表：服务器地址、账号号码、群号、本机路径 |
| `.deploy/` | 连接服务器用的 SSH 私钥与 known_hosts |
| `work/` | 调试过程产生的临时文件与本地笔记 |

服务器地址、账号号码、密钥与运行数据均被版本控制忽略，仓库中只保留占位符版本。

## 仓库约定

- 提交身份统一为 `muhan5102 <258375253+muhan5102@users.noreply.github.com>`，提交使用 SSH 签名，托管平台显示为 Verified。
- 文档改动流程：本地修改 → 真实值替换为占位符 → 提交前扫描敏感串 → 提交推送。
- 推送通道：`git push` 直连可用时直接使用；直连不可用时改用 GitHub REST API 重建提交，保持作者、提交时间与提交信息一致。
- 本仓库为个人记录，不接受外部贡献，详见 [CONTRIBUTING.md](CONTRIBUTING.md)。

## 运行环境

| 项目 | 说明 |
|---|---|
| 服务器 | 阿里云轻量应用服务器（实例名 `<INSTANCE_NAME>`），2 核 2 GB / 40 GB |
| 系统 | Ubuntu 22.04 LTS |
| 运行方式 | Docker（协议端容器）+ systemd 用户服务（机器人主体） |
| 模型 | DeepSeek，OpenAI 兼容接口 |
| 部署目录 | `/mnt/data/qq-agent`（`app/` 程序、`data/` 数据、`snowluma/` 协议端） |
| 访问端口 | 控制台 3210、协议端面板 5099、扫码登录 6081（默认关闭） |

服务器地址等具体值见本地 `LOCAL-NOTES.md`。

## 架构

```
QQ 群  ⇄  SnowLuma 容器（OneBot 协议端）
                ↕  WebSocket 127.0.0.1:3001
           QQ Agent（systemd 用户服务）
                ↓
           DeepSeek 对话模型
```

- **协议端**：Docker 容器 `qq-agent-snowluma`，负责与 QQ 通信，向机器人主体提供 OneBot 接口；该接口只绑定本机地址，不对外。
- **机器人主体**：systemd 用户服务 `qq-agent-linux`，负责接收消息、判断是否参与、调用模型、按条发送。
- **控制台**：网页界面（端口 3210），用于修改配置、查看会话记录与用量统计。
- **模型接口**：OpenAI 兼容的 HTTP 接口。

部署顺序与各层职责见 [整体流程.md](整体流程.md) 第二节。

## 当前状态

截至 2026-10-03，机器人处于**暂停状态**：

| 项目 | 状态 |
|---|---|
| 程序版本 | `qq-agent-plus` v0.7.7（2026-10-03 由 v0.6.8 升级） |
| 机器人账号 | `<BOT_QQ>`，注册于 2026-09-21 |
| 风控记录 | 2026-09-22、09-23 两次被平台限制功能，均通过身份验证恢复 |
| 机器人服务 | 已停止（`inactive`），配置与人设保留 |
| 协议端容器 | 运行中，未登录 |
| 后续计划 | 账号正常使用一段时间后再考虑重新接入 |

使用第三方协议端登录 QQ 可能被平台判定为异常，进而限制账号功能。该风险由部署者
自行承担。相关内容见 NOTICE.md 的「风险与合规提示」。

## 恢复流程

```bash
# 1. 启动机器人服务与协议端容器
systemctl --user start qq-agent-linux
sudo docker restart qq-agent-snowluma && sleep 20

# 2. 临时开放扫码端口，浏览器访问 http://<SERVER_IP>:6081 扫码登录，完成后关闭该端口
#    noVNC 密码：sudo grep noVNC /mnt/data/qq-agent/deployment-access.txt

# 3. 验证登录状态，返回 "retcode":0 即为正常
T=$(sudo awk -F': ' '/OneBot token:/{print $2}' /mnt/data/qq-agent/deployment-access.txt)
curl -sS -m 10 -H "authorization: Bearer $T" -H 'content-type: application/json' \
  -d '{}' http://127.0.0.1:3000/get_login_info; echo
```

中间状态的检查与异常处理见 [运维手册](QQ机器人-运维速查.md) 第六节。

## 配置摘要

| 项目 | 值 |
|---|---|
| 模型与温度 | `deepseek-chat`，温度 1.3 |
| 人设 | 角色卡约 5.3 千字，附加规则约 1 千字 |
| 交流策略 / 参与度 | `legacy`（原版群友）/ high |
| 响应概率 | 60%（被 @ 必回） |
| 消息节奏 | 思考等待 15~28 秒，分条间隔 2.5~7 秒，单轮通常 1 条、最多 2 条 |
| 对话模式 | `threaded`（参与者续接） |
| 时间控制 | 启用（全天），夜间由人设规则约束 |
| 每日动态 | 开启，20:00~23:30 区间内随机发布 1 条 |
| 动态互动 / 主动加好友 | 关闭 |
| 表情自动收藏 | 开启（每小时不超过 10 张） |
| 白名单 | 群 `<GROUP_ID>`（1 个）；私聊为管理员 `<ADMIN_QQ>` 与一个测试账号（2 个） |

## 操作注意事项

以下操作会造成账号登录态失效，需要重新扫码：

1. 重启协议端容器（`docker restart qq-agent-snowluma`）
2. 重启服务器

其他注意事项：

- 扫码端口 6081 用完即关，不要长期对外开放
- 不要开启自动更新：升级过程会重启服务
- 不要手动删除 dpkg 锁文件
- 服务器不要关机或停止实例
- SSH 访问凭证不要随意清理

完整清单见运维手册第七节。

## 第三方组件与致谢

本仓库内容基于以下项目与服务整理，感谢作者与维护者：

- [qq-agent-plus](https://github.com/sakurawwwxh/qq-agent-plus)：机器人主体程序，MIT 许可
- [SnowLuma](https://github.com/SnowLuma/SnowLuma)：OneBot 协议端框架；本项目部署时使用 Docker Hub 上的镜像 `motricseven7/snowluma`（该串是 Docker Hub 的镜像路径，与 GitHub 仓库 `SnowLuma/SnowLuma` 分属两个平台，不是同一处引用）
- [OneBot v11 协议规范](https://github.com/botuniverse/onebot-11)：机器人对接协议
- [DeepSeek](https://platform.deepseek.com)：对话模型服务
- 阿里云：服务器与网络环境
- 角色「千早爱音」出自《BanG Dream! It's MyGO!!!!!》，版权归 Bushiroad 及相关权利人
- 设定资料参考：萌娘百科、百度百科对应条目
- 部署流程参考：小黑盒社区一篇部署教程（作者 bbbgd）

本仓库仅记录个人实践，不含上述项目的源代码或官方素材。具体权利归属与免责条款
见 [NOTICE.md](NOTICE.md)。

## 许可

本仓库中由仓库所有者自行创作的内容（部署记录、运维文档、人设文本等）采用 MIT 许可，
详见 [LICENSE](LICENSE)。第三方项目、商标与角色版权归各自权利人所有。
