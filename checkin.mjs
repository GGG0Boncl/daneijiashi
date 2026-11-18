#!/usr/bin/env node
/**
 * 家庭多人小目标打卡中心 —— 数据层 CLI
 *
 * 设计要点
 *  - 时间基准固定北京时间（Asia/Shanghai），按自然日一份目标清单。
 *  - 每个成员一个目录，数据相互隔离；记录可回溯。
 *  - 只做"存储 + 统计 + 提醒候选筛选"，不替任何人自动改目标/打卡。
 *  - 分析报告只输出单人事实 + 量化辅助，定性结论由 Agent 写。
 *
 * 目录结构
 *  data/members.json                        成员表
 *  data/records/<memberId>/<YYYY-MM-DD>.json 每人每日目标与打卡
 *
 * 用法见 README.md，或 node checkin.mjs help
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { memberIdProblem, normalizeMemberId } from './shared/id.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = process.env.CHECKIN_DATA_DIR
  ? path.resolve(process.env.CHECKIN_DATA_DIR)
  : path.join(HERE, 'data');
const MEMBERS_FILE = path.join(DATA_DIR, 'members.json');
const RECORD_DIR = path.join(DATA_DIR, 'records');
const TZ = 'Asia/Shanghai';
const STATUS = { pending: '未打卡', done: '已完成', failed: '未完成' };
const ICON = { pending: '⬜', done: '✅', failed: '❌' };

/* ------------------------------- 基础工具 ------------------------------- */

const pad = (n) => String(n).padStart(2, '0');

function bjParts(d = new Date()) {
  // sv-SE 形如 "2026-11-18 10:50:28"，天然是 YYYY-MM-DD HH:mm:ss
  const s = new Intl.DateTimeFormat('sv-SE', {
    timeZone: TZ,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hour12: false,
  }).format(d);
  const [date, time] = s.split(' ');
  return { date, time };
}

function nowIso() {
  const { date, time } = bjParts();
  return `${date}T${time}+08:00`;
}

function bjToday() {
  return bjParts().date;
}

function bjNowTime() {
  return bjParts().time;
}

function isValidDate(s) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(s))) return false;
  const d = new Date(`${s}T00:00:00+08:00`);
  return !Number.isNaN(d.getTime()) && bjParts(d).date === s;
}

function needDate(s, label = '日期') {
  if (!isValidDate(s)) die(`${label}格式应为 YYYY-MM-DD，收到：${s}`);
  return s;
}

function dateToWeekday(dateStr) {
  const idx = new Date(`${dateStr}T00:00:00+08:00`).getDay();
  return `周${'日一二三四五六'[idx]}`;
}

function addDays(dateStr, n) {
  const d = new Date(`${dateStr}T00:00:00+08:00`);
  d.setUTCDate(d.getUTCDate() + n);
  return bjParts(d).date;
}

function daysBetween(from, to) {
  const a = new Date(`${from}T00:00:00+08:00`).getTime();
  const b = new Date(`${to}T00:00:00+08:00`).getTime();
  return Math.round((b - a) / 86400000);
}

function rangeDates(from, to) {
  const out = [];
  for (let d = from; daysBetween(d, to) >= 0; d = addDays(d, 1)) out.push(d);
  return out;
}

function die(msg) {
  console.error(`✗ ${msg}`);
  process.exit(1);
}

function ok(msg) {
  console.log(msg);
}

