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
 * 口径说明：估算费用来自程序自己的计算（内置官方价格 × Token，含缓存价与高峰价），
 * 与控制台「用量」页一致；余额是 DeepSeek 接口给的真实数字。两者不是一回事，消息里分开写。
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import tls from 'node:tls';
import crypto from 'node:crypto';
import zlib from 'node:zlib';

const DATA_DIR = process.env.QQ_AGENT_DATA_DIR || '/mnt/data/qq-agent/data';
const TODAY_FILE = path.join(DATA_DIR, 'usage-today.json');
const HISTORY_FILE = path.join(DATA_DIR, 'usage-daily.json');
const BALANCE_FILE = path.join(DATA_DIR, 'balance-daily.json');
const SESSIONS_DIR = path.join(DATA_DIR, 'sessions');
// 邮件凭据放在服务器上、不进仓库（600 权限）。格式：
//   { "host": "smtp.qq.com", "port": 465, "user": "<SMTP_EMAIL>", "pass": "<SMTP授权码>", "to": "<SMTP_EMAIL>" }
const MAIL_FILE = process.env.QQ_AGENT_MAIL_CRED || '/mnt/data/qq-agent/mail-cred.json';
// 告警转发的状态（已转发过哪些、上次看到哪），以及"只转发这么久的"下限
const INCIDENT_STATE_FILE = path.join(DATA_DIR, 'incident-notify.json');
// 程序侧排队的"管理员通知"（更新提示 / 好友申请 / 好友候选 / 审批回执）由本脚本发信
const MAIL_OUTBOX_FILE = path.join(DATA_DIR, 'mail-outbox.json');
const MAIL_OUTBOX_FAIL_MAX = 6;
// 当日预算超限状态（程序写的，日报里带一行）
const BUDGET_ALERT_FILE = path.join(DATA_DIR, 'budget-alert.json');
const REPORT_STATE_FILE = path.join(DATA_DIR, 'usage-report-state.json');
const INCIDENT_MAX_AGE_MS = 24 * 3600 * 1000;
// 只有这些级别**立刻**发邮件；其余级别（默认只剩 warning）攒进每天 08:00 的日报里一起看。
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
    parts.push(`${severityLabel(k)} ${counts.get(k)} 项`);
    counts.delete(k);
  }
  for (const [k, n] of counts) parts.push(`${severityLabel(k)} ${n} 项`);
  return parts.join(' · ');
}
const RETAIN_DAYS = 120;
const BALANCE_RETAIN_DAYS = 365;
const REPORT_STATE_RETAIN_DAYS = 180;
const REPORT_HOUR = 8;          // 上海时间几点发小结
const REPORT_CATCHUP_DAYS = 2;  // 启动/网络恢复后最多补发最近两天，避免一次灌很多旧邮件
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
function fullInt(v) {
  return String(Math.round(num(v))).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}
function tok(v) {
  return fullInt(v);
}
const PNG_CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k += 1) c = (c & 1) ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function pngCrc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) crc = PNG_CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}
function pngChunk(type, data) {
  const name = Buffer.from(type, 'ascii');
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(pngCrc32(Buffer.concat([name, data])), 0);
  return Buffer.concat([length, name, data, crc]);
}
/**
 * 邮件里用内嵌 PNG，避免 SVG/data URI 在不同邮箱客户端被拦截。
 * 320px 图像足够在手机上以 160~180px 清晰显示。
 */
