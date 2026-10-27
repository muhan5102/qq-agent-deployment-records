# 服务器侧代码补丁

这里存放**对上游 `qq-agent-plus` 代码的小改动**。上游升级会整树覆盖 `app/`，
所以每一条改动都要留成 `.diff`，升级后按下面的步骤重新打。

> 补丁只描述"从上游原版改成什么样"，**不含任何部署信息**（服务器地址、账号、群号、
> 群成员昵称等一律不写进补丁与说明）。真实值见本地未纳管的 `LOCAL-NOTES.md`。

> **2026-10-27 起基线为 v0.9.11**：服务器改用合并补丁
> `patch-local-all-0.9.11-20261027.diff`（53 个目标文件，含本地私有补丁，
> **仅保留在服务器与本地未纳管目录，不进仓库**）。
> 启动钩子按程序版本分流：旧版继续调用保留的补丁链，v0.9.11 调用新的单文件补丁；
> 这样部署失败自动回滚后，旧版仍可启动。下面是历史拆分记录，保留作回滚参考。

## 清单

| 补丁 | 目标文件 | 适用于 | 作用 |
|---|---|---|---|
| [patch-feature-provider-meta-2026-10-21.diff](patch-feature-provider-meta-2026-10-21.diff) | `src/tools/tools-core.js` + `src/tools/audio-transcribe.js` | v0.9.4、v0.9.5 | 搜索与语音转写工具结果记录实际 service/model/route，供运行简报准确区分聚合搜索、QQ 自带转写和外部 ASR |
| [patch-undirected-text-nudge-2026-10-21.diff](patch-undirected-text-nudge-2026-10-21.diff) | `src/core/orchestrator.js` | v0.9.4、v0.9.5 | `probability` / `lifecycle` 触发只写了正常文本却未调用工具时提醒一次用 `send_message` 重发；内部备注、`done/ok` 等完成标记和定向消息不重复处理 |
| [patch-daily-reminders-2026-10-21.diff](patch-daily-reminders-2026-10-21.diff) | `src/core/reminders.js` + 工具/控制台/UI | v0.9.4、v0.9.5 | 新增每日固定时刻循环提醒：稳定系列 ID、重复创建去重、成功后推进次日、离线跳期、整系列取消；一次性提醒保持兼容 |
| [patch-memory-qq-2026-10-09.diff](patch-memory-qq-2026-10-09.diff) | `src/memory/memory-global.js` | `qq-agent-plus` v0.8.1、v0.8.3、v0.8.4、v0.8.5 | 让「对群友的全局印象」每行在昵称后带上 `(QQ 号)`，认人以号为准 |
| [patch-memory-source-replace-2026-10-22.diff](patch-memory-source-replace-2026-10-22.diff) | `src/memory/global-person-memory-store.js` | v0.9.4、v0.9.5 | 人物记忆的“整人替换”只替换当前会话来源，群聊与私聊各自的印象不会被后整理的会话覆盖 |
| [patch-render-web-2026-10-22.diff](patch-render-web-2026-10-22.diff) | `src/core/orchestrator.js` + `src/llm/prompt.js` + `src/tools/` | v0.9.5 | 新增按需启用的动态网页渲染工具，复用服务器本地 Crawl4AI/Chromium，读取 JavaScript 页面；限制单并发、55 秒超时和 3 万字符输出 |
| [patch-video-link-hybrid-2026-10-22.diff](patch-video-link-hybrid-2026-10-22.diff) | 视频/音频工具、提示词与工具过滤 | v0.9.5 | 新增 B 站、YouTube、抖音视频链接读取；B 站优先本地字幕/音轨，其他平台走 `yt-dlp`，深度模式可调用 BiliNote 在线精读 |
| [patch-video-intent-2026-10-23.diff](patch-video-intent-2026-10-23.diff) | `src/tools/video-link.js` + `src/core/orchestrator.js` | v0.9.5 | 当前批次明确要求“详细分析/完整分析/认真看完/完整笔记”时，确定性强制视频工具进入深度模式；否定句和普通询问不触发 |
| [patch-video-deep-context-2026-10-24.diff](patch-video-deep-context-2026-10-24.diff) | `src/tools/video-link.js` + `src/core/orchestrator.js` + `src/onebot/onebot.js` | v0.9.5 | 分享卡片补提视频 URL；扩展“详细看看/认真看/从头看”等意图；追问不带链接时绑定最近人类消息中的视频，先取 BiliNote 笔记，再结合本轮要求组织回复 |
| [patch-sticker-note-40-2026-10-14.diff](patch-sticker-note-40-2026-10-14.diff) | `src/onebot/sticker-manager.js` | v0.8.5 | 表情备注上限 24 → 40 字，让"谁+在干什么+适合什么场合"写得完 |
| [patch-memory-guard-and-scope-2026-10-16.diff](patch-memory-guard-and-scope-2026-10-16.diff) | `src/core/orchestrator.js` | v0.8.5 | 印象整理器的约束（不抄粗口、不用量化词）+ **按会话分口径与分来源**：群只整理群来源、私聊只整理私聊来源，互不串 |
| [patch-text-nudge-2026-10-16.diff](patch-text-nudge-2026-10-16.diff) | `src/core/orchestrator.js` | v0.8.5 | 模型把回复写成文本、没调 `send_message` 时，提醒它一次改用工具重发（不替它发） |
| [patch-admin-notify-mail-2026-10-16.diff](patch-admin-notify-mail-2026-10-16.diff) | `src/console/app.js` | v0.8.5 | 管理员通知（异常/更新/好友申请/审批回执）从"私聊 QQ"改成"排队等邮件"，QQ 通道默认关 |
| [patch-budget-mail-2026-10-16.diff](patch-budget-mail-2026-10-16.diff) | `src/core/orchestrator.js` | v0.8.5 | 每日花费超限不再私聊管理员：写 `data/budget-alert.json`，由日报带一行 |
| [patch-incident-ui-text-2026-10-16.diff](patch-incident-ui-text-2026-10-16.diff) | `ui/pages/features.js` | v0.8.5 | 控制台「异常」页文案跟上（告警收件人走邮件、待发含义、警告级勾选） |
| [patch-handoff-detail-2026-10-16.diff](patch-handoff-detail-2026-10-16.diff) | `src/memory/memory-global.js` + `src/llm/prompt.js` + `src/tools/tools-core.js` | v0.8.5 | 私聊的「会话交接」写细一档：存储容量与注入上限放宽、`finish` 的字段上限 6/8→8/12 且描述点名"私聊里要写细"、提示里要求记约定/近况/情绪/停在哪/下次接什么 |
| [patch-search-relevance-2026-10-17.diff](patch-search-relevance-2026-10-17.diff) | `src/llm/web-search.js` | v0.8.5 | 搜索逻辑三处：① 聚合结果按"命中词总字数"打分排序、0 分丢弃（不足 2 条退回原结果）；② 查询归一化，剥掉"什么是/是谁/有哪些/怎么样"这类包装词再送引擎；③ Bing 先读 `&format=rss`、拿不到再回退 HTML 解析（HTML 结果页对云服务器 IP 常回验证页）|
| [patch-search-cjk-deepseek-2026-10-17.diff](patch-search-cjk-deepseek-2026-10-17.diff) | `src/llm/web-search.js` + `ui/pages/settings.js` | v0.8.5 | 中文整句搜索修复：① 去虚词后按两字滑窗切词（"今天有什么科技新闻"→科技/技新/新闻），相关性过滤对整句提问重新生效；② 同分按来源权重排（智谱 > DeepSeek > Bing）；③ 去重同时按"域名+路径"和"域名+标题"，消掉同一文章带 utm 参数的重复；④ 新增 DeepSeek 官方搜索源（`/v1/tools/search`，结构化结果，Key 回退主模型） |
| [patch-auto-trigger-images-2026-10-17.diff](patch-auto-trigger-images-2026-10-17.diff) | `src/core/orchestrator.js` | v0.8.5 | 触发消息带图时**自动附图**（最多 3 张，走 tools-core 同一套下载/压缩），不再依赖模型主动调 `get_message_images` |
| [patch-rule-modules-2026-10-17.diff](patch-rule-modules-2026-10-17.diff) | `src/llm/prompt.js` + `src/core/orchestrator.js` | v0.8.5 | 功能性规则按场景注入：`data/rules/image.md`（识图）与 `data/rules/voice.md`（转写）作为**用户消息里的操作规则**追加，系统提示保持稳定（避免 `prompt-prefix-changed` 重置线程）。判定：视觉可用且本轮有图或文本出现 `[图片]/[表情包]`；ASR 可用且本轮有音频或出现 `[语音]/音频文件`。缺文件跳过 + 警告一次 |