function ensureDirs() {
  fs.mkdirSync(RECORD_DIR, { recursive: true });
  if (!fs.existsSync(MEMBERS_FILE)) writeJson(MEMBERS_FILE, []);
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

/* ------------------------------- 成员 ------------------------------- */

// 规则只有一份：shared/id.mjs（emoji 合法，只拦会弄坏文件系统的字符）
function checkMemberId(id) {
  const problem = memberIdProblem(id);
  if (problem) die(problem);
  return normalizeMemberId(id);
}

function listMembers({ activeOnly = false } = {}) {
  const all = readJson(MEMBERS_FILE, []);
  return activeOnly ? all.filter((m) => m.active !== false) : all;
}

function getMember(id) {
  const m = listMembers().find((x) => x.id === id);
  if (!m) die(`找不到成员「${id}」，先用 member add 添加`);
  return m;
}

function recordPath(memberId, date) {
  return path.join(RECORD_DIR, memberId, `${date}.json`);
}

function readRecord(memberId, date) {
  const p = recordPath(memberId, date);
  if (!fs.existsSync(p)) return null;
  return readJson(p, null);
}

function readAllRecords(memberId) {
  const dir = path.join(RECORD_DIR, memberId);
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter((f) => /^\d{4}-\d{2}-\d{2}\.json$/.test(f))
    .map((f) => readJson(path.join(dir, f), null))
    .filter(Boolean)
    .sort((a, b) => a.date.localeCompare(b.date));
}

function nextGoalId(goals) {
  let max = 0;
  for (const g of goals) {
    const n = Number(String(g.id).replace(/^g/, ''));
    if (Number.isFinite(n) && n > max) max = n;
  }
  return `g${max + 1}`;
}

function saveRecord(rec) {
  writeJson(recordPath(rec.memberId, rec.date), rec);
  return rec;
}

function newGoal(text) {
  return { id: '', text: String(text).trim(), status: 'pending', checkedAt: null, note: '', createdAt: nowIso() };
}

/* ------------------------------- 目标输入 ------------------------------- */

/**
 * 目标文本来源（优先级）：--file <utf8 JSON 数组/对象> > --stdin-json > 位置参数
 * 中文参数在 Windows 老控制台可能被转码，稳妥做法是走 --file。
 */
function collectGoals(argv) {
  const file = takeFlag(argv, '--file');
  if (file) {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
    const arr = Array.isArray(raw) ? raw : raw.goals ?? [raw];
    return arr.map(toGoalText).filter(Boolean);
  }
  if (argv.includes('--stdin-json')) {
    const idx = argv.indexOf('--stdin-json');
    argv.splice(idx, 1);
    const raw = JSON.parse(fs.readFileSync(0, 'utf8').replace(/^\uFEFF/, '') || '[]');
    const arr = Array.isArray(raw) ? raw : raw.goals ?? [raw];
    return arr.map(toGoalText).filter(Boolean);
  }
  const rest = argv.filter((a) => !a.startsWith('--'));
  return rest.map((s) => String(s).trim()).filter(Boolean);
}

function toGoalText(x) {
  if (x == null) return '';
  if (typeof x === 'string') return x.trim();
  return String(x.text ?? x.goal ?? '').trim();
}

/* ------------------------------- 参数解析 ------------------------------- */

function takeFlag(argv, name) {
  const i = argv.indexOf(name);
  if (i < 0) return undefined;
  const v = argv[i + 1];
  if (v === undefined || v.startsWith('--')) die(`${name} 后面缺值`);
  argv.splice(i, 2);
  return v;
}

function takeBool(argv, name) {
  const i = argv.indexOf(name);
  if (i < 0) return false;
  argv.splice(i, 1);
  return true;
}

function positional(argv) {
  return argv.filter((a) => !a.startsWith('--'));
}

/* ------------------------------- 渲染 ------------------------------- */

function fmtTime(iso) {
  if (!iso) return '';
  return String(iso).slice(11, 16);
}

function renderRecord(rec, { withHeader = true } = {}) {
  const lines = [];
  if (withHeader) lines.push(`📅 ${rec.date}（${dateToWeekday(rec.date)}）· ${rec.memberName || rec.memberId}`);
  if (!rec.goals.length) {
    lines.push('  （今日还没有目标）');
    return lines.join('\n');
  }
  rec.goals.forEach((g, i) => {
    const bits = [`  ${i + 1}. ${ICON[g.status] ?? '⬜'} ${g.text}`, `[${STATUS[g.status] ?? g.status}`];
    if (g.checkedAt) bits[1] += ` ${fmtTime(g.checkedAt)}`;
    bits[1] += ']';
    let line = bits.join(' ');
    if (g.note) line += `　备注：${g.note}`;
    lines.push(line);
  });
  const done = rec.goals.filter((g) => g.status === 'done').length;
  lines.push(`  进度：完成 ${done}/${rec.goals.length}`);
  return lines.join('\n');
}

/* ------------------------------- 统计 ------------------------------- */

function statsFor(memberId, dates) {
  const recs = new Map();
  for (const d of dates) {
    const r = readRecord(memberId, d);
    if (r) recs.set(d, r);
  }
  const submitted = dates.filter((d) => recs.has(d));
  const missing = dates.filter((d) => !recs.has(d));

  let total = 0;
  let done = 0;
  let failed = 0;
  let pending = 0;
  let lateCheck = 0;
  const perDay = [];
  const textStats = new Map();
  const weekday = new Map();

  const today = bjToday();
  for (const d of submitted) {
    const rec = recs.get(d);
    const isToday = d === today;
    const dDone = rec.goals.filter((g) => g.status === 'done').length;
    const dFailed = rec.goals.filter((g) => g.status === 'failed').length;
    const dPending = rec.goals.filter((g) => g.status !== 'done' && g.status !== 'failed').length;
    total += rec.goals.length;
    done += dDone;
    failed += dFailed;
    pending += dPending;
    perDay.push({ date: d, count: rec.goals.length, done: dDone, failed: dFailed, pending: dPending, isToday });

    const wd = dateToWeekday(d);
    const w = weekday.get(wd) ?? { days: 0, total: 0, done: 0 };
    w.days += 1; w.total += rec.goals.length; w.done += dDone;
    weekday.set(wd, w);

    for (const g of rec.goals) {
      const key = g.text;
      const s = textStats.get(key) ?? { text: key, times: 0, done: 0, failed: 0, pending: 0 };
      s.times += 1;
      if (g.status === 'done') s.done += 1;
      else if (g.status === 'failed') s.failed += 1;
      else s.pending += 1;
      textStats.set(key, s);
      const t = fmtTime(g.checkedAt);
      if (t && (t >= '22:00' || t < '05:00')) lateCheck += 1;
    }
  }

  // 连续提交（自然日连续）
  let longestStreak = 0;
  let run = 0;
  let streakStart = null;
  let bestStreakRange = null;
  for (const d of dates) {
    if (recs.has(d)) {
      if (run === 0) streakStart = d;
      run += 1;
      if (run > longestStreak) {
        longestStreak = run;
        bestStreakRange = [streakStart, d];
      }
    } else run = 0;
  }
  const currentStreakBackwards = (() => {
    let n = 0;
    let d = today;
    while (dates.includes(d)) {
      const r = recs.get(d);
      if (!r) break;
      n += 1;
      d = addDays(d, -1);
    }
    return n;
  })();

  const richTexts = [...textStats.values()].sort((a, b) => b.times - a.times);
  const repeatStuck = richTexts
    .filter((s) => s.times >= 2 && s.done / s.times < 0.5)
    .slice(0, 8);
  const heavyDays = perDay.filter((p) => p.count >= 5);
  const heavyRate = heavyDays.length
    ? heavyDays.reduce((a, p) => a + p.done, 0) / heavyDays.reduce((a, p) => a + p.count, 0)
    : null;
  const lightDays = perDay.filter((p) => p.count <= 3);
  const lightRate = lightDays.length
    ? lightDays.reduce((a, p) => a + p.done, 0) / lightDays.reduce((a, p) => a + p.count, 0)
    : null;

  return {
    memberId,
    from: dates[0] ?? null,
    to: dates[dates.length - 1] ?? null,
    daysInRange: dates.length,
    submittedDays: submitted.length,
    missingDates: missing,
    submissionRate: dates.length ? submitted.length / dates.length : 0,
    totalGoals: total,
    done,
    failed,
    pending,
    completionRate: total ? done / total : 0,
    longestStreak,
    longestStreakRange: bestStreakRange,
    currentStreakBackwards,
    lateNightChecks: lateCheck,
    goalsPerDay: perDay.length
      ? {
        min: Math.min(...perDay.map((p) => p.count)),
        max: Math.max(...perDay.map((p) => p.count)),
        avg: perDay.reduce((a, p) => a + p.count, 0) / perDay.length,
      }
      : null,
    heavyDays: { days: heavyDays.length, completionRate: heavyRate },
    lightDays: { days: lightDays.length, completionRate: lightRate },
    weekday: [...weekday.entries()].map(([wd, v]) => ({ weekday: wd, ...v, rate: v.total ? v.done / v.total : 0 })),
    repeatStuck: repeatStuck.map((s) => ({ ...s, rate: s.times ? s.done / s.times : 0 })),
    perDay,
  };
}

/* ------------------------------- 命令 ------------------------------- */

function cmdMember(argv) {
  const sub = positional(argv)[0] ?? 'list';
  if (sub === 'add' || sub === 'set') {
    const id = checkMemberId(positional(argv)[1] ?? '');
    const name = takeFlag(argv, '--name') ?? positional(argv)[2];
    if (!name) die('缺少 --name 或成员姓名');
    const members = listMembers();
    const found = members.find((m) => m.id === id);
    const share = takeFlag(argv, '--share');
    const chatId = takeFlag(argv, '--chat');
    if (found) {
      found.name = String(name);
      if (share !== undefined) found.shareToFamily = share === 'true' || share === '1';
      if (chatId !== undefined) found.feishuChatId = chatId || null;
      writeJson(MEMBERS_FILE, members);
      ok(`✓ 已更新成员 ${id}（${name}）`);
      return;
    }
    members.push({
      id,
      name: String(name),
      active: true,
      shareToFamily: share === 'true' || share === '1',
      feishuChatId: chatId || null,
      createdAt: nowIso(),
    });
    writeJson(MEMBERS_FILE, members);
    ok(`✓ 已添加成员 ${id}（${name}）`);
    return;
  }
  if (sub === 'off' || sub === 'on') {
    const id = checkMemberId(positional(argv)[1] ?? '');
    const members = listMembers();
    const m = members.find((x) => x.id === id);
    if (!m) die(`找不到成员 ${id}`);
    m.active = sub === 'on';
    writeJson(MEMBERS_FILE, members);
    ok(`✓ 成员 ${id} 已${sub === 'on' ? '启用' : '停用'}（历史记录保留）`);
    return;
  }
  // list
  const members = listMembers();
  if (!members.length) {
    ok('（还没有成员，用 member add <id> --name "名字" 添加）');
    return;
  }
  ok(`共 ${members.length} 位成员：`);
  for (const m of members) {
    const recs = readAllRecords(m.id);
    const tail = recs.length ? `${recs.length} 天记录，最近 ${recs[recs.length - 1].date}` : '暂无记录';
    ok(`  · ${m.id}　${m.name}　${m.active === false ? '（停用）' : '（启用）'}　${m.shareToFamily ? '家庭互看:开' : '家庭互看:关'}　${tail}${m.feishuChatId ? '　[已配推送通道]' : ''}`);
  }
}

function cmdSubmit(argv) {
  const id = checkMemberId(positional(argv)[0] ?? '');
  const member = getMember(id);
  const date = needDate(takeFlag(argv, '--date') ?? bjToday());
  if (daysBetween(bjToday(), date) > 0) die(`${date} 还没到，不能提前交目标`);
  const goals = collectGoals(argv);
  if (!goals.length) die('没有收到目标内容（用 --file 传 UTF-8 JSON 数组最稳）');
  const replace = takeBool(argv, '--replace');

  let rec = readRecord(id, date) ?? {
    memberId: id,
    memberName: member.name,
    date,
    version: 0,
    submittedAt: nowIso(),
    createdAt: nowIso(),
    updatedAt: nowIso(),
    goals: [],
  };
  rec.memberName = member.name;
  if (replace) rec.goals = [];
  const added = [];
  for (const text of goals) {
    const g = newGoal(text);
    g.id = nextGoalId(rec.goals);
    rec.goals.push(g);
    added.push(g);
  }
  rec.version += 1;
  rec.updatedAt = nowIso();
  saveRecord(rec);
  ok(`✓ ${member.name} ${date} 目标已保存（v${rec.version}，共 ${rec.goals.length} 条，本次${replace ? '整体替换' : '新增'} ${added.length} 条）`);
  ok(renderRecord(rec, { withHeader: false }));
}

function findGoal(rec, target) {
  if (!rec) return null;
  const t = String(target ?? '');
  if (/^g\d+$/.test(t)) return rec.goals.find((g) => g.id === t) ?? null;
  if (/^\d+$/.test(t)) return rec.goals[Number(t) - 1] ?? null;
  const exact = rec.goals.find((g) => g.text === t);
  if (exact) return exact;
  const fuzzy = rec.goals.filter((g) => g.text.includes(t));
  return fuzzy.length === 1 ? fuzzy[0] : null;
}

function cmdCheck(argv) {
  const id = checkMemberId(positional(argv)[0] ?? '');
  const member = getMember(id);
  const date = needDate(takeFlag(argv, '--date') ?? bjToday());
  const target = takeFlag(argv, '--goal');
  if (!target) die('缺少 --goal（可用目标序号 2 或 id g2 或目标文本）');
  const note = takeFlag(argv, '--note');
  let status = 'done';
  if (takeBool(argv, '--fail')) status = 'failed';
  if (takeBool(argv, '--pending') || takeBool(argv, '--undo')) status = 'pending';

  const rec = readRecord(id, date);
  if (!rec) die(`${member.name} 在 ${date} 还没有提交过目标`);
  const goal = findGoal(rec, target);
  if (!goal) die(`没找到目标「${target}」，当前目标：\n${rec.goals.map((g, i) => `  ${i + 1}. ${g.text}`).join('\n')}`);
  goal.status = status;
  goal.checkedAt = status === 'pending' ? null : nowIso();
  if (note !== undefined) goal.note = note;
  rec.version += 1;
  rec.updatedAt = nowIso();
  saveRecord(rec);
  ok(`✓ ${member.name} ${date}「${goal.text}」→ ${STATUS[status]}${note ? `（备注：${note}）` : ''}`);
  ok(renderRecord(rec, { withHeader: false }));
}

function cmdNote(argv) {
  const id = checkMemberId(positional(argv)[0] ?? '');
  const member = getMember(id);
  const date = needDate(takeFlag(argv, '--date') ?? bjToday());
  const target = takeFlag(argv, '--goal');
  const note = takeFlag(argv, '--note') ?? '';
  const rec = readRecord(id, date);
  if (!rec) die(`${member.name} 在 ${date} 还没有目标记录`);
  const goal = findGoal(rec, target);
  if (!goal) die('没找到对应目标（用 --goal 指定序号或 g 编号）');
  goal.note = note;
  rec.version += 1;
  rec.updatedAt = nowIso();
  saveRecord(rec);
  ok(`✓ 已更新「${goal.text}」的备注：${note || '（清空）'}`);
}

function cmdEdit(argv) {
  const id = checkMemberId(positional(argv)[0] ?? '');
  const member = getMember(id);
  const date = needDate(takeFlag(argv, '--date') ?? bjToday());
  const rec = readRecord(id, date);
  if (!rec) die(`${member.name} 在 ${date} 还没有目标记录`);
  const changes = [];
  let dirty = false;

  const addText = takeFlag(argv, '--add');
  if (addText !== undefined) {
    for (const text of addText.split('||').map((s) => s.trim()).filter(Boolean)) {
      const g = newGoal(text);
      g.id = nextGoalId(rec.goals);
      rec.goals.push(g);
      changes.push(`＋ ${text}`);
    }
    dirty = true;
  }
  const del = takeFlag(argv, '--remove');
  if (del !== undefined) {
    for (const t of del.split('||').map((s) => s.trim()).filter(Boolean)) {
      const g = findGoal(rec, t);
      if (!g) die(`没找到要删除的目标「${t}」`);
      rec.goals = rec.goals.filter((x) => x.id !== g.id);
      changes.push(`－ ${g.text}`);
    }
    dirty = true;
  }
  const ren = takeFlag(argv, '--rename');
  if (ren !== undefined) {
    const [target, ...rest] = ren.split('||').map((s) => s.trim());
    const text = rest.join('||');
    if (!target || !text) die('--rename 需要 "目标序号||新文本"');
    const g = findGoal(rec, target);
    if (!g) die(`没找到目标「${target}」`);
    changes.push(`✎ ${g.text} → ${text}`);
    g.text = text;
    dirty = true;
  }

  if (!dirty) die('没有要修改的内容（--add / --remove / --rename）');
  rec.version += 1;
  rec.updatedAt = nowIso();
  saveRecord(rec);
  ok(`✓ ${member.name} ${date} 已更新（v${rec.version}）：\n  ${changes.join('\n  ')}`);
  ok(renderRecord(rec, { withHeader: false }));
}

function cmdQuery(argv) {
  const id = checkMemberId(positional(argv)[0] ?? '');
  const member = getMember(id);
  const asJson = takeBool(argv, '--json');
  const date = takeFlag(argv, '--date');
  const from = takeFlag(argv, '--from');
  const to = takeFlag(argv, '--to');
  let recs;
  if (date) {
    const r = readRecord(id, needDate(date));
    recs = r ? [r] : [];
  } else if (from || to) {
    const a = needDate(from ?? bjToday());
    const b = needDate(to ?? bjToday());
    recs = rangeDates(a, b).map((d) => readRecord(id, d)).filter(Boolean);
  } else {
    const all = readAllRecords(id);
    recs = all.slice(-7);
  }
  if (asJson) {
    console.log(JSON.stringify({ member: { id, name: member.name }, records: recs }, null, 2));
    return;
  }
  if (!recs.length) {
    ok(`（${member.name} 在这段时间还没有打卡记录）`);
    return;
  }
  ok(`🧾 ${member.name} 的打卡记录（${recs.length} 天）`);
  for (const r of recs) ok(`\n${renderRecord(r, { withHeader: true })}`);
}

function resolveRange(argv) {
  const from = takeFlag(argv, '--from');
  const to = takeFlag(argv, '--to');
  const days = Number(takeFlag(argv, '--days') ?? 0);
  if (from || to) {
    const a = needDate(from ?? to);
    const b = needDate(to ?? from);
    return rangeDates(a, b);
  }
  const n = days > 0 ? days : 7;
  const end = bjToday();
  return rangeDates(addDays(end, -(n - 1)), end);
}

function renderReportText(s, memberName) {
  const pct = (x) => `${Math.round(x * 100)}%`;
  const lines = [];
  lines.push(`📊 ${memberName} · ${s.from} ~ ${s.to}（${s.daysInRange} 天）`);
  lines.push(`提交 ${s.submittedDays}/${s.daysInRange} 天（${pct(s.submissionRate)}），目标 ${s.totalGoals} 条，完成 ${s.done} 条（${pct(s.completionRate)}）`);
  if (s.goalsPerDay) lines.push(`每日目标量：平均 ${s.goalsPerDay.avg.toFixed(1)} 条（${s.goalsPerDay.min}~${s.goalsPerDay.max}）`);
  lines.push(`最长连续提交 ${s.longestStreak} 天${s.longestStreakRange ? `（${s.longestStreakRange[0]} ~ ${s.longestStreakRange[1]}）` : ''}，当前连续 ${s.currentStreakBackwards} 天`);
  if (s.missingDates.length) {
    const show = s.missingDates.slice(0, 10).join('、');
    lines.push(`未提交的日子（${s.missingDates.length} 天）：${show}${s.missingDates.length > 10 ? ' …' : ''}`);
  }
  if (s.pending) lines.push(`⚠️ 还有 ${s.pending} 条一直没标记打卡`);
  if (s.heavyDays.days) lines.push(`目标 ≥5 条的日子 ${s.heavyDays.days} 天，完成率 ${pct(s.heavyDays.completionRate)}`);
  if (s.lightDays.days) lines.push(`目标 ≤3 条的日子 ${s.lightDays.days} 天，完成率 ${pct(s.lightDays.completionRate)}`);
  if (s.lateNightChecks) lines.push(`22:00 之后才打卡的次数：${s.lateNightChecks}`);
  const wd = s.weekday.filter((w) => w.days >= 2).sort((a, b) => a.rate - b.rate);
  if (wd.length) {
    lines.push('按星期：');
    for (const w of wd) lines.push(`  ${w.weekday} 提交 ${w.days} 天，完成 ${pct(w.rate)}`);
  }
  if (s.repeatStuck.length) {
    lines.push('反复没完成的目标：');
    for (const r of s.repeatStuck) lines.push(`  · ${r.text}（出现 ${r.times} 次，完成 ${r.done} 次）`);
  }
  return lines.join('\n');
}

function cmdReport(argv) {
  const id = checkMemberId(positional(argv)[0] ?? '');
  const member = getMember(id);
  const asJson = takeBool(argv, '--json');
  const withRecords = takeBool(argv, '--with-records');
  const dates = resolveRange(argv);
  const s = statsFor(id, dates);
  if (asJson) {
    const payload = { member: { id, name: member.name }, stats: s };
    if (withRecords) {
      payload.records = dates.map((d) => readRecord(id, d)).filter(Boolean);
    }
    console.log(JSON.stringify(payload, null, 2));
    return;
  }
  ok(renderReportText(s, member.name));
}

/* ------------------------------- 提醒候选 ------------------------------- */

const MSG_0730 = (name) => `早上好呀，${name} ☀️\n新的一天开始啦，请设置你今天的工作/学习/生活小目标～\n写好了发给我就行，我会帮你记下来。`;
const MSG_2130 = (name, pending) => `晚上好，${name} 🌙\n你今日的目标还没有完成打卡，请及时打卡：\n${pending.map((g) => `  · ${g.text}`).join('\n')}\n（21:30 之后也随时可以补打卡，不着急～）`;

const OUTBOX = path.join(DATA_DIR, 'outbox');

/** 没有个人推送通道时落地到 outbox，保证提醒不丢、可追溯 */
function writeOutbox(date, kind, t) {
  const dir = path.join(OUTBOX, `${date}-${kind}`);
  const file = path.join(dir, `${t.memberId}.txt`);
  writeJson(path.join(dir, `${t.memberId}.json`), { date, kind, ...t, generatedAt: nowIso() });
  fs.writeFileSync(file, `${t.text}\n`, 'utf8');
  return file;
}

function remindCandidates(kind, date) {
  const members = listMembers({ activeOnly: true });
  const out = [];
  for (const m of members) {
    const rec = readRecord(m.id, date);
    if (kind === '0730') {
      if (!rec || !rec.goals.length) {
        out.push({ memberId: m.id, name: m.name, chatId: m.feishuChatId ?? null, reason: '今日未提交目标', text: MSG_0730(m.name), pending: [] });
      }
    } else if (kind === '2130') {
      if (!rec || !rec.goals.length) continue; // 完全没提交 → 不打扰
      const pending = rec.goals.filter((g) => g.status === 'pending');
      if (!pending.length) continue;
      out.push({
        memberId: m.id,
        name: m.name,
        chatId: m.feishuChatId ?? null,
        reason: `已提交目标但有 ${pending.length} 条未打卡`,
        text: MSG_2130(m.name, pending),
        pending: pending.map((g) => ({ id: g.id, text: g.text })),
      });
    }
  }
  return out;
}

async function sendFeishu(chatId, text) {
  const cfgFile = process.env.DSH_BRIDGE_CONFIG
    || path.join(os.homedir(), '.dsh', 'dsh-bridge', 'config.json');
  const cfg = readJson(cfgFile, null);
  if (!cfg) return { code: -1, msg: '找不到 dsh-bridge 配置，未发送' };
  const { appId, appSecret, domain = 'feishu' } = cfg.feishu ?? {};
  const base = domain === 'lark' ? 'https://open.larksuite.com' : 'https://open.feishu.cn';
  const tokRes = await (await fetch(`${base}/open-apis/auth/v3/tenant_access_token/internal`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ app_id: appId, app_secret: appSecret }),
  })).json();
  const token = tokRes.tenant_access_token;
  const r = await (await fetch(`${base}/open-apis/im/v1/messages?receive_id_type=chat_id`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json; charset=utf-8' },
    body: JSON.stringify({ receive_id: chatId, msg_type: 'text', content: JSON.stringify({ text }) }),
  })).json();
  return r;
}

