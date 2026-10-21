# 声明、第三方权利与致谢

最后更新：2026-10-15

## 一、本仓库的性质

本仓库是个人自用的部署记录与运维文档，用于记载在自有服务器上部署 QQ 群聊机器人的
过程、配置与运维经验，同时保存配套的角色扮演人设文本。

本仓库与腾讯、阿里云、DeepSeek、Bushiroad 及其他所涉公司**均无关联**，不代表其
官方立场，也未获得其授权或许可。仓库内容仅代表个人实践，不构成对任何产品或服务的
官方说明或技术担保。

## 二、第三方项目与致谢

本仓库内容基于以下项目与服务整理，感谢作者与维护者的工作：

| 项目 / 服务 | 用途 | 许可与权利 |
|---|---|---|
| [qq-agent-plus](https://github.com/sakurawwwxh/qq-agent-plus) | 机器人主体程序 | MIT License，版权归原作者 |
| [SnowLuma](https://github.com/SnowLuma/SnowLuma) | OneBot 协议端框架 | 遵循项目自身声明的许可 |
| [OneBot v11](https://github.com/botuniverse/onebot-11) | 机器人对接协议规范 | 遵循项目自身声明的许可 |
| [DeepSeek](https://platform.deepseek.com) | 对话模型服务 | 服务条款归深度求索公司 |
| [博查 Bocha](https://bochaai.com/) | 联网搜索（`web_search` 的后端） | 服务条款归其运营方 |
| [硅基流动 SiliconFlow](https://siliconflow.cn/) | 语音转文字（`FunAudioLLM/SenseVoiceSmall`）与图片生成（`Tongyi-MAI/Z-Image-Turbo`） | 服务条款归其运营方；模型遵循各自作者声明的许可 |
| [阿里云轻量应用服务器](https://cn.aliyun.com/product/swas) | 运行环境 | 服务条款归阿里云 |
| [Node.js](https://nodejs.org/) | 机器人运行时 | MIT 许可，版权归 OpenJS Foundation 及贡献者 |
| [Docker](https://www.docker.com/) | 协议端容器运行时 | 各组件遵循自身许可，商标归 Docker, Inc. |
| [Ubuntu](https://ubuntu.com/) | 服务器操作系统 | 系统组件遵循各自开源许可，商标归 Canonical |
| [FFmpeg](https://ffmpeg.org/) | 语音 / 音频转码（"听语音"依赖它） | LGPL 或 GPL，取决于构建选项 |
| [GPT-SoVITS](https://github.com/RVC-Boss/GPT-SoVITS) | 语音合成框架（自建 TTS 用它的 API 推理） | 遵循项目自身声明的许可 |
| 千早爱音语音模型（GPT-SoVITS） | 语音合成（可选） | **CC-BY-NC 4.0**，作者 **花咲川楽奈**；禁止商用、不得二次配布 |

此外：

- 角色「千早爱音」出自《[BanG Dream! It's MyGO!!!!!](https://anime.bang-dream.com/mygo/)》
  （[系列官网](https://bang-dream.com/)，[官方游戏《BanG Dream! Our Notes》官网](https://bdon.biligames.com/)），
  著作权与商标权归 [Bushiroad](https://bushiroad.com/) 及相关权利人所有。
- 设定资料参考自 [萌娘百科](https://zh.moegirl.org.cn/%E5%8D%83%E6%97%A9%E7%88%B1%E9%9F%B3)、
  [百度百科](https://baike.baidu.com/item/%E5%8D%83%E6%97%A9%E7%88%B1%E9%9F%B3) 对应条目，仅用于核对角色设定。
- 语音模型「`MyGO_千早爱音_v2pp`」（GPT-SoVITS v2ProPlus）由 **花咲川楽奈**
  （Bilibili 主页 <https://space.bilibili.com/40008084>，交流群 **339588591**）训练并公开分享，
  采用 [CC-BY-NC 4.0](https://creativecommons.org/licenses/by-nc/4.0/deed.zh-hans) 协议；
  训练数据来源为 [Bestdori!](https://bestdori.com/) 与 [ウマ娘WIKI](https://wiki.biligame.com)。
  按作者要求完整标注上述署名：该模型**禁止任何商业用途、不得二次配布**。
  **本仓库不含该模型权重**，只记录来源、参数与配置方式（见 [persona/千早爱音-语音模型.md](persona/千早爱音-语音模型.md)）。
  形象与语音的权利同样归 BUSHIROAD / Cygames / Key / TOEI ANIMATION，仅限二次创作。
- 部署流程参考了小黑盒社区的公开教程《在自己 QQ 群里养一个 AI 群友：qq-agent-plus
  保姆级部署教程》（作者 bbbgd，[原文链接](https://www.xiaoheihe.cn/app/bbs/link/43197277b4fa)），在此致谢。

本仓库**不包含**上述任何项目的源代码、官方素材或商业资源，仅包含个人撰写的过程记录、
运维笔记与人设文本。人设文本属于个人非商业性质的二次创作，不用于销售、推广或其他
营利场景。相关权利人如认为内容不当，请按 [SECURITY.md](SECURITY.md) 中列出的方式
联系仓库所有者（涉及敏感信息时请使用其中的私密报告通道），我们会及时处理。

**许可范围**：本仓库采用的 MIT 许可（全文见 [LICENSE](LICENSE)）仅覆盖仓库所有者
自行创作的内容（部署记录、运维文档、人设文本等）。上表中的第三方项目、商标与角色
版权不在该许可范围内，其权利归各自所有者。

## 三、使用环境与合规提示

1. **平台条款**：部署与使用本仓库所述方案时，需自行遵守腾讯 QQ 用户协议、阿里云
   服务条款，以及所使用模型服务的条款。本仓库不提供任何规避平台规则的方法。
   本仓库不鼓励、也不指导他人违反任何平台条款，所述内容仅为个人使用记录。
2. **账号风险**：使用第三方协议端登录 QQ 属于平台用户协议允许范围之外的行为，
   可能被平台判定为异常并限制账号功能。本仓库所有者的账号即曾两次被限制功能。
   此类风险由使用者自行承担，建议使用独立的小号，不要使用主账号。
3. **内容责任**：机器人发送的内容由部署者负责。不得用于传播违法违规信息，不得涉及
   违反法律法规、平台规则、公序良俗，以及诈骗引流、侵犯他人隐私等内容。
4. **用途限制**：本仓库内容仅供个人学习与自用，不得用于违反所在地法律法规的场景。

## 四、隐私与敏感信息

- 仓库中的服务器地址、账号号码、群号、实例名、本机路径等信息已替换为占位符，
  例如 `<SERVER_IP>`、`<BOT_QQ>`。真实值保存在本地未纳入版本控制的文件中，
  不随仓库分发。
- 仓库中不含密钥、令牌、密码或任何形式的凭证，也不含服务器登录凭证。
- 仓库中不含真实聊天记录、群成员昵称或任何可识别到具体个人的信息。
- 若发现仓库中存在遗漏的敏感信息，请按 SECURITY.md 的方式告知，我们会尽快处理。

## 五、免责声明

本仓库内容按「现状」提供，不附带任何明示或默示的担保，包括但不限于对适用性或
特定用途适用性的担保。因使用或无法使用本仓库内容而产生的任何直接或间接损失
（包括但不限于账号被限制或封禁、数据丢失、服务中断、费用支出），仓库所有者
不承担责任。

使用者应在充分了解相关风险与平台条款后自行决定是否采用本仓库所述方案。
