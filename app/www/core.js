/**
 * 家庭打卡 · 纯逻辑层（无 DOM、无 IO）
 *
 * 为什么要单独一层：手机上我无法点击验证，只有把这部分做成纯函数并用
 * node:test 覆盖，才能真正锁住"打卡状态机"和"提醒排期规则"。
 */

export const STATUS_LABEL = { pending: '未回话', doing: '在办', done: '办成了', failed: '没办成' };
export const STATUS_ICON = { pending: '○', doing: '◐', done: '✓', failed: '✗' };

const clampPct = (n) => Math.max(0, Math.min(100, Math.round(Number(n) || 0)));

/** 每条差事都带百分制进度；status 只是进度的派生物（failed 是显式标记） */
export function goalProgress(g) {
  if (Number.isFinite(Number(g?.progress))) return clampPct(g.progress);
  if (g?.status === 'done') return 100;
  return 0;
}

const pad = (n) => String(n).padStart(2, '0');
const TZ = 'Asia/Shanghai';

/** 北京时间：日期、当天分钟数、ISO 带偏移 */
export function bjParts(now = new Date()) {
  const s = new Intl.DateTimeFormat('sv-SE', {
    timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  }).format(now);
  const [date, time] = s.split(' ');
  const [h, m] = time.split(':').map(Number);
  return { date, minutes: h * 60 + m, iso: `${date}T${time}+08:00`, time };
}

export const bjToday = (now = new Date()) => bjParts(now).date;
export const bjIso = (now = new Date()) => bjParts(now).iso;

export function addDays(dateStr, n) {
  const d = new Date(`${dateStr}T00:00:00+08:00`);
  d.setUTCDate(d.getUTCDate() + n);
  return bjParts(d).date;
}

export function weekdayLabel(dateStr) {
  const idx = new Date(`${dateStr}T00:00:00+08:00`).getDay();
  return `周${'日一二三四五六'[idx]}`;
}

/** 未删除的目标（墓碑不参与展示与统计） */
export function liveGoals(rec) {
  return (rec?.goals ?? []).filter((g) => !g.deleted);
}

export function summarize(rec) {
  const goals = liveGoals(rec);
  const total = goals.length;
  const done = goals.filter((g) => goalProgress(g) >= 100).length;
  const failed = goals.filter((g) => g.status === 'failed').length;
  const pending = goals.filter((g) => goalProgress(g) < 100 && g.status !== 'failed').length;
  const progressSum = goals.reduce((a, g) => a + goalProgress(g), 0);
  return {
    total,
    done,
    failed,
    pending,
    progress: total ? progressSum / total : 0, // 0~100 的平均进度
    rate: total ? progressSum / (total * 100) : 0, // 0~1，给旧口径用
    settled: total > 0,
  };
}

export const pendingGoals = (rec) => liveGoals(rec).filter((g) => goalProgress(g) < 100 && g.status !== 'failed');

function nextGoalId(goals) {
  let max = 0;
  for (const g of goals ?? []) {
    const n = Number(String(g.id).replace(/^g/, ''));
    if (Number.isFinite(n) && n > max) max = n;
  }
  return `g${max + 1}`;
}

export function createRecord(identity, date, now = new Date()) {
  return {
    memberId: identity.memberId,
    memberName: identity.memberName ?? null,
    date,
    version: 1,
    submittedAt: bjIso(now),
    updatedAt: bjIso(now),
    deviceId: identity.deviceId ?? null,
    goals: [],
  };
}

/** 所有写操作都返回新记录，调用方负责持久化 */
function touch(rec, now) {
  return {
    ...rec,
    version: (rec.version ?? 0) + 1,
    updatedAt: bjIso(now),
    submittedAt: rec.submittedAt ?? bjIso(now),
  };
}

export function addGoal(rec, text, now = new Date()) {
  const t = String(text ?? '').trim();
  if (!t) throw new Error('目标内容不能为空');
  if (t.length > 60) throw new Error('目标太长啦，60 字以内比较好记');
  const goals = rec.goals ?? [];
  if (goals.some((g) => !g.deleted && g.text === t)) throw new Error('这条目标已经在了');
  const goal = {
    id: nextGoalId(goals),
    text: t,
    progress: 0,
    status: 'pending',
    checkedAt: null,
    note: '',
    createdAt: bjIso(now),
    updatedAt: bjIso(now),
    deleted: false,
  };
  return touch({ ...rec, goals: [...goals, goal] }, now);
}

function patchGoal(rec, goalId, patch, now) {
  const goals = rec.goals ?? [];
  const idx = goals.findIndex((g) => g.id === goalId);
  if (idx < 0) throw new Error('找不到这条目标');
  const next = [...goals];
  next[idx] = { ...goals[idx], ...patch, updatedAt: bjIso(now) };
  return touch({ ...rec, goals: next }, now);
}

