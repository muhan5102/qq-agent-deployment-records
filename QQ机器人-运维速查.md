# QQ Agent 运维手册

最后更新：2026-10-03

---

## 快速索引

| 你要做的事 | 去哪看 |
|---|---|
| **QQ 掉登录了，要重新扫码** | 第六节 **第 2 条**（5 步：重启容器 → 取密码 → 开 6081 → 扫码 → 验证关闭） |
| 机器人不说话了 | 第六节 **第 1 条**（排查决策树） |
| 账号被风控限制了 | 第六节 **第 3 条**（验证解封 + 别立刻重挂） |
| 想打开控制台 | 第四节 |
| 改了配置要让生效 | `systemctl --user restart qq-agent-linux` |
| 配置改错了要回滚 | 第六节 **第 10 条**（有 8 份备份） |
| 从本机连服务器 | 第六节 **第 11 条**（SSH 密钥与四个注意点） |
| **绝对不能做的操作** | 第七节（8 条红线） |

---

## 一、服务器与账号

| 项目 | 值 |
|---|---|
| 服务商 / 机型 | 阿里云 轻量应用服务器（实例名 <INSTANCE_NAME>） |
| 公网 IP | `<SERVER_IP>` |
| 地域 | 华东2（上海） |
| 系统 | Ubuntu 22.04.5 LTS（内核 5.15.0-142） |
| 规格 | 2 核 2 GB / 40 GB 系统盘 |
| 登录用户 | `admin`（免密 sudo） |
| 到期时间 | `<EXPIRES_AT>`（本地对照表记录真实值） |
| 机器人 QQ | <BOT_QQ>（昵称 Chihaya Anon） |
| 管理员 QQ | <ADMIN_QQ>（机器人告警/审批收件人） |

**当前状态（2026-10-10）**：机器人**已重新接入，处于「只看不说」的观察期**——服务 `active`、
运行模式 `observe`；协议端容器运行中且**已登录**（2026-10-09 扫码，之后没重启过容器）。程序已于
2026-10-10 由 v0.8.1 升级至 **v0.8.3**（协议端镜像仍是 **`motricseven7/snowluma:v1.14.22`**，
与上游基线一致，所以升级时"随版本对齐协议端"是 no-op）。每日动态、动态互动、补话均已关闭；
自主节奏 `pacing` 已开启；`admin` 已加入 `docker` 组（见第三节）。

---

## 二、服务与端口

| 组件 | 地址 / 端口 | 说明 |
|---|---|---|
| QQ Agent 控制台 | `http://<SERVER_IP>:3210` | 需 Agent token |
| SnowLuma WebUI | `http://<SERVER_IP>:5099` | 容器 `qq-agent-snowluma` |
| QQ 扫码登录（noVNC） | `http://<SERVER_IP>:6081` | **防火墙平时禁用**，需要时临时启用 |
| OneBot HTTP / WS | `127.0.0.1:3000` / `:3001` | 仅本机，不对外 |
| SSH | `<SERVER_IP>:22` | 见第六节第 11 条 |

---

## 三、关键路径

| 内容 | 路径 |
|---|---|
| 凭据（token / 各种密码） | `/mnt/data/qq-agent/deployment-access.txt` |
| Agent 程序 | `/mnt/data/qq-agent/app` |
| Agent 数据（配置、消息库、记忆） | `/mnt/data/qq-agent/data` |
| SnowLuma（容器数据 + compose） | `/mnt/data/qq-agent/snowluma` |
| 项目源码 | `/home/admin/qq-agent-plus` |
| Node 运行时 | `/mnt/data/qq-agent/app/.runtime/node-v22.23.2-linux-x64/bin/node` |

**配置备份**（都在 `/mnt/data/qq-agent/data/`，共 15 份）：

```
config.json.bak-friendoff        # 改好友功能前
config.json.bak-prob0            # 好友抽签概率设 0 前
config.json.bak-pacing           # 调整节奏参数前（2026-09）
config.json.bak-short            # 缩短话痨前
config.json.bak-qzoneoff         # 关动态互动前
config.json.bak-moments          # 改动态发布时间前
config.json.bak-pre084           # 升级 v0.7.8 前
config.json.bak-prob60-before    # 响应概率改回 60% 前
config.json.bak-pre081           # 升级 v0.8.1 前
config.json.bak-moments-off      # 关每日动态前
config.json.bak-followup-off     # 关补话前
config.json.bak-pacing-sendlimit # 开 pacing 并收紧发送闸门（10/120）前
config.json.bak-sendlimit-hi     # 发送闸门放回 15/180 前
config.json.bak-zjsn             # 人设里 zjsn 改回"这缩写"前
config.json.bak-pre083           # 升级 v0.8.3 前
```

