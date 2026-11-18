#!/usr/bin/env node
/**
 * 家庭打卡中枢（Windows 侧）
 *
 * 职责：① 局域网自动发现（UDP 8788）② 接收手机同步（HTTP 8787）
 *       ③ 双向合并落盘（复用 checkin.mjs 的 data/records 结构）
 *       ④ 本机网页看板
 *
 * 不负责：不做提醒（提醒在手机上本地响），不自动改任何人的数据。
 *
 * 启动：node hub/hub.mjs     或双击 tools\start-hub.cmd
 * 环境变量：CHECKIN_DATA_DIR / HUB_PORT / HUB_UDP_PORT / HUB_TOKEN
 */
import http from 'node:http';
import dgram from 'node:dgram';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { mergeRecords, liveGoals } from './merge.mjs';
import { pickLanInterfaces, subnetBroadcast, isHotspotAddress, announceTargets } from './net.mjs';
import { buildPack, renderPackText, SYSTEM_PROMPT, ALLOWED_DAYS, recordsAsText } from './pack.mjs';
import { renderDashboardPage } from './dashboard.mjs';
import { memberIdProblem, normalizeMemberId } from '../shared/id.mjs';
import { COURT_DEPTS, deptById } from '../court/personas.mjs';
import {
  summon as courtSummon, dispose as courtDispose, reply as courtReply, meeting as courtMeeting,
  listMemorials as courtListMemorials, readMemorial as courtReadMemorial,
} from '../court/agents.mjs';
import {
  ensureCourtDirs, readRoles, roleOf, setRole, appendLedger, listLedger, listItems, appendItem,
  readBudget, setBudget, ROLES as COURT_ROLES, canDispose, ROLE_LABEL as COURT_ROLE_LABEL,
} from '../court/store.mjs';
import { parseLedgerLine, parseLedgerText, summarizeLedger } from '../court/ledger.mjs';
import {
  appendUsage, summarizeUsage, fetchBalance, bjIso as usageIso,
} from '../court/usage.mjs';
import { estimateCny } from '../court/pricing.mjs';
import { dispatchEdict } from '../court/dispatch.mjs';
import { routeByRules } from '../shared/dispatch-rules.mjs';
import { listAnnual, addAnnual, updateAnnual, removeAnnual, ANNUAL_STATUS, ANNUAL_PERIOD, ANNUAL_ADJUST_LIMIT } from '../court/annual.mjs';
import { listTasks, addTask, updateTask, removeTask, TASK_STATUS } from '../court/tasks.mjs';
import { readCourtState, mergeForHub, writeCourtState } from '../court/state.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = process.env.CHECKIN_DATA_DIR
  ? path.resolve(process.env.CHECKIN_DATA_DIR)
  : path.resolve(HERE, '..', 'data');
const RECORD_DIR = path.join(DATA_DIR, 'records');
const MEMBERS_FILE = path.join(DATA_DIR, 'members.json');
const SYNC_LOG = path.join(DATA_DIR, 'sync-log.jsonl');
const ANALYSIS_DIR = path.join(DATA_DIR, 'analyses');
const SETTINGS_FILE = path.join(DATA_DIR, 'settings.json');
const PORT = Number(process.env.HUB_PORT ?? 8787);
const UDP_PORT = Number(process.env.HUB_UDP_PORT ?? 8788);
const TOKEN = (process.env.HUB_TOKEN ?? '').trim();
const RETENTION_MONTHS = Math.min(12, Math.max(1, Number(process.env.HUB_RETENTION_MONTHS ?? 12)));
const VERSION = 2;
const TZ = 'Asia/Shanghai';

/** 设备在线登记表（内存里就够：重启后重新连一次即可） */
const devices = new Map(); // key = `${memberId}::${deviceId}`
const DEVICE_ONLINE_MS = 2 * 60 * 1000;

/* ------------------------------- 工具 ------------------------------- */

const pad = (n) => String(n).padStart(2, '0');

function bjIso(d = new Date()) {
  const s = new Intl.DateTimeFormat('sv-SE', {
    timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  }).format(d);
  return `${s.replace(' ', 'T')}+08:00`;
}

const bjToday = () => bjIso().slice(0, 10);