> `sticker-collect-criteria` 已于 2026-10-10 **退役**（上游 v0.8.4 自带同一能力），
> 见文末「已退役」一节；它的判定标准现在由配置 `sticker.collectCriteria` 承担。

**跨版本偏移**：补丁的 hunk 行号是按 v0.8.1 生成的。在 **v0.8.3** 上，memory 补丁会提示
`Hunk #1 succeeded at 211 (offset 17 lines)`——这是正常的自动对齐，不是失败；打完照例跑
`node --check` 确认（**v0.8.4**、**v0.8.5** 上同样是 17 行偏移）。

## 升级后一键重打（`scripts/apply-patches.sh`）

上面的补丁清单如果靠手工逐条打，升级一忙就容易漏。仓库里的 `scripts/apply-patches.sh`
（服务器上放 `/mnt/data/qq-agent/apply-patches.sh`）把这件事收成一条命令：

```bash
bash apply-patches.sh            # 检查并补齐缺的，不重启
bash apply-patches.sh --restart  # 补齐后重启机器人主体（不动容器）
```

判断逻辑：**反向 dry-run 通过 = 已经生效**（跳过）；正向 dry-run 通过 = 补上并跑 `node --check`；
两边都对不上 = 报冲突并原样留着不动，退出码非 0，也**不会**重启服务。所以它在"已经打过"、
"全新升级后"两种状态下都安全，重复执行没有副作用（2026-10-15 用一份还原成升级后状态的临时
代码树实测通过）。

