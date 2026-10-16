#!/usr/bin/env node
/**
 * 每日用量小结：把「昨天机器人花了多少 + DeepSeek 余额」合成一封邮件发给管理员。
 *
 * 为什么不用 QQ 私聊：机器人账号发的消息会落在"和角色的私聊"里，既出戏、又会被角色
 * 自己的上下文读到并接茬（2026-10-16 实测反馈）。所以改成发邮件，聊天里干干净净。
 * 凭据放 /mnt/data/qq-agent/mail-cred.json（600，不进仓库）。
 *
 * 为什么需要它：各家平台都没有"查用量"接口（DeepSeek 只有余额接口，硅基流动的老接口已废弃、
 * 博查没有），而机器人自己每次都记着 token 用量（程序写的 `data/usage-today.json`）。
 * 但那个台账**只留今天、每天覆盖**，所以要靠本脚本定期快照出一份按天历史。
 *
 * 用法（两种都跑在服务器上，由 systemd user timer 每 10 分钟调一次）：
 *   node usage-daily.mjs            # 快照今天的台账；到点就发小结
 *   node usage-daily.mjs --dry      # 只打印，不发送、不写文件
 *
 * 口径说明：花费来自程序自己的估算（内置官方价 × token，含缓存价与高峰价），
 * 与控制台「用量」页一致；余额是 DeepSeek 接口给的真实数字。两者不是一回事，消息里分开写。
 */

import fs from 'node:fs';
import path from 'node:path';
import tls from 'node:tls';

const DATA_DIR = process.env.QQ_AGENT_DATA_DIR || '/mnt/data/qq-agent/data';
const TODAY_FILE = path.join(DATA_DIR, 'usage-today.json');
const HISTORY_FILE = path.join(DATA_DIR, 'usage-daily.json');
const BALANCE_FILE = path.join(DATA_DIR, 'balance-daily.json');
// 邮件凭据放在服务器上、不进仓库（600 权限）。格式：
//   { "host": "smtp.qq.com", "port": 465, "user": "xxx@qq.com", "pass": "<SMTP授权码>", "to": "xxx@qq.com" }
const MAIL_FILE = process.env.QQ_AGENT_MAIL_CRED || '/mnt/data/qq-agent/mail-cred.json';
// 告警转发的状态（已转发过哪些、上次看到哪），以及"只转发这么久的"下限
const INCIDENT_STATE_FILE = path.join(DATA_DIR, 'incident-notify.json');
// 程序侧排队的"管理员通知"（更新提示 / 好友申请 / 好友候选 / 审批回执）由本脚本发信
const MAIL_OUTBOX_FILE = path.join(DATA_DIR, 'mail-outbox.json');
const MAIL_OUTBOX_FAIL_MAX = 6;
// 当日预算超限状态（程序写的，日报里带一行）
const BUDGET_ALERT_FILE = path.join(DATA_DIR, 'budget-alert.json');
const INCIDENT_MAX_AGE_MS = 24 * 3600 * 1000;
// 只有这些级别**立刻**发邮件；其余级别（默认只剩 warning）攒进每天 9:00 的日报里一起看。
// 用户 2026-10-16 定：严重实时、警告日汇总。
// 立刻发的等级。环境变量优先；否则按控制台那个「警告级也通知」勾选决定要不要带上 warning
// —— 这个勾选以前只管 QQ 私聊告警，QQ 通道关掉后改由这里生效（勾了就连警告也单发一封）。
const INCIDENT_IMMEDIATE = new Set(
  String(process.env.QQ_AGENT_INCIDENT_IMMEDIATE
    || `critical,severe,error${(readJson(path.join(DATA_DIR, 'config.json'), {}) || {})?.incidentPilot?.notifyWarnings === true ? ',warning' : ''}`)
    .split(',').map((s) => s.trim()).filter(Boolean)
);
// 等级标签：程序里实际用到的是 critical / error / warning / info（以前只认 severe，
// 于是"错误"被误标成"警告"）。未知等级原样显示，不吞掉。
const SEVERITY_LABEL = { critical: '严重', severe: '严重', error: '错误', warning: '警告', info: '信息' };
const severityLabel = (v) => SEVERITY_LABEL[String(v || '')] || String(v || '未知');
const SEVERITY_STYLE = {
  critical: { bg: '#fef2f2', fg: '#b91c1c' },
  severe: { bg: '#fef2f2', fg: '#b91c1c' },
  error: { bg: '#fff1f2', fg: '#be123c' },
  warning: { bg: '#fff7ed', fg: '#b45309' },
  info: { bg: '#f3f4f6', fg: '#4b5563' }
};
function severityStyle(v) { return SEVERITY_STYLE[String(v || '')] || SEVERITY_STYLE.info; }
/** "严重 1 条 · 错误 2 条 · 警告 3 条"（按等级从重到轻） */
function severitySummary(list) {
  const counts = new Map();
  for (const i of list) {
    const k = String(i.severity || 'unknown');
    counts.set(k, (counts.get(k) || 0) + 1);
  }
  const order = ['critical', 'severe', 'error', 'warning', 'info'];
  const parts = [];
  for (const k of order) {
    if (!counts.has(k)) continue;
    parts.push(`${severityLabel(k)} ${counts.get(k)} 条`);
    counts.delete(k);
  }
  for (const [k, n] of counts) parts.push(`${severityLabel(k)} ${n} 条`);
  return parts.join(' · ');
}
const RETAIN_DAYS = 120;
const REPORT_HOUR = 9;          // 上海时间几点发小结
const TZ = 'Asia/Shanghai';
const DRY = process.argv.includes('--dry');