> 回滚用 `cp config.json.bak-<名字> config.json`，然后重启服务才生效
> （控制台改配置是即时生效的，直接改文件才需要重启）。

**本地代码补丁（升级会被覆盖，务必留意）**

目前有两个补丁，完整用途与打/回退步骤见仓库 [patches/README.md](patches/README.md)：

| 补丁 | 改了什么 | 改前原件（服务器） |
|---|---|---|
| `memory-qq-2026-10-09` | 记忆印象行在昵称后带上 QQ 号，认人以号为准 | `app/src/memory/memory-global.js.bak-20261009` |
| `sticker-collect-criteria-2026-10-10` | 收藏判定改成"两条都要过"并做成配置项 `sticker.collectCriteria` | `app/src/onebot/sticker-manager.js.bak-20261010`、`app/src/core/config-legacy.js.bak-20261010` |

> 2026-10-10 升级到 v0.8.3 时，`deploy.sh` 的 `rsync --delete` 会把 `src/` 整个换掉，两个补丁
> 都被覆盖 —— 已按上表重打，并另存了 v0.8.3 的原件为 `*.bak-20261010b`（重打失败时可回退）。
> memory 补丁在 v0.8.3 上是 **17 行偏移**（`patch` 会自动对齐并提示，属正常）。

> 收藏判定标准**平时不用改代码**：`sticker.collectCriteria` 填一段"收什么 / 不收什么"就即时生效
> （留空 = 用内置默认）。只有改代码逻辑时才需要走下面的打补丁流程。

跑过 `deploy-all.sh` 升级之后要重新打一次：

```bash
cd /mnt/data/qq-agent/app && patch -p1 < /mnt/data/qq-agent/patch-memory-qq-2026-10-09.diff
./.runtime/node-v22.23.2-linux-x64/bin/node --check src/memory/memory-global.js
systemctl --user restart qq-agent-linux
```

> 上游若动过同一个文件，`patch` 会报 hunk failed——那种情况手工重做，不要硬打。

**运行模式的位置**：v0.8.x 起 `runtime.mode` 在配置的 `runtime` 段（旧版写在 `server` 段）。
直接改配置文件时要认这个位置；用控制台改则不用管。

**docker 组（2026-10-10 起）**：`admin` 已加入 `docker` 组。

这是上游 v0.8.2 起部署脚本的"自愈"步骤，目的是让控制台的「更新协议端」按钮可用（Issue #30：
服务进程的补充组在 user manager 启动那一刻冻结，事后 `usermod` 对已运行的进程无效）。升级时
脚本会加组并**重建 user manager**（`stop → sleep 3 → start`，实测不能用 `restart`），期间
`admin` 名下所有用户服务会停约 10 秒再自动恢复。

代价照上游文档：docker 组等于 root 等价权限。本机原本就配了 `admin` 的免密 sudo，所以**实际
权限级别没有变化**。不想保留可以撤销：

```bash
sudo gpasswd -d admin docker    # 撤销后控制台「更新协议端」会报权限不足，协议端升级要手工 ssh
```

---

## 四、怎么打开控制台

控制台是**网页**，开在自己电脑浏览器里，服务器上不用装任何东西。

1. 取 token：

```bash
cd /mnt/data/qq-agent/app && bash manage.sh token
```

2. 浏览器打开 `http://<SERVER_IP>:3210`，粘贴 token 登录

进去后可看：控制（服务状态）、会话/存档（聊天记录与每次运行的完整模型输入）、观测（表情包）、用量（token 与花费）、设置（人设/模型/白名单等）。

---

## 五、常用命令

### 日常运维（先 `cd /mnt/data/qq-agent/app`）

```bash
bash manage.sh status                        # 服务状态
bash manage.sh logs                          # 最近日志
bash manage.sh health                        # 健康检查
bash manage.sh token                         # 打印控制台 token
bash manage.sh restart                       # 重启 Agent（不影响 QQ 登录）
bash manage.sh pause                         # 暂停发言（仍记录消息）
bash manage.sh activate --confirm-exclusive  # 恢复正常发言
```