### 权威副本在哪（重要）

服务器上的 `/mnt/data/qq-agent/apply-patches.sh` 是**权威清单**：它的数组顺序 = 补丁执行顺序，
而且比仓库这份**多两条本地私有补丁**（只服务于本地配置，全文放在未纳管目录 `work/patches/`，
细节见本地 `LOCAL-NOTES.md`，不在仓库里展开）。

- 升级后只需在服务器上跑 `bash apply-patches.sh --restart`，不需要把仓库这份拷过去覆盖它
  （拷过去会丢掉那两条私有补丁）。
- 万一服务器重装/补丁目录丢了：仓库这份 + `work/patches/` 那两条 = 完整清单；
  按服务器那份清单的顺序把这两条插回原位置（紧跟 `patch-text-nudge` 之后）即可。

### 升级前先跑一次演练（`scripts/patch-replay-drill.sh`）

升级会把 `app/` 整树换成上游版本，补丁链一旦有顺序错、上下文对不上、漏登记，当天就会卡住。
这个脚本**只动临时目录、不碰线上代码**，把清单里所有补丁涉及的文件复制一份：
先逆序反向应用（还原成上游原样）、再正序正向重打，最后与线上文件逐字节比对。

```bash
bash patch-replay-drill.sh
```

2026-10-17 实测：15 条补丁、14 个文件，反向 + 正向 + md5 比对全部通过。

> 规则模块的正文不在补丁里（它属于 `data/` 数据，不随 `app/` 升级覆盖）。源文件见仓库
> `persona/爱音-模块-识图.md` / `persona/爱音-模块-语音.md`，部署时复制到 `/mnt/data/qq-agent/data/rules/`。
**建议每次升级前后各跑一次**（升级前确认链子是好的，升级后确认真的都打上了）。

### 升级 checklist