function readJson(file, fallback = null) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}
function writeJson(file, value) {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value));
  fs.renameSync(tmp, file);
  try { fs.chmodSync(file, 0o600); } catch { /* 忽略 */ }
}
function shanghaiParts(at = Date.now()) {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false
  });
  const p = Object.fromEntries(fmt.formatToParts(new Date(at)).map((x) => [x.type, x.value]));
  return {
    dayKey: `${p.year}-${p.month}-${p.day}`,
    hour: Number(p.hour),
    minute: Number(p.minute)
  };
}
function shiftDay(dayKey, deltaDays) {
  const [y, m, d] = dayKey.split('-').map(Number);
  const t = Date.UTC(y, m - 1, d) + deltaDays * 86400000;
  const dt = new Date(t);
  return `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, '0')}-${String(dt.getUTCDate()).padStart(2, '0')}`;
}
function num(v) { return Number.isFinite(Number(v)) ? Number(v) : 0; }
function yuan(v) { return `¥${num(v).toFixed(2)}`; }
function tok(v) {
  const n = num(v);
  if (n >= 1e6) return `${(n / 1e6).toFixed(2)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}k`;
  return String(Math.round(n));
}

/** 快照：把程序写的当天台账按 dayKey 存进历史（同一个 dayKey 覆盖，取最后见到的值）。 */
function snapshot(today) {
  const ledger = readJson(TODAY_FILE);
  if (!ledger?.dayKey) return null;
  const hist = readJson(HISTORY_FILE, {});
  hist[ledger.dayKey] = {
    promptTokens: num(ledger.promptTokens),
    completionTokens: num(ledger.completionTokens),
    totalTokens: num(ledger.totalTokens),
    cachedTokens: num(ledger.cachedTokens),
    runs: num(ledger.runs),
    webSearchCount: num(ledger.webSearchCount),
    estimatedYuan: num(ledger.estimatedYuan),
    unpricedRuns: num(ledger.unpricedRuns),
    snapAt: Date.now()
  };
  const keys = Object.keys(hist).sort();
  for (const k of keys.slice(0, Math.max(0, keys.length - RETAIN_DAYS))) delete hist[k];
  writeJson(HISTORY_FILE, hist);
  return ledger.dayKey;
}

async function deepseekBalance() {
  const cfg = readJson(path.join(DATA_DIR, 'config.json'), {}) || {};
  const providerId = cfg.api?.provider;
  const key = String((cfg.providerKeys || {})[providerId] || '').trim();
  if (!key) return null;
  try {
    const r = await fetch('https://api.deepseek.com/user/balance', { headers: { Authorization: `Bearer ${key}` } });
    if (!r.ok) return null;
    const j = await r.json();
    const cny = (j.balance_infos || []).find((b) => b.currency === 'CNY') || (j.balance_infos || [])[0];
    if (!cny) return null;
    return {
      total: num(cny.total_balance),
      granted: num(cny.granted_balance),
      topped: num(cny.topped_up_balance),
      available: j.is_available === true
    };
  } catch { return null; }
}

/**
 * 极简 SMTP 客户端（隐式 TLS，AUTH LOGIN）。
 *
 * 为什么不引 nodemailer：这一个功能不值得往部署目录塞第三方依赖（升级、审计都要跟着管）。
 * 这里只需要"发一封纯文本中文邮件"，手写够用，而且没有额外依赖。
 */
function smtpConnect(host, port) {
  return new Promise((resolve, reject) => {
    const socket = tls.connect({ host, port, servername: host }, () => resolve(socket));
    socket.setEncoding('utf8');
    socket.setTimeout(20000, () => { socket.destroy(new Error('SMTP 超时')); });
    socket.once('error', reject);
  });
}