### 服务与容器

```bash
systemctl --user status qq-agent-linux          # 机器人服务详情
systemctl --user stop/start/restart qq-agent-linux
journalctl --user -u qq-agent-linux -f          # 实时日志（Ctrl+C 退出）
sudo docker ps --filter name=snowluma           # 协议端容器状态
sudo docker logs --tail 50 qq-agent-snowluma    # 容器日志
```

### 检查 QQ 登录态

```bash
T=$(sudo awk -F': ' '/OneBot token:/{print $2}' /mnt/data/qq-agent/deployment-access.txt); curl -sS -m 10 -H "authorization: Bearer $T" -H 'content-type: application/json' -d '{}' http://127.0.0.1:3000/get_login_info; echo
```

返回 `"retcode":0` = 正常。

### 资源查看

```bash
free -m      # 内存
df -h /      # 磁盘
uptime       # 负载与开机时长
```

---

## 六、常见场景与解决

### 1. 机器人不说话 / 回复变慢

**按这个顺序查**：

1. 控制台顶栏状态点：绿=正常，黄=断过在重连，灰=没连上
2. 跑第五节的 `get_login_info`：`retcode` 不是 0 → 走第 2 条；返回 `Connection reset` → 走第 3 条
3. 服务与容器是否活着（第五节的命令）
4. 若一切正常但仍不回话，看「对话 → 会话」里有没有对应记录：
   - **没有记录** → 被响应概率跳过了（正常，概率 60% 表示约 40% 的普通消息不接）
   - **有记录但决定不回复** → 人设/规则让它判断"不需要接"
5. 也可能是夜间：时间控制 `mode=always` 时不受时段限制，但【作息】人设会让它凌晨基本不吭声

### 2. QQ 掉登录了（最常见）

#### 第一步：确认是不是真的掉了

```bash
# ① 登录态（报错 / retcode≠0 / Connection reset 都算掉了）
T=$(sudo awk -F': ' '/OneBot token:/{print $2}' /mnt/data/qq-agent/deployment-access.txt); curl -sS -m 10 -H "authorization: Bearer $T" -H 'content-type: application/json' -d '{}' http://127.0.0.1:3000/get_login_info; echo

# ② 容器日志里的掉线痕迹
sudo docker logs --tail 200 qq-agent-snowluma 2>&1 | grep -iE "session closed|kick|offline|load failed" | tail

# ③ 端口是否在监听
ss -ltn 2>/dev/null | grep -E ":3000|:3001"
```

典型掉线日志长这样：

```
[OneBot] session closed: UIN=<BOT_QQ>
[Hook] load failed: component loading failed
```

#### 第二步：恢复（5 步）

**① 重启容器**，让协议端重新注入 hook

```bash
sudo docker restart qq-agent-snowluma
sleep 20
sudo docker ps --filter name=snowluma --format '{{.Status}}'   # 应显示 Up ...
```

> 这一步本身会掉登录——但登录**已经掉了**，所以没有额外代价。**只在掉线时用它**，平时不要碰。

**② 取出 noVNC 密码**

```bash
sudo grep noVNC /mnt/data/qq-agent/deployment-access.txt
```

**③ 开放扫码端口**：阿里云控制台 →「防火墙」→ 把 **6081** 那条改成「**启用**」

**④ 扫码**：浏览器打开 `http://<SERVER_IP>:6081` → 输入 noVNC password → 用**机器人小号**的手机 QQ 扫码登录

**⑤ 验证并收尾**

```bash
T=$(sudo awk -F': ' '/OneBot token:/{print $2}' /mnt/data/qq-agent/deployment-access.txt); curl -sS -m 10 -H "authorization: Bearer $T" -H 'content-type: application/json' -d '{}' http://127.0.0.1:3000/get_login_info; echo
```

看到 `"retcode":0` 就成功了。**然后把 6081 改回「禁用」**。

#### 扫码后还是不行？按现象对照

| 现象 | 原因 | 处理 |
|---|---|---|
| 页面打不开 | 6081 没启用，或容器没起来 | 回到第 ①③ 步 |
| 页面黑屏 / 一直转圈 | 协议端还在启动 | 等 30～60 秒再刷新 |
| 扫完仍无响应 | hook 没注入成功 | 再执行一次 `sudo docker restart qq-agent-snowluma`，等 30 秒重试 |
| `retcode` 不是 0 | QQ 未登录，或令牌不一致 | 看容器日志；确认协议端 `onebot.json` 的 accessToken 与控制台一致 |
| Agent 显示未连接 | 连接只在启动时建立一次 | `cd /mnt/data/qq-agent/app && bash manage.sh restart` |