1. `cd /mnt/data/qq-agent && bash apply-patches.sh`（先看一眼"已生效 N / 需处理 0"）
2. 备份 `data/config.json` 与 `app/src`（升级脚本自己也会留 `data/deploy-backups/`）
3. 跑升级（`deploy-all.sh`，rsync 会覆盖 `app/`）
4. `bash apply-patches.sh --restart` → 应为"本次补打 N / 需处理 0"，随后 `node --check` 由脚本自带
5. `bash patch-replay-drill.sh` → 应打印"演练通过"
6. 抽查关键功能：控制台能开（3210）、`/api/daily-moments/status` 正常、
   本地那两条私有补丁对应的功能正常（自查方法见本地 `LOCAL-NOTES.md`）、
   异常页文案是"告警收件人（邮件）"（说明 UI 补丁生效）

---

## patch-memory-guard-and-scope-2026-10-16.diff（合并了原 patch-memory-guard-2026-10-15）

### 为什么合并

印象整理器原来有一条"不抄粗口、私聊内容不进印象、不用量化词"的约束补丁（`patch-memory-guard-2026-10-15`），
后来又在同一处加了"**按会话分口径与分来源**"（这次新写的）：整理时只读、只写本会话来源的印象，
群 ↔ 私聊各存各的。两条补丁改的是同几行，拆开时单条反向检查会误报"冲突"，于是合并成这一条。

### 这次新增的行为

- **整理只看本会话来源**：`#consolidateOneMember` 先按 `sourceChatKeys` 把"本会话的"和"别的会话的"分开，
  模型只看到本会话那几条，写回时把别的会话的原文原样带回（存储层会保留它们原来的来源标记）。
  这样群里的整理不会把私聊内容"洗"成群可见条目，反之亦然
- **提示词按会话给口径**：群聊只写"群里看得见的"（说话风格、梗、群内角色、公开兴趣、雷点），
  私聊写"私聊里的"（语气、称呼、聊过的事、约定、情绪、亲疏），并点明这些条目只在私聊可见
- 保留原有的：不抄粗口原文、不用"经常/总是/从来"这类量化词

---

## patch-memory-qq-2026-10-09.diff

### 为什么需要它

拼进提示词的【对群友的全局印象】原本只写昵称。昵称是不可靠的标识：同一个群里的昵称可能
重名、可能是英文缩写，也可能本身就是一句会误导的话（读起来像系统消息或事件）。模型据此
认人，就会出现"把 A 的印象算到 B 头上"这类问题。

QQ 号是稳定且唯一的，而系统其它部分（人物档案、记忆文件、身份来源表、以及所有"对某个人
动手"的工具参数）本来就以 QQ 号为主键——只有**显示给模型看的那一层**用的是昵称。这个补丁
把显示层也带上号，让两边对得上。

管理员那一行保持原有形态（`（QQ …，就是管理员本人）`），因为那句"就是管理员本人"是模型
判断"谁在管这个账号"的依据。若某个人还没有昵称、显示的就是号本身，则不重复拼接。

### 打补丁

在服务器上、以 `app/` 为当前目录执行：

```bash
cd /mnt/data/qq-agent/app
patch -p1 < patches/patch-memory-qq-2026-10-09.diff      # 路径按实际存放位置替换
./.runtime/node-v22.23.2-linux-x64/bin/node --check src/memory/memory-global.js
systemctl --user restart qq-agent-linux
```

- `node --check` 通过只是语法通过；真正生效要重启服务（Node 不热加载源码）。
- 改的是**展示层文案**，不改变任何发送行为与数据。

### 验证

1. 补丁与线上文件是否一致：`patch -p1 --dry-run -R < patch-memory-qq-2026-10-09.diff`
   反向 dry-run 通过，说明该补丁与当前文件逐字吻合。
2. 效果：重启后，运行时拼出的【对群友的全局印象】每行形如
   `- 昵称(QQ <QQ_ID>)：[09-22] …`；管理员那行仍是 `昵称（QQ <QQ_ID>，就是管理员本人）`。

### 回退

```bash
patch -p1 -R < patch-memory-qq-2026-10-09.diff
systemctl --user restart qq-agent-linux
```

服务器上另有改前的原件副本（`memory-global.js.bak-<日期>`），便于直接比对。

### 维护注意（对本目录所有补丁通用）

- 上游若改过同一个文件，`patch` 会报 `hunk failed`——**不要硬打**（`--forward` 会留下半个
  改动），照新版本的代码手工重做，再重新生成补丁文件。