export function setGoalStatus(rec, goalId, status, now = new Date(), note) {
  if (!STATUS_LABEL[status]) throw new Error(`未知状态: ${status}`);
  const patch = {
    status,
    checkedAt: status === 'pending' ? null : bjIso(now),
  };
  if (status === 'done') patch.progress = 100;
  if (status === 'pending') patch.progress = 0;
  if (note !== undefined) patch.note = String(note);
  return patchGoal(rec, goalId, patch, now);
}

/** 滑动设置完成度（0~100），status 跟着变 */
export function setGoalProgress(rec, goalId, pct, now = new Date()) {
  const progress = clampPct(pct);
  const goal = (rec.goals ?? []).find((g) => g.id === goalId);
  if (!goal) throw new Error('找不到这条目标');
  const status = progress >= 100 ? 'done' : progress <= 0 && goal.status !== 'failed' ? 'pending' : progress <= 0 ? 'failed' : 'doing';
  return patchGoal(rec, goalId, {
    progress,
    status,
    checkedAt: progress > 0 ? bjIso(now) : null,
  }, now);
}

/** 点一下在「办了」与「没办」之间切换（快捷手势，进度直接 100 / 0） */
export function toggleGoalDone(rec, goalId, now = new Date()) {
  const goal = (rec.goals ?? []).find((g) => g.id === goalId);
  if (!goal) throw new Error('找不到这条目标');
  return setGoalProgress(rec, goalId, goalProgress(goal) >= 100 ? 0 : 100, now);
}

export function setGoalNote(rec, goalId, note, now = new Date()) {
  return patchGoal(rec, goalId, { note: String(note ?? '') }, now);
}

export function renameGoal(rec, goalId, text, now = new Date()) {
  const t = String(text ?? '').trim();
  if (!t) throw new Error('目标内容不能为空');
  if (t.length > 60) throw new Error('目标太长啦，60 字以内比较好记');
  return patchGoal(rec, goalId, { text: t }, now);
}

/** 删除＝墓碑，保证同步时不会被另一台设备复活 */
export function removeGoal(rec, goalId, now = new Date()) {
  return patchGoal(rec, goalId, { deleted: true }, now);
}

/**
 * 本地提醒排期（纯函数，便于单测）
 *
 * 07:30 —— 当天还没提交目标才排（已提交不排）；今天已过点则不排。
 *          未来 6 天每天都排 07:30（到点那天必然还没提交过当天目标）。
 * 21:30 —— 只给"今天提交过 + 还有未打卡"排；没提交的人绝不排。
 */
export function planReminders(records, now = new Date()) {
  const { date: today, minutes } = bjParts(now);
  const rec = (records ?? []).find((r) => r.date === today) ?? null;
  const goals = liveGoals(rec);
  const pending = goals.filter((g) => g.status === 'pending');
  const plan = [];

  for (let d = 0; d < 7; d += 1) {
    const dateStr = addDays(today, d);
    if (d === 0) {
      if (minutes >= 7 * 60 + 30) continue; // 今天 07:30 已过
      if (goals.length > 0) continue; // 已经提交过今天的目标 → 不打扰
    }
    plan.push({
      id: 1000 + d,
      kind: '0730',
      at: `${dateStr}T07:30:00+08:00`,
      title: '早上好呀',
      body: '请设置你今天的工作 / 学习 / 生活小目标～',
      extra: { date: dateStr },
    });
  }

  if (rec && pending.length > 0 && minutes < 21 * 60 + 30) {
    const shown = pending.slice(0, 5).map((g) => `· ${g.text}`).join('\n');
    const more = pending.length > 5 ? `\n…还有 ${pending.length - 5} 条` : '';
    plan.push({
      id: 2000,
      kind: '2130',
      at: `${today}T21:30:00+08:00`,
      title: '今天还有目标没打卡',
      body: `你今日的目标还没有完成打卡，请及时打卡：\n${shown}${more}`,
      extra: { date: today, pending: pending.length },
    });
  }

  return plan;
}

/** 一天的展示文案（今日卡片/历史行共用） */
export function dayLabel(rec) {
  const s = summarize(rec);
  if (!s.settled) return '还没有目标';
  if (s.done === s.total) return `俱已办成 · 100%`;
  return `已办 ${Math.round(s.progress)}% · 办了 ${s.done}/${s.total} 桩`;
}

/* -------------------------- 纯文本导出 -------------------------- */

/**
 * 「复制全部数据」用的格式（用户指定）：
 *   2026年11月18日：具体事项1；具体事项2；…；具体事项N。
 * 一天一行，按日期从早到晚，没记录的日子不占行，删除的目标不出现。
 */