async function sendMail({ subject, text, html = null }) {
  const cred = readJson(MAIL_FILE);
  if (!cred?.user || !cred?.pass) throw new Error(`没有邮件凭据（${MAIL_FILE}）`);
  const host = String(cred.host || 'smtp.qq.com');
  const port = Number(cred.port) || 465;
  const from = String(cred.user);
  const to = String(cred.to || cred.user);

  const socket = await smtpConnect(host, port);
  socket.setEncoding('utf8');

  // 读回复：SMTP 一个响应可能是多行 "250-..." 直到 "250 " 收尾
  let buf = '';
  let waiting = null;
  const queue = [];
  let cur = [];
  socket.on('data', (chunk) => {
    buf += chunk;
    let nl;
    while ((nl = buf.indexOf('\r\n')) >= 0) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 2);
      cur.push(line);
      if (/^\d{3} /.test(line)) {
        const resp = cur.join('\n');
        cur = [];
        if (waiting) { const w = waiting; waiting = null; w(resp); } else queue.push(resp);
      }
    }
  });
  const next = () => new Promise((res) => { if (queue.length) res(queue.shift()); else waiting = res; });
  const run = async (line) => {
    socket.write(`${line}\r\n`);
    const resp = await next();
    if (!/^[23]/.test(resp)) throw new Error(`SMTP ${line.split(' ')[0]} 被拒：${resp.split('\n')[0]}`);
    return resp;
  };

  try {
    const greeting = await next();
    if (!/^220/.test(greeting)) throw new Error(`SMTP 握手异常：${greeting}`);
    await run('EHLO usage-daily');
    await run('AUTH LOGIN');
    await run(Buffer.from(from, 'utf8').toString('base64'));
    await run(Buffer.from(String(cred.pass), 'utf8').toString('base64'));
    await run(`MAIL FROM:<${from}>`);
    await run(`RCPT TO:<${to}>`);
    await run('DATA');

    const encodeBody = (s) => Buffer.from(String(s), 'utf8').toString('base64').replace(/(.{76})/g, '$1\r\n');
    // 显示名只在含非 ASCII 时才用 RFC 2047 编码字；纯 ASCII 直接写明文
    // （"QQ-bot" 这种被编码成 =?UTF-8?B?UVEtYm90?= 时，部分邮箱会显示成乱码或原样码）
    const fromName = String(process.env.QQ_AGENT_MAIL_FROM_NAME || 'QQ-bot');
    const encName = /^[\x20-\x7E]+$/.test(fromName)
      ? fromName
      : `=?UTF-8?B?${Buffer.from(fromName, 'utf8').toString('base64')}?=`;
    const headers = [
      `From: ${encName} <${from}>`,
      `To: <${to}>`,
      `Subject: =?UTF-8?B?${Buffer.from(subject, 'utf8').toString('base64')}?=`,
      `Date: ${new Date().toUTCString()}`,
      'MIME-Version: 1.0'
    ];
    // 有 HTML 就发 multipart/alternative（纯文本在前、HTML 在后，客户端自己挑），
    // 没有就退回单段纯文本。正文一律 base64，避免 8-bit 与行长问题。
    let body;
    if (html) {
      const boundary = `anon-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
      body = [
        `Content-Type: multipart/alternative; boundary="${boundary}"`,
        '',
        `--${boundary}`,
        'Content-Type: text/plain; charset=UTF-8',
        'Content-Transfer-Encoding: base64',
        '',
        encodeBody(text),
        `--${boundary}`,
        'Content-Type: text/html; charset=UTF-8',
        'Content-Transfer-Encoding: base64',
        '',
        encodeBody(html),
        `--${boundary}--`,
        ''
      ].join('\r\n');
    } else {
      body = ['Content-Type: text/plain; charset=UTF-8', 'Content-Transfer-Encoding: base64', '', encodeBody(text), ''].join('\r\n');
    }
    // 行首单个 "." 在 SMTP 里表示正文结束，必须转义
    const stuffed = body.replace(/^\./gm, '..');
    socket.write(`${headers.join('\r\n')}\r\n${stuffed}\r\n.\r\n`);
    const done = await next();
    if (!/^250/.test(done)) throw new Error(`正文未被接受：${done.split('\n')[0]}`);
    await run('QUIT');
    return { to, fromName };
  } finally {
    try { socket.end(); } catch { /* 忽略 */ }
  }
}

/** 读控制台的异常列表（GET /api/incidents：只读，需要控制台 token）。 */
async function fetchIncidents() {
  const cfg = readJson(path.join(DATA_DIR, 'config.json'), {}) || {};
  const token = String(cfg.server?.token || '');
  const port = Number(cfg.server?.port) || 3210;
  const r = await fetch(`http://127.0.0.1:${port}/api/incidents?limit=50`, {
    headers: { 'x-console-token': token }
  });
  if (!r.ok) throw new Error(`/api/incidents HTTP ${r.status}`);
  const j = await r.json();
  return Array.isArray(j.incidents) ? j.incidents : [];
}

function describeIncident(i) {
  const at = new Date(Number(i.firstAt) || Date.now())
    .toLocaleString('zh-CN', { hour12: false, timeZone: TZ });
  const sev = severityLabel(i.severity);
  const merged = Number(i.count) > 1 ? `（同类合并 ${i.count} 次）` : '';
  const msg = String(i.message || '').replace(/\s+/g, ' ').slice(0, 400);
  return `【${sev}】${at}  ${i.source || ''}  ${i.chatKey || ''}${merged}\n${msg}`;
}

/**
 * 把控制台里"新出现"的告警转发到邮箱。
 *
 * 程序的告警本来是私聊发给管理员 QQ 的——那会落在"和角色的私聊"里出戏（2026-10-16 用户反馈）。
 * 这里用只读接口把新告警捞出来发邮件；不去动程序内部的发送逻辑，所以要不要关掉 QQ 那条
 * 是另一件事（需要打补丁）。
 */