- 补丁针对的是 v0.8.1 的行号；跨版本打之前先 `diff` 一眼上下文是否还对得上。
- 打完记得 `node --check` 目标文件，并重启服务（Node 不热加载源码）。

---

## patch-sticker-note-40-2026-10-14.diff

### 为什么需要它

自动收藏表情包时，模型会顺带写一句中文备注。上游把备注硬限制在 **24 字**，而且是
`schema.maxLength = 24` 加 `.slice(0, 24)` 双重截断——提示词里怎么写"要写完整"都没用，
超出的部分在进入存储前就被切掉了，留下的是断在半句上的备注（如"…适合想干小"）。

先试过只改配置（把 `sticker.collectCriteria` 里的备注要求写紧凑），能缓解但治不了本：
24 字对"谁 + 在干什么 + 适合什么场合"三件事本来就紧。**上限是代码里的常量，配置文件改不破**，
所以留了这个补丁把上限放宽到 40 字。放宽后 `collectCriteria` 也改成写全三样（见文末一节）。

### 打补丁

```bash
cd /mnt/data/qq-agent/app
patch -p1 < patches/patch-sticker-note-40-2026-10-14.diff
./.runtime/node-v22.23.2-linux-x64/bin/node --check src/onebot/sticker-manager.js
systemctl --user restart qq-agent-linux
```

### 验证

1. `patch -p1 --dry-run -R < patch-sticker-note-40-2026-10-14.diff` 反向 dry-run 通过。
2. 重启后日志里 `[sticker]` 的备注长度可以超过 24 字，且整句完整。

---

## patch-memory-guard-2026-10-15.diff

### 为什么需要它

自动整理「人物印象」时，整理器会照抄原文里的话，写出两类不该留的内容：

1. **照抄粗口**——原文里的脏话被原样搬进印象；
2. **给行为贴标签**——把"他喜欢逗你"写成"想掌控设定""喜欢试探规则"这类揣测动机的说法；
3. **量化词**——"经常""总是""从来"，一次观察就被写成习惯。

另外私聊内容也不该进群聊用的印象库。这个补丁在两处整理提示词里各加一行约束
（全局印象、单群印象各一处），只改提示词，不动数据结构与写入逻辑。

### 打补丁

```bash
cd /mnt/data/qq-agent/app
patch -p1 < patches/patch-memory-guard-2026-10-15.diff
./.runtime/node-v22.23.2-linux-x64/bin/node --check src/core/orchestrator.js
systemctl --user restart qq-agent-linux
```

### 验证

1. `patch -p1 --dry-run -R < patch-memory-guard-2026-10-15.diff` 反向 dry-run 通过。
2. 重启后新整理的印象条目里不再出现原文粗口、也不带"经常/总是"这类词。

---

## patch-text-nudge-2026-10-16.diff

### 为什么需要它

模型偶尔会把要说的话写成**普通文本**、而一次 `send_message` 都不调。按上游设计，
普通文本只是"本次运行的内部输出"，不会发到 QQ，于是那轮就安静地结束了——
控制台记成"本轮未回复"，会话详情里能看到一段"模型文本（不发送）"。

改前量化过：最近几天 **79 次真实会话触发里有 9 次（约 11%）** 是这么掉字的，
掉的内容有整句正常回复、也有"早上好"这种短句。而在"控制台主动唤醒"这类例行运行里，
模型写内部判断（"没有新消息，安静结束"）却不调工具，其实是**正常形态**，不是故障。

### 这个补丁做什么

不替它发——程序自动把文本发出去的话，"（这轮不接）"这类内部备注也会进群。
补丁只在"这一轮没调任何工具、也一条都没发出去"时，补一条合成 user 消息提醒它：

> 你刚才把要说的话写成了普通文本，没有调用 `send_message`——它一个字都不会到达任何人。
> 如果那是你想说的，就用 `send_message` 发出去；如果确实不打算说话，直接结束，不用解释。

细节：