/** 保留上限（默认 12 个月，最长一年）：返回最早的允许日期 YYYY-MM-01 */
function retentionCutoff() {
  const today = bjToday();
  const [y, m] = today.split('-').map(Number);
  const d = new Date(Date.UTC(y, m - 1 - (RETENTION_MONTHS - 1), 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-01`;
}

/** 删掉超出保留期的旧记录文件，返回删除天数 */
function pruneMemberRetention(memberId) {
  const dir = memberDir(memberId);
  if (!fs.existsSync(dir)) return 0;
  const cutoff = retentionCutoff();
  let removed = 0;
  for (const f of fs.readdirSync(dir)) {
    if (!/^\d{4}-\d{2}-\d{2}\.json$/.test(f)) continue;
    if (f.slice(0, 10) < cutoff) {
      fs.unlinkSync(path.join(dir, f));
      removed += 1;
    }
  }
  return removed;
}

function ensureDirs() {
  fs.mkdirSync(RECORD_DIR, { recursive: true });
  if (!fs.existsSync(MEMBERS_FILE)) fs.writeFileSync(MEMBERS_FILE, '[]\n', 'utf8');
  ensureCourtDirs(DATA_DIR);
}

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
  } catch {
    return fallback;
  }
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  fs.renameSync(tmp, file);
}

function memberDir(memberId) {
  const problem = memberIdProblem(memberId);
  if (problem) {
    const err = new Error(problem);
    err.statusCode = 400;
    throw err;
  }
  return path.join(RECORD_DIR, normalizeMemberId(memberId));
}

function recordPath(memberId, date) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error(`非法日期: ${date}`);
  return path.join(memberDir(memberId), `${date}.json`);
}

function readMemberRecords(memberId, limitDays = 400) {
  let dir;
  try {
    dir = memberDir(memberId);
  } catch {
    return []; // 查别的设备传进来的怪 ID 时不要炸，当作没有记录
  }
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter((f) => /^\d{4}-\d{2}-\d{2}\.json$/.test(f))
    .sort()
    .slice(-limitDays)
    .map((f) => readJson(path.join(dir, f), null))
    .filter(Boolean);
}

function readAllRecords(limitDays = 400) {
  if (!fs.existsSync(RECORD_DIR)) return {};
  const out = {};
  for (const memberId of fs.readdirSync(RECORD_DIR)) {
    const dir = path.join(RECORD_DIR, memberId);
    if (fs.statSync(dir).isDirectory()) out[memberId] = readMemberRecords(memberId, limitDays);
  }
  return out;
}

function upsertMember(memberId, memberName) {
  const members = readJson(MEMBERS_FILE, []);
  const found = members.find((m) => m.id === memberId);
  if (found) {
    if (memberName && found.name !== memberName) {
      found.name = memberName;
      found.updatedAt = bjIso();
      writeJson(MEMBERS_FILE, members);
    }
    return;
  }
  members.push({
    id: memberId,
    name: memberName || memberId,
    active: true,
    shareToFamily: false,
    feishuChatId: null,
    createdAt: bjIso(),
    source: 'app-sync',
  });
  writeJson(MEMBERS_FILE, members);
}

function appendSyncLog(entry) {
  try {
    fs.appendFileSync(SYNC_LOG, `${JSON.stringify(entry)}\n`, 'utf8');
  } catch {
    /* 日志失败不影响同步 */
  }
}

/* --------------------------- 设备在线登记 --------------------------- */

function touchDevice({ memberId, memberName, deviceId, ip, mode }) {
  const key = `${memberId}::${deviceId ?? 'unknown'}`;
  const at = bjIso();
  const prev = devices.get(key) ?? {
    memberId,
    name: memberName ?? memberId,
    deviceId: deviceId ?? null,
    ip: ip ?? null,
    firstSeen: at,
    syncCount: 0,
    autoCount: 0,
    manualCount: 0,
  };
  prev.name = memberName ?? prev.name;
  if (ip) prev.ip = ip;
  prev.lastSeen = at;
  prev.lastMode = mode === 'manual' ? 'manual' : 'auto';
  prev.syncCount += 1;
  if (prev.lastMode === 'manual') prev.manualCount += 1;
  else prev.autoCount += 1;
  devices.set(key, prev);
  return prev;
}

function deviceList() {
  const now = Date.now();
  return [...devices.values()]
    .map((d) => ({ ...d, online: Boolean(d.lastSeen) && now - Date.parse(d.lastSeen) < DEVICE_ONLINE_MS }))
    .sort((a, b) => String(b.lastSeen).localeCompare(String(a.lastSeen)));
}

function recentSyncs(limit = 15) {
  try {
    if (!fs.existsSync(SYNC_LOG)) return [];
    const lines = fs.readFileSync(SYNC_LOG, 'utf8').trim().split('\n').filter(Boolean);
    return lines
      .slice(-limit)
      .reverse()
      .map((line) => {
        try {
          return JSON.parse(line);
        } catch {
          return null;
        }
      })
      .filter(Boolean);
  } catch {
    return [];
  }
}

/* --------------------------- 备份 --------------------------- */

function backupInfo() {
  const members = readJson(MEMBERS_FILE, []);
  const all = readAllRecords();
  const rows = members.map((m) => {
    const recs = all[m.id] ?? [];
    let bytes = 0;
    for (const r of recs) {
      try {
        bytes += fs.statSync(recordPath(m.id, r.date)).size;
      } catch {
        /* 文件可能刚好被移动，忽略 */
      }
    }
    return {
      memberId: m.id,
      name: m.name,
      days: recs.length,
      bytes,
      first: recs[0]?.date ?? null,
      latest: recs.at(-1)?.date ?? null,
    };
  });
  return {
    dataDir: DATA_DIR,
    recordDir: RECORD_DIR,
    analysesDir: ANALYSIS_DIR,
    members: rows,
    totalDays: rows.reduce((a, r) => a + r.days, 0),
    totalBytes: rows.reduce((a, r) => a + r.bytes, 0),
    analyses: fs.existsSync(ANALYSIS_DIR) ? fs.readdirSync(ANALYSIS_DIR).filter((f) => f.endsWith('.json')).length : 0,
  };
}

/** 在电脑上打开数据文件夹（只能在运行中枢的这台机器上生效） */
function openDataFolder(which = '') {
  if (which === 'analyses') fs.mkdirSync(ANALYSIS_DIR, { recursive: true });
  const target = which === 'analyses' ? ANALYSIS_DIR : DATA_DIR;
  fs.mkdirSync(target, { recursive: true });
  const child = spawn('explorer.exe', [target], { detached: true, stdio: 'ignore' });
  child.unref();
  return target;
}

/* --------------------------- 头像 --------------------------- */

const AVATAR_DIR = path.join(DATA_DIR, 'avatars');
const AVATAR_MAX_BYTES = 400 * 1024;

function avatarPath(memberId) {
  return path.join(AVATAR_DIR, `${normalizeMemberId(memberId)}.json`);
}

function hasAvatar(memberId) {
  try {
    return fs.existsSync(avatarPath(memberId));
  } catch {
    return false;
  }
}

function saveAvatar(memberId, dataUrl) {
  const problem = memberIdProblem(memberId);
  if (problem) throw new Error(problem);
  const m = String(dataUrl ?? '').match(/^data:image\/(png|jpeg|jpg|webp);base64,([A-Za-z0-9+/=]+)$/);
  if (!m) {
    const err = new Error('头像格式不对（只收 png/jpeg/webp 的 dataURL）');
    err.statusCode = 400;
    throw err;
  }
  const bytes = Buffer.byteLength(m[2], 'base64');
  if (bytes > AVATAR_MAX_BYTES) {
    const err = new Error(`头像太大了（${Math.round(bytes / 1024)}KB），控制在 400KB 以内`);
    err.statusCode = 400;
    throw err;
  }
  writeJson(avatarPath(memberId), { memberId: normalizeMemberId(memberId), dataUrl, bytes, at: bjIso() });
  return { bytes, at: bjIso() };
}

function readAvatar(memberId) {
  const problem = memberIdProblem(memberId);
  if (problem) return null;
  return readJson(avatarPath(memberId), null);
}

/* --------------------------- 家是小国：奏疏摘要 --------------------------- */

const memorialSummary = (m) => ({
  id: m.id,
  dept: m.dept,
  deptName: m.deptName,
  office: m.office,
  title: m.title,
  status: m.status,
  createdAt: m.createdAt,
  updatedAt: m.updatedAt,
  focus: m.focus ?? '',
  replies: (m.replies ?? []).length,
  dispositions: (m.dispositions ?? []).length,
  chars: (m.body ?? '').length,
  cached: m.cached === true,
});

/* --------------------------- AI 复盘（DeepSeek） --------------------------- */
const DEEPSEEK_DEFAULTS = { baseUrl: 'https://api.deepseek.com', model: 'deepseek-chat' };

/** 没配 key 时，退一步复用这台机器上 dsh 自己的 key（同一个人的机器） */
function readDshCredentialKey() {
  try {
    const file = path.join(os.homedir(), '.dsh', '.credentials.yaml');
    if (!fs.existsSync(file)) return '';
    const text = fs.readFileSync(file, 'utf8');
    const m = text.match(/^\s*DEEPSEEK_API_KEY:\s*(\S+)\s*$/m);
    return m ? m[1].trim() : '';
  } catch {
    return '';
  }
}

function deepseekConfig() {
  if (/^(0|off|false|no)$/i.test(String(process.env.HUB_DEEPSEEK ?? ''))) {
    return { configured: false, reason: '已通过 HUB_DEEPSEEK=off 关闭 AI 复盘' };
  }
  const settings = readJson(SETTINGS_FILE, {}) ?? {};
  const file = settings.deepseek ?? {};
  const dshKey = readDshCredentialKey();
  const apiKey = String(process.env.DEEPSEEK_API_KEY || file.apiKey || dshKey || '').trim();
  const baseUrl = String(process.env.DEEPSEEK_BASE_URL || file.baseUrl || DEEPSEEK_DEFAULTS.baseUrl).replace(/\/+$/, '');
  const model = String(process.env.DEEPSEEK_MODEL || file.model || DEEPSEEK_DEFAULTS.model).trim();
  if (!apiKey) {
    return {
      configured: false,
      reason: `没找到 DeepSeek API Key。可以设环境变量 DEEPSEEK_API_KEY，或在 ${SETTINGS_FILE} 里写 {"deepseek":{"apiKey":"sk-...","model":"deepseek-chat"}}`,
    };
  }
  const source = process.env.DEEPSEEK_API_KEY ? 'env' : file.apiKey ? 'settings.json' : 'dsh-credentials';
  return { configured: true, apiKey, baseUrl, model, source };
}

async function callDeepSeek({ apiKey, baseUrl, model }, system, user) {
  // 测试用：不真的打 API，也不花钱
  if (/^(1|on|true|yes|fake)$/i.test(String(process.env.HUB_DEEPSEEK_FAKE ?? ''))) {
    if (/司礼监掌印/.test(system)) {
      const said = user.replace(/【主上的口谕】/g, '').trim().slice(0, 120);
      return {
        content: JSON.stringify({ items: routeByRules(said).items }),
        usage: { total_tokens: 0, fake: true },
      };
    }
    if (/奏疏|家臣 Agent/.test(system)) {
      const deptName = (system.match(/你是「大内家事」的\s*(\S+?)\s*Agent/) ?? [])[1] ?? '某部';
      return {
        content: [
          '标题：测试奏疏（假模型）',
          `臣 ${deptName} 启奏陛下、皇后娘娘：`,
          '现状：这是假模型生成的固定奏疏，只用于联调流程，不消耗 token。',
          '问题：一、还没有接入真实数据；二、需要配置 DeepSeek key 才能看到真奏疏。',
          '方案：一、先配 key 再看真实内容；二、继续用假模型把流程走通。',
          '臣建议：先把御书房与批阅流程验收完，再切真模型。',
          '伏候圣裁',
        ].join('\n'),
        usage: { total_tokens: 0, fake: true },
      };
    }
    const chip = user.split('\n')[0] ?? '';
    return {
      content: `**【假模型输出】**\n① 现状复盘总结：这是测试用的固定回复（不会消耗 token）。\n${chip.slice(0, 80)}\n② 识别到的问题：这里本来应该是模型分析。\n③ 建议：配置真实 key 后即可看到真实复盘。`,
      usage: { total_tokens: 0, fake: true },
    };
  }
  const res = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
      temperature: 0.6,
      max_tokens: 2200,
      stream: false,
    }),
    signal: AbortSignal.timeout(120000),
  });
  const raw = await res.text();
  let data = null;
  try {
    data = JSON.parse(raw);
  } catch {
    /* 非 JSON 响应，下面统一报错 */
  }
  if (!res.ok) {
    const detail = data?.error?.message ?? raw.slice(0, 200);
    const err = new Error(`DeepSeek 返回 ${res.status}：${detail}`);
    err.statusCode = 502;
    throw err;
  }
  const content = data?.choices?.[0]?.message?.content;
  if (!content) {
    const err = new Error('DeepSeek 没有返回内容');
    err.statusCode = 502;
    throw err;
  }
  return { content: String(content).trim(), usage: data.usage ?? null };
}

/** 一次调用的花费（元）随流水一起存，缓存命中记 0 */
function chargeOf(usage, cached = false) {
  if (cached) return { cost: 0, costEstimated: false, usage: usage ?? null };
  const est = estimateCny(usage ?? {});
  return { cost: est.cny, costEstimated: est.estimated, peak: est.peak, usage: usage ?? null };
}

/**
 * 分析结果缓存：同一个人 + 同一区间 + 数据没变 → 直接复用上次结果，不再调模型（不花 token）。
 * 指纹只看"这段时间的打卡内容"（状态、备注、目标文本），改一个字就会变。
 */
function packFingerprint(pack) {
  const basis = JSON.stringify({
    member: pack.member.id,
    from: pack.range.from,
    to: pack.range.to,
    details: pack.details,
  });
  return createHash('sha1').update(basis).digest('hex').slice(0, 16);
}

/** 每个 (成员, 天数) 最多留这么多份，多了删最旧的 */
const ANALYSES_PER_BUCKET = 10;

function pruneAnalysisBucket(memberId, days) {
  const bucket = listAnalyses(memberId, { limit: 999, perDaysCap: 999 })
    .filter((a) => a.days === days)
    .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  for (const old of bucket.slice(ANALYSES_PER_BUCKET)) {
    try {
      fs.unlinkSync(path.join(ANALYSIS_DIR, `${old.id}.json`));
    } catch {
      /* 删不掉就算了 */
    }
  }
}

async function runAnalysis({ memberId, days, force = false }) {
  const cfg = deepseekConfig();
  if (!cfg.configured) {
    const err = new Error(cfg.reason);
    err.statusCode = 503;
    throw err;
  }
  const pack = buildPack(memberId, { days });
  if (!pack.stats.totalGoals && !pack.stats.submittedDays) {
    const err = new Error(`「${pack.member.name}」这段时间没有记录，先攒几天再分析吧`);
    err.statusCode = 400;
    throw err;
  }

  const fingerprint = packFingerprint(pack);
  if (!force) {
    const cached = listAnalyses(pack.member.id, { limit: 999, perDaysCap: 999 })
      .find((a) => a.days === pack.range.days && a.fingerprint === fingerprint);
    if (cached) {
      return { ...cached, cached: true };
    }
  }

  const started = Date.now();
  const { content, usage } = await callDeepSeek(cfg, SYSTEM_PROMPT, renderPackText(pack));
  const record = {
    id: `${Date.now()}-${pack.member.id}`,
    memberId: pack.member.id,
    memberName: pack.member.name,
    days: pack.range.days,
    from: pack.range.from,
    to: pack.range.to,
    createdAt: bjIso(),
    model: cfg.model,
    keySource: cfg.source,
    fingerprint,
    ms: Date.now() - started,
    usage,
    text: content,
    chars: content.length,
  };
  writeJson(path.join(ANALYSIS_DIR, `${record.id}.json`), record);
  pruneAnalysisBucket(pack.member.id, record.days);
  return { ...record, cached: false };
}

/**
 * 列出分析结果。
 * 默认按 (成员, 天数) 分组，每组只留最新 3 条 —— 用户要求"别把历史堆成一片"。
 */
function listAnalyses(memberId, { limit = 30, perDaysCap = 3 } = {}) {
  if (!fs.existsSync(ANALYSIS_DIR)) return [];
  const files = fs.readdirSync(ANALYSIS_DIR).filter((f) => f.endsWith('.json')).sort().reverse();
  const out = [];
  const perDays = new Map();
  for (const f of files) {
    const a = readJson(path.join(ANALYSIS_DIR, f), null);
    if (!a) continue;
    if (memberId && a.memberId !== memberId) continue;
    const key = `${a.memberId}::${a.days}`;
    const count = perDays.get(key) ?? 0;
    if (count >= perDaysCap) continue;
    perDays.set(key, count + 1);
    out.push(a);
    if (out.length >= limit) break;
  }
  return out;
}

/** 列表里只传摘要，正文另取（历史里点开再要全文） */
const analysisSummary = (a) => ({
  id: a.id,
  memberId: a.memberId,
  memberName: a.memberName,
  days: a.days,
  from: a.from,
  to: a.to,
  createdAt: a.createdAt,
  model: a.model,
  chars: a.chars,
  cached: a.cached === true,
});

/** 每次调模型后回给前端的"账单"：这次花了多少、今天花了多少、账上还剩多少 */
async function quotaSnapshot() {
  const cfg = deepseekConfig();
  const usage = summarizeUsage(DATA_DIR, { limit: 5 });
  const fake = /^(1|on|true|yes|fake)$/i.test(String(process.env.HUB_DEEPSEEK_FAKE ?? ''));
  const balance = fake
    ? { ok: false, error: '假模型模式，不查余额' }
    : cfg.configured
      ? await fetchBalance(cfg)
      : { ok: false, error: '未配置模型 key' };
  return { balance, today: usage.today, month: usage.month, recent: usage.recent.slice(0, 5), price: usage.price };
}

/* ------------------------------- HTTP ------------------------------- */

/**
 * 手机 App 的页面来源是 https://localhost（Capacitor 本地服务），
 * 而中枢是 http://192.168.x.x:8787 —— 跨源请求。没有 CORS 头时，
 * 浏览器/WebView 会直接把响应拦掉，前端只能看到 "Failed to fetch"。
 * 所以每个响应都要带 Access-Control-Allow-Origin，OPTIONS 预检也要回 204。
 */
const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, x-hub-token',
  'Access-Control-Max-Age': '86400',
};

const json = (res, code, body) => {
  const text = `${JSON.stringify(body, null, 2)}\n`;
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(text),
    'Cache-Control': 'no-store',
    ...CORS_HEADERS,
  });
  res.end(text);
};

async function readBody(req, limit = 4 * 1024 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new Error('请求体过大');
    chunks.push(chunk);
  }
  const text = Buffer.concat(chunks).toString('utf8');
  return text ? JSON.parse(text) : {};
}

function authorized(req) {
  if (!TOKEN) return true;
  return req.headers['x-hub-token'] === TOKEN;
}

function handleSync(body, ctx = {}) {
  const memberId = normalizeMemberId(body.memberId);
  if (!memberId) throw new Error('缺少 memberId');
  const problem = memberIdProblem(memberId);
  if (problem) {
    const err = new Error(`${problem}（收到的称呼：${memberId}）`);
    err.statusCode = 400;
    throw err;
  }
  const memberName = body.memberName ? String(body.memberName) : null;
  const deviceId = body.deviceId ? String(body.deviceId) : null;
  const incoming = Array.isArray(body.records) ? body.records : [];
  const mode = body.mode === 'manual' ? 'manual' : 'auto';

  upsertMember(memberId, memberName);
  touchDevice({ memberId, memberName, deviceId, ip: ctx.ip ?? null, mode });

  const pruned = pruneMemberRetention(memberId);
  const cutoff = retentionCutoff();
  const locals = readMemberRecords(memberId).filter((r) => r.date >= cutoff);
  const merged = mergeRecords(locals, incoming.filter((r) => (r?.date ?? '') >= cutoff));

  // 落盘（只写有变化的）
  const localByDate = new Map(locals.map((r) => [r.date, r]));
  let written = 0;
  for (const rec of merged) {
    const prev = localByDate.get(rec.date);
    if (!prev || JSON.stringify(prev) !== JSON.stringify(rec)) {
      writeJson(recordPath(memberId, rec.date), rec);
      written += 1;
    }
  }

  const stats = merged.reduce(
    (acc, rec) => {
      const goals = liveGoals(rec);
      acc.days += 1;
      acc.goals += goals.length;
      acc.done += goals.filter((g) => g.status === 'done').length;
      acc.failed += goals.filter((g) => g.status === 'failed').length;
      acc.pending += goals.filter((g) => g.status === 'pending').length;
      return acc;
    },
    { days: 0, goals: 0, done: 0, failed: 0, pending: 0 },
  );

  appendSyncLog({
    at: bjIso(),
    memberId,
    memberName,
    deviceId,
    ip: ctx.ip ?? null,
    mode,
    incoming: incoming.length,
    written,
    pruned,
    total: merged.length,
    stats,
  });

  return {
    ok: true,
    serverTime: bjIso(),
    memberId,
    mode,
    records: merged,
    written,
    pruned,
    retention: { months: RETENTION_MONTHS, cutoff },
    stats,
  };
}

function summaryRows(date = bjToday()) {
  const all = readAllRecords();
  return readJson(MEMBERS_FILE, []).map((m) => {
    const rec = (all[m.id] ?? []).find((r) => r.date === date) ?? null;
    const goals = liveGoals(rec);
    const recent = (all[m.id] ?? []).slice(-7);
    const totalRecent = recent.reduce((a, r) => a + liveGoals(r).length, 0);
    const doneRecent = recent.reduce((a, r) => a + liveGoals(r).filter((g) => g.status === 'done').length, 0);
    return {
      memberId: m.id,
      name: m.name,
      hasAvatar: hasAvatar(m.id),
      submitted: Boolean(rec) && goals.length > 0,
      total: goals.length,
      done: goals.filter((g) => g.status === 'done').length,
      failed: goals.filter((g) => g.status === 'failed').length,
      pending: goals.filter((g) => g.status === 'pending').length,
      lastDate: all[m.id]?.at(-1)?.date ?? null,
      recentRate: totalRecent ? doneRecent / totalRecent : null,
    };
  });
}

function startPage() {
  return renderDashboardPage({
    today: bjToday(),
    analysis: deepseekConfig(),
    dataDir: DATA_DIR,
    allowedDays: ALLOWED_DAYS,
  });
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host ?? 'localhost'}`);
  const remoteIp = String(req.socket?.remoteAddress ?? '').replace(/^::ffff:/, '');
  try {
    // CORS 预检：WebView 从 https://localhost 跨源访问中枢时必走这一步
    if (req.method === 'OPTIONS') {
      res.writeHead(204, { ...CORS_HEADERS, 'Content-Length': '0' });
      res.end();
      return;
    }
    if (req.method === 'GET' && url.pathname === '/') {
      const html = startPage();
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', ...CORS_HEADERS });
      res.end(html);
      return;
    }
    if (req.method === 'GET' && url.pathname === '/api/health') {
      const cfg = deepseekConfig();
      json(res, 200, {
        ok: true,
        app: 'family-checkin-hub',
        version: VERSION,
        serverTime: bjIso(),
        today: bjToday(),
        authRequired: Boolean(TOKEN),
        retention: { months: RETENTION_MONTHS, cutoff: retentionCutoff() },
        analysis: {
          available: cfg.configured,
          model: cfg.configured ? cfg.model : null,
          keySource: cfg.configured ? cfg.source : null,
          reason: cfg.configured ? null : cfg.reason,
          days: ALLOWED_DAYS,
        },
        members: readJson(MEMBERS_FILE, []).map((m) => m.id),
      });
      return;
    }
    if (!authorized(req)) {
      json(res, 401, { ok: false, error: 'token 不对' });
      return;
    }
    if (req.method === 'GET' && url.pathname === '/api/records') {
      const memberId = url.searchParams.get('memberId');
      if (!memberId) {
        json(res, 400, { ok: false, error: '需要 memberId' });
        return;
      }
      const from = url.searchParams.get('from');
      const to = url.searchParams.get('to');
      let recs = readMemberRecords(memberId);
      if (from) recs = recs.filter((r) => r.date >= from);
      if (to) recs = recs.filter((r) => r.date <= to);
      json(res, 200, { ok: true, serverTime: bjIso(), memberId, records: recs });
      return;
    }
    if (req.method === 'GET' && url.pathname === '/api/summary') {
      const date = url.searchParams.get('date') ?? bjToday();
      json(res, 200, { ok: true, serverTime: bjIso(), date, members: summaryRows(date) });
      return;
    }
    if (req.method === 'POST' && url.pathname === '/api/sync') {
      const body = await readBody(req);
      const result = handleSync(body, { ip: remoteIp });
      json(res, 200, result);
      return;
    }

    /* ---------- 看板数据：谁在线 / 谁刚刚同步 ---------- */
    if (req.method === 'GET' && url.pathname === '/api/status') {
      const cfg = deepseekConfig();
      json(res, 200, {
        ok: true,
        serverTime: bjIso(),
        today: bjToday(),
        retention: { months: RETENTION_MONTHS, cutoff: retentionCutoff() },
        analysis: {
          available: cfg.configured,
          model: cfg.configured ? cfg.model : null,
          keySource: cfg.configured ? cfg.source : null,
          reason: cfg.configured ? null : cfg.reason,
          days: ALLOWED_DAYS,
        },
        members: summaryRows(),
        devices: deviceList(),
        syncs: recentSyncs(15),
        analyses: listAnalyses(null, { limit: 12 }).map(analysisSummary),
      });
      return;
    }

    /* ---------- 单个成员的详情（点卡片才看） ---------- */
    if (req.method === 'GET' && url.pathname === '/api/member') {
      const memberId = url.searchParams.get('memberId');
      if (!memberId) {
        json(res, 400, { ok: false, error: '需要 memberId' });
        return;
      }
      const member = readJson(MEMBERS_FILE, []).find((m) => m.id === memberId);
      if (!member) {
        json(res, 404, { ok: false, error: '没有这个成员' });
        return;
      }
      const today = url.searchParams.get('date') ?? bjToday();
      const recs = readMemberRecords(member.id);
      const rec = recs.find((r) => r.date === today) ?? null;
      const goals = liveGoals(rec);
      const recent = recs.slice(-7);
      const totalRecent = recent.reduce((a, r) => a + liveGoals(r).length, 0);
      const doneRecent = recent.reduce((a, r) => a + liveGoals(r).filter((g) => g.status === 'done').length, 0);
      let bytes = 0;
      for (const r of recs) {
        try {
          bytes += fs.statSync(recordPath(member.id, r.date)).size;
        } catch {
          /* ignore */
        }
      }
      json(res, 200, {
        ok: true,
        serverTime: bjIso(),
        member: { id: member.id, name: member.name },
        today: {
          date: today,
          submitted: Boolean(rec) && goals.length > 0,
          total: goals.length,
          done: goals.filter((g) => g.status === 'done').length,
          failed: goals.filter((g) => g.status === 'failed').length,
          pending: goals.filter((g) => g.status === 'pending').length,
          goals: goals.map((g) => ({
            text: g.text,
            status: g.status,
            note: g.note ?? '',
            checkedAt: g.checkedAt ?? null,
          })),
        },
        stats: {
          days: recs.length,
          bytes,
          first: recs[0]?.date ?? null,
          latest: recs.at(-1)?.date ?? null,
          recentRate: totalRecent ? doneRecent / totalRecent : null,
        },
        syncs: recentSyncs(200).filter((s) => s.memberId === member.id).slice(0, 8),
        devices: deviceList().filter((d) => d.memberId === member.id),
        analyses: listAnalyses(member.id, { limit: 30 }).map(analysisSummary),
      });
      return;
    }

    /* ---------- 本地备份 ---------- */
    if (req.method === 'GET' && url.pathname === '/api/backup') {
      json(res, 200, { ok: true, ...backupInfo() });
      return;
    }
    if (req.method === 'GET' && url.pathname === '/api/backup/download') {
      const memberId = url.searchParams.get('memberId');
      const date = url.searchParams.get('date');
      if (!memberId) {
        json(res, 400, { ok: false, error: '需要 memberId' });
        return;
      }
      const recs = readMemberRecords(memberId).filter((r) => !date || r.date === date);
      const payload = JSON.stringify({ memberId, exportedAt: bjIso(), count: recs.length, records: recs }, null, 2);
      const name = `${memberId}-${date ?? '全部'}.json`;
      res.writeHead(200, {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(name)}`,
        'Content-Length': Buffer.byteLength(payload),
        ...CORS_HEADERS,
      });
      res.end(payload);
      return;
    }
    // 纯文本导出：2026年11月18日：事项1；事项2。一天一行
    if (req.method === 'GET' && url.pathname === '/api/backup/text') {
      const memberId = url.searchParams.get('memberId');
      if (!memberId) {
        json(res, 400, { ok: false, error: '需要 memberId' });
        return;
      }
      const text = recordsAsText(readMemberRecords(memberId));
      const name = `${memberId}-打卡.txt`;
      res.writeHead(200, {
        'Content-Type': 'text/plain; charset=utf-8',
        'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(name)}`,
        'Content-Length': Buffer.byteLength(text),
        ...CORS_HEADERS,
      });
      res.end(text);
      return;
    }
    if (req.method === 'POST' && url.pathname === '/api/open-folder') {
      // 只对"跑中枢的这台电脑"有意义：弹出资源管理器
      if (remoteIp && remoteIp !== '127.0.0.1' && remoteIp !== '::1') {
        json(res, 403, { ok: false, error: '只能在电脑本机打开文件夹（手机上点了也不会弹出）' });
        return;
      }
      const body = await readBody(req);
      const opened = openDataFolder(body.which === 'analyses' ? 'analyses' : '');
      json(res, 200, { ok: true, opened });
      return;
    }

    /* ---------- AI 复盘（带缓存：数据没变就不再花钱） ---------- */
    if (req.method === 'POST' && url.pathname === '/api/analyze') {
      const body = await readBody(req);
      const memberId = String(body.memberId ?? '').trim();
      const days = Number(body.days ?? 7);
      const force = body.force === true;
      if (!memberId) {
        json(res, 400, { ok: false, error: '需要 memberId' });
        return;
      }
      const record = await runAnalysis({ memberId, days, force });
      const charge = chargeOf(record.usage, record.cached === true);
      appendUsage(DATA_DIR, {
        at: usageIso(),
        kind: 'analysis',
        memberId,
        days: record.days,
        model: record.model,
        tokens: record.usage?.total_tokens ?? 0,
        cached: record.cached === true,
        id: record.id,
        ...charge,
      });
      json(res, 200, { ok: true, analysis: record, quota: await quotaSnapshot() });
      return;
    }
    if (req.method === 'GET' && url.pathname === '/api/analyses') {
      const memberId = url.searchParams.get('memberId');
      const limit = Math.min(30, Math.max(1, Number(url.searchParams.get('limit') ?? 30)));
      // 列表只给摘要，正文用 /api/analysis?id= 取（省流量，也避免一次拉一堆长文）
      json(res, 200, { ok: true, analyses: listAnalyses(memberId || null, { limit }).map(analysisSummary) });
      return;
    }
    if (req.method === 'GET' && url.pathname === '/api/analysis') {
      const id = url.searchParams.get('id') ?? '';
      // id 里带中文成员名（如 1794...-小满），不能用 \w 校验；只挡目录穿越
      if (!id || id.length > 120 || /[\/\\]/.test(id) || id.includes('..')) {
        json(res, 400, { ok: false, error: '需要合法的 id' });
        return;
      }
      const a = readJson(path.join(ANALYSIS_DIR, `${id}.json`), null);
      if (!a) {
        json(res, 404, { ok: false, error: '找不到这份复盘' });
        return;
      }
      json(res, 200, { ok: true, analysis: a });
      return;
    }

    /* ---------------- 家是小国 · 朝廷 ---------------- */

    if (req.method === 'GET' && url.pathname === '/api/court/config') {
      json(res, 200, {
        ok: true,
        depts: COURT_DEPTS.map((d) => ({ id: d.id, name: d.name, office: d.office, icon: d.icon, duty: d.duty, example: d.example ?? '', focusHint: d.focusHint })),
        roles: readRoles(DATA_DIR),
        roleLabels: COURT_ROLE_LABEL,
        roleOptions: COURT_ROLES,
        statuses: { pending: '待批阅', approved: '已朱批', held: '留中', rejected: '已驳回', counciling: '待合议' },
        analysisAvailable: deepseekConfig().configured,
        disclaimer: '家庭角色扮演设定，现实中夫妻平等；皇后拥有完整决策权，不是附属。',
      });
      return;
    }
    /**
     * 国事状态同步：App 离线也照记，连上就把整份推上来。
     * GET 取全量（含墓碑），POST 合并后落盘并回全量。
     */
    if (req.method === 'GET' && url.pathname === '/api/court/state') {
      const memberId = normalizeMemberId(url.searchParams.get('memberId') ?? '');
      json(res, 200, {
        ok: true,
        state: readCourtState(DATA_DIR),
        role: memberId ? roleOf(DATA_DIR, memberId) : 'member',
        adjustLimit: ANNUAL_ADJUST_LIMIT,
        serverTime: usageIso(),
      });
      return;
    }
    if (req.method === 'POST' && url.pathname === '/api/court/state') {
      const body = await readBody(req);
      const memberId = normalizeMemberId(body.memberId);
      const role = roleOf(DATA_DIR, memberId);
      const canEdit = canDispose(role);
      const merged = mergeForHub(readCourtState(DATA_DIR), body.state, { canEdit });
      writeCourtState(DATA_DIR, merged.state);
      json(res, 200, {
        ok: true,
        state: merged.state,
        rejected: merged.rejected,
        role,
        canEdit,
        adjustLimit: ANNUAL_ADJUST_LIMIT,
        serverTime: usageIso(),
      });
      return;
    }
    if (req.method === 'GET' && url.pathname === '/api/court/roles') {
      json(res, 200, { ok: true, roles: readRoles(DATA_DIR) });
      return;
    }
    if (req.method === 'POST' && url.pathname === '/api/court/role') {
      const body = await readBody(req);
      const memberId = normalizeMemberId(body.memberId);
      if (memberIdProblem(memberId)) {
        json(res, 400, { ok: false, error: memberIdProblem(memberId) });
        return;
      }
      const role = setRole(DATA_DIR, memberId, String(body.role ?? 'member'));
      json(res, 200, { ok: true, memberId, role });
      return;
    }
    if (req.method === 'GET' && url.pathname === '/api/court/memorials') {
      const dept = url.searchParams.get('dept');
      const status = url.searchParams.get('status');
      const limit = Math.min(100, Math.max(1, Number(url.searchParams.get('limit') ?? 30)));
      const list = courtListMemorials(DATA_DIR, { dept: dept || null, status: status || null, limit });
      json(res, 200, { ok: true, memorials: list.map(memorialSummary) });
      return;
    }
    if (req.method === 'GET' && url.pathname === '/api/court/memorial') {
      const id = url.searchParams.get('id') ?? '';
      const m = courtReadMemorial(DATA_DIR, id);
      if (!m) {
        json(res, 404, { ok: false, error: '找不到这份奏疏' });
        return;
      }
      json(res, 200, { ok: true, memorial: m });
      return;
    }
    if (req.method === 'GET' && url.pathname === '/api/court/tasks') {
      const dept = url.searchParams.get('dept') ?? '';
      if (!deptById(dept)) {
        json(res, 400, { ok: false, error: `没有这个部：${dept}` });
        return;
      }
      json(res, 200, { ok: true, dept, tasks: listTasks(DATA_DIR, dept), statuses: TASK_STATUS });
      return;
    }
    if (req.method === 'POST' && url.pathname === '/api/court/tasks') {
      const body = await readBody(req);
      const dept = String(body.dept ?? '').trim();
      if (!deptById(dept)) {
        json(res, 400, { ok: false, error: `没有这个部：${dept}` });
        return;
      }
      const memberId = normalizeMemberId(body.memberId);
      if (!canDispose(roleOf(DATA_DIR, memberId))) {
        json(res, 403, { ok: false, error: '下旨要陛下或皇后钦点（家人可以先看着）' });
        return;
      }
      const task = addTask(DATA_DIR, dept, { text: body.text, by: memberId || null, progress: body.progress, note: body.note });
      json(res, 200, { ok: true, task, tasks: listTasks(DATA_DIR, dept) });
      return;
    }
    if (req.method === 'POST' && url.pathname === '/api/court/task/update') {
      const body = await readBody(req);
      const dept = String(body.dept ?? '').trim();
      const task = updateTask(DATA_DIR, dept, {
        id: String(body.id ?? ''),
        progress: body.progress,
        text: body.text,
        note: body.note,
      });
      json(res, 200, { ok: true, task, tasks: listTasks(DATA_DIR, dept) });
      return;
    }
    if (req.method === 'POST' && url.pathname === '/api/court/task/delete') {
      const body = await readBody(req);
      const dept = String(body.dept ?? '').trim();
      if (!canDispose(roleOf(DATA_DIR, normalizeMemberId(body.memberId)))) {
        json(res, 403, { ok: false, error: '只有陛下与皇后可以撤销旨意' });
        return;
      }
      const out = removeTask(DATA_DIR, dept, { id: String(body.id ?? '') });
      json(res, 200, { ok: true, ...out, tasks: listTasks(DATA_DIR, dept) });
      return;
    }
    if (req.method === 'POST' && url.pathname === '/api/court/summon') {
      const body = await readBody(req);
      const deptId = String(body.dept ?? body.deptId ?? '').trim();
      if (!deptById(deptId)) {
        json(res, 400, { ok: false, error: `没有这个部：${deptId}` });
        return;
      }
      const memberId = normalizeMemberId(body.memberId);
      const role = memberId ? roleOf(DATA_DIR, memberId) : 'member';
      if (!canDispose(role)) {
        // 家人不能直接指挥六部：只允许帝后召唤（宁可拒绝也不越权）
        json(res, 403, { ok: false, error: `只有陛下与皇后可以召见六部（当前身份：${COURT_ROLE_LABEL[role]}）` });
        return;
      }
      const memorial = await courtSummon(DATA_DIR, {
        deptId,
        role,
        focus: body.focus ?? '',
        force: body.force === true,
        callModel: async (system, user) => {
          const cfg = deepseekConfig();
          if (!cfg.configured) {
            const err = new Error(cfg.reason);
            err.statusCode = 503;
            throw err;
          }
          return callDeepSeek(cfg, system, user);
        },
        model: deepseekConfig().model ?? 'deepseek-chat',
      });
      appendUsage(DATA_DIR, {
        at: usageIso(),
        kind: 'court',
        dept: deptId,
        memberId,
        model: memorial.model ?? null,
        tokens: memorial.usage?.total_tokens ?? 0,
        cached: memorial.cached === true,
        id: memorial.id,
        ...chargeOf(memorial.usage, memorial.cached === true),
      });
      json(res, 200, { ok: true, memorial, cached: memorial.cached === true, quota: await quotaSnapshot() });
      return;
    }
    if (req.method === 'POST' && url.pathname === '/api/court/dispatch') {
      const body = await readBody(req);
      const memberId = normalizeMemberId(body.memberId);
      const role = roleOf(DATA_DIR, memberId);
      if (!canDispose(role)) {
        json(res, 403, { ok: false, error: `传旨要陛下或皇后（当前身份：${COURT_ROLE_LABEL[role]}）` });
        return;
      }
      const cfg = deepseekConfig();
      const record = await dispatchEdict(DATA_DIR, {
        text: body.text,
        force: body.force === true,
        callModel: cfg.configured ? async (system, user) => callDeepSeek(cfg, system, user) : null,
        model: cfg.model ?? 'deepseek-chat',
      });
      // 只有真的调过模型才记流水；纯规矩拆免费
      if (record.usage || record.cached) {
        appendUsage(DATA_DIR, {
          at: usageIso(),
          kind: 'dispatch',
          dept: 'silijian',
          memberId,
          model: record.model,
          tokens: record.usage?.total_tokens ?? 0,
          cached: record.cached === true,
          id: record.id,
          items: record.items?.length ?? 0,
          ...chargeOf(record.usage, record.cached === true),
        });
      }
      json(res, 200, { ok: true, ...record, quota: await quotaSnapshot() });
      return;
    }
    if (req.method === 'POST' && url.pathname === '/api/court/dispose') {
      const body = await readBody(req);
      const memberId = normalizeMemberId(body.memberId);
      const role = roleOf(DATA_DIR, memberId);
      const m = courtDispose(DATA_DIR, {
        id: String(body.id ?? ''),
        action: String(body.action ?? ''),
        comment: body.comment ?? '',
        role,
        by: memberId || COURT_ROLE_LABEL[role],
      });
      json(res, 200, { ok: true, memorial: m });
      return;
    }
    if (req.method === 'POST' && url.pathname === '/api/court/reply') {
      const body = await readBody(req);
      const memberId = normalizeMemberId(body.memberId);
      const m = courtReply(DATA_DIR, { id: String(body.id ?? ''), text: body.text ?? '', by: memberId || null });
      json(res, 200, { ok: true, memorial: m });
      return;
    }
    if (req.method === 'GET' && url.pathname === '/api/court/meeting') {
      json(res, 200, { ok: true, ...courtMeeting(DATA_DIR) });
      return;
    }
    if (req.method === 'GET' && url.pathname === '/api/court/ledger') {
      const days = Math.min(365, Math.max(1, Number(url.searchParams.get('days') ?? 30)));
      json(res, 200, { ok: true, summary: summarizeLedger(listLedger(DATA_DIR), { days }), budget: readBudget(DATA_DIR) });
      return;
    }
    if (req.method === 'POST' && url.pathname === '/api/court/ledger') {
      const body = await readBody(req);
      const parsed = parseLedgerText(body.text);
      if (!parsed.ok) {
        json(res, 400, { ok: false, error: parsed.error, unparsed: parsed.unparsed });
        return;
      }
      const memberId = normalizeMemberId(body.memberId);
      const entries = parsed.entries.map((p) => appendLedger(DATA_DIR, {
        id: `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        at: bjIso(),
        date: bjToday(),
        by: memberId || null,
        amount: p.amount,
        item: p.item,
        categoryId: p.categoryId,
        categoryLabel: p.categoryLabel,
        raw: p.raw,
      }));
      json(res, 200, {
        ok: true,
        entries,
        entry: entries[0] ?? null,
        unparsed: parsed.unparsed ?? [],
        summary: summarizeLedger(listLedger(DATA_DIR), { days: 30 }),
      });
      return;
    }
    if (req.method === 'POST' && url.pathname === '/api/court/budget') {
      const body = await readBody(req);
      json(res, 200, { ok: true, budget: setBudget(DATA_DIR, body.monthly) });
      return;
    }
    if (req.method === 'GET' && url.pathname === '/api/court/items') {
      const dept = url.searchParams.get('dept') ?? 'libu2';
      if (!deptById(dept)) {
        json(res, 400, { ok: false, error: `没有这个部：${dept}` });
        return;
      }
      json(res, 200, { ok: true, dept, items: listItems(DATA_DIR, dept, { limit: 100 }) });
      return;
    }
    if (req.method === 'POST' && url.pathname === '/api/court/item') {
      const body = await readBody(req);
      const dept = String(body.dept ?? '').trim();
      if (!deptById(dept)) {
        json(res, 400, { ok: false, error: `没有这个部：${dept}` });
        return;
      }
      const row = appendItem(DATA_DIR, dept, {
        text: body.text ?? '',
        kind: String(body.kind ?? 'note'),
        by: normalizeMemberId(body.memberId) || null,
        at: bjIso(),
      });
      json(res, 200, { ok: true, item: row });
      return;
    }

    /* ---------------- 用量账簿 ---------------- */
    if (req.method === 'GET' && url.pathname === '/api/usage') {
      const summary = summarizeUsage(DATA_DIR, { limit: 30 });
      const cfg = deepseekConfig();
      const fake = /^(1|on|true|yes|fake)$/i.test(String(process.env.HUB_DEEPSEEK_FAKE ?? ''));
      const balance = fake
        ? { ok: false, error: '假模型模式，不查余额' }
        : cfg.configured
          ? await fetchBalance(cfg)
          : { ok: false, error: '未配置模型 key' };
      json(res, 200, { ok: true, balance, ...summary });
      return;
    }

    /* ---------------- 头像 ---------------- */
    if (req.method === 'GET' && url.pathname === '/api/avatar') {
      const memberId = url.searchParams.get('memberId');
      const row = readAvatar(memberId);
      if (!row) {
        json(res, 404, { ok: false, error: '还没有头像' });
        return;
      }
      json(res, 200, { ok: true, ...row });
      return;
    }
    if (req.method === 'POST' && url.pathname === '/api/avatar') {
      const body = await readBody(req);
      const memberId = normalizeMemberId(body.memberId);
      const saved = saveAvatar(memberId, body.dataUrl);
      json(res, 200, { ok: true, memberId, ...saved });
      return;
    }

    /* ---------------- 国家大事（年度 / 半年度要事） ---------------- */
    if (req.method === 'GET' && url.pathname === '/api/annual') {
      json(res, 200, {
        ok: true,
        items: listAnnual(DATA_DIR),
        statuses: ANNUAL_STATUS,
        periods: ANNUAL_PERIOD,
        adjustLimit: ANNUAL_ADJUST_LIMIT,
      });
      return;
    }
    if (req.method === 'POST' && url.pathname === '/api/annual') {
      const body = await readBody(req);
      const memberId = normalizeMemberId(body.memberId);
      if (!canDispose(roleOf(DATA_DIR, memberId))) {
        json(res, 403, { ok: false, error: '国家大事要陛下或皇后定夺（家人可以先在御书房提议）' });
        return;
      }
      const item = addAnnual(DATA_DIR, {
        text: body.text,
        owner: body.owner ?? memberId,
        note: body.note ?? '',
        period: body.period ?? 'year',
        budget: body.budget ?? null,
      });
      json(res, 200, { ok: true, item, items: listAnnual(DATA_DIR) });
      return;
    }
    if (req.method === 'POST' && url.pathname === '/api/annual/update') {
      const body = await readBody(req);
      const memberId = normalizeMemberId(body.memberId);
      if (!canDispose(roleOf(DATA_DIR, memberId))) {
        json(res, 403, { ok: false, error: '只有陛下与皇后可以改动国家大事' });
        return;
      }
      const item = updateAnnual(DATA_DIR, {
        id: String(body.id ?? ''),
        text: body.text,
        status: body.status,
        note: body.note,
        owner: body.owner,
        progress: body.progress,
        period: body.period,
        budget: body.budget,
      });
      json(res, 200, { ok: true, item, items: listAnnual(DATA_DIR), adjustLimit: ANNUAL_ADJUST_LIMIT });
      return;
    }
    if (req.method === 'POST' && url.pathname === '/api/annual/delete') {
      const body = await readBody(req);
      const memberId = normalizeMemberId(body.memberId);
      if (!canDispose(roleOf(DATA_DIR, memberId))) {
        json(res, 403, { ok: false, error: '只有陛下与皇后可以删国家大事' });
        return;
      }
      const out = removeAnnual(DATA_DIR, { id: String(body.id ?? '') });
      json(res, 200, { ok: true, ...out, items: listAnnual(DATA_DIR) });
      return;
    }

    /* ---------------- 看板：六部台账总览 ---------------- */
    if (req.method === 'GET' && url.pathname === '/api/court/overview') {
      json(res, 200, {
        ok: true,
        depts: COURT_DEPTS.map((d) => {
          const tasks = listTasks(DATA_DIR, d.id);
          const mems = courtListMemorials(DATA_DIR, { dept: d.id, limit: 5 }).map(memorialSummary);
          return {
            id: d.id,
            name: d.name,
            office: d.office,
            icon: d.icon,
            duty: d.duty[0],
            tasks,
            openTasks: tasks.filter((t) => t.progress < 100).length,
            avgProgress: tasks.length ? Math.round(tasks.reduce((a, t) => a + t.progress, 0) / tasks.length) : null,
            memorials: mems,
            pendingMemorials: mems.filter((m) => m.status === 'pending').length,
          };
        }),
        annual: listAnnual(DATA_DIR),
        usage: summarizeUsage(DATA_DIR, { limit: 8 }),
      });
      return;
    }

    json(res, 404, { ok: false, error: `没有这个接口: ${req.method} ${url.pathname}` });
  } catch (err) {
    json(res, err.statusCode ?? 400, { ok: false, error: String(err.message ?? err) });
  }
});

/* ------------------------------- UDP 发现 ------------------------------- */

// 网卡筛选与子网广播地址都在 net.mjs（纯函数，可单测）
const payload = (ip) => JSON.stringify({
  service: 'family-checkin-hub',
  version: VERSION,
  httpPort: PORT,
  host: os.hostname(),
  ...(ip ? { ip } : {}),
  serverTime: bjIso(),
});

const udp = dgram.createSocket({ type: 'udp4', reuseAddr: true });
udp.on('message', (msg, rinfo) => {
  const text = msg.toString('utf8').trim();
  if (!text.startsWith('FAMILY-CHECKIN/DISCOVER')) return; // 自己的 announce 会绕回来，忽略
  udp.send(Buffer.from(payload()), rinfo.port, rinfo.address, (err) => {
    if (err) console.error(`  UDP 回复失败: ${err.message}`);
    else console.log(`  → 回应发现请求 ${rinfo.address}:${rinfo.port}`);
  });
});

/**
 * 主动广播：每 ANNOUNCE_MS 朝每张真实网卡的广播地址喊一声「我在这儿」。
 * 这样即便手机发出的广播被路由器/热点挡住，手机端只要在听就能找到中枢。
 */
const ANNOUNCE_MS = Math.max(1000, Number(process.env.HUB_ANNOUNCE_MS ?? 5000));
let announceTimer = null;

function announceOnce() {
  const targets = announceTargets();
  for (const ip of targets) {
    const buf = Buffer.from(`FAMILY-CHECKIN/HERE ${payload()}`);
    udp.send(buf, UDP_PORT, ip, (err) => {
      if (err && err.code !== 'EPERM') {
        // 某些网卡不允许广播，忽略即可（别的网卡可能成功）
      }
    });
  }
}

function startAnnounce() {
  announceOnce();
  announceTimer = setInterval(announceOnce, ANNOUNCE_MS);
  announceTimer.unref?.();
}

function lanAddresses() {
  return pickLanInterfaces().map((i) => i.address);
}

function printNetworkInfo() {
  const ifaces = pickLanInterfaces();
  console.log(`   数据目录：${DATA_DIR}`);
  console.log(`   看板：    http://127.0.0.1:${PORT}/`);
  if (ifaces.length) {
    for (const i of ifaces) {
      const tag = isHotspotAddress(i.address) ? '  ← 手机热点网段' : '';
      console.log(`   局域网：  http://${i.address}:${PORT}/   [${i.name}]${tag}`);
    }
  } else {
    console.log('   ⚠️ 没有可用的局域网地址：电脑可能没连 WiFi/网线，或者只有虚拟网卡。');
  }
  console.log('   同步接口：POST /api/sync   发现端口：UDP ' + UDP_PORT + '（中枢每 ' + Math.round(ANNOUNCE_MS / 1000) + ' 秒广播一次）');
  console.log('   网络要求：手机和电脑在同一个家里网络就行——');
  console.log('             ① 同一个 WiFi　② 电脑连手机热点　③ 手机连 WiFi + 电脑插网线（同一路由器）');
  console.log(`   历史保留：最近 ${RETENTION_MONTHS} 个月（早于 ${retentionCutoff()} 的会被清掉）`);
  console.log(TOKEN ? '   已启用 token 校验（HUB_TOKEN）' : '   未设 HUB_TOKEN（仅限可信任的家庭局域网）');
}

ensureDirs();

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`✗ 端口 ${PORT} 被占用了——大概是已经开着一个中枢窗口。`);
    console.error('  先关掉那个黑窗口，再重开本窗口；或者设 HUB_PORT 换个端口。');
  } else if (err.code === 'EACCES') {
    console.error(`✗ 没有权限监听端口 ${PORT}，换一个大于 1024 的端口试试（HUB_PORT）。`);
  } else {
    console.error(`✗ 中枢启动失败：${err.message}`);
  }
  setTimeout(() => process.exit(1), 300);
});

udp.on('error', (err) => {
  console.error(`✗ UDP 发现端口 ${UDP_PORT} 不可用（${err.message}）——同步不受影响，只是手机自动发现会失效，可手填中枢地址。`);
});

server.listen(PORT, '0.0.0.0', () => {
  udp.bind(UDP_PORT, () => {
    console.log(`🐱 大内家事中枢已启动  ${bjIso()}`);
    printNetworkInfo();
    startAnnounce();
    console.log('   Ctrl+C 退出');
  });
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    console.log('\n中枢退出。');
    if (announceTimer) clearInterval(announceTimer);
    udp.close();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 800);
  });
}