async function forwardIncidents({ dry = false } = {}) {
  const list = await fetchIncidents();
  const ids = list.map((i) => String(i.id));
  const state = readJson(INCIDENT_STATE_FILE, null);
  if (!state) {
    // 首次运行只种标记：不然第一封邮件会把历史告警一次性全补发出来
    if (!dry) writeJson(INCIDENT_STATE_FILE, { seen: ids.slice(-300), lastAt: Date.now() });
    return { seeded: true, total: list.length, fresh: [] };
  }
  const seen = new Set(state.seen || []);
  const fresh = list.filter((i) =>
    !seen.has(String(i.id))
    && INCIDENT_IMMEDIATE.has(String(i.severity || ''))
    && (Date.now() - Number(i.firstAt || 0) < INCIDENT_MAX_AGE_MS));
  if (!dry && fresh.length) {
    const analysis = await analyzeIncidents(fresh);
    const body = fresh.map(describeIncident).join('\n\n────────\n\n');
    const worst = ['critical', 'severe', 'error', 'warning', 'info']
      .find((lv) => fresh.some((i) => String(i.severity) === lv)) || '';
    const worstLabel = severityLabel(worst);
    await sendMail({
      subject: `[QQ-bot][${worstLabel}] 异常 ${fresh.length} 条`,
      html: buildSevereHtml({ incidents: fresh, analysis }),
      text: [
        `[QQ-bot] ${worstLabel}异常提醒`,
        `${new Date().toLocaleString('zh-CN', { timeZone: TZ, hour12: false })}`,
        '',
        `检测到 ${fresh.length} 条需立即处理的异常（控制台「异常处理」页可以确认 / 解决）：`,
        '',
        body,
        analysis ? `\nAI 分析：\n${analysis}\n` : '',
        '附注：本邮件由服务器上的定时任务自动生成；严重 / 错误级立刻发，警告级不单独发、每天 9:00 汇总在运行日报里。'
      ].join('\n')
    });
  }
  if (!dry) {
    writeJson(INCIDENT_STATE_FILE, {
      seen: [...new Set([...(state.seen || []), ...ids])].slice(-300),
      lastAt: Date.now(),
      lastSentAt: fresh.length ? Date.now() : state.lastSentAt
    });
  }
  return { seeded: false, total: list.length, fresh };
}

/** 某一天（上海自然日）的时间范围，毫秒。 */
function dayRangeMs(dayKey) {
  const start = Date.parse(`${dayKey}T00:00:00+08:00`);
  return [start, start + 86400000];
}

/** 取某一天（上海自然日）发生的异常。 */
function dayIncidents(dayKey, incidents = []) {
  const [from, to] = dayRangeMs(dayKey);
  return incidents.filter((i) => {
    const t = Number(i.firstAt) || 0;
    return t >= from && t < to;
  });
}

function fmtTime(at) {
  return new Intl.DateTimeFormat('zh-CN', { timeZone: TZ, hour: '2-digit', minute: '2-digit', hour12: false })
    .format(new Date(Number(at) || Date.now()));
}

function renderIncidents(list, limit = 8) {
  const lines = [];
  for (const i of list.slice(0, limit)) {
    const sev = severityLabel(i.severity);
    const msg = String(i.message || '').replace(/\s+/g, ' ').slice(0, 90);
    lines.push(`  · ${fmtTime(i.firstAt)}  ${sev}  ${i.source || '-'}  ${msg}`);
  }
  if (list.length > limit) {
    lines.push(`  · 其余 ${list.length - limit} 条见控制台「异常处理」页`);
  }
  return lines;
}

/**
 * 让模型读一遍异常清单，给一段简短分析。
 *
 * 只在**确实有异常**时调用（平时零成本）。用机器人自己那套 provider 配置与 key，
 * temperature 压低、要求"不含糊、不编造"；失败就返回 null，日报照常发（分析只是锦上添花）。
 */