- **一次运行最多提醒一次**，提醒后仍只写文本就照旧安静结束（不会循环）；
- 本轮已经发过消息的运行不提醒（"边调工具边写草稿"是正常形态）；
- 文本明显是**内部备注/判断草稿**时不提醒（开头是括号/书名号，或含"安静、冷场、
  不发言、新消息、草稿、本次唤醒、本轮、判断：、思考：、没人说话、按作息"等词），
  免得每天几十次例行唤醒白烧一轮；
- 那条合成消息只进本轮请求，**不进生命周期交接的转录**（`providerTranscriptDelta` 里按引用剔除）。

过滤规则是拿最近几天 310 条"没走工具的输出"回放挑出来的：收紧后能拦下约六成误报，
同时保住全部 9 条真实掉字。按这个比例约每天 7 次会提醒（每次多一轮调用，量级 ¥0.003）。

### 打补丁

```bash
cd /mnt/data/qq-agent/app
patch -p1 < patches/patch-text-nudge-2026-10-16.diff
./.runtime/node-v22.23.2-linux-x64/bin/node --check src/core/orchestrator.js
systemctl --user restart qq-agent-linux
```

### 验证

1. `patch -p1 --dry-run -R < patch-text-nudge-2026-10-16.diff` 反向 dry-run 通过。
2. 部署后跑一次"回放"：用文件里的 `looksLikeSpeechText` 去过一遍最近的会话样本，
   确认该拦的备注被拦住、该放的发言不在拦截里。
3. 线上观察：触发时 journal 里会出现 `本轮只写了文本没调工具，已提醒一次（N 字）`，
   会话 JSON 里相应运行带 `textNudged: true`。

---

## patch-admin-notify-mail / patch-budget-mail / patch-incident-ui-text（2026-10-16）

### 为什么需要它

程序给管理员的通知以前一律**私聊发 QQ**（`incident-pilot` 的异常告警、更新提示、好友申请、
好友候选、审批回执）。那条会落进"和角色的私聊"里：既出戏，又会被角色自己的上下文读到、
甚至接茬。用户明确要求"这些也转邮件"。

### 三个补丁各改什么

| 补丁 | 作用 |
|---|---|
| `patch-admin-notify-mail` | `sendIdentityAdminText` 不再发 QQ，改为把通知排进 `data/mail-outbox.json`（最多 50 条）；新增 `incidentPilot.qqNotify` 开关（默认关，关着时"可发"算真、事件标记已通知）；更新通知不再依赖 OneBot 连接；好友申请/候选的文案改成"审批入口在控制台"（邮件里回复不会被执行） |
| `patch-budget-mail` | 每日花费超限不再私聊管理员，改写 `data/budget-alert.json`；顺带删掉因此不再使用的 `readOwnerUin` 引入 |
| `patch-incident-ui-text` | 控制台「异常」页三处文案：「告警管理员 QQ」→「告警收件人（邮件）」、「OneBot 恢复后发送」→「排队等邮件（每 10 分钟一发）」、警告级勾选说明 |

### 配套（脚本侧，不是补丁）

`scripts/usage-daily.mjs`（服务器上同一份）负责把队列发出去：每次跑读 `mail-outbox.json`
逐条发信、发完清掉；失败留队重试、连续 6 次放弃并记错误。另外：

- 立刻发的等级从"只有 `severe`"改成 `critical,severe,error`，等级标签按真实等级显示
- `incidentPilot.notifyWarnings` 现在决定要不要把警告级也单发一封（以前只管 QQ 通道）
- 投递失败会把 `lastFailureAt/lastFailureError` 写进 `data/incident-notify.json`，
  下一天的日报里带一行 ⚠

### 验证

1. `patch -p1 --dry-run -R < 每个补丁` 反向 dry-run 通过（`apply-patches.sh` 会用这个判"已生效"）。
2. 往 `data/mail-outbox.json` 放一条测试通知 → 跑 `usage-daily.mjs` → 邮件收到、队列清空；
   同时确认 QQ 私聊里没有该消息（`messages` 表按关键词查询应为 0 条）。
3. 临时写 `data/budget-alert.json` + 一份模拟的 `lastFailureAt` → `--dry` 能看到
   "四、需要你注意"两行。

## 已退役：sticker-collect-criteria（2026-10-10 随 v0.8.4 退役）