async function cmdRemind(argv) {
  const sub = positional(argv)[0];
  if (sub !== '0730' && sub !== '2130') die('用法：remind 0730|2130 [--date D] [--json] [--send]');
  const date = needDate(takeFlag(argv, '--date') ?? bjToday());
  const asJson = takeBool(argv, '--json');
  const send = takeBool(argv, '--send');
  const list = remindCandidates(sub, date);
  if (asJson) {
    console.log(JSON.stringify({ kind: sub, date, count: list.length, targets: list }, null, 2));
    return;
  }
  if (!list.length) {
    ok(`（${date} ${sub} 没有需要提醒的人）`);
    return;
  }
  ok(`⏰ ${date} ${sub} 提醒候选 ${list.length} 人（一人一条，勿群发）：`);
  for (const t of list) {
    ok(`\n── ${t.name}（${t.memberId}）· ${t.reason} ──\n${t.text}`);
    if (send) {
      if (!t.chatId) {
        const f = writeOutbox(date, sub, t);
        ok(`  ⚠️ 未配置个人推送通道（member set <id> --chat <chat_id>），已写入待发：${f}`);
        continue;
      }
      const r = await sendFeishu(t.chatId, t.text);
      ok(`  发送：code=${r.code} msg=${r.msg}`);
      if (r.code !== 0) ok(`  已落到待发箱：${writeOutbox(date, sub, t)}`);
    }
  }
}