function makeUsagePiePng(hist, size = 480) {
  const cached = Math.max(0, num(hist?.cachedTokens));
  const uncached = Math.max(0, num(hist?.promptTokens) - cached);
  const output = Math.max(0, num(hist?.completionTokens));
  const values = [cached, uncached, output];
  const colors = [
    [0x25, 0x63, 0xeb, 0xff],
    [0x93, 0xc5, 0xfd, 0xff],
    [0x10, 0xb9, 0x81, 0xff]
  ];
  const total = values.reduce((sum, value) => sum + value, 0);
  const parts = total > 0 ? values.map((value) => value / total) : [1, 0, 0];
  if (total <= 0) colors[0] = [0xe5, 0xe7, 0xeb, 0xff];
  const bounds = [0];
  for (const part of parts) bounds.push(bounds[bounds.length - 1] + part * Math.PI * 2);
  const raw = Buffer.alloc((size * 4 + 1) * size);
  const center = (size - 1) / 2;
  const radius = size * 0.46;
  for (let y = 0; y < size; y += 1) {
    const row = y * (size * 4 + 1);
    raw[row] = 0;
    for (let x = 0; x < size; x += 1) {
      const dx = x - center;
      const dy = y - center;
      const distance = Math.hypot(dx, dy);
      const index = row + 1 + x * 4;
      if (distance > radius) {
        raw[index] = raw[index + 1] = raw[index + 2] = raw[index + 3] = 0;
        continue;
      }
      if (distance >= radius - size * 0.008) {
        raw[index] = raw[index + 1] = raw[index + 2] = 0xff;
        raw[index + 3] = 0xff;
        continue;
      }
      const angle = (Math.atan2(dy, dx) + Math.PI / 2 + Math.PI * 2) % (Math.PI * 2);
      let color = colors[0];
      for (let i = 0; i < parts.length; i += 1) {
        if (angle >= bounds[i] && angle <= bounds[i + 1]) {
          color = colors[i];
          break;
        }
      }
      const separator = distance > radius * 0.22
        && bounds.some((bound) => Math.abs(angle - bound) < 0.008 || Math.abs(angle - bound - Math.PI * 2) < 0.008);
      if (separator) {
        raw[index] = raw[index + 1] = raw[index + 2] = 0xff;
        raw[index + 3] = 0xff;
      } else {
        [raw[index], raw[index + 1], raw[index + 2], raw[index + 3]] = color;
      }
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    pngChunk('IEND', Buffer.alloc(0))
  ]);
}
function signedPct(value) {
  return value == null ? '—' : `${value >= 0 ? '+' : ''}${value.toFixed(1)}%`;
}
function errorSummary(error, max = 240) {
  const parts = [];
  const seen = new Set();
  let cur = error;
  while (cur && parts.length < 4 && !seen.has(cur)) {
    seen.add(cur);
    if (typeof cur === 'string') {
      parts.push(cur);
      break;
    }
    const bits = [cur.name, cur.code, cur.message].filter(Boolean).map(String);
    if (bits.length) parts.push(bits.join(': '));
    cur = cur.cause;
  }
  return [...new Set(parts)].join(' <- ').replace(/\s+/g, ' ').slice(0, max);
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

function currentProviderInfo() {
  const cfg = readJson(path.join(DATA_DIR, 'config.json'), {}) || {};
  const providerId = cfg.api?.provider;
  const provider = (cfg.providers || []).find((p) => String(p.id) === String(providerId)) || {};
  return {
    cfg,
    id: String(provider.id || providerId || ''),
    displayName: String(provider.displayName || provider.name || provider.id || providerId || '当前服务商'),
    baseURL: String(provider.baseURL || ''),
    model: String(cfg.api?.model || '')
  };
}

function platformDisplayMap() {
  const cfg = readJson(path.join(DATA_DIR, 'config.json'), {}) || {};
  const knownHosts = {
    'api.deepseek.com': 'DeepSeek 官方',
    'openrouter.ai': 'OpenRouter',
    'api.siliconflow.cn': '硅基流动',
    'api.openai.com': 'OpenAI',
    'api.anthropic.com': 'Anthropic',
    'open.bigmodel.cn': '智谱 AI',
    'api.moonshot.cn': '月之暗面',
    'dashscope.aliyuncs.com': '阿里云百炼',
    'generativelanguage.googleapis.com': 'Google Gemini'
  };
  const map = new Map(Object.entries(knownHosts));
  for (const provider of (cfg.providers || [])) {
    const label = String(provider?.displayName || provider?.name || '').trim();
    const looksLikeDomain = /^[a-z0-9.-]+\.[a-z]{2,}$/i.test(label);
    if (!label || looksLikeDomain) continue;
    if (provider.id) map.set(String(provider.id).toLowerCase(), label);
    try {
      const host = new URL(String(provider.baseURL || '')).hostname.toLowerCase();
      if (host) map.set(host, label);
    } catch { /* 非法地址不参与映射 */ }
  }
  return map;
}

function featureServiceLabels() {
  const cfg = readJson(path.join(DATA_DIR, 'config.json'), {}) || {};
  const search = cfg.webSearch || {};
  const searchNames = {
    bing: 'Bing',
    deepseek: 'DeepSeek 搜索',
    zhipu: '智谱搜索',
    bocha: '博查',
    baidu: '百度',
    metaso: '秘塔',
    doubao: '豆包搜索',
    tavily: 'Tavily',
    aggregate: '聚合搜索'
  };
  const providerId = String(search.provider || 'bing');
  let searchLabel = searchNames[providerId] || providerId;
  if (providerId === 'aggregate') {
    const sources = (Array.isArray(search.aggregate?.sources) ? search.aggregate.sources : [])
      .map((id) => searchNames[id] || id);
    if (sources.length) searchLabel = `聚合搜索（${sources.join(' / ')}）`;
  } else if (providerId === 'custom' || providerId.startsWith('custom:')) {
    const id = providerId.slice('custom:'.length);
    const custom = (Array.isArray(search.providers) ? search.providers : [])
      .find((provider) => String(provider?.id || '') === id);
    searchLabel = String(custom?.displayName || custom?.name || '自定义搜索');
  }

  const asr = cfg.asr || {};
  const asrNames = {
    openai: 'OpenAI 兼容语音识别',
    local: '本机 Whisper',
    fire: '火山 Seed-ASR',
    dashscope: '阿里云百炼',
    baidu: '百度语音识别',
    tencent: '腾讯云语音识别',
    iflytek: '讯飞语音识别'
  };
  const asrProviderId = String(asr.provider || 'openai');
  const asrModel = asrProviderId === 'local'
    ? String(asr.localModel || '').split(/[\\/]/).filter(Boolean).pop() || '本机模型'
    : String(asr.model || asrProviderId || '未配置');
  return {
    searchLabel,
    asrLabel: asrNames[asrProviderId] || asrProviderId,
    asrModel
  };
}

function recordedFeatureService(kind, row) {
  const names = kind === 'search'
    ? {
        bing: 'Bing',
        deepseek: 'DeepSeek 搜索',
        zhipu: '智谱搜索',
        bocha: '博查',
        baidu: '百度',
        metaso: '秘塔',
        doubao: '豆包搜索',
        tavily: 'Tavily',
        aggregate: '聚合搜索'
      }
    : {
        qq: 'QQ 自带转写',
        openai: 'OpenAI 兼容语音识别',
        local: '本机 Whisper',
        fire: '火山 Seed-ASR',
        dashscope: '阿里云百炼',
        baidu: '百度语音识别',
        tencent: '腾讯云语音识别',
        iflytek: '讯飞语音识别'
      };
  const service = String(row?.service || '');
  if (!service) return '当时服务未记录';
  if (kind === 'search' && service === 'aggregate') {
    const sources = String(row.serviceModel || '').split(',').filter(Boolean).map((id) => names[id] || id);
    return sources.length ? `聚合搜索（${sources.join(' / ')}）` : '聚合搜索';
  }
  const label = names[service] || service;
  if (kind === 'asr' && row.serviceModel) return `${label}｜${row.serviceModel}`;
  return label;
}

function parseDeepseekBalance(payload) {
  const cny = (payload?.balance_infos || []).find((b) => b.currency === 'CNY');
  if (!cny) {
    const currencies = (payload?.balance_infos || []).map((item) => String(item?.currency || '')).filter(Boolean);
    return {
      ok: false,
      supported: true,
      total: null,
      reason: currencies.length
        ? `DeepSeek 余额接口没有 CNY 账户（返回：${currencies.join(' / ')}）`
        : 'DeepSeek 余额接口没有返回 CNY 账户'
    };
  }
  return {
    ok: true,
    supported: true,
    total: num(cny.total_balance),
    currency: 'CNY',
    granted: num(cny.granted_balance),
    topped: num(cny.topped_up_balance),
    available: payload?.is_available === true,
    reason: ''
  };
}

async function balanceSnapshot() {
  const info = currentProviderInfo();
  let host = '';
  try { host = new URL(info.baseURL).hostname.toLowerCase(); } catch { /* 留给下面统一报不支持 */ }
  if (host !== 'api.deepseek.com') {
    return {
      ok: false,
      supported: false,
      total: null,
      reason: `${info.displayName} 没有接入余额查询`
    };
  }
  const providerId = info.cfg.api?.provider;
  const cfg = info.cfg;
  const key = String((cfg.providerKeys || {})[providerId] || '').trim();
  if (!key) return { ok: false, supported: true, total: null, reason: '当前服务商未配置 API Key' };
  try {
    const r = await fetch('https://api.deepseek.com/user/balance', { headers: { Authorization: `Bearer ${key}` } });
    if (!r.ok) {
      return { ok: false, supported: true, total: null, reason: `DeepSeek 余额接口 HTTP ${r.status}` };
    }
    return parseDeepseekBalance(await r.json());
  } catch (error) {
    return { ok: false, supported: true, total: null, reason: errorSummary(error) || '余额查询失败' };
  }
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

function stableMessageId(label, parts) {
  const digest = crypto.createHash('sha256').update(parts.map(String).join('\n')).digest('hex').slice(0, 32);
  return `<${label}-${digest}@qq-bot.local>`;
}

function encodeMailBody(value) {
  return (Buffer.isBuffer(value) ? value : Buffer.from(String(value), 'utf8'))
    .toString('base64').replace(/(.{76})/g, '$1\r\n');
}

function buildMimeBody({ text, html = null, inlineImages = [] }) {
  if (!html) {
    return ['Content-Type: text/plain; charset=UTF-8', 'Content-Transfer-Encoding: base64', '', encodeMailBody(text), ''].join('\r\n');
  }
  if (!inlineImages.length) {
    const boundary = `anon-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
    return [
      `Content-Type: multipart/alternative; boundary="${boundary}"`,
      '',
      `--${boundary}`,
      'Content-Type: text/plain; charset=UTF-8',
      'Content-Transfer-Encoding: base64',
      '',
      encodeMailBody(text),
      `--${boundary}`,
      'Content-Type: text/html; charset=UTF-8',
      'Content-Transfer-Encoding: base64',
      '',
      encodeMailBody(html),
      `--${boundary}--`,
      ''
    ].join('\r\n');
  }
  const related = `anon-rel-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  const alternative = `anon-alt-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  const imageParts = inlineImages.flatMap((image) => [
    `--${related}`,
    `Content-Type: ${image.contentType || 'image/png'}; name="${image.filename || 'inline.png'}"`,
    'Content-Transfer-Encoding: base64',
    `Content-ID: <${image.cid}>`,
    `Content-Disposition: inline; filename="${image.filename || 'inline.png'}"`,
    '',
    encodeMailBody(image.data)
  ]);
  return [
    `Content-Type: multipart/related; boundary="${related}"`,
    '',
    `--${related}`,
    `Content-Type: multipart/alternative; boundary="${alternative}"`,
    '',
    `--${alternative}`,
    'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
    '',
    encodeMailBody(text),
    `--${alternative}`,
    'Content-Type: text/html; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
    '',
    encodeMailBody(html),
    `--${alternative}--`,
    ...imageParts,
    `--${related}--`,
    ''
  ].join('\r\n');
}

async function sendMail({ subject, text, html = null, messageId = null, inlineImages = [] }) {
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
      `Message-ID: ${messageId || stableMessageId('mail', [Date.now(), Math.random()])}`,
      'MIME-Version: 1.0',
      'Auto-Submitted: auto-generated',
      'X-Auto-Response-Suppress: All'
    ];
    const body = buildMimeBody({ text, html, inlineImages });
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
      subject: `[QQ-bot][${worstLabel}] 异常 ${fresh.length} 项`,
      html: buildSevereHtml({ incidents: fresh, analysis }),
      text: [
        `[QQ-bot] ${worstLabel}异常提醒`,
        `${new Date().toLocaleString('zh-CN', { timeZone: TZ, hour12: false })}`,
        '',
        `检测到 ${fresh.length} 项需立即处理的异常（控制台「异常处理」页可以确认 / 解决）：`,
        '',
        body,
        analysis ? `\nAI 分析：\n${analysis}\n` : '',
        '附注：本邮件由服务器上的定时任务自动生成；严重 / 错误级立刻发，警告级不单独发、每天 08:00 汇总在运行简报里。'
      ].join('\n'),
      messageId: stableMessageId('incident', fresh.map((i) => i.id).sort())
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
    const first = Number(i.firstAt) || 0;
    const last = Number(i.lastAt) || first;
    return (first >= from && first < to) || (last >= from && first < to);
  });
}

function incidentIsRecurring(i, dayKey) {
  if (!dayKey) return false;
  const [from] = dayRangeMs(dayKey);
  return (Number(i.firstAt) || 0) < from;
}

function fmtTime(at) {
  return new Intl.DateTimeFormat('zh-CN', { timeZone: TZ, hour: '2-digit', minute: '2-digit', hour12: false })
    .format(new Date(Number(at) || Date.now()));
}

function renderIncidents(list, limit = 8, dayKey = null) {
  const lines = [];
  for (const i of list.slice(0, limit)) {
    const sev = severityLabel(i.severity);
    const kind = incidentIsRecurring(i, dayKey) ? '  持续' : '';
    const msg = String(i.message || '').replace(/\s+/g, ' ').slice(0, 90);
    lines.push(`  · ${fmtTime(incidentIsRecurring(i, dayKey) ? i.lastAt : i.firstAt)}  ${sev}${kind}  ${i.source || '-'}  ${msg}`);
  }
  if (list.length > limit) {
    lines.push(`  · 其余 ${list.length - limit} 项见控制台「异常处理」页`);
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
    '这是一台 QQ 机器人的运行简报。下面是它自检出的异常清单。',
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

function buildReport({
  dayKey,
  hist,
  balance,
  prevBalance,
  incidents = [],
  analysis = null,
  trend = null,
  modelUsage = null,
  featureUsage = null,
  featureServices = null,
  budget = null,
  delivery = null,
  mailFailure = null,
  reportState = null,
  late = false
}) {
  const weekday = new Intl.DateTimeFormat('zh-CN', { timeZone: TZ, weekday: 'long' })
    .format(new Date(`${dayKey}T12:00:00+08:00`));
  const lines = [];
  lines.push('[QQ-bot] 运行简报');
  lines.push(`昨日统计：${dayKey}（${weekday}）`);
  lines.push(`附录：今日实时参考截至 ${now.dayKey} ${String(now.hour).padStart(2, '0')}:${String(now.minute).padStart(2, '0')}`);
  if (late) lines.push('状态：补发（常规 08:00 发送时段已过或任务曾经中断）');
  lines.push('');

  lines.push('一、昨日核心概览');
  if (!hist) {
    lines.push('  该统计日无台账快照（机器人服务可能未运行）。');
  } else {
    const cacheRate = hist.promptTokens > 0 ? (hist.cachedTokens / hist.promptTokens) * 100 : 0;
    const uncached = Math.max(0, num(hist.promptTokens) - num(hist.cachedTokens));
    lines.push(`  运行次数：${hist.runs} 次`);
    lines.push(`  总 Token：${tok(hist.totalTokens)}`);
    lines.push(`  输入 Token（缓存命中）：${tok(hist.cachedTokens)}（缓存命中率 ${cacheRate.toFixed(1)}%）`);
    lines.push(`  输入 Token（未命中缓存）：${tok(uncached)}`);
    lines.push(`  输出 Token：${tok(hist.completionTokens)}`);
    lines.push(`  估算费用：${yuan(hist.estimatedYuan)}${hist.unpricedRuns > 0 ? `（另有 ${hist.unpricedRuns} 次运行未匹配价格，未计入）` : ''}`);
    lines.push(`  搜索工具调用次数：${hist.webSearchCount} 次`);
  }
  lines.push('');

  lines.push('二、平台与模型调用');
  if (modelUsage?.rows?.length) {
    const rows = modelUsage.rows.slice(0, 20);
    lines.push(`  模型调用合计：${modelUsage.calls} 次`);
    for (const row of rows) {
      const uncached = Math.max(0, row.promptTokens - row.cachedTokens);
      lines.push(`  ${row.platform}｜${row.model}`);
      lines.push(`    调用 ${row.calls} 次 · 总 Token ${tok(row.totalTokens)}`);
      lines.push(`    输入 Token（缓存命中）${tok(row.cachedTokens)} · 输入 Token（未命中缓存）${tok(uncached)} · 输出 Token ${tok(row.completionTokens)}`);
    }
    if (modelUsage.rows.length > rows.length) {
      lines.push(`  另有 ${modelUsage.rows.length - rows.length} 个模型未展开，请到控制台「用量」页查看。`);
    }
    if (modelUsage.missingTokens > 0) {
      lines.push(`  另有 ${tok(modelUsage.missingTokens)} Token 来自无会话留档的辅助调用，无法细分到模型。`);
    }
    if (modelUsage.extraTokens > 0) {
      lines.push(`  会话明细比当天台账多 ${tok(modelUsage.extraTokens)} Token，可能是最后一次台账快照发生在午夜之前。`);
    }
  } else {
    lines.push('  该统计日没有可用的平台与模型调用明细。');
  }
  lines.push('');

  lines.push('三、功能调用明细');
  const featureRows = (kind) => featureUsage?.[kind] || [];
  const featureCalls = (kind) => featureRows(kind).reduce((total, row) => total + row.calls, 0);
  const renderFeatureModels = (list, emptyText, { withImages = false, serviceKind = '' } = {}) => {
    if (!list.length) {
      lines.push(`    ${emptyText}`);
      return;
    }
    for (const row of list) {
      const images = withImages && row.images > 0
        ? ` · ${row.sessions} 个含图会话 / ${row.images} 张图`
        : '';
      const service = serviceKind ? `实际服务：${recordedFeatureService(serviceKind, row)} · ` : '';
      lines.push(`    · ${service}发起模型 ${row.platform}｜${row.model}：${row.calls} 次${images}`);
    }
  };
  lines.push(`  当前搜索配置（仅供参考）：${featureServices?.searchLabel || '未配置'}`);
  lines.push(`  搜索工具调用：${featureCalls('search')} 次`);
  renderFeatureModels(featureRows('search'), '无模型发起的搜索工具调用。', { serviceKind: 'search' });
  lines.push(`  网页读取工具调用：${featureCalls('fetch')} 次`);
  renderFeatureModels(featureRows('fetch'), '无模型发起的网页读取工具调用。');
  lines.push(`  当前 ASR 配置（仅供参考）：${featureServices?.asrLabel || '未配置'}｜${featureServices?.asrModel || '未配置模型'}`);
  lines.push(`  语音转文字工具调用：${featureCalls('asr')} 次`);
  renderFeatureModels(featureRows('asr'), '无模型发起的语音转文字调用。', { serviceKind: 'asr' });
  const visionInputs = featureRows('visionInput').reduce((total, row) => ({
    sessions: total.sessions + row.sessions,
    images: total.images + row.images
  }), { sessions: 0, images: 0 });
  lines.push(`  识图请求：${visionInputs.sessions} 个含图会话 / ${visionInputs.images} 张图`);
  lines.push(`  识图工具调用：${featureCalls('visionTool')} 次`);
  renderFeatureModels(featureRows('visionInput'), '无含图请求记录。', { withImages: true });
  if (featureRows('visionTool').length) {
    lines.push('    识图工具发起模型：');
    renderFeatureModels(featureRows('visionTool'), '无识图工具调用。');
  }
  lines.push('');

  lines.push('四、趋势与预测');
  if (trend?.presentDays > 0) {
    if (trend.changePct == null) {
      lines.push(`  近 7 日：有记录 ${trend.presentDays} 天，日均费用 ${yuan(trend.avgCost)}`);
    } else {
      const sign = trend.changePct >= 0 ? '+' : '';
      lines.push(`  昨日估算费用较近 7 日均值：${sign}${trend.changePct.toFixed(1)}%`);
      lines.push(`  近 7 日均值：${yuan(trend.avgCost)} / 天 · ${tok(trend.avgTokens)} Token · ${trend.avgRuns.toFixed(1)} 次运行`);
    }
    if (trend.dayOverDayCostPct != null) {
      lines.push(`  较前一日：费用 ${signedPct(trend.dayOverDayCostPct)} · 运行次数 ${signedPct(trend.dayOverDayRunsPct)} · 总 Token ${signedPct(trend.dayOverDayTokensPct)}`);
    }
    lines.push(`  按近 7 日均值估算：月度费用约 ${yuan(trend.projectedMonthYuan)}`);
  } else {
    lines.push('  历史数据不足，暂不计算趋势。');
  }
  const chartRows = trend?.chartRows || trend?.rows || [];
  if (chartRows.length) {
    lines.push('  近 7 日及今日实时估算费用：');
    for (const row of chartRows) {
      const live = row.live ? '（今日实时）' : '';
      if (!row.hist) {
        lines.push(`    ${row.dayKey}  无记录${live}`);
        continue;
      }
      const cached = num(row.hist.cachedTokens);
      const uncached = Math.max(0, num(row.hist.promptTokens) - cached);
      lines.push(`    ${row.dayKey}  ${yuan(row.hist.estimatedYuan)} · ${tok(row.hist.totalTokens)} Token · ${row.hist.runs} 次运行${live}`);
      lines.push(`      输入命中 ${tok(cached)} · 输入未命中 ${tok(uncached)} · 输出 ${tok(row.hist.completionTokens)}`);
    }
  }
  lines.push('');

  lines.push('五、当前账户余额');
  if (balance?.ok) {
    lines.push(`  DeepSeek：${yuan(balance.total)}`);
    if (prevBalance != null) {
      const delta = balance.total - prevBalance;
      lines.push(`  较上一份简报：${delta >= 0 ? '+' : '-'}${Math.abs(delta).toFixed(2)} 元`);
    }
    if (trend?.avgCost > 0) {
      const days = balance.total / trend.avgCost;
      lines.push(`  按近 7 日均值估算：余额预计可用 ${days.toFixed(1)} 天`);
    }
  } else {
    lines.push(`  未取得余额：${balance?.reason || '当前服务商没有接入余额查询'}`);
  }
  lines.push('');

  lines.push('六、异常');
  if (!incidents.length) {
    lines.push('  该统计日无异常。');
  } else {
    const recurring = incidents.filter((i) => incidentIsRecurring(i, dayKey)).length;
    lines.push(`  ${severitySummary(incidents)}。新增异常 ${incidents.length - recurring} 项，持续异常 ${recurring} 项。`);
    lines.push(...renderIncidents(incidents, 8, dayKey));
    if (analysis) {
      lines.push('');
      lines.push('  异常分析：');
      for (const para of analysis.split('\n')) lines.push(`    ${para}`);
    }
  }
  lines.push('');

  lines.push('七、运行与投递');
  const lastReport = reportState ? lastSuccessfulReportBefore(reportState, dayKey) : null;
  lines.push(`  上次简报发送成功：${lastReport ? new Date(lastReport.sentAt).toLocaleString('zh-CN', { hour12: false, timeZone: TZ }) : '无历史记录'}`);
  lines.push(`  通知队列：${delivery?.outboxPending || 0} 封待发${delivery?.outboxFailed ? `，其中 ${delivery.outboxFailed} 封曾投递失败` : ''}`);
  lines.push('');

  const attention = [];
  if (hist?.unpricedRuns > 0) attention.push(`${hist.unpricedRuns} 次运行未匹配价格，估算费用偏低。`);
  if (budget) attention.push(budget.line);
  if (mailFailure) attention.push(mailFailure.line);
  if (balance?.supported === false) attention.push(`余额查询：${balance.reason}。`);
  else if (balance && !balance.ok) attention.push(`余额读取失败：${balance.reason}。`);
  if (delivery?.outboxFailed > 0) attention.push(`通知队列有 ${delivery.outboxFailed} 封投递失败通知。`);
  if (attention.length) {
    lines.push('八、需要你注意');
    for (const item of attention) lines.push(`  ⚠ ${item}`);
    lines.push('');
  }

  lines.push('附注');
  lines.push('  · 估算费用按服务商官方价格与 Token 用量计算，不等同于实际账单；账户余额仅在服务商提供查询接口时显示。');
  lines.push('  · 技术口径：输入 Token 未命中缓存＝promptTokens－cachedTokens；输出 Token＝completionTokens。');
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

function mailShell({ accent, title, subtitle, body, footnote, preheader = '' }) {
  return `<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title></head>
<body style="margin:0;padding:0;background:#f3f4f6;">
${preheader ? `<div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent;">${esc(preheader)}</div>` : ''}
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f3f4f6;padding:16px 4px;">
<tr><td align="center">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="width:100%;max-width:720px;background:#ffffff;border:1px solid #e5e7eb;border-radius:12px;">
    <tr><td style="padding:21px 24px;background:${accent};border-radius:12px 12px 0 0;">
      <div style="font-family:${FONT};font-size:21px;line-height:1.35;color:#ffffff;font-weight:600;">${esc(title)}</div>
      <div style="font-family:${FONT};font-size:14px;line-height:1.5;color:rgba(255,255,255,0.88);margin-top:5px;">${esc(subtitle)}</div>
    </td></tr>
    <tr><td style="padding:5px 22px 24px;">${body}</td></tr>
  </table>
  <div style="font-family:${FONT};font-size:13px;line-height:1.85;color:#9ca3af;margin-top:14px;width:100%;max-width:720px;">${esc(footnote)}</div>
</td></tr>
</table>
</body></html>`;
}

function htmlSection(title, inner) {
  return `<div style="margin-top:20px;">
  <div style="font-family:${FONT};font-size:15px;font-weight:600;color:#374151;padding-bottom:8px;border-bottom:1px solid #f0f1f3;">${esc(title)}</div>
  ${inner}
</div>`;
}

function htmlRows(rows) {
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="font-family:${FONT};font-size:15px;line-height:1.55;color:#111827;">${rows
    .map((r) => `<tr>
      <td style="padding:9px 0;color:#5f6875;">${esc(r.label)}</td>
      <td align="right" style="padding:9px 0;font-weight:${r.strong ? 600 : 400};color:${r.color || '#111827'};">${r.html || esc(r.value)}</td>
    </tr>`)
    .join('')}</table>`;
}

function htmlIncidents(list, dayKey = null) {
  return list
    .map((i) => {
      const st = severityStyle(i.severity);
      const tag = `<span style="display:inline-block;padding:1px 6px;border-radius:4px;font-size:13px;background:${st.bg};color:${st.fg};">${severityLabel(i.severity)}</span>`;
      const recurring = incidentIsRecurring(i, dayKey);
      const kind = recurring
        ? '<span style="display:inline-block;margin-left:5px;color:#92400e;font-size:13px;">持续复现</span>'
        : '';
      const at = recurring ? i.lastAt : i.firstAt;
      const msg = String(i.message || '').replace(/\s+/g, ' ').slice(0, 200);
      return `<div style="padding:10px 0;border-bottom:1px solid #f3f4f6;">
      <div style="font-family:${MONO};font-size:13px;color:#6b7280;">${esc(fmtTime(at))} ${tag}${kind} ${esc(i.source || '')}</div>
      <div style="font-family:${FONT};font-size:14px;line-height:1.7;color:#111827;margin-top:4px;word-break:break-word;">${esc(msg)}</div>
    </div>`;
    })
    .join('');
}

function htmlTokenChart(rows) {
  const maxTokens = rows.reduce((max, row) => Math.max(max, num(row.hist?.totalTokens)), 0);
  const scale = maxTokens > 0 ? 132 / maxTokens : 0;
  const cellWidth = (100 / Math.max(1, rows.length)).toFixed(2);
  const cells = rows.map((row) => {
    if (!row.hist || num(row.hist.totalTokens) <= 0) {
      return `<td width="${cellWidth}%" height="140" align="center" valign="bottom" style="padding:0 4px;">
        <div style="height:3px;background:#e5e7eb;border-radius:3px 3px 0 0;"></div>
      </td>`;
    }
    const totalHeight = Math.max(4, Math.round(num(row.hist.totalTokens) * scale));
    const cached = num(row.hist.cachedTokens);
    const uncached = Math.max(0, num(row.hist.promptTokens) - cached);
    const output = num(row.hist.completionTokens);
    const componentTotal = cached + uncached + output || 1;
    const outputHeight = Math.round(totalHeight * output / componentTotal);
    const uncachedHeight = Math.round(totalHeight * uncached / componentTotal);
    const cachedHeight = Math.max(0, totalHeight - outputHeight - uncachedHeight);
    return `<td width="${cellWidth}%" height="140" align="center" valign="bottom" style="padding:0 4px;">
      <div style="width:30px;margin:0 auto;overflow:hidden;border-radius:5px 5px 2px 2px;background:#eff6ff;">
        ${outputHeight > 0 ? `<div style="height:${outputHeight}px;background:#10b981;"></div>` : ''}
        ${uncachedHeight > 0 ? `<div style="height:${uncachedHeight}px;background:#93c5fd;"></div>` : ''}
        ${cachedHeight > 0 ? `<div style="height:${cachedHeight}px;background:#2563eb;"></div>` : ''}
      </div>
    </td>`;
  }).join('');
  const dates = rows.map((row) => `<td width="${cellWidth}%" align="center" style="padding:7px 2px 0;font-family:${MONO};font-size:11px;color:${row.live ? '#2563eb' : '#9ca3af'};white-space:nowrap;">
    ${esc(row.dayKey.slice(5))}${row.live ? '<br><span style="font-family:sans-serif;font-size:10px;font-weight:600;">今日</span>' : ''}
  </td>`).join('');
  return `<div style="margin-top:13px;padding:14px 12px 10px;background:#f8fbff;border:1px solid #dbeafe;border-radius:9px;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:5px;">
      <tr>
        <td style="font-family:${FONT};font-size:13px;font-weight:600;color:#374151;">近 7 日 + 今日 Token 用量</td>
        <td align="right" style="font-family:${FONT};font-size:11px;color:#6b7280;white-space:nowrap;">峰值 ${tok(maxTokens)}</td>
      </tr>
    </table>
    <div style="font-family:${FONT};font-size:11px;line-height:1.8;color:#6b7280;padding-bottom:7px;">
      <span style="color:#2563eb;">■</span> 输入命中
      <span style="color:#93c5fd;margin-left:8px;">■</span> 输入未命中
      <span style="color:#10b981;margin-left:8px;">■</span> 输出
    </div>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
      <tr>
        <td width="58" height="140" valign="top" style="font-family:${MONO};font-size:9px;line-height:1.35;color:#9ca3af;text-align:right;padding:0 5px 0 0;word-break:break-all;">
          <div>${tok(maxTokens)}</div>
          <div style="padding-top:55px;">${tok(maxTokens / 2)}</div>
          <div style="padding-top:55px;">0</div>
        </td>
        <td>
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
            <tr>${cells}</tr>
            <tr>${dates}</tr>
          </table>
        </td>
      </tr>
    </table>
    <div style="font-family:${FONT};font-size:11px;color:#9ca3af;padding-top:8px;">柱高按每日总 Token 等比缩放；今日为截至生成邮件时的实时数据，完整精确数值见下方明细。</div>
  </div>`;
}

function htmlTrend(rows) {
  const card = (row) => {
    if (!row.hist) {
      return `<div style="min-height:136px;padding:11px 11px 10px;background:#fafafa;border:1px solid #e5e7eb;border-radius:9px;">
        <div style="font-family:${MONO};font-size:13px;font-weight:600;color:${row.live ? '#2563eb' : '#6b7280'};">${esc(row.dayKey.slice(5))}${row.live ? ' · 今日' : ''}</div>
        <div style="font-family:${FONT};font-size:13px;color:#9ca3af;padding-top:18px;">暂无数据</div>
      </div>`;
    }
    const cached = num(row.hist.cachedTokens);
    const uncached = Math.max(0, num(row.hist.promptTokens) - cached);
    const accent = row.live ? '#2563eb' : '#374151';
    const detail = (color, label, value) => `<tr>
      <td style="padding:3px 0;font-family:${FONT};font-size:11px;color:#6b7280;white-space:nowrap;">
        <span style="color:${color};">■</span> ${esc(label)}
      </td>
      <td align="right" style="padding:3px 0 3px 6px;font-family:${MONO};font-size:11px;font-weight:600;color:#374151;word-break:break-all;">${tok(value)}</td>
    </tr>`;
    return `<div style="min-height:136px;padding:11px 11px 10px;background:${row.live ? '#f5f9ff' : '#fbfdff'};border:1px solid ${row.live ? '#bfdbfe' : '#e5e7eb'};border-radius:9px;">
      <div style="font-family:${MONO};font-size:13px;font-weight:600;color:${accent};">${esc(row.dayKey.slice(5))}${row.live ? ' · 今日' : ''}</div>
      <div style="font-family:${FONT};font-size:11px;color:#6b7280;margin-top:5px;">总 Token</div>
      <div style="font-family:${MONO};font-size:16px;font-weight:700;line-height:1.3;color:#111827;margin-top:1px;word-break:break-all;">${tok(row.hist.totalTokens)}</div>
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-top:5px;">
        ${detail('#2563eb', '输入命中', cached)}
        ${detail('#93c5fd', '输入未命中', uncached)}
        ${detail('#10b981', '输出', row.hist.completionTokens)}
      </table>
      <div style="font-family:${FONT};font-size:11px;color:#6b7280;line-height:1.6;margin-top:6px;padding-top:5px;border-top:1px solid #eef2f7;">
        运行 ${fullInt(row.hist.runs)} 次 · 估算费用 <strong style="color:#374151;">${yuan(row.hist.estimatedYuan)}</strong>
      </div>
    </div>`;
  };
  const paired = [];
  for (let i = 0; i < rows.length; i += 2) {
    paired.push(`<tr>
      <td width="50%" valign="top" style="padding:0 5px 10px 0;">${card(rows[i])}</td>
      <td width="50%" valign="top" style="padding:0 0 10px 5px;">${rows[i + 1] ? card(rows[i + 1]) : ''}</td>
    </tr>`);
  }
  return `<div style="margin-top:14px;">
    <div style="font-family:${FONT};font-size:14px;font-weight:600;color:#374151;margin-bottom:8px;">每日用量明细</div>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0">${paired.join('')}</table>
  </div>`;
}

const YESTERDAY_PIE_CID = 'yesterday-usage-pie@qq-bot.local';

function htmlYesterdayPie(hist, dayKey) {
  const cached = Math.max(0, num(hist?.cachedTokens));
  const uncached = Math.max(0, num(hist?.promptTokens) - cached);
  const output = Math.max(0, num(hist?.completionTokens));
  const total = cached + uncached + output;
  const pct = (value) => total > 0 ? `${((value / total) * 100).toFixed(1)}%` : '0.0%';
  const legend = (color, label, value) => `<tr>
    <td style="padding:5px 0;font-family:${FONT};font-size:13px;color:#6b7280;white-space:nowrap;">
      <span style="color:${color};">■</span> ${esc(label)}
    </td>
    <td align="right" style="padding:5px 0 5px 8px;font-family:${MONO};font-size:13px;font-weight:600;color:#374151;word-break:break-all;">${tok(value)}</td>
    <td align="right" width="52" style="padding:5px 0 5px 8px;font-family:${MONO};font-size:12px;color:#9ca3af;white-space:nowrap;">${pct(value)}</td>
  </tr>`;
  return `<div style="margin-top:14px;padding:14px;background:#fbfdff;border:1px solid #e5e7eb;border-radius:10px;">
    <div style="font-family:${FONT};font-size:14px;font-weight:600;color:#374151;">昨日 Token 构成 · ${esc(dayKey)}</div>
    <div style="font-family:${FONT};font-size:12px;color:#9ca3af;line-height:1.7;margin-top:3px;">统计日 ${esc(dayKey)} · 总 Token ${tok(total)}</div>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-top:8px;">
      <tr>
        <td width="42%" align="center" valign="middle" style="padding:4px 8px 4px 0;">
          <img src="cid:${YESTERDAY_PIE_CID}" width="160" alt="昨日 Token 构成饼图" style="display:block;width:160px;max-width:100%;height:auto;border:0;">
        </td>
        <td valign="middle" style="padding-left:8px;">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
            ${legend('#2563eb', '输入命中', cached)}
            ${legend('#93c5fd', '输入未命中', uncached)}
            ${legend('#10b981', '输出', output)}
          </table>
        </td>
      </tr>
    </table>
  </div>`;
}

function reportInlineImages(ctx) {
  return [{
    cid: YESTERDAY_PIE_CID,
    data: makeUsagePiePng(ctx?.hist),
    contentType: 'image/png',
    filename: 'yesterday-usage.png'
  }];
}

function htmlModels(modelUsage) {
  if (!modelUsage?.rows?.length) {
    return `<div style="font-family:${FONT};font-size:14px;color:#9ca3af;padding:12px 0;">该统计日没有可用的平台与模型调用明细。</div>`;
  }
  const rows = modelUsage.rows.slice(0, 20).map((row, index) => {
    const uncached = Math.max(0, row.promptTokens - row.cachedTokens);
    return `<tr style="background:${index % 2 ? '#fbfdff' : '#ffffff'};">
      <td style="padding:10px 8px;border-bottom:1px solid #f1f5f9;vertical-align:top;">
        <div style="font-family:${FONT};font-size:14px;font-weight:600;color:#111827;">${esc(row.platform)}</div>
        <div style="font-family:${MONO};font-size:13px;color:#6b7280;margin-top:3px;word-break:break-word;">${esc(row.model)}</div>
      </td>
      <td align="right" style="padding:10px 8px;border-bottom:1px solid #f1f5f9;font-family:${FONT};font-size:14px;white-space:nowrap;">
        <strong>${row.calls} 次</strong><br>
        <span style="color:#6b7280;">${tok(row.totalTokens)} Token</span>
      </td>
      <td style="padding:10px 0 10px 8px;border-bottom:1px solid #f1f5f9;font-family:${MONO};font-size:12px;line-height:1.7;color:#4b5563;white-space:nowrap;">
        命中 ${tok(row.cachedTokens)}<br>
        未命中 ${tok(uncached)}<br>
        输出 ${tok(row.completionTokens)}
      </td>
    </tr>`;
  }).join('');
  const more = modelUsage.rows.length > 20
    ? `<div style="font-family:${FONT};font-size:13px;color:#9ca3af;padding-top:8px;">另有 ${modelUsage.rows.length - 20} 个模型未展开。</div>`
    : '';
  const missing = modelUsage.missingTokens > 0
    ? `<div style="font-family:${FONT};font-size:13px;color:#b45309;padding-top:8px;">另有无会话留档的辅助调用 ${tok(modelUsage.missingTokens)} Token，无法细分到模型。</div>`
    : '';
  const extra = modelUsage.extraTokens > 0
    ? `<div style="font-family:${FONT};font-size:13px;color:#b45309;padding-top:8px;">会话明细比当天台账多 ${tok(modelUsage.extraTokens)} Token，可能是最后一次台账快照发生在午夜之前。</div>`
    : '';
  return `<div style="font-family:${FONT};font-size:14px;color:#6b7280;padding:10px 0 4px;">模型调用合计 ${modelUsage.calls} 次</div>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0">${rows}</table>${missing}${extra}${more}`;
}

function htmlFeatureUsage(featureUsage, featureServices) {
  const listOf = (kind) => featureUsage?.[kind] || [];
  const totalCalls = (kind) => listOf(kind).reduce((total, row) => total + row.calls, 0);
  const modelLines = (rows, empty, imageMode = false, serviceKind = '') => {
    if (!rows.length) {
      return `<div style="font-family:${FONT};font-size:13px;color:#9ca3af;line-height:1.8;">${esc(empty)}</div>`;
    }
    return rows.map((row) => {
      const imageNote = imageMode && row.images > 0 ? ` · ${row.sessions} 个含图会话 / ${row.images} 张图` : '';
      const service = serviceKind ? `实际服务：${recordedFeatureService(serviceKind, row)} · ` : '';
      return `<div style="font-family:${MONO};font-size:12px;line-height:1.75;color:#6b7280;word-break:break-word;">${esc(service)}发起模型 ${esc(row.platform)}｜${esc(row.model)} · ${row.calls} 次${esc(imageNote)}</div>`;
    }).join('');
  };
  const block = (title, summary, rows, empty, imageMode = false, serviceKind = '') => `<div style="padding:11px 0;border-bottom:1px solid #f1f5f9;">
    <div style="font-family:${FONT};font-size:14px;font-weight:600;color:#111827;">${esc(title)}</div>
    <div style="font-family:${FONT};font-size:13px;color:#6b7280;line-height:1.8;margin:3px 0;">${esc(summary)}</div>
    ${modelLines(rows, empty, imageMode, serviceKind)}
  </div>`;

  const visionInputs = listOf('visionInput').reduce((total, row) => ({
    sessions: total.sessions + row.sessions,
    images: total.images + row.images
  }), { sessions: 0, images: 0 });
  const visionToolRows = [...listOf('visionInput'), ...listOf('visionTool')];
  return block(
    '搜索',
    `当前配置（仅供参考）：${featureServices?.searchLabel || '未配置'} · ${totalCalls('search')} 次搜索工具调用`,
    listOf('search'),
    '无模型发起的搜索工具调用。',
    false,
    'search'
  ) + block(
    '网页读取',
    `${totalCalls('fetch')} 次网页读取工具调用`,
    listOf('fetch'),
    '无模型发起的网页读取工具调用。'
  ) + block(
    '语音转文字',
    `当前配置（仅供参考）：${featureServices?.asrLabel || '未配置'}｜${featureServices?.asrModel || '未配置模型'} · ${totalCalls('asr')} 次工具调用`,
    listOf('asr'),
    '无模型发起的语音转文字调用。',
    false,
    'asr'
  ) + block(
    '识图',
    `${visionInputs.sessions} 个含图会话 / ${visionInputs.images} 张图 · ${totalCalls('visionTool')} 次识图工具调用`,
    visionToolRows,
    '无含图请求或识图工具调用。',
    true
  );
}

function htmlAttention(items) {
  return items.map((item) => `<div style="margin-top:8px;padding:10px 12px;background:#fffbeb;border:1px solid #fde68a;border-radius:7px;font-family:${FONT};font-size:14px;line-height:1.7;color:#92400e;">⚠ ${esc(item)}</div>`).join('');
}

function htmlAnalysis(analysis) {
  return `<div style="margin-top:14px;padding:12px 14px;background:#f9fafb;border-left:3px solid #d1d5db;border-radius:6px;">
  <div style="font-family:${FONT};font-size:13px;font-weight:600;color:#6b7280;margin-bottom:6px;">AI 分析</div>
  <div style="font-family:${FONT};font-size:14px;line-height:1.9;color:#374151;">${esc(analysis).replace(/\n/g, '<br>')}</div>
</div>`;
}

const FOOTNOTE = '本邮件由服务器上的定时任务自动生成 · 估算费用按服务商官方价格与 Token 用量计算，不等同于实际账单；账户余额仅在服务商提供查询接口时显示。';

function buildReportHtml({
  dayKey,
  hist,
  balance,
  prevBalance,
  incidents = [],
  analysis = null,
  trend = null,
  modelUsage = null,
  featureUsage = null,
  featureServices = null,
  budget = null,
  delivery = null,
  mailFailure = null,
  reportState = null,
  late = false
}) {
  const weekday = new Intl.DateTimeFormat('zh-CN', { timeZone: TZ, weekday: 'long' })
    .format(new Date(`${dayKey}T12:00:00+08:00`));
  let body = '';

  const cacheRate = hist && hist.promptTokens > 0 ? (hist.cachedTokens / hist.promptTokens) * 100 : null;
  const uncached = hist ? Math.max(0, num(hist.promptTokens) - num(hist.cachedTokens)) : 0;
  const overview = hist
    ? htmlRows([
      { label: '运行次数', value: `${hist.runs} 次` },
      { label: '总 Token', value: tok(hist.totalTokens) },
      { label: '输入 Token（缓存命中）', value: `${tok(hist.cachedTokens)}${cacheRate == null ? '' : ` · ${cacheRate.toFixed(1)}%`}` },
      { label: '输入 Token（未命中缓存）', value: tok(uncached) },
      { label: '输出 Token', value: tok(hist.completionTokens) },
      { label: '估算费用', value: yuan(hist.estimatedYuan), strong: true },
      { label: '搜索工具调用次数', value: `${hist.webSearchCount} 次` }
    ])
    : `<div style="font-family:${FONT};font-size:14px;color:#9ca3af;padding:12px 0;">该统计日无台账快照（机器人服务可能未运行）。</div>`;
  body += htmlSection(`昨日核心概览 · ${dayKey}`, overview);
  body += htmlYesterdayPie(hist, dayKey);
  body += htmlSection('平台与模型调用', htmlModels(modelUsage));
  body += htmlSection('功能调用明细', htmlFeatureUsage(featureUsage, featureServices));

  let trendHtml = '';
  if (trend?.presentDays > 0) {
    const compare = trend.changePct == null
      ? `近 7 日有记录 ${trend.presentDays} 天`
      : `昨日估算费用较近 7 日均值 ${trend.changePct >= 0 ? '+' : ''}${trend.changePct.toFixed(1)}%`;
    const dayOverDay = trend.dayOverDayCostPct == null
      ? ''
      : `<br>较前一日：费用 ${signedPct(trend.dayOverDayCostPct)} · 运行次数 ${signedPct(trend.dayOverDayRunsPct)} · 总 Token ${signedPct(trend.dayOverDayTokensPct)}`;
    const chartRows = trend.chartRows || trend.rows;
    trendHtml = htmlTokenChart(chartRows)
      + `<div style="font-family:${FONT};font-size:14px;color:#6b7280;line-height:1.8;padding-top:12px;">${esc(compare)}<br>日均费用 ${yuan(trend.avgCost)} · 预计月度费用 ${yuan(trend.projectedMonthYuan)}${dayOverDay}</div>`
      + htmlTrend(chartRows);
  } else {
    trendHtml = `<div style="font-family:${FONT};font-size:14px;color:#9ca3af;padding:12px 0;">历史数据不足，暂不计算趋势。</div>`;
  }
  body += htmlSection('趋势与预测', trendHtml);

  let balanceHtml;
  if (balance?.ok) {
    const delta = prevBalance != null ? balance.total - prevBalance : null;
    const runway = trend?.avgCost > 0 ? balance.total / trend.avgCost : null;
    balanceHtml = `<div style="padding:14px 0 4px;">
      <div style="font-family:${FONT};font-size:28px;font-weight:600;color:#111827;line-height:1.2;">${yuan(balance.total)}</div>
      <div style="font-family:${FONT};font-size:14px;color:#6b7280;margin-top:4px;">DeepSeek 账户余额${delta == null ? '' : `，较上一份简报 ${delta >= 0 ? '+' : '-'}${Math.abs(delta).toFixed(2)} 元`}</div>
      ${runway == null ? '' : `<div style="font-family:${FONT};font-size:14px;color:#6b7280;margin-top:4px;">按近 7 日均值估算，余额预计可用 ${runway.toFixed(1)} 天</div>`}
    </div>`;
  } else {
    balanceHtml = `<div style="font-family:${FONT};font-size:14px;color:#9ca3af;padding:12px 0;">${esc(balance?.reason || '当前服务商没有接入余额查询')}</div>`;
  }
  body += htmlSection('当前账户余额', balanceHtml);

  let incidentHtml;
  if (!incidents.length) {
    incidentHtml = `<div style="font-family:${FONT};font-size:14px;color:#9ca3af;padding:12px 0;">该统计日无异常。</div>`;
  } else {
    const recurring = incidents.filter((i) => incidentIsRecurring(i, dayKey)).length;
    incidentHtml = `<div style="font-family:${FONT};font-size:14px;color:#6b7280;padding:10px 0 2px;">${severitySummary(incidents)}。新增异常 ${incidents.length - recurring} 项，持续异常 ${recurring} 项。</div>`
      + htmlIncidents(incidents, dayKey)
      + (analysis ? htmlAnalysis(analysis) : '');
  }
  body += htmlSection('异常', incidentHtml);

  const lastReport = reportState ? lastSuccessfulReportBefore(reportState, dayKey) : null;
  const deliveryHtml = htmlRows([
    { label: '上次简报发送成功', value: lastReport ? new Date(lastReport.sentAt).toLocaleString('zh-CN', { hour12: false, timeZone: TZ }) : '无历史记录' },
    { label: '通知队列', value: `${delivery?.outboxPending || 0} 封待发` },
    { label: '投递失败通知', value: `${delivery?.outboxFailed || 0} 封`, color: delivery?.outboxFailed ? '#b45309' : '#111827' }
  ]);
  body += htmlSection('运行与投递', deliveryHtml);

  const attention = [];
  if (hist?.unpricedRuns > 0) attention.push(`${hist.unpricedRuns} 次运行未匹配价格，估算费用偏低。`);
  if (budget) attention.push(budget.line);
  if (mailFailure) attention.push(mailFailure.line);
  if (balance?.supported === false) attention.push(`余额查询：${balance.reason}。`);
  else if (balance && !balance.ok) attention.push(`余额读取失败：${balance.reason}。`);
  if (delivery?.outboxFailed > 0) attention.push(`通知队列有 ${delivery.outboxFailed} 封投递失败通知。`);
  if (late) attention.push('本封为补发邮件；常规发送时段为每天 08:00。');
  if (attention.length) body += htmlSection('需要你注意', htmlAttention(attention));

  const preheader = hist
    ? `${dayKey}：${hist.runs} 次运行，估算 ${yuan(hist.estimatedYuan)}，${incidents.length} 条异常`
    : `${dayKey}：无运行台账`;
  const accent = attention.some((item) => /预算|失败/.test(item)) ? '#b45309' : '#2563eb';
  return mailShell({
    accent,
    title: '运行简报',
    subtitle: `昨日统计 ${dayKey}（${weekday}） · 邮件生成于 ${String(now.hour).padStart(2, '0')}:${String(now.minute).padStart(2, '0')}${late ? ' · 补发' : ''}`,
    body,
    footnote: FOOTNOTE,
    preheader
  });
}

function buildSevereHtml({ incidents, analysis }) {
  const body = htmlSection('需立即处理的异常', htmlIncidents(incidents) + (analysis ? htmlAnalysis(analysis) : ''))
    + htmlSection('说明', `<div style="font-family:${FONT};font-size:14px;line-height:1.9;color:#6b7280;padding:10px 0;">严重 / 错误级异常立刻发这一封；警告级不单独发送，每天 08:00 汇总在运行简报里。控制台「异常处理」页可以确认 / 解决。</div>`);
  return mailShell({
    accent: '#dc2626',
    title: '异常提醒',
    subtitle: new Date().toLocaleString('zh-CN', { timeZone: TZ, hour12: false }),
    body,
    footnote: FOOTNOTE
  });
}

function runSelfTests() {
  const checks = [];
  const check = (name, condition) => {
    if (!condition) throw new Error(name);
    checks.push(name);
  };

  check('完整数字格式', fullInt(2163932) === '2,163,932');
  const mixedBalance = parseDeepseekBalance({
    is_available: true,
    balance_infos: [
      { currency: 'USD', total_balance: '10' },
      { currency: 'CNY', total_balance: '20' }
    ]
  });
  check('余额优先 CNY', mixedBalance.ok && mixedBalance.total === 20 && mixedBalance.currency === 'CNY');
  const usdOnly = parseDeepseekBalance({ balance_infos: [{ currency: 'USD', total_balance: '10' }] });
  check('非 CNY 不冒充人民币', !usdOnly.ok && usdOnly.reason.includes('USD'));
  const pie = makeUsagePiePng({ cachedTokens: 600, promptTokens: 800, completionTokens: 50 }, 96);
  check('饼图 PNG 签名', pie.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])));
  check('饼图 PNG 尺寸', pie.readUInt32BE(16) === 96 && pie.readUInt32BE(20) === 96);
  const mime = buildMimeBody({
    text: 'plain',
    html: '<img src="cid:yesterday-usage-pie@qq-bot.local">',
    inlineImages: [{ cid: YESTERDAY_PIE_CID, data: pie, filename: 'yesterday-usage.png' }]
  });
  check('内嵌图片 MIME', mime.includes('multipart/related') && mime.includes(`Content-ID: <${YESTERDAY_PIE_CID}>`) && mime.includes('image/png'));
  const pieHtml = buildReportHtml({
    dayKey: '2026-10-20',
    hist: { promptTokens: 850, cachedTokens: 600, completionTokens: 50, totalTokens: 900, runs: 1, estimatedYuan: 0.01, webSearchCount: 0, unpricedRuns: 0 },
    balance: { ok: false, supported: true, reason: '测试不发余额' },
    trend: { presentDays: 0, todayHist: { promptTokens: 1, completionTokens: 1, totalTokens: 2, cachedTokens: 0 } },
    modelUsage: null,
    featureUsage: {},
    featureServices: {},
    incidents: [],
    late: false
  });
  check('饼图固定昨日统计日', pieHtml.includes('昨日 Token 构成 · 2026-10-20'));
  check('饼图不再冒充今日实时', !pieHtml.includes('今日实时 Token 构成'));

  const oldMap = { '2025-01-01': 1, '2026-01-01': 2 };
  pruneDayMap(oldMap, '2026-01-01');
  check('状态文件保留期', !('2025-01-01' in oldMap) && oldMap['2026-01-01'] === 2);

  const catchup = pendingReportDays({ lastSuccessfulDayKey: '2026-10-18', reports: {} }, '2026-10-21');
  check('补发顺序', catchup.join(',') === '2026-10-19,2026-10-20');

  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-agent-report-test-'));
  try {
    const sessionsDir = path.join(tempRoot, 'sessions');
    const trashDir = path.join(sessionsDir, '.trash');
    fs.mkdirSync(trashDir, { recursive: true });
    const at = Date.parse('2026-10-20T12:00:00+08:00');
    const session = {
      id: 'known',
      startedAt: at,
      status: 'done',
      model: 'known-model',
      vendor: 'api.deepseek.com',
      usage: { promptTokens: 800, completionTokens: 50, totalTokens: 850, cachedTokens: 600, calls: 1 },
      messages: [
        {
          role: 'assistant',
          raw: {
            model: 'known-model',
            created: at / 1000,
            usage: { prompt_tokens: 800, completion_tokens: 50, prompt_tokens_details: { cached_tokens: 600 } }
          },
          tool_calls: [{ function: { name: 'web_search' } }]
        },
        {
          toolCall: {
            name: 'web_search',
            result: JSON.stringify({ searchProvider: 'aggregate', searchSources: ['zhipu', 'bing'] })
          }
        }
      ]
    };
    fs.writeFileSync(path.join(sessionsDir, 'known.json'), JSON.stringify(session));
    fs.writeFileSync(path.join(trashDir, 'unknown.json'), JSON.stringify({ ...session, id: 'unknown', vendor: '' }));
    fs.writeFileSync(path.join(sessionsDir, 'unknown-live.json'), JSON.stringify({ ...session, id: 'unknown-live', vendor: '' }));
    const usage = modelUsageForDay('2026-10-20', { totalTokens: 850 }, sessionsDir);
    check('未知渠道无论在活动目录还是回收目录都不计入', usage.rows.length === 1 && usage.rows.every((row) => row.platform !== '未知渠道'));
    check('被过滤的未知渠道不会误报成无留档辅助调用', usage.missingTokens === 0);
    check('搜索实际服务元数据', usage.features.search?.[0]?.service === 'aggregate');
    check('搜索实际来源元数据', usage.features.search?.[0]?.serviceModel === 'zhipu,bing');
  } finally {
    const resolved = path.resolve(tempRoot);
    if (resolved.startsWith(path.resolve(os.tmpdir()) + path.sep)) {
      fs.rmSync(resolved, { recursive: true, force: true });
    }
  }
  return checks;
}