#### 如果是"服务器整机重启"之后

1. 等 2 分钟，让 Docker 和各项服务自动拉起
2. 逐个检查：

```bash
systemctl is-active docker                              # 应为 active
sudo docker ps --filter name=snowluma --format '{{.Status}}'   # 应为 Up ...
systemctl --user is-active qq-agent-linux               # 应为 active
```

- 容器没起 → `cd /mnt/data/qq-agent/snowluma && sudo docker compose up -d`
- Agent 没起 → `systemctl --user start qq-agent-linux`（如果之前执行过 disable，先 `systemctl --user enable qq-agent-linux`）

3. **整机重启后大概率需要重新扫码** —— 走上面"第二步恢复"的 ②～⑤ 步

### 3. 账号被风控限制（功能限制 / 封禁）

症状：手机 QQ 收到"QQ安全中心 · 功能限制提醒"，或提示"身份验证信息已失效"。

**处理**：

1. 手机上按提示**完成身份验证**（这一步只有你能做）——两次限制都是这样解开的
2. **验证解开后不要立刻挂回协议端**。立刻重挂会被判定为对抗风控，处罚会升档
3. 让账号"歇一段时间"：停掉 Agent（`systemctl --user stop qq-agent-linux`），什么都不挂
4. 用手机正常用这个号养号（发消息、加好友、逛空间），**至少 2～4 周**再考虑重挂
5. 重挂前先**只保留"被 @ 回复"**，观察几天没问题再逐步放开其他功能

**判断要不要担心永封**：如果两次都是"功能限制 + 验证即可恢复"这种同档处理，说明还在"可疑但可挽回"范围；真正容易永封的是**内容踩红线**（涉政/涉黄/诈骗引流）和**被多人举报**。

### 4. 想让它夜间安静

两个层次，可以叠加：

- **硬性静音**：「设置 → 时间控制」启用后配自定义时段——非活跃期**完全不响应**（消息只归档，不补回复）。注意 `mode=always` 表示**全天活跃，时段配置会被忽略**
- **软性收敛**：角色卡里的【作息】规则——凌晨 1～7 点基本不吭声，被 @ 才回且回得很短

### 5. 觉得话痨 / 话太少

| 想调整 | 位置 | 当前值 |
|---|---|---|
| 多久接一次话 | 设置 → 聊天设置 → 响应档位滑条 | 60% |
| 分条之间的间隔 | 设置 → 聊天设置 → 发送保护 | 2.5～7 秒 |
| 反应快慢 | 设置 → 聊天设置 → 运行节奏（思考等待） | 15～28 秒 |
| 一轮说几句 | 设置 → 人设 → 角色设定 / 附加规则 | 通常 1 条、最多 2 条 |

**改响应概率要用滑条，不要直接改配置文件里的 `randomPercent`**：
`contextSliderPos`（滑条位置）是权威字段，`randomPercent` 是它的派生值。程序在启动与升级
迁移时会按 `contextSliderPos` 重算 `randomPercent`，直接改后者会被覆盖回去（v0.7.7、v0.7.8 实测）。

**还嫌话多**：概率降到 45～50，思考等待拉到 40 秒。
**嫌太慢**：思考等待回到 10～15 秒。

### 6. 人设不像 / 口癖不出来

按顺序检查：

1. **交流策略**必须是「**原版群友**」（`legacy`）——选成「自然可靠」会变得正经、不装傻
2. **温度**建议 1.1～1.3（当前 1.3）
3. 角色卡第三节的"口癖是招牌，要敢用"是否还在（这是下限要求：每 2～3 条至少出现一次）
4. **验证是否真的生效**：控制台「对话 → 会话」→ 最近一次运行 → 在「最新完整模型输入」里搜关键词（如"えらい""作息"）。设置页只证明你填了，会话记录才证明它发出去了
5. 还是不够像 → **往角色卡第七节加"不要 X / 可以 Y"的对照示例**，这比改规则有效

### 7. 想关掉某个功能