async function analyzeIncidents(list) {
  const cfg = readJson(path.join(DATA_DIR, 'config.json'), {}) || {};
  const provider = (cfg.providers || []).find((p) => String(p.id) === String(cfg.api?.provider)) || {};
  const key = String((cfg.providerKeys || {})[provider.id] || '');
  const base = String(provider.baseURL || '').replace(/\/+$/, '');
  if (!key || !base || !list.length) return null;
  const detail = list.slice(0, 12).map((i) => {
    const sev = severityLabel(i.severity);
    const msg = String(i.message || '').replace(/\s+/g, ' ').slice(0, 300);
    return `- [${sev}] ${fmtTime(i.firstAt)} 来源=${i.source || '-'} 次数=${i.count || 1}\n  ${msg}`;
  }).join('\n');
  const prompt = [
    '这是一台 QQ 机器人的运行日报。下面是它自检出的异常清单。',
    '请用中文写一段简短分析（200 字以内，纯文本、不要 Markdown 标题、不要分点符号），依次说清三件事：',
    '① 这些异常共同说明什么；② 要不要人工处理；③ 要处理的话，第一步做什么。',
    '要求：只依据清单里的信息判断，不要编造或联想清单之外的原因；如果都是无害的偶发问题，就直接说不用处理。',
    '注意：清单是当天发生的记录，到现在可能已经被处理过（例如某项依赖后来补装了）。',
    '所以只说"当时是什么问题、要不要人工确认"，不要断言它现在仍然存在。',
    '',
    detail
  ].join('\n');
  try {
    const r = await fetch(`${base}/chat/completions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: cfg.api?.model || 'deepseek-chat',
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.3,
        stream: false
      })
    });
    if (!r.ok) return null;
    const j = await r.json();
    const out = String(j.choices?.[0]?.message?.content || '').trim();
    return out ? out.slice(0, 600) : null;
  } catch { return null; }
}

function buildReport({ dayKey, hist, balance, prevBalance, incidents = [], analysis = null }) {
  const weekday = new Intl.DateTimeFormat('zh-CN', { timeZone: TZ, weekday: 'long' })
    .format(new Date(`${dayKey}T12:00:00+08:00`));
  const lines = [];
  lines.push('[QQ-bot] 运行日报');
  lines.push(`${dayKey}（${weekday}）`);
  lines.push('');

  lines.push('一、运行概览');
  if (!hist) {
    lines.push('  无台账快照（该时段机器人服务未运行）。');
  } else {
    const cacheRate = hist.promptTokens > 0 ? (hist.cachedTokens / hist.promptTokens) * 100 : 0;
    lines.push(`  运行次数：${hist.runs} 次`);
    lines.push(`  模型用量：${tok(hist.totalTokens)} tokens（缓存命中 ${cacheRate.toFixed(0)}%）`);
    lines.push(`  估算花费：${yuan(hist.estimatedYuan)}${hist.unpricedRuns > 0 ? `（另有 ${hist.unpricedRuns} 次未匹配到价目，未计入）` : ''}`);
    lines.push(`  联网搜索：${hist.webSearchCount} 次`);
  }
  lines.push('');

  lines.push('二、账号余额');
  if (balance) {
    lines.push(`  DeepSeek：${yuan(balance.total)}`);
    if (prevBalance != null) {
      const delta = balance.total - prevBalance;
      lines.push(`  较上次查询：${delta >= 0 ? '+' : '-'}${Math.abs(delta).toFixed(2)} 元`);
    }
  } else {
    lines.push('  本次查询失败（接口异常或未配置 key）。');
  }
  lines.push('');

  lines.push('三、异常');
  if (!incidents.length) {
    lines.push('  该时段无异常。');
  } else {
    lines.push(`  ${severitySummary(incidents)}。`);
    lines.push(...renderIncidents(incidents));
    if (analysis) {
      lines.push('');
      lines.push('  AI 分析：');
      for (const para of analysis.split('\n')) lines.push(`    ${para}`);
    }
  }
  lines.push('');

  // 四、需要你注意：只在"确实发生过"时才出现（平时日报不多这一节）
  const budgetLine = budgetAlertLine(dayKey);
  const failureLine = mailFailureLine();
  if (budgetLine || failureLine) {
    lines.push('四、需要你注意');
    if (budgetLine) lines.push(...budgetLine.split('\n'));
    if (failureLine) lines.push(failureLine);
    lines.push('');
  }

  lines.push('附注');
  lines.push('  · 花费按官方价与 token 用量估算，不是账单金额；余额为服务商接口返回的真实值。');
  lines.push('  · 本邮件由服务器上的定时任务自动生成。');
  return lines.join('\n');
}

// ── HTML 版排版 ───────────────────────────────────────────────────────────
// 仿大厂的交易类邮件：600px 固定宽、table 布局、样式全部内联。
// 为什么不用 <style>/flex/grid：QQ 邮箱、Outlook、各种手机客户端会把 <head> 里的样式表
// 直接丢掉，只有内联样式和 table 布局是普遍可靠的。

const FONT = "-apple-system,BlinkMacSystemFont,'Segoe UI','PingFang SC','Hiragino Sans GB','Microsoft YaHei',sans-serif";
const MONO = "ui-monospace,SFMono-Regular,Menlo,Consolas,'Courier New',monospace";

function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

function mailShell({ accent, title, subtitle, body, footnote }) {
  return `<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title></head>
<body style="margin:0;padding:0;background:#f3f4f6;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f3f4f6;padding:28px 12px;">
<tr><td align="center">
  <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="width:600px;max-width:100%;background:#ffffff;border:1px solid #e5e7eb;border-radius:12px;">
    <tr><td style="padding:22px 28px;background:${accent};border-radius:12px 12px 0 0;">
      <div style="font-family:${FONT};font-size:18px;line-height:1.4;color:#ffffff;font-weight:600;">${esc(title)}</div>
      <div style="font-family:${FONT};font-size:13px;line-height:1.5;color:rgba(255,255,255,0.85);margin-top:4px;">${esc(subtitle)}</div>
    </td></tr>
    <tr><td style="padding:4px 28px 22px;">${body}</td></tr>
  </table>
  <div style="font-family:${FONT};font-size:12px;line-height:1.9;color:#9ca3af;margin-top:16px;max-width:600px;">${esc(footnote)}</div>
</td></tr>
</table>
</body></html>`;
}

function htmlSection(title, inner) {
  return `<div style="margin-top:20px;">
  <div style="font-family:${FONT};font-size:13px;font-weight:600;color:#374151;padding-bottom:8px;border-bottom:1px solid #f0f1f3;">${esc(title)}</div>
  ${inner}
</div>`;
}

function htmlRows(rows) {
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="font-family:${FONT};font-size:14px;color:#111827;">${rows
    .map((r) => `<tr>
      <td style="padding:8px 0;color:#6b7280;">${esc(r.label)}</td>
      <td align="right" style="padding:8px 0;font-weight:${r.strong ? 600 : 400};color:${r.color || '#111827'};">${r.html || esc(r.value)}</td>
    </tr>`)
    .join('')}</table>`;
}

function htmlIncidents(list) {
  return list
    .map((i) => {
      const st = severityStyle(i.severity);
      const tag = `<span style="display:inline-block;padding:1px 6px;border-radius:4px;font-size:12px;background:${st.bg};color:${st.fg};">${severityLabel(i.severity)}</span>`;
      const msg = String(i.message || '').replace(/\s+/g, ' ').slice(0, 200);
      return `<div style="padding:10px 0;border-bottom:1px solid #f3f4f6;">
      <div style="font-family:${MONO};font-size:12px;color:#6b7280;">${esc(fmtTime(i.firstAt))} ${tag} ${esc(i.source || '')}</div>
      <div style="font-family:${FONT};font-size:13px;line-height:1.7;color:#111827;margin-top:4px;word-break:break-word;">${esc(msg)}</div>
    </div>`;
    })
    .join('');
}

function htmlAnalysis(analysis) {
  return `<div style="margin-top:14px;padding:12px 14px;background:#f9fafb;border-left:3px solid #d1d5db;border-radius:6px;">
  <div style="font-family:${FONT};font-size:12px;font-weight:600;color:#6b7280;margin-bottom:6px;">AI 分析</div>
  <div style="font-family:${FONT};font-size:13px;line-height:1.9;color:#374151;">${esc(analysis).replace(/\n/g, '<br>')}</div>
</div>`;
}

const FOOTNOTE = '本邮件由服务器上的定时任务自动生成 · 花费按官方价与 token 用量估算，不是账单金额；余额为服务商接口返回的真实值。';

function buildReportHtml({ dayKey, hist, balance, prevBalance, incidents = [], analysis = null }) {
  const weekday = new Intl.DateTimeFormat('zh-CN', { timeZone: TZ, weekday: 'long' })
    .format(new Date(`${dayKey}T12:00:00+08:00`));
  let body = '';

  const overview = hist
    ? htmlRows([
      { label: '运行次数', value: `${hist.runs} 次` },
      { label: '模型用量', value: `${tok(hist.totalTokens)} tokens` },
      { label: '缓存命中', value: hist.promptTokens > 0 ? `${((hist.cachedTokens / hist.promptTokens) * 100).toFixed(0)}%` : '—' },
      { label: '估算花费', value: yuan(hist.estimatedYuan), strong: true },
      { label: '联网搜索', value: `${hist.webSearchCount} 次` }
    ])
    : `<div style="font-family:${FONT};font-size:13px;color:#9ca3af;padding:12px 0;">无台账快照（该时段机器人服务未运行）。</div>`;
  body += htmlSection('运行概览', overview);

  let balanceHtml;
  if (balance) {
    const delta = prevBalance != null ? balance.total - prevBalance : null;
    balanceHtml = `<div style="padding:14px 0 4px;">
      <div style="font-family:${FONT};font-size:28px;font-weight:600;color:#111827;line-height:1.2;">${yuan(balance.total)}</div>
      <div style="font-family:${FONT};font-size:13px;color:#6b7280;margin-top:4px;">DeepSeek 账户余额${delta == null ? '' : `，较上次 ${delta >= 0 ? '+' : '-'}${Math.abs(delta).toFixed(2)} 元`}</div>
    </div>`;
  } else {
    balanceHtml = `<div style="font-family:${FONT};font-size:13px;color:#9ca3af;padding:12px 0;">本次查询失败（接口异常或未配置 key）。</div>`;
  }
  body += htmlSection('账号余额', balanceHtml);

  let incidentHtml;
  if (!incidents.length) {
    incidentHtml = `<div style="font-family:${FONT};font-size:13px;color:#9ca3af;padding:12px 0;">该时段无异常。</div>`;
  } else {
    incidentHtml = `<div style="font-family:${FONT};font-size:13px;color:#6b7280;padding:10px 0 2px;">${severitySummary(incidents)}</div>`
      + htmlIncidents(incidents)
      + (analysis ? htmlAnalysis(analysis) : '');
  }
  body += htmlSection('异常', incidentHtml);

  return mailShell({
    accent: '#2563eb',
    title: '运行日报',
    subtitle: `${dayKey}（${weekday}）`,
    body,
    footnote: FOOTNOTE
  });
}

function buildSevereHtml({ incidents, analysis }) {
  const body = htmlSection('需立即处理的异常', htmlIncidents(incidents) + (analysis ? htmlAnalysis(analysis) : ''))
    + htmlSection('说明', `<div style="font-family:${FONT};font-size:13px;line-height:1.9;color:#6b7280;padding:10px 0;">严重 / 错误级异常立刻发这一封；警告级不单独发送，每天 9:00 汇总在运行日报里。控制台「异常处理」页可以确认 / 解决。</div>`);
  return mailShell({
    accent: '#dc2626',
    title: '异常提醒',
    subtitle: new Date().toLocaleString('zh-CN', { timeZone: TZ, hour12: false }),
    body,
    footnote: FOOTNOTE
  });
}

const now = shanghaiParts();

/**
 * 程序侧排队的"管理员通知"（更新提示 / 好友申请 / 好友候选 / 审批回执）→ 邮件。
 * 每次跑都处理一次，所以最长延迟就是定时器的间隔（当前 10 分钟）。
 * 发失败的留在队列里下次重试，连续失败到 MAIL_OUTBOX_FAIL_MAX 次就停手（免得永远卡着），
 * 同时把状态写进 data/mail-outbox.json，日报里会带一句。
 */
async function forwardMailOutbox({ dry = false } = {}) {
  const box = readJson(MAIL_OUTBOX_FILE, null);
  const items = Array.isArray(box?.items) ? box.items : [];
  if (!items.length) return { sent: 0, pending: 0, failed: 0 };
  const remain = [];
  let sent = 0;
  let failed = 0;
  for (const item of items) {
    const title = String(item.subject || '通知');
    const at = new Date(Number(item.at) || Date.now()).toLocaleString('zh-CN', { hour12: false, timeZone: TZ });
    if (dry) {
      console.log(`（演练）会发通知邮件：${title}`);
      continue;
    }
    try {
      await sendMail({
        subject: `[QQ-bot] ${title}`,
        html: mailShell({
          accent: '#2563eb',
          title,
          subtitle: at,
          body: htmlSection('内容', `<div style="font-family:${FONT};font-size:13px;line-height:1.9;color:#111827;white-space:pre-wrap;">${esc(String(item.text || ''))}</div>`),
          footnote: FOOTNOTE
        }),
        text: [`[QQ-bot] ${title}`, at, '', String(item.text || '')].join('\n')
      });
      sent += 1;
    } catch (error) {
      failed += 1;
      remain.push({
        ...item,
        failures: (Number(item.failures) || 0) + 1,
        lastError: String(error?.message ?? error).slice(0, 200)
      });
    }
  }
  if (!dry) {
    const keep = remain.filter((i) => (Number(i.failures) || 0) < MAIL_OUTBOX_FAIL_MAX);
    const dropped = remain.length - keep.length;
    writeJson(MAIL_OUTBOX_FILE, { items: keep, lastRunAt: Date.now() });
    if (dropped > 0) {
      console.log(`[通知队列] ${dropped} 条连续失败 ${MAIL_OUTBOX_FAIL_MAX} 次，已放弃：${remain[0]?.lastError || ''}`);
    }
    if (sent) console.log(`[${new Date().toISOString()}] 已发 ${sent} 封通知邮件`);
    if (failed) console.log(`[通知队列] ${failed} 条投递失败，留在队列里下次重试`);
  }
  return { sent, pending: remain.length, failed };
}

/** 当日预算超限提示（程序在超限当天写 data/budget-alert.json）。 */
function budgetAlertLine(dayKey) {
  const st = readJson(BUDGET_ALERT_FILE, null);
  if (!st || String(st.dayKey || '') !== String(dayKey || '')) return '';
  const unpriced = Number(st.unpricedRuns) > 0 ? `（另有 ${st.unpricedRuns} 次运行未计价）` : '';
  const policy = st.onExceed === 'block' ? '超限策略＝停止：新消息不处理' : '超限策略＝降级：群里只回应 @';
  return `  当日花费已达上限：估算 ¥${Number(st.spentYuan || 0).toFixed(2)} / ¥${Number(st.limitYuan || 0)}${unpriced}；${policy}。`;
}

/** 上次转发/发送失败的状态（写进 incident-notify.json，日报里提醒一句）。 */
function mailFailureLine() {
  const st = readJson(INCIDENT_STATE_FILE, null) || {};
  if (!st.lastFailureAt) return '';
  const at = new Date(Number(st.lastFailureAt)).toLocaleString('zh-CN', { hour12: false, timeZone: TZ });
  const where = st.lastFailureWhere === 'outbox' ? '通知邮件' : '告警邮件';
  return `  ⚠ ${where}上次投递失败：${at}　${String(st.lastFailureError || '').slice(0, 120)}`;
}

if (process.argv.includes('--test-mail')) {
  const hist = readJson(HISTORY_FILE, {});
  const yKey = shiftDay(now.dayKey, -1);
  const balance = await deepseekBalance();
  const incidents = await fetchIncidents().catch(() => []);
  const dayList = dayIncidents(yKey, incidents);
  const analysis = dayList.length ? await analyzeIncidents(dayList) : null;
  const body = [
    '这是一封测试邮件，用来确认邮件通道正常。',
    '',
    buildReport({ dayKey: yKey, hist: hist[yKey] || null, balance, incidents: dayList, analysis }),
    '',
    '（正式日报每天 9:00 发一封，内容是前一天的数据。）'
  ].join('\n');
  try {
    const res = await sendMail({
      subject: '[QQ-bot] 通道测试',
      text: body,
      html: buildReportHtml({ dayKey: yKey, hist: hist[yKey] || null, balance, incidents: dayList, analysis })
    });
    console.log(`测试邮件已发送到 ${res.to}（发件人显示名：${res.fromName}）`);
  } catch (error) {
    console.log(`测试邮件发送失败：${error?.message ?? error}`);
    process.exit(1);
  }
  process.exit(0);
}

if (DRY) {
  const hist = readJson(HISTORY_FILE, {});
  const yKey = shiftDay(now.dayKey, -1);
  const balance = await deepseekBalance();
  const incidents = await fetchIncidents().catch(() => []);
  const dayList = dayIncidents(yKey, incidents);
  const analysis = dayList.length ? await analyzeIncidents(dayList) : null;
  const bh = readJson(BALANCE_FILE, {});
  const prevKeys = Object.keys(bh).filter((k) => k < now.dayKey).sort();
  const prev = prevKeys.length ? bh[prevKeys[prevKeys.length - 1]].total : null;
  console.log(`（演练，不发送。现在是 ${now.dayKey} ${now.hour}:${String(now.minute).padStart(2, '0')}）`);
  console.log(buildReport({ dayKey: yKey, hist: hist[yKey] || null, balance, prevBalance: prev, incidents: dayList, analysis }));
  const inc = await forwardIncidents({ dry: true }).catch((e) => ({ error: String(e?.message ?? e) }));
  if (inc.error) console.log(`\n[告警转发] 查询失败：${inc.error}`);
  else if (inc.seeded) console.log(`\n[告警转发] 尚未开始（当前 ${inc.total} 条），正式运行会把它们记为"已见"、不补发`);
  else console.log(`\n[告警转发] 现在有 ${inc.fresh.length} 条新告警待发（当前共 ${inc.total} 条）`);
  const boxDry = await forwardMailOutbox({ dry: true }).catch(() => ({ pending: 0 }));
  console.log(`[通知队列] 演练：队列里 ${boxDry.pending} 条待发通知邮件`);
  if (budgetAlertLine(yKey)) console.log(`[预算] ${budgetAlertLine(yKey).trim()}`);
  if (mailFailureLine()) console.log(`[投递] ${mailFailureLine().trim()}`);
  process.exit(0);
}

// 1) 每次跑都做快照（幂等，同一个 dayKey 覆盖）
const snapped = snapshot();

// 2) 顺便把新告警转发到邮箱（失败不影响日报）
try {
  const inc = await forwardIncidents();
  if (inc.fresh.length) console.log(`[${new Date().toISOString()}] 已转发 ${inc.fresh.length} 条新告警`);
} catch (error) {
  console.log(`[${new Date().toISOString()}] 告警转发失败：${error?.message ?? error}`);
  // 让日报能提醒"有东西没发出去"（状态文件本来就存在，加两个字段，不动 seen）
  try {
    const st = readJson(INCIDENT_STATE_FILE, null) || {};
    writeJson(INCIDENT_STATE_FILE, {
      ...st,
      lastFailureAt: Date.now(),
      lastFailureWhere: 'incident',
      lastFailureError: String(error?.message ?? error).slice(0, 200)
    });
  } catch { /* 状态写不进去就算了 */ }
}

// 3) 程序侧排队的通知（更新 / 好友申请 …）也在这里发出去
try {
  await forwardMailOutbox();
} catch (error) {
  console.log(`[${new Date().toISOString()}] 通知队列处理失败：${error?.message ?? error}`);
  try {
    const st = readJson(INCIDENT_STATE_FILE, null) || {};
    writeJson(INCIDENT_STATE_FILE, {
      ...st,
      lastFailureAt: Date.now(),
      lastFailureWhere: 'outbox',
      lastFailureError: String(error?.message ?? error).slice(0, 200)
    });
  } catch { /* 同上 */ }
}

// 4) 到点发小结（每天只发一次，发完在台账里记一笔）
const reportKey = now.dayKey;
const bh = readJson(BALANCE_FILE, {});
if (now.hour === REPORT_HOUR && !bh[reportKey]?.reportedAt) {
  const hist = readJson(HISTORY_FILE, {});
  const yKey = shiftDay(reportKey, -1);
  const balance = await deepseekBalance();
  const incidents = await fetchIncidents().catch(() => []);
  const dayList = dayIncidents(yKey, incidents);
  const analysis = dayList.length ? await analyzeIncidents(dayList) : null;
  const prevKeys = Object.keys(bh).filter((k) => k < reportKey).sort();
  const prev = prevKeys.length ? bh[prevKeys[prevKeys.length - 1]].total : null;
  const text = buildReport({ dayKey: yKey, hist: hist[yKey] || null, balance, prevBalance: prev, incidents: dayList, analysis });
  try {
    const res = await sendMail({
      subject: `[QQ-bot] 运行日报 ${yKey}`,
      text,
      html: buildReportHtml({ dayKey: yKey, hist: hist[yKey] || null, balance, prevBalance: prev, incidents: dayList, analysis })
    });
    console.log(`[${new Date().toISOString()}] 日报已发送到 ${res.to}\n${text}`);
  } catch (error) {
    console.log(`[${new Date().toISOString()}] 日报发送失败：${error?.message ?? error}\n${text}`);
    process.exit(1);
  }
  bh[reportKey] = {
    ...(bh[reportKey] || {}),
    reportedAt: Date.now(),
    total: balance ? balance.total : null
  };
  writeJson(BALANCE_FILE, bh);
}

// 3) 每天第一次跑时把余额也记一笔（用于"较上次"）
if (!bh[reportKey]?.total) {
  const balance = await deepseekBalance();
  if (balance) {
    bh[reportKey] = { ...(bh[reportKey] || {}), total: balance.total, at: Date.now() };
    writeJson(BALANCE_FILE, bh);
  }
}

if (process.env.QQ_AGENT_USAGE_VERBOSE === '1') console.log(`[snapshot] dayKey=${snapped}`);