/* ------------------------------- 概览 ------------------------------- */

function cmdStatus(argv) {
  const date = needDate(takeFlag(argv, '--date') ?? bjToday());
  const asJson = takeBool(argv, '--json');
  const members = listMembers({ activeOnly: true });
  const rows = members.map((m) => {
    const rec = readRecord(m.id, date);
    const goals = rec?.goals ?? [];
    return {
      memberId: m.id,
      name: m.name,
      submitted: Boolean(rec && goals.length),
      total: goals.length,
      done: goals.filter((g) => g.status === 'done').length,
      failed: goals.filter((g) => g.status === 'failed').length,
      pending: goals.filter((g) => g.status === 'pending').length,
    };
  });
  if (asJson) {
    console.log(JSON.stringify({ date, members: rows }, null, 2));
    return;
  }
  ok(`🗓 ${date}（${dateToWeekday(date)}）共 ${rows.length} 位成员`);
  for (const r of rows) {
    if (!r.submitted) {
      ok(`  · ${r.name}：今日未提交目标`);
    } else {
      ok(`  · ${r.name}：${r.done}/${r.total} 完成${r.failed ? `，${r.failed} 条未完成` : ''}${r.pending ? `，${r.pending} 条未打卡` : ''}`);
    }
  }
}

/* ------------------------------- 入口 ------------------------------- */