export function exportRecordsAsText(records) {
  const rows = (records ?? [])
    .filter((r) => liveGoals(r).length > 0 && /^\d{4}-\d{2}-\d{2}$/.test(String(r?.date ?? '')))
    .sort((a, b) => String(a.date).localeCompare(String(b.date)))
    .map((r) => {
      const [y, m, d] = r.date.split('-').map(Number);
      const items = liveGoals(r)
        .map((g) => String(g.text ?? '').replace(/[；;]+/g, '，').trim())
        .filter(Boolean)
        .join('；');
      return `${y}年${m}月${d}日：${items}。`;
    });
  return rows.join('\n');
}

/* -------------------------- 日历（历史页） -------------------------- */

export const RETENTION_OPTIONS = [
  { months: 3, label: '3 个月' },
  { months: 6, label: '半年' },
  { months: 12, label: '1 年' },
];

export const monthKey = (dateStr) => String(dateStr).slice(0, 7);

export function addMonths(key, n) {
  const [y, m] = String(key).split('-').map(Number);
  const d = new Date(Date.UTC(y, m - 1 + n, 1));
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}`;
}

export function monthRange(key) {
  const [y, m] = String(key).split('-').map(Number);
  const total = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return Array.from({ length: total }, (_, i) => `${key}-${pad(i + 1)}`);
}

/** 允许回溯的最早月份：保留上限（默认 12 个月）往前推 */
export function earliestMonth(now = new Date(), retentionMonths = 12) {
  return addMonths(monthKey(bjToday(now)), -(Math.max(1, retentionMonths) - 1));
}

/**
 * 月历网格（周一起），每格带上当天进度，便于一眼看出哪天空着。
 * level: 0 没记录 / 1 全没成 / 2 部分完成 / 3 全部完成
 */
export function calendarGrid(month, records, now = new Date()) {
  const byDate = new Map((records ?? []).map((r) => [r.date, r]));
  const [y, m] = String(month).split('-').map(Number);
  const firstWeekday = new Date(Date.UTC(y, m - 1, 1)).getUTCDay();
  const lead = (firstWeekday + 6) % 7; // 周一=0
  const total = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const today = bjToday(now);

  const cells = [];
  for (let i = 0; i < lead; i += 1) cells.push({ key: `blank-${i}`, blank: true });
  for (let d = 1; d <= total; d += 1) {
    const date = `${month}-${pad(d)}`;
    const rec = byDate.get(date) ?? null;
    const s = summarize(rec);
    cells.push({
      key: date,
      blank: false,
      date,
      day: d,
      submitted: s.total > 0,
      total: s.total,
      done: s.done,
      failed: s.failed,
      pending: s.pending,
      future: date > today,
      isToday: date === today,
      level: s.total === 0 ? 0 : s.rate >= 1 ? 3 : s.rate > 0 ? 2 : 1,
    });
  }
  // 补到整周，网格对齐
  while (cells.length % 7 !== 0) cells.push({ key: `blank-pad-${cells.length}`, blank: true });
  return cells;
}

/** 某个月的汇总（历史页顶部那行字） */
export function monthSummary(month, records, now = new Date()) {
  const byDate = new Map((records ?? []).map((r) => [r.date, r]));
  const today = bjToday(now);
  let days = 0;
  let submitted = 0;
  let total = 0;
  let done = 0;
  for (const date of monthRange(month)) {
    if (date > today) continue;
    days += 1;
    const rec = byDate.get(date);
    const s = summarize(rec);
    if (s.total === 0) continue;
    submitted += 1;
    total += s.total;
    done += s.done;
  }
  return { days, submitted, total, done, rate: total ? done / total : 0 };
}

/**
 * 只保留最近 N 个月（用户可选 3 / 6 / 12，最长一年）。
 * 返回要删的日期列表与保留的记录，由调用方落库。
 */
export function pruneRecords(records, retentionMonths = 12, now = new Date()) {
  const cutoff = `${earliestMonth(now, retentionMonths)}-01`;
  const kept = [];
  const removed = [];
  for (const r of records ?? []) {
    if (typeof r?.date === 'string' && r.date >= cutoff) kept.push(r);
    else removed.push(r);
  }
  return { kept, removed, cutoff };
}


/** 近 n 天统计（不含未来；缺记录的日子算"未提交"） */
export function recentStats(records, n = 7, now = new Date()) {
  const today = bjToday(now);
  const byDate = new Map((records ?? []).map((r) => [r.date, r]));
  let days = 0;
  let submitted = 0;
  let total = 0;
  let done = 0;
  for (let i = n - 1; i >= 0; i -= 1) {
    const d = addDays(today, -i);
    days += 1;
    const rec = byDate.get(d);
    if (!rec) continue;
    const s = summarize(rec);
    if (s.total > 0) {
      submitted += 1;
      total += s.total;
      done += s.done;
    }
  }
  return { days, submitted, total, done, rate: total ? done / total : 0 };
}
