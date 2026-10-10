<div align="center">

# QQ 群聊机器人：部署与运维记录

面向 Linux 服务器的 QQ 群聊机器人部署与运维记录：运行环境、运维手册、踩坑记录与人设文本。

[![License](https://img.shields.io/badge/license-MIT-3da639.svg)](LICENSE)
[![qq-agent-plus](https://img.shields.io/badge/qq--agent--plus-v0.8.3-blue)](https://github.com/sakurawwwxh/qq-agent-plus)
[![Platform](https://img.shields.io/badge/platform-Linux-0b5fff?logo=linux&logoColor=white)](#运行环境)
[![Protocol](https://img.shields.io/badge/protocol-OneBot%20v11-12b7f5)](https://github.com/botuniverse/onebot-11)
[![LLM](https://img.shields.io/badge/LLM-DeepSeek-6b4fbb)](https://platform.deepseek.com)
[![Last commit](https://img.shields.io/github/last-commit/muhan5102/qq-agent-deployment-records?logo=git&logoColor=white)](https://github.com/muhan5102/qq-agent-deployment-records/commits/main)
[![Stars](https://img.shields.io/github/stars/muhan5102/qq-agent-deployment-records?label=stars&logo=github)](https://github.com/muhan5102/qq-agent-deployment-records/stargazers)

**简体中文** ｜ [English](README.en.md)

</div>

本仓库记录在一台阿里云轻量应用服务器上部署 QQ 群聊机器人的过程，包括运行环境、
运维手册、踩坑记录，以及配套的角色扮演人设文本。

这套环境由以下组件构成：开源项目 [qq-agent-plus](https://github.com/sakurawwwxh/qq-agent-plus)
作为机器人主体，SnowLuma 容器提供 OneBot 协议端，模型使用 DeepSeek。

**仓库性质**：个人自用记录，与所涉任何公司或项目均无关联；欢迎通过 Issue 提出问题、错误纠正与改进意见。
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
| [README.en.md](README.en.md) | 本文档的英文版 |
| [整体流程.md](整体流程.md) | 从部署到运维的完整流程 |
| [QQ机器人-运维速查.md](QQ机器人-运维速查.md) | 运维手册：常用命令与常见问题处理 |
| [踩坑总结.md](踩坑总结.md) | 部署与调优过程中遇到的问题、原因与处理方式 |
| [CHANGELOG.md](CHANGELOG.md) | 变更记录：按日期记录文档与服务器侧的变动 |

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
| [CONTRIBUTING.md](CONTRIBUTING.md) | 贡献说明：欢迎反馈与改动，以及仓库所有者本人的提交约定 |
| [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md) | 行为准则 |
| [LICENSE](LICENSE) | MIT，仅覆盖本仓库自行创作的内容 |

### 脚本与工具

| 路径 | 说明 |
|---|---|
| [scripts/ops.sh](scripts/ops.sh) | 服务器常用运维命令封装：状态、日志、登录态、端口、资源、备份与恢复配置 |
| [scripts/verify-deployment.sh](scripts/verify-deployment.sh) | 只读部署自检，输出通过 / 注意 / 失败计数 |
| [scripts/README.md](scripts/README.md) | 脚本用法与安全边界 |
| [tools/console-tunnel.ps1](tools/console-tunnel.ps1) | 本机通过 SSH 隧道访问控制台，避免把 3210 暴露到公网 |
| [patches/](patches/) | 服务器侧代码补丁：对上游 app 的小改动，含用途说明与打/回退方法 |

### 仓库配置

| 文件 | 说明 |
|---|---|
| [.gitignore](.gitignore) | 排除本地真实值、SSH 私钥与临时文件 |
| [.gitattributes](.gitattributes) | 统一换行符（仓库以 LF 存储） |
| [.github/](.github/) | 平台配置：Issue 表单模板（问题 / 建议）、PR 模板 |

### 仅本地，不纳入版本控制

| 路径 | 说明 |
|---|---|
| `LOCAL-NOTES.md` | 真实值对照表：服务器地址、账号号码、群号、本机路径 |
| `.deploy/` | 连接服务器用的 SSH 私钥与 known_hosts |
| `work/` | 调试过程产生的临时文件与本地笔记 |

服务器地址、账号号码、密钥与运行数据均被版本控制忽略，仓库中只保留占位符版本。

## 仓库约定

下列约定用于约束**仓库所有者本人的提交**，目的是让署名可追溯、内容不含敏感信息、历史可核对：

- 提交身份统一为 `muhan5102 <258375253+muhan5102@users.noreply.github.com>`，提交使用 SSH 签名，托管平台显示为 Verified。
- 文档改动流程：本地修改 → 真实值替换为占位符 → 提交前扫描敏感串 → 提交推送。
- 推送通道：`git push` 直连可用时直接使用；直连不可用时改用 GitHub REST API 重建提交，保持作者、提交时间与提交信息一致。
- 仓库只记录个人实践，不作为官方文档，也不构成对任何产品或服务的技术担保。

其他人的问题、建议与改动**不受上述约定限制**：错误纠正与改进建议可以提到 Issue，
用法交流与开放讨论可以放在 Discussions，也可以按自己的习惯提交改动。
所有互动请遵守 [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md)：说明具体文件、版本或复现步骤，
就事论事、理性表达；重复刷屏、情绪化指责或与主题无关的内容可能被关闭。
贡献方式与内容边界见 [CONTRIBUTING.md](CONTRIBUTING.md)，安全问题与敏感信息的报告方式见 [SECURITY.md](SECURITY.md)。

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

截至 2026-10-09，机器人**已重新接入，处于「只看不说」的观察期**：

| 项目 | 状态 |
|---|---|
| 程序版本 | `qq-agent-plus` v0.8.3（2026-10-10 升级） |
| 协议端 | `motricseven7/snowluma:v1.14.22`（2026-10-09 升级） |
| 机器人账号 | `<BOT_QQ>`，注册于 2026-09-21 |
| 风控记录 | 2026-09-22、09-23 两次被平台限制功能，均通过身份验证恢复 |
| 机器人服务 | 运行中（`active`），运行模式 `observe` |
| 协议端容器 | 运行中，**已登录**（2026-10-09 扫码） |
| 后续计划 | 先观察 1~2 天，再决定是否放开被动回复；流程见运维手册第六节第 2 条 |

使用第三方协议端登录 QQ 可能被平台判定为异常，进而限制账号功能。该风险由部署者
自行承担。相关内容见 NOTICE.md 的「风险与合规提示」。

## 断线重连 / 重新扫码流程

> ⚠️ 只有**登录态掉线**时才需要走这套。平时不要执行第 1 步里的容器重启——那会注销登录，
> 必须重新扫码才能恢复。

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
| 人设 | 角色卡约 5.6 千字，附加规则约 1.4 千字 |
| 交流策略 / 参与度 | `legacy`（原版群友）/ medium |
| 响应概率 | 60%（被 @ 必回） |
| 消息节奏 | 思考等待 15～20 秒，分条间隔 2.5～7 秒，单轮通常 1 条、最多 2 条 |
| 发送闸门 | 每分钟 15 条 / 每小时 180 条（防模型抽风，平时碰不到） |
| 自主节奏 `pacing` | 开启（群聊：默认 6 分钟醒一次、最短 3 分钟；被 @ 仍即时） |
| 对话模式 | `threaded`（参与者续接） |
| 时间控制 | 启用（模式 `always`，全天开放），夜间由人设规则约束 |
| 每日动态 / 动态互动 | **关闭** |
| 主动找话 | 冷场开话题 关闭；补话 关闭；自唤醒 保留 |
| 成员认知 | 印象行带 QQ 号（服务器侧本地补丁，见运维手册第三节） |
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
- [阿里云](https://cn.aliyun.com/)：服务器与网络环境
- [Node.js](https://nodejs.org/)：机器人运行时
- [Docker](https://www.docker.com/)：协议端容器运行时
- [Ubuntu](https://ubuntu.com/)：服务器操作系统（22.04 LTS）
- 角色「千早爱音」出自《[BanG Dream! It's MyGO!!!!!](https://anime.bang-dream.com/mygo/)》（[系列官网](https://bang-dream.com/)、[官方游戏《BanG Dream! Our Notes》官网](https://bdon.biligames.com/)），版权归 [Bushiroad](https://bushiroad.com/) 及相关权利人
- 设定资料参考：[萌娘百科](https://zh.moegirl.org.cn/%E5%8D%83%E6%97%A9%E7%88%B1%E9%9F%B3)、[百度百科](https://baike.baidu.com/item/%E5%8D%83%E6%97%A9%E7%88%B1%E9%9F%B3) 对应条目
- 部署流程参考：小黑盒社区公开教程《在自己 QQ 群里养一个 AI 群友：qq-agent-plus 保姆级部署教程》（作者 bbbgd，[原文链接](https://www.xiaoheihe.cn/app/bbs/link/43197277b4fa)）

本仓库仅记录个人实践，不含上述项目的源代码或官方素材。具体权利归属与免责条款
见 [NOTICE.md](NOTICE.md)。

## 许可

本仓库中由仓库所有者自行创作的内容（部署记录、运维文档、人设文本等）采用 MIT 许可，
详见 [LICENSE](LICENSE)。第三方项目、商标与角色版权归各自权利人所有。
