<div align="center">

# QQ Group Chat Bot: Deployment and Operations Notes

Deployment and operations notes for a QQ group chat bot on Linux: runtime environment,
operations manual, troubleshooting notes and persona text.

[![License](https://img.shields.io/badge/license-MIT-3da639.svg)](LICENSE)
[![qq-agent-plus](https://img.shields.io/badge/qq--agent--plus-v0.8.4-blue)](https://github.com/sakurawwwxh/qq-agent-plus)
[![Platform](https://img.shields.io/badge/platform-Linux-0b5fff?logo=linux&logoColor=white)](#runtime-environment)
[![Protocol](https://img.shields.io/badge/protocol-OneBot%20v11-12b7f5)](https://github.com/botuniverse/onebot-11)
[![LLM](https://img.shields.io/badge/LLM-DeepSeek-6b4fbb)](https://platform.deepseek.com)
[![Last commit](https://img.shields.io/github/last-commit/muhan5102/qq-agent-deployment-records?logo=git&logoColor=white)](https://github.com/muhan5102/qq-agent-deployment-records/commits/main)
[![Stars](https://img.shields.io/github/stars/muhan5102/qq-agent-deployment-records?label=stars&logo=github)](https://github.com/muhan5102/qq-agent-deployment-records/stargazers)

[简体中文](README.md) ｜ **English**

</div>

This repository documents how a QQ group chat bot was deployed on an Alibaba Cloud
lightweight server. It covers the runtime environment, an operations manual,
troubleshooting notes, and the roleplay persona text used by the bot.

The setup consists of the open-source project
[qq-agent-plus](https://github.com/sakurawwwxh/qq-agent-plus) as the bot itself,
a SnowLuma container providing the OneBot protocol side, and DeepSeek as the model.

**What this repository is**: personal notes only, not affiliated with any company or
project mentioned here. Issues, corrections and suggestions are welcome. See
[NOTICE.md](NOTICE.md) for third-party rights and acknowledgements, and
[LICENSE](LICENSE) for the licensing terms.

Deployed: 2026-09-21　|　Last updated: 2026-10-03

## Sensitive Information

Server addresses, account numbers, group IDs and local paths in this repository have
**all been replaced with placeholders**, such as `<SERVER_IP>` and `<BOT_QQ>`.
The real values are kept in a local file that is not tracked by version control
(`LOCAL-NOTES.md`).

The repository contains no keys, tokens, passwords or credentials, and no real chat
logs or group member information. The scripts under `scripts/` and `tools/` contain no
accounts, addresses or tokens either — they read credentials from files on the server
at runtime. See the "Privacy" section of NOTICE.md for details.

When reading this repository, replace any placeholder in a command (for example
`ssh admin@<SERVER_IP>`) with the real value before running it.

## Repository Layout

### Documentation

| File | Description |
|---|---|
| [README.md](README.md) | Overview, runtime environment, current status and navigation (Chinese) |
| [README.en.md](README.en.md) | English version of this document |
| [整体流程.md](整体流程.md) | End-to-end flow, from initial deployment to daily operations |
| [QQ机器人-运维速查.md](QQ机器人-运维速查.md) | Operations manual: common commands and troubleshooting |
| [踩坑总结.md](踩坑总结.md) | Problems encountered during deployment and tuning, with causes and fixes |
| [CHANGELOG.md](CHANGELOG.md) | Change log: dated record of documentation and server-side changes |

### Persona

| File | Description |
|---|---|
| [千早爱音-角色卡.md](千早爱音-角色卡.md) | The persona text itself |
| [爱音-附加规则.md](爱音-附加规则.md) | Additional constraints for the persona; takes precedence over the persona file |

### Notices and Licensing

| File | Description |
|---|---|
| [NOTICE.md](NOTICE.md) | Repository nature, third-party rights and acknowledgements, compliance notes, privacy and disclaimer |
| [SECURITY.md](SECURITY.md) | Applicable versions, the endpoints this deployment exposes by default, and how to report security issues |
| [CONTRIBUTING.md](CONTRIBUTING.md) | How to give feedback or contribute, plus the repository owner's own commit conventions |
| [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md) | Code of conduct |
| [LICENSE](LICENSE) | MIT, covering only content created for this repository |

### Scripts and Tools

| Path | Description |
|---|---|
| [scripts/ops.sh](scripts/ops.sh) | Wrapper for common server operations: status, logs, login state, ports, resources, backing up and restoring configuration |
| [scripts/verify-deployment.sh](scripts/verify-deployment.sh) | Read-only deployment self-check with pass / warn / fail counts |
| [scripts/README.md](scripts/README.md) | Script usage and safety boundaries |
| [tools/console-tunnel.ps1](tools/console-tunnel.ps1) | Access the console from a local machine over an SSH tunnel, so port 3210 need not be public |
| [patches/](patches/) | Server-side code patches: small changes to the upstream app, with purpose and apply/rollback steps |

### Repository Configuration

| File | Description |
|---|---|
| [.gitignore](.gitignore) | Excludes local real values, SSH private keys and temporary files |
| [.gitattributes](.gitattributes) | Normalises line endings (stored as LF) |
| [.github/](.github/) | Platform configuration: issue form templates (problem / suggestion) and a PR template |

### Local Only, Not Under Version Control

| Path | Description |
|---|---|
| `LOCAL-NOTES.md` | Table of real values: server address, account numbers, group ID, local paths |
| `.deploy/` | SSH private key and known_hosts used to reach the server |
| `work/` | Temporary files and local notes produced while debugging |

Server addresses, account numbers, keys and runtime data are all excluded from version
control; only placeholder versions are published here.

## Repository Conventions

The rules below constrain **the repository owner's own commits**, so that authorship is
traceable, content stays free of sensitive information, and history can be verified:

- Commit identity is always `muhan5102 <258375253+muhan5102@users.noreply.github.com>`,
  commits are SSH-signed, and the hosting platform shows them as Verified.
- Change process: edit locally → replace real values with placeholders → scan for
  sensitive strings before committing → commit and push.
- Push channel: use `git push` directly when it works; when it does not, recreate the
  commit through the GitHub REST API, preserving author, timestamp and message.
- This repository records personal practice only. It is not official documentation and
  makes no technical guarantee about any product or service.

Other people's questions, suggestions and changes are **not bound by those rules**:
corrections and improvement ideas can go to Issues, general discussion to Discussions,
and changes may be submitted in your own preferred style. All interaction should follow
[CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md): cite the specific file, version or
reproduction steps, stay on topic and keep it civil. Repeated spam, emotional attacks
or unrelated content may be closed. See [CONTRIBUTING.md](CONTRIBUTING.md) for how to
contribute and what to avoid, and [SECURITY.md](SECURITY.md) for reporting security or
sensitive-information problems.

## Runtime Environment

| Item | Description |
|---|---|
| Server | Alibaba Cloud lightweight server (instance name `<INSTANCE_NAME>`), 2 vCPU / 2 GB RAM / 40 GB disk |
| OS | Ubuntu 22.04 LTS |
| Runtime | Docker (protocol-side container) + systemd user service (the bot itself) |
| Model | DeepSeek, OpenAI-compatible API |
| Deployment directory | `/mnt/data/qq-agent` (`app/` program, `data/` data, `snowluma/` protocol side) |
| Exposed ports | Console 3210, protocol panel 5099, QR login 6081 (disabled by default) |

Concrete values such as the server address are kept in the local `LOCAL-NOTES.md`.

## Architecture

```
QQ groups  ⇄  SnowLuma container (OneBot protocol side)
                    ↕  WebSocket 127.0.0.1:3001
              QQ Agent (systemd user service)
                    ↓
              DeepSeek chat model
```

- **Protocol side**: Docker container `qq-agent-snowluma`, handling communication with
  QQ and exposing the OneBot API to the bot. That API binds to localhost only.
- **Bot**: systemd user service `qq-agent-linux`, which receives messages, decides
  whether to take part, calls the model, and sends replies as separate messages.
- **Console**: web interface on port 3210 for editing configuration, reading session
  records and checking usage statistics.
- **Model**: an OpenAI-compatible HTTP API.

Deployment order and the responsibilities of each layer are described in section 2 of
[整体流程.md](整体流程.md).

## Current Status

As of 2026-10-09 the bot has been **reconnected and is in an observe-only period**:

| Item | Status |
|---|---|
| Program version | `qq-agent-plus` v0.8.4 (upgraded on 2026-10-10) |
| Protocol client | `motricseven7/snowluma:v1.14.22` (upgraded on 2026-10-09) |
| Bot account | `<BOT_QQ>`, registered on 2026-09-21 |
| Platform restrictions | Function-limited twice (2026-09-22 and 09-23); both restored via identity verification |
| Bot service | Running (`active`), runtime mode `observe` |
| Protocol container | Running, **logged in** (QR scan on 2026-10-09) |
| Next step | Observe for 1–2 days first, then decide whether to re-enable passive replies (see section 6.2 of the operations manual) |

Logging into QQ with a third-party protocol client may be treated as abnormal by the
platform and can lead to account restrictions. That risk is borne by the person running
it. See the "Risk and compliance" section of NOTICE.md.

## Reconnect / Re-scan Procedure

> ⚠️ Only needed when the **login state is lost**. Do not run the container restart in step 1
> as part of normal operation — it logs the account out and a new QR scan becomes mandatory.

```bash
# 1. Start the bot service and the protocol container
systemctl --user start qq-agent-linux
sudo docker restart qq-agent-snowluma && sleep 20

# 2. Temporarily open the QR login port, then visit http://<SERVER_IP>:6081 in a
#    browser and scan the code; close the port afterwards
#    noVNC password: sudo grep noVNC /mnt/data/qq-agent/deployment-access.txt

# 3. Verify the login state; "retcode":0 means everything is fine
T=$(sudo awk -F': ' '/OneBot token:/{print $2}' /mnt/data/qq-agent/deployment-access.txt)
curl -sS -m 10 -H "authorization: Bearer $T" -H 'content-type: application/json' \
  -d '{}' http://127.0.0.1:3000/get_login_info; echo
```

For intermediate checks and error handling, see section 6 of the
[operations manual](QQ机器人-运维速查.md).

## Configuration Summary

| Item | Value |
|---|---|
| Model and temperature | `deepseek-chat`, temperature 1.3 |
| Persona | Role card ≈ 5.6k characters, additional rules ≈ 1.4k characters |
| Behaviour profile / participation | `legacy` (original group-member style) / medium |
| Response probability | 60% (always replies when mentioned) |
| Message pacing | Thinking delay 15–20 s, 2.5–7 s between split messages, usually 1 message per turn, at most 2 |
| Send throttle | 15 messages/minute and 180 messages/hour (a guard against runaway output; normal chat never reaches it) |
| Autonomous pacing `pacing` | Enabled (group chats: wakes about every 6 minutes, minimum 3; mentions are still handled immediately) |
| Conversation mode | `threaded` (participant continuation) |
| Time control | Enabled (`always`); night-time behaviour is constrained by the persona rules |
| Daily moments / Qzone interactions | **Disabled** |
| Self-initiated talk | Cold-start topics off; follow-up off; self-scheduled wake-up kept |
| Member recognition | Impression lines carry the QQ number (local server-side patch; see section 3 of the operations manual) |
| Sticker auto-collection | Enabled (at most 10 per hour); collection criteria customised via `sticker.collectCriteria` (see [patches/README.md](patches/README.md)) |
| Allowlist | Group `<GROUP_ID>` (one); private chats: the administrator `<ADMIN_QQ>` and one test account (two) |

## Operational Cautions

The following actions invalidate the QQ login state and require scanning the QR code again:

1. Restarting the protocol container (`docker restart qq-agent-snowluma`)
2. Restarting the server

Other cautions:

- Close port 6081 as soon as the QR login is done; do not leave it open
- Do not enable auto-update: upgrading restarts the service
- Do not manually delete dpkg lock files
- Do not shut down the server or stop the instance
- Do not casually clean up SSH access credentials

The full list is in section 7 of the operations manual.

## Third-Party Components and Acknowledgements

This repository is based on the following projects and services. Thanks to their
authors and maintainers:

- [qq-agent-plus](https://github.com/sakurawwwxh/qq-agent-plus): the bot itself, MIT licensed
- [SnowLuma](https://github.com/SnowLuma/SnowLuma): OneBot protocol framework; this
  deployment uses the Docker Hub image `motricseven7/snowluma` (that string is a Docker
  Hub image path — a different platform from the GitHub repository `SnowLuma/SnowLuma`)
- [OneBot v11 specification](https://github.com/botuniverse/onebot-11): the protocol used
- [DeepSeek](https://platform.deepseek.com): chat model service
- [Alibaba Cloud](https://cn.aliyun.com/): server and network environment
- [Node.js](https://nodejs.org/): runtime for the bot
- [Docker](https://www.docker.com/): container runtime for the protocol side
- [Ubuntu](https://ubuntu.com/): server operating system (22.04 LTS)
- The character "Chihaya Anon" is from
  *[BanG Dream! It's MyGO!!!!!](https://anime.bang-dream.com/mygo/)*
  ([franchise site](https://bang-dream.com/),
  [official site of the game *BanG Dream! Our Notes*](https://bdon.biligames.com/));
  copyright belongs to [Bushiroad](https://en.bushiroad.com/) and related rights holders
- Character reference material: [Moegirlpedia](https://zh.moegirl.org.cn/%E5%8D%83%E6%97%A9%E7%88%B1%E9%9F%B3)
  and [Baidu Baike](https://baike.baidu.com/item/%E5%8D%83%E6%97%A9%E7%88%B1%E9%9F%B3) entries
- The deployment walkthrough referenced a public Xiaoheihe community tutorial,
  《在自己QQ群里养一个AI群友：qq-agent-plus 保姆级部署教程》 (author bbbgd,
  [original article](https://www.xiaoheihe.cn/app/bbs/link/43197277b4fa))

This repository records personal practice only and contains no source code or official
assets from the projects above. See [NOTICE.md](NOTICE.md) for rights and disclaimers.

## License

Content created by the repository owner (deployment notes, operations documentation,
persona text, and so on) is released under the MIT license; see [LICENSE](LICENSE).
Third-party projects, trademarks and character copyrights belong to their respective owners.