**这条补丁已退役**：它要的能力上游 v0.8.4 已自带（[PR #31](https://github.com/sakurawwwxh/qq-agent-plus/pull/31)，
合并提交 `1f8bad2a`），`patches/` 下的 `.diff` 文件已删除。本部署改成**配置驱动**：

- 配置项 `sticker.collectCriteria`：只写"收什么 / 不收什么"，身份那句（你是「谁」、正在看谁的图）
  由代码补在前面；上限 2000 字；运行期读取，改完即时生效、不用重启。
- 改法：控制台接口 `POST /api/config` 写 `{"sticker":{"collectCriteria":"……"}}`（v0.8.5 起也可在控制台「设置 → 聊天设置」直接编辑）；**清空即回到上游默认**
  （上游默认是原版那套"带字的梗图也算值得收"，本部署必须填）。

**当时为什么要做**（留作记录）：上游默认标准只写了「以后聊天时用得上吗」，并把"带字的梗图、
抽象搞笑图"一律算作值得收；而不同角色的取向不同——本部署是二次元角色，希望库里以 ACG／干净卡通
为主，不收社交平台网红卡通形象梗图、真人/三次元梗图、带水印或整屏截图的图。以前想调只能改源码，
而升级会整树替换 `src/`，改一次丢一次（v0.8.1 → v0.8.3 实测被覆盖、还要处理行号偏移）。

### 本部署的判定标准（配置里的当前值，566 字）

```
判断标准两条，都满足才收。
① 以后聊天时用得上吗——能拿来表达情绪、吐槽、怼人、接梗的。
② 跟你的形象搭不搭——你是个二次元角色（大学生、粉发、追星、打音游），表情库要有你自己的味道。
值得收：ACG／动漫画风的角色图、动漫梗图、番剧或动画截图（带字幕、台词、梗的也算），可爱或干净的卡通形象，抽象但不出戏的搞笑图，猫猫狗狗等可爱动物。
不值得收：真人或朋友的生活照、随手拍、自拍；跟聊天无关的截图（新闻、游戏、聊天记录、网页界面）、二维码、证件、广告、纯风景照；跟你形象不搭的社交平台网红卡通形象梗图、真人/三次元梗图、带平台或账号水印的图、连界面/评论区一并截进来的整屏截图；擦边、恶心、重口味的图（你是正经大学生，别往库里放）。
拿不准就问自己：以后聊天真会用上吗，而且发出去像个二次元大学生会发的东西吗——两条都过才收，否则不收。
写备注要写全三样：① 是谁——认得出来就写角色名或形象（例：粉发少女、蓝胖卡通人），认不出就写"某某样的角色"，别硬猜作品名；② 在干什么——动作、表情、有没有配字；有配字就把配字原样带上（例：配字"切换忧郁模式"）；③ 适合什么时候用（例：适合吐槽摆烂装委屈）。上限 40 字，宁可多写几个字也要把一句话写完，别断在半句。例：「蓝胖卡通人挂两条泪配字切换忧郁模式，适合吐槽或摆烂装委屈」
```

> 备注上限 40 字要靠 [patch-sticker-note-40-2026-10-14.diff](patch-sticker-note-40-2026-10-14.diff)；只改配置的话上限仍是 24。

### 效果实测

| 图 | 判定 | 理由（模型原话） |
|---|---|---|
| 二次元画风可爱表情（粉发形象） | **收下** | "二次元画风可爱表情，粉发形象贴合，聊天常用" |
| 番剧截图带台词 | **收下** | "番剧截图带台词，画风干净，心虚偷看梗聊天常用" |
| 新闻 / 仓库页面截图 | **不收** | "GitHub 仓库页面截图，非表情图，聊天用不上" |
| 真人三次元梗图 | **不收** | "真人三次元梗图，跟二次元高中生形象不搭" |

（前两行与后两行分别取自补丁版与 v0.8.4 升级后的复测；配置路径另用"一律不收 + TEST-REJECT"
的临时标准单独验过一次。）

判定是**提示词级的**，不是硬过滤器——模型偶尔仍可能收错；想确认它是否按自定义标准在拒，
看日志里的 `[sticker] 判断：… —— <理由>` 就行。