const now = shanghaiParts();

if (process.argv.includes('--self-test')) {
  try {
    const checks = runSelfTests();
    console.log(`self-test: ${checks.length}/${checks.length} passed`);
    process.exit(0);
  } catch (error) {
    console.error(`self-test failed: ${errorSummary(error) || String(error)}`);
    process.exit(1);
  }
}

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
          body: htmlSection('内容', `<div style="font-family:${FONT};font-size:14px;line-height:1.9;color:#111827;white-space:pre-wrap;">${esc(String(item.text || ''))}</div>`),
          footnote: FOOTNOTE
        }),
        text: [`[QQ-bot] ${title}`, at, '', String(item.text || '')].join('\n'),
        messageId: stableMessageId('outbox', [item.id || item.at || '', title, item.text || ''])
      });
      sent += 1;
    } catch (error) {
      failed += 1;
      remain.push({
        ...item,
        failures: (Number(item.failures) || 0) + 1,
        lastError: errorSummary(error) || String(error?.message ?? error).slice(0, 200)
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
function budgetAlertStatus(dayKey) {
  const st = readJson(BUDGET_ALERT_FILE, null);
  if (!st || String(st.dayKey || '') !== String(dayKey || '')) return null;
  const unpriced = Number(st.unpricedRuns) > 0 ? `（另有 ${st.unpricedRuns} 次运行未计价）` : '';
  const policy = st.onExceed === 'block' ? '超限策略＝停止：新消息不处理' : '超限策略＝降级：群里只回应 @';
  return {
    spentYuan: num(st.spentYuan),
    limitYuan: num(st.limitYuan),
    unpricedRuns: num(st.unpricedRuns),
    policy,
    line: `当日估算费用已达上限：${yuan(st.spentYuan)} / ${yuan(st.limitYuan)}${unpriced}；${policy}。`
  };
}

function budgetAlertLine(dayKey) {
  return budgetAlertStatus(dayKey)?.line || '';
}

/** 上次转发/发送失败的状态（写进 incident-notify.json，日报里提醒一句）。 */
function mailFailureStatus() {
  const st = readJson(INCIDENT_STATE_FILE, null) || {};
  if (!st.lastFailureAt) return null;
  const at = new Date(Number(st.lastFailureAt)).toLocaleString('zh-CN', { hour12: false, timeZone: TZ });
  const where = st.lastFailureWhere === 'outbox'
    ? '通知邮件'
    : st.lastFailureWhere === 'daily'
      ? '运行简报'
      : '告警邮件';
  const error = String(st.lastFailureError || '').slice(0, 180);
  return {
    at: Number(st.lastFailureAt),
    where,
    error,
    line: `${where}上次投递失败：${at}　${error}`
  };
}

function mailFailureLine() {
  return mailFailureStatus()?.line || '';
}

/**
 * 日报发送状态。旧版本只把 reportedAt 写在 balance-daily 的“发送日”键上，
 * 这里首次运行时自动迁移成“数据日”: 发送日 D 的 reportedAt 实际对应 D-1 的日报。
 */
function loadReportState(bh) {
  const raw = readJson(REPORT_STATE_FILE, null);
  const state = raw && typeof raw === 'object' ? raw : {};
  state.reports = state.reports && typeof state.reports === 'object' ? state.reports : {};
  for (const [sendDay, value] of Object.entries(bh || {})) {
    const targetDay = shiftDay(sendDay, -1);
    if (!value?.reportedAt || state.reports[targetDay]?.sentAt) continue;
    state.reports[targetDay] = {
      sentAt: Number(value.reportedAt),
      messageId: state.reports[targetDay]?.messageId || `legacy-daily-${targetDay}@qq-bot.local`,
      legacy: true
    };
  }
  const sentDays = Object.entries(state.reports)
    .filter(([, value]) => Number(value?.sentAt) > 0)
    .map(([day]) => day)
    .sort();
  if (sentDays.length && sentDays[sentDays.length - 1] > String(state.lastSuccessfulDayKey || '')) {
    state.lastSuccessfulDayKey = sentDays[sentDays.length - 1];
  }
  return state;
}

function pruneDayMap(map, floorDay) {
  for (const day of Object.keys(map || {})) {
    if (day < floorDay) delete map[day];
  }
  return map;
}

function saveReportState(state) {
  pruneDayMap(state.reports, shiftDay(now.dayKey, -REPORT_STATE_RETAIN_DAYS));
  writeJson(REPORT_STATE_FILE, state);
}

function saveBalanceHistory(bh) {
  pruneDayMap(bh, shiftDay(now.dayKey, -BALANCE_RETAIN_DAYS));
  writeJson(BALANCE_FILE, bh);
}

function lastSuccessfulReportBefore(state, beforeDayKey) {
  const day = Object.entries(state.reports || {})
    .filter(([dayKey, value]) => dayKey < beforeDayKey && Number(value?.sentAt) > 0)
    .sort(([a], [b]) => b.localeCompare(a))[0];
  return day ? { dayKey: day[0], sentAt: Number(day[1].sentAt) } : null;
}

function pendingReportDays(state, todayKey) {
  const yesterday = shiftDay(todayKey, -1);
  const floor = shiftDay(todayKey, -REPORT_CATCHUP_DAYS);
  let day = state.lastSuccessfulDayKey ? shiftDay(state.lastSuccessfulDayKey, 1) : yesterday;
  if (day < floor) day = floor;
  const out = [];
  for (; day <= yesterday; day = shiftDay(day, 1)) {
    if (!state.reports?.[day]?.sentAt) out.push(day);
  }
  return out;
}

function recentUsage(hist, endDayKey, count = 7) {
  const rows = [];
  for (let i = count - 1; i >= 0; i -= 1) {
    const dayKey = shiftDay(endDayKey, -i);
    rows.push({ dayKey, hist: hist[dayKey] || null });
  }
  return rows;
}

function usageTrend(hist, endDayKey) {
  const rows = recentUsage(hist, endDayKey, 7);
  const present = rows.filter((row) => row.hist);
  const sum = (field) => present.reduce((total, row) => total + num(row.hist[field]), 0);
  const count = present.length;
  const avgCost = count ? sum('estimatedYuan') / count : 0;
  const avgTokens = count ? sum('totalTokens') / count : 0;
  const avgRuns = count ? sum('runs') / count : 0;
  const yesterday = hist[endDayKey] || null;
  const previous = hist[shiftDay(endDayKey, -1)] || null;
  const changePct = avgCost > 0 && yesterday
    ? ((num(yesterday.estimatedYuan) - avgCost) / avgCost) * 100
    : null;
  const changeFrom = (field) => {
    if (!yesterday || !previous || num(previous[field]) <= 0) return null;
    return ((num(yesterday[field]) - num(previous[field])) / num(previous[field])) * 100;
  };
  return {
    rows,
    presentDays: count,
    avgCost,
    avgTokens,
    avgRuns,
    changePct,
    dayOverDayCostPct: changeFrom('estimatedYuan'),
    dayOverDayRunsPct: changeFrom('runs'),
    dayOverDayTokensPct: changeFrom('totalTokens'),
    projectedMonthYuan: avgCost * 30.4,
    maxCost: present.reduce((max, row) => Math.max(max, num(row.hist.estimatedYuan)), 0)
  };
}

function cachedTokensFromUsage(usage = {}) {
  return num(
    usage.prompt_tokens_details?.cached_tokens
    ?? usage.prompt_cache_hit_tokens
    ?? usage.cached_tokens
  );
}

/**
 * 按会话留档统计某个统计日各“渠道 / 模型”的调用明细。
 * 会话消息里的 raw.usage 是逐次 API 调用；没有 raw 时退回会话汇总。
 */
function modelUsageForDay(dayKey, hist = null, sessionsDir = SESSIONS_DIR) {
  const [from, to] = dayRangeMs(dayKey);
  const groups = new Map();
  const featureGroups = new Map();
  const platformMap = platformDisplayMap();
  let ignoredUnknownTokens = 0;
  let files = [];
  try { files = fs.readdirSync(sessionsDir).filter((file) => file.endsWith('.json')); } catch {
    return { rows: [], calls: 0, totalTokens: 0, missingTokens: num(hist?.totalTokens), features: {} };
  }
  const mtimeFloor = from - 6 * 3600 * 1000;

  const addRow = ({ vendor, model, at, promptTokens, completionTokens, cachedTokens, calls }) => {
    if (at < from || at >= to) return;
    const prompt = num(promptTokens);
    const completion = num(completionTokens);
    const cached = Math.min(prompt, num(cachedTokens));
    if (!prompt && !completion) return;
    const rawPlatform = String(vendor || '').trim();
    if (!rawPlatform) {
      ignoredUnknownTokens += prompt + completion;
      return;
    }
    const platform = platformMap.get(rawPlatform.toLowerCase()) || rawPlatform;
    const modelId = String(model || '未知模型').trim() || '未知模型';
    const key = `${platform}\u0000${modelId}`;
    const row = groups.get(key) || {
      platform,
      model: modelId,
      calls: 0,
      promptTokens: 0,
      completionTokens: 0,
      cachedTokens: 0,
      totalTokens: 0
    };
    row.calls += Math.max(1, num(calls) || 1);
    row.promptTokens += prompt;
    row.completionTokens += completion;
    row.cachedTokens += cached;
    row.totalTokens += prompt + completion;
    groups.set(key, row);
  };
  const addFeature = ({
    kind, vendor, model, at, calls = 1, images = 0, sessions = 0,
    service = '', serviceModel = '', serviceRoute = ''
  }) => {
    if (at < from || at >= to) return;
    const rawPlatform = String(vendor || '').trim();
    if (!rawPlatform) return;
    const platform = platformMap.get(rawPlatform.toLowerCase()) || rawPlatform;
    const modelId = String(model || '未知模型').trim() || '未知模型';
    if (!platform && !modelId) return;
    const key = `${kind}\u0000${platform}\u0000${modelId}\u0000${service}\u0000${serviceModel}\u0000${serviceRoute}`;
    const row = featureGroups.get(key) || {
      kind,
      platform,
      model: modelId,
      service: String(service || ''),
      serviceModel: String(serviceModel || ''),
      serviceRoute: String(serviceRoute || ''),
      calls: 0,
      images: 0,
      sessions: 0
    };
    row.calls += num(calls);
    row.images += num(images);
    row.sessions += num(sessions);
    featureGroups.set(key, row);
  };
  const featureKindOfTool = (name) => {
    if (name === 'web_search') return 'search';
    if (name === 'web_fetch') return 'fetch';
    if (name === 'get_message_audio') return 'asr';
    if (name === 'get_message_images' || name === 'get_sticker_image' || name === 'read_image_text') return 'visionTool';
    return '';
  };

  for (const file of files) {
    const filePath = path.join(sessionsDir, file);
    try { if (fs.statSync(filePath).mtimeMs < mtimeFloor) continue; } catch { continue; }
    let session;
    try { session = JSON.parse(fs.readFileSync(filePath, 'utf8')); } catch { continue; }
    const startedAt = Number(session.startedAt) || 0;
    if (!startedAt) continue;
    let foundCall = false;
    let currentVendor = session.vendor;
    let currentModel = session.model;
    let currentAt = startedAt;
    for (const message of (session.messages || [])) {
      const raw = message?.raw;
      const at = Number(raw?.created) ? Number(raw.created) * 1000 : startedAt;
      if (raw && typeof raw === 'object') {
        currentAt = at;
        currentModel = raw.model || currentModel;
        if (raw.usage) {
          addRow({
            vendor: currentVendor,
            model: currentModel,
            at,
            promptTokens: raw.usage.prompt_tokens,
            completionTokens: raw.usage.completion_tokens,
            cachedTokens: cachedTokensFromUsage(raw.usage),
            calls: 1
          });
          foundCall = true;
        }
      }
      if (message?.toolCall) {
        const name = String(message.toolCall.name || '');
        const kind = featureKindOfTool(name);
        if (kind) {
          const resultText = String(message.toolCall.result || '');
          let metadata = {};
          try { metadata = JSON.parse(resultText); } catch { metadata = {}; }
          const field = (key) => {
            if (metadata[key] != null) return String(metadata[key]);
            const match = resultText.match(new RegExp(`"${key}"\\s*:\\s*"([^"]*)"`));
            return match ? match[1] : '';
          };
          addFeature({
            kind,
            vendor: currentVendor,
            model: currentModel,
            at: currentAt,
            service: field('searchProvider') || field('asrProvider'),
            serviceModel: kind === 'search'
              ? field('searchSources')
              : field('asrModel'),
            serviceRoute: field('asrRoute')
          });
        }
      }
    }
    if (!foundCall && session.usage) {
      addRow({
        vendor: session.vendor,
        model: session.model,
        at: startedAt,
        promptTokens: session.usage.promptTokens,
        completionTokens: session.usage.completionTokens,
        cachedTokens: session.usage.cachedTokens,
        calls: session.usage.calls
      });
    }
    const imageParts = (session.inputMessages || []).reduce((total, message) => (
      total + (Array.isArray(message?.content)
        ? message.content.filter((part) => part?.type === 'image_url').length
        : 0)
    ), 0);
    if (imageParts > 0) {
      addFeature({
        kind: 'visionInput',
        vendor: session.vendor,
        model: session.model,
        at: startedAt,
        calls: 0,
        images: imageParts,
        sessions: 1
      });
    }
  }

  const rows = [...groups.values()].sort((a, b) => b.totalTokens - a.totalTokens);
  const calls = rows.reduce((total, row) => total + row.calls, 0);
  const totalTokens = rows.reduce((total, row) => total + row.totalTokens, 0);
  const features = {};
  for (const row of featureGroups.values()) {
    (features[row.kind] ||= []).push(row);
  }
  for (const list of Object.values(features)) {
    list.sort((a, b) => b.calls - a.calls || b.images - a.images || a.platform.localeCompare(b.platform));
  }
  return {
    rows,
    calls,
    totalTokens,
    missingTokens: Math.max(0, num(hist?.totalTokens) - totalTokens - ignoredUnknownTokens),
    extraTokens: Math.max(0, totalTokens + ignoredUnknownTokens - num(hist?.totalTokens)),
    features
  };
}

function deliveryStatus() {
  const box = readJson(MAIL_OUTBOX_FILE, null) || {};
  const items = Array.isArray(box.items) ? box.items : [];
  return {
    outboxPending: items.length,
    outboxFailed: items.filter((item) => Number(item.failures) > 0).length,
    outboxLastRunAt: Number(box.lastRunAt) || 0
  };
}

async function buildReportContext(dayKey, bh, hist, { incidents = null } = {}) {
  const balance = await balanceSnapshot();
  const allIncidents = incidents || await fetchIncidents().catch(() => []);
  const dayList = dayIncidents(dayKey, allIncidents);
  const analysis = dayList.length ? await analyzeIncidents(dayList) : null;
  const modelUsage = modelUsageForDay(dayKey, hist[dayKey] || null);
  const todayLedger = readJson(TODAY_FILE, null);
  const todayHist = todayLedger?.dayKey === now.dayKey
    ? {
        promptTokens: num(todayLedger.promptTokens),
        completionTokens: num(todayLedger.completionTokens),
        totalTokens: num(todayLedger.totalTokens),
        cachedTokens: num(todayLedger.cachedTokens),
        runs: num(todayLedger.runs),
        webSearchCount: num(todayLedger.webSearchCount),
        estimatedYuan: num(todayLedger.estimatedYuan),
        unpricedRuns: num(todayLedger.unpricedRuns)
      }
    : null;
  const trend = usageTrend(hist, dayKey);
  trend.todayHist = todayHist;
  trend.chartRows = [
    ...recentUsage(hist, shiftDay(now.dayKey, -1), 7),
    { dayKey: now.dayKey, hist: todayHist, live: true }
  ];
  const prevKeys = Object.keys(bh)
    .filter((key) => key < shiftDay(dayKey, 1) && bh[key]?.total != null)
    .sort();
  const prevBalance = prevKeys.length ? bh[prevKeys[prevKeys.length - 1]].total : null;
  const expectedSendDay = shiftDay(dayKey, 1);
  return {
    dayKey,
    hist: hist[dayKey] || null,
    balance,
    prevBalance,
    incidents: dayList,
    analysis,
    trend,
    modelUsage,
    featureUsage: modelUsage.features || {},
    featureServices: featureServiceLabels(),
    budget: budgetAlertStatus(dayKey),
    delivery: deliveryStatus(),
    mailFailure: mailFailureStatus(),
    reportState: loadReportState(bh),
    late: now.dayKey !== expectedSendDay || now.hour > REPORT_HOUR || (now.hour === REPORT_HOUR && now.minute > 0)
  };
}

function reportSubject(ctx) {
  const parts = [`[QQ-bot] 运行简报｜昨日 ${ctx.dayKey.slice(5)}`];
  if (ctx.hist) {
    parts.push(`${yuan(ctx.hist.estimatedYuan)} · ${ctx.hist.runs} 次`);
  } else {
    parts.push('无运行记录');
  }
  parts.push(ctx.incidents.length ? `${ctx.incidents.length} 项异常` : '运行正常');
  if (ctx.late) parts.push('补发');
  return parts.join('｜');
}

if (process.argv.includes('--test-mail')) {
  const hist = readJson(HISTORY_FILE, {});
  const bh = readJson(BALANCE_FILE, {});
  const yKey = shiftDay(now.dayKey, -1);
  const ctx = await buildReportContext(yKey, bh, hist);
  ctx.late = false;
  const body = [
    '这是一封测试邮件，用来确认邮件通道和最新版运行简报结构正常。',
    '',
    buildReport(ctx),
    '',
    '（正式运行简报每天 08:00 后发一封，以昨日统计为主并附今日实时参考；任务中断后会在恢复运行时补发。）'
  ].join('\n');
  try {
    const res = await sendMail({
      subject: '[QQ-bot] 运行简报通道测试',
      text: body,
      html: buildReportHtml(ctx),
      messageId: stableMessageId('daily-test', [Date.now()]),
      inlineImages: reportInlineImages(ctx)
    });
    console.log(`测试邮件已发送到 ${res.to}（发件人显示名：${res.fromName}）`);
  } catch (error) {
    console.log(`测试邮件发送失败：${errorSummary(error)}`);
    process.exit(1);
  }
  process.exit(0);
}

if (DRY) {
  const hist = readJson(HISTORY_FILE, {});
  const bh = readJson(BALANCE_FILE, {});
  const yKey = shiftDay(now.dayKey, -1);
  const ctx = await buildReportContext(yKey, bh, hist);
  console.log(`（演练，不发送。现在是 ${now.dayKey} ${now.hour}:${String(now.minute).padStart(2, '0')}）`);
  console.log(buildReport(ctx));
  const inc = await forwardIncidents({ dry: true }).catch((e) => ({ error: errorSummary(e) }));
  if (inc.error) console.log(`\n[告警转发] 查询失败：${inc.error}`);
  else if (inc.seeded) console.log(`\n[告警转发] 尚未开始（当前 ${inc.total} 条），正式运行会把它们记为"已见"、不补发`);
  else console.log(`\n[告警转发] 现在有 ${inc.fresh.length} 条新告警待发（当前共 ${inc.total} 条）`);
  const boxDry = await forwardMailOutbox({ dry: true }).catch(() => ({ pending: 0 }));
  console.log(`[通知队列] 演练：队列里 ${boxDry.pending} 封待发通知邮件`);
  if (ctx.budget) console.log(`[预算] ${ctx.budget.line}`);
  if (ctx.mailFailure) console.log(`[投递] ${ctx.mailFailure.line}`);
  process.exit(0);
}

// 1) 每次跑都做快照（幂等，同一个 dayKey 覆盖）
const snapped = snapshot();

// 2) 顺便把新告警转发到邮箱（失败不影响日报）
try {
  const inc = await forwardIncidents();
  if (inc.fresh.length) console.log(`[${new Date().toISOString()}] 已转发 ${inc.fresh.length} 条新告警`);
} catch (error) {
  const detail = errorSummary(error);
  console.log(`[${new Date().toISOString()}] 告警转发失败：${detail}`);
  // 让日报能提醒"有东西没发出去"（状态文件本来就存在，加两个字段，不动 seen）
  try {
    const st = readJson(INCIDENT_STATE_FILE, null) || {};
    writeJson(INCIDENT_STATE_FILE, {
      ...st,
      lastFailureAt: Date.now(),
      lastFailureWhere: 'incident',
      lastFailureError: detail
    });
  } catch { /* 状态写不进去就算了 */ }
}

// 3) 程序侧排队的通知（更新 / 好友申请 …）也在这里发出去
try {
  await forwardMailOutbox();
} catch (error) {
  const detail = errorSummary(error);
  console.log(`[${new Date().toISOString()}] 通知队列处理失败：${detail}`);
  try {
    const st = readJson(INCIDENT_STATE_FILE, null) || {};
    writeJson(INCIDENT_STATE_FILE, {
      ...st,
      lastFailureAt: Date.now(),
      lastFailureWhere: 'outbox',
      lastFailureError: detail
    });
  } catch { /* 同上 */ }
}

// 4) 08:00 后检查未发送的日报；任务中断或 SMTP 临时失败时，在后续运行补发。
const reportKey = now.dayKey;
let bh = readJson(BALANCE_FILE, {});
if (now.hour >= REPORT_HOUR) {
  let state = loadReportState(bh);
  const pendingDays = pendingReportDays(state, reportKey);
  const hist = readJson(HISTORY_FILE, {});
  for (const targetDay of pendingDays) {
    const ctx = await buildReportContext(targetDay, bh, hist);
    const text = buildReport(ctx);
    const messageId = stableMessageId('daily', [targetDay]);
    try {
      const res = await sendMail({
        subject: reportSubject(ctx),
        text,
        html: buildReportHtml(ctx),
        messageId,
        inlineImages: reportInlineImages(ctx)
      });
      const sentAt = Date.now();
      state = loadReportState(bh);
      state.reports[targetDay] = {
        sentAt,
        messageId,
        late: ctx.late,
        subject: reportSubject(ctx)
      };
      state.lastSuccessfulDayKey = targetDay;
      state.lastSuccessAt = sentAt;
      delete state.lastFailureAt;
      delete state.lastFailureError;
      saveReportState(state);
      const markerDay = shiftDay(targetDay, 1);
      bh[markerDay] = {
        ...(bh[markerDay] || {}),
        reportedAt: sentAt,
        total: ctx.balance?.ok ? ctx.balance.total : null,
        reportDayKey: targetDay
      };
      saveBalanceHistory(bh);
      console.log(`[${new Date().toISOString()}] 运行简报已发送到 ${res.to}\n${text}`);
    } catch (error) {
      const detail = errorSummary(error);
      state = loadReportState(bh);
      state.lastAttemptAt = Date.now();
      state.lastAttemptDayKey = targetDay;
      state.lastFailureAt = Date.now();
      state.lastFailureError = detail;
      saveReportState(state);
      try {
        const st = readJson(INCIDENT_STATE_FILE, null) || {};
        writeJson(INCIDENT_STATE_FILE, {
          ...st,
          lastFailureAt: Date.now(),
          lastFailureWhere: 'daily',
          lastFailureError: detail
        });
      } catch { /* 状态写不进去就算了 */ }
      console.log(`[${new Date().toISOString()}] 运行简报发送失败：${detail}\n${text}`);
      process.exit(1);
    }
  }
}

// 5) 每天第一次跑时把余额也记一笔（用于"较上次"）
bh = readJson(BALANCE_FILE, {});
if (bh[reportKey]?.total == null) {
  const balance = await balanceSnapshot();
  if (balance.ok) {
    bh[reportKey] = { ...(bh[reportKey] || {}), total: balance.total, at: Date.now() };
    saveBalanceHistory(bh);
  }
}

if (process.env.QQ_AGENT_USAGE_VERBOSE === '1') console.log(`[snapshot] dayKey=${snapped}`);