// 被 import 时只当库用（analyze.mjs 等），被直接执行时才跑 CLI
export {
  DATA_DIR,
  RECORD_DIR,
  MEMBERS_FILE,
  STATUS,
  ICON,
  bjParts,
  bjToday,
  nowIso,
  isValidDate,
  dateToWeekday,
  addDays,
  daysBetween,
  rangeDates,
  readJson,
  readRecord,
  readAllRecords,
  listMembers,
  getMember,
  statsFor,
  fmtTime,
  renderRecord,
  renderReportText,
};

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  main();
}

function main() {
  ensureDirs();
  const argv = process.argv.slice(2);
  const cmd = argv.shift();
  switch (cmd) {
    case 'member': return cmdMember(argv);
    case 'submit': return cmdSubmit(argv);
    case 'check': return cmdCheck(argv);
    case 'note': return cmdNote(argv);
    case 'edit': return cmdEdit(argv);
    case 'query': return cmdQuery(argv);
    case 'report': return cmdReport(argv);
    case 'remind': return cmdRemind(argv);
    case 'status': return cmdStatus(argv);
    case 'today':
      ok(bjToday());
      return;
    case 'now':
      ok(nowIso());
      return;
    case 'help':
    case undefined:
      return printHelp();
    default:
      die(`未知命令 ${cmd}，试试 help`);
  }
}

function printHelp() {
  ok(`家庭多人小目标打卡中心 · 数据层 CLI

成员
  member list
  member add <id> --name "名字" [--share true] [--chat <chat_id>]
  member set <id> --name "名字" [--share true] [--chat <chat_id>]
  member on|off <id>

当日目标
  submit <id> [--date D] [--file goals.json] "目标1" "目标2" ...
  submit <id> [--date D] --replace --file goals.json
  edit <id> [--date D] --add "新目标||第二条" --remove 2 --rename "2||改后的文本"
  check <id> [--date D] --goal 2 [--done|--fail|--pending] [--note "备注"]
  note <id> [--date D] --goal 2 --note "备注"

查询与分析数据
  query <id> [--date D | --from A --to B] [--json]
  report <id> [--days 7|30|90 | --from A --to B] [--json] [--with-records]
  status [--date D] [--json]

定时调度用（到点由外部调度器调用，一人一条）
  remind 0730 [--date D] [--json] [--send]
  remind 2130 [--date D] [--json] [--send]

其它
  today | now | help`);
}