| 功能 | 位置 | 备注 |
|---|---|---|
| 动态互动（自动点赞/评论好友动态） | 设置 → 动态互动 | 当前**已关** |
| 每日动态（自动发说说） | 设置 → 每日动态 | 当前开着，见第 8 条 |
| 主动加好友 | 记忆 → 好友管理 → 运行设置 → **抽签概率设为 0** | 当前**已关**；`enabled` 字段是废弃的，改了会被固化策略改回来 |
| 表情自动收藏 | 设置 → 表情 | 当前开着，风险低 |
| 自动更新 | 控制 → 更新部署 | 建议**保持暂停**（升级会重启服务，可能掉登录） |

### 8. 让每日动态在随机时间发布

固定时刻（如每天 23:30）太像机器人。改成窗口内随机：

- 界面：设置 → 每日动态 →「定时方式」选「**时间范围内随机发布**」→ 填起止时间与条数
- 当前配置：`20:00 ~ 23:30`，每天 1 条 → 每天在窗口内随机挑时间发
- 规则：每条至少间隔 5 分钟，最多 8 个窗口，每天最多 20 条，窗口不能重叠（支持跨午夜）

### 9. 改完配置怎么确认生效

1. **看配置文件**（最直接）：
   ```bash
   sudo grep -A3 '"要查的字段"' /mnt/data/qq-agent/data/config.json
   ```
2. **看模型实际收到什么**：控制台「对话 → 会话」→ 最近一次运行 → 完整模型输入
3. 走 SSH 改配置后**必须重启 Agent** 才生效：
   ```bash
   systemctl --user restart qq-agent-linux
   ```

### 10. 配置改错了怎么回滚

```bash
sudo cp /mnt/data/qq-agent/data/config.json.bak-<后缀> /mnt/data/qq-agent/data/config.json
sudo chown admin:admin /mnt/data/qq-agent/data/config.json
sudo chmod 600 /mnt/data/qq-agent/data/config.json
systemctl --user restart qq-agent-linux
```

备份清单见第三节。

### 11. 从本机 SSH 上服务器

密钥在 `C:\Users\<USERNAME>\.ssh\qqbot_deploy`（**已去掉密码**）：

```powershell
ssh -i "$env:USERPROFILE\.ssh\qqbot_deploy" -o IdentitiesOnly=yes admin@<SERVER_IP> "要执行的命令"
```

**注意**：

- 必须在**非沙箱**环境运行（沙箱内 ssh 无法加载私钥）
- 私钥文件必须**属主是当前 Windows 用户**、ACL 只留本人，否则报 `Permissions are too open`
- 服务器 `admin` 账户必须**不是锁定状态**（`sudo passwd -S admin` 显示 `P`）；万一被锁，`sudo passwd admin` 重设
- **不要**执行清理 `authorized_keys` 里 `qqbot-deploy` 那行的命令，会把访问通道删掉

### 12. 磁盘 / 内存吃紧

```bash
df -h /                      # 磁盘
free -m                      # 内存
sudo docker system df        # Docker 占用
sudo docker image prune -f   # 清理无用镜像（可选）
```

当前内存占用约 690MB / 1608MB（SnowLuma 容器占大头）。如果不需要协议端，可以 `sudo docker stop qq-agent-snowluma` 省下约 500MB；恢复时用 `cd /mnt/data/qq-agent/snowluma && sudo docker compose up -d`。

---

## 七、操作红线（不要做）

1. **不要 `docker restart qq-agent-snowluma`**——会掉 QQ 登录，要重新扫码（**除非登录已经掉了**，那时重启没有额外代价）
2. **不要重启服务器**——同样掉登录；`System restart required` 可以长期无视
3. **不要手动删 dpkg 锁文件**
4. **不要把 6081 长期开着**——扫码页用完就禁用
5. **不要开自动更新**——升级会重启服务
6. **不要把服务器关机 / 停止实例**
7. **不要清理自己的 SSH 访问凭证**
8. **不要在账号被限制后立刻把协议端挂回去**——会被判定为对抗风控，处罚升档

---

## 八、相关文档

- [踩坑总结.md](踩坑总结.md)：25 个已踩的坑 + 具体原因（部署、SSH、运行、人设调优）
- [千早爱音-角色卡.md](千早爱音-角色卡.md)：当前使用的人设正文
- [爱音-附加规则.md](爱音-附加规则.md)：管理员附加规则正文
