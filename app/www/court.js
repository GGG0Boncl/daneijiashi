/**
 * 国事本机改造（App 侧，纯函数，不碰 DOM）
 *
 * 设计：手机先记在本机（IndexedDB），中枢只是同步的另一份。
 * 没连中枢也照常加国家大事、下旨、记流水；连上后由 syncCourtNow() 整份推上去合并。
 */
import {
  ANNUAL_ADJUST_LIMIT, ANNUAL_PERIOD, DEPT_IDS, annualSummary, bjIsoFromMs, clampPct,
  emptyCourtState, mergeCourtState, normalizeCourtState, taskSummary,
} from './court-state.js';
import { categorize, parseLedgerText, summarizeLedger } from './ledger.js';

export {
  ANNUAL_ADJUST_LIMIT, ANNUAL_PERIOD, DEPT_IDS, annualSummary, clampPct,
  emptyCourtState, mergeCourtState, normalizeCourtState, taskSummary,
};

const genId = () => `c-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
const pad = (n) => String(n).padStart(2, '0');
const isoOf = (d) => d.toISOString();
const dateOf = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const bjDateOf = (d = new Date()) => new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Shanghai' }).format(d);
const dateOrToday = (value, now = new Date()) => (
  /^\d{4}-\d{2}-\d{2}$/.test(String(value ?? '')) ? String(value) : bjDateOf(now)
);
const atForDate = (date, now = new Date()) => (
  date === bjDateOf(now) ? isoOf(now) : new Date(`${date}T12:00:00+08:00`).toISOString()
);

/** 该桩大事今年还剩几次调整（改措辞/周期才算调整） */
export function adjustmentsLeft(item, now = new Date()) {
  const used = item?.adjustmentsYear === now.getFullYear() ? (item?.adjustments ?? 0) : 0;
  return Math.max(0, ANNUAL_ADJUST_LIMIT - used);
}

function touch(item) {
  item.updatedAt = isoOf(new Date());
  return item;
}

/* ------------------------------ 国家大事 ------------------------------ */

export function addAnnualLocal(state, { text, period = 'year', by = null, budget = null } = {}) {
  const t = String(text ?? '').trim();
  if (!t) throw new Error('内阁大事得写一句话');
  if (t.length > 60) throw new Error('大事写短一点，60 字以内');
  const s = normalizeCourtState(state);
  const at = isoOf(new Date());
  const year = new Date().getFullYear();
  const amount = Number(budget);
  s.annual.items.push({
    id: genId(),
    text: t,
    period: ANNUAL_PERIOD[period] ? period : 'year',
    status: 'pending',
    progress: 0,
    budget: Number.isFinite(amount) && amount >= 0 ? Math.round(amount * 100) / 100 : null,
    adjustments: 0,
    adjustmentsYear: year,
    owner: by ?? null,
    note: '',
    year,
    createdAt: at,
    updatedAt: at,
  });
  return s;
}

/**
 * 改一桩内阁大事。progress/status 随便改（日常汇报）；
 * text/period/budget 算一次调整，用满 3 次就不许再动。
 */
export function updateAnnualLocal(state, id, patch = {}) {
  const s = normalizeCourtState(state);
  const item = s.annual.items.find((i) => i.id === id);
  if (!item) throw new Error('找不到这件大事');
  const year = new Date().getFullYear();
  if (item.adjustmentsYear !== year) {
    item.adjustmentsYear = year;
    item.adjustments = 0;
  }
  const structural = patch.text !== undefined || patch.period !== undefined || patch.budget !== undefined;
  const nextText = patch.text !== undefined ? String(patch.text).trim() : item.text;
  if (patch.text !== undefined && !nextText) throw new Error('内容不能为空');
  if (patch.period !== undefined && !ANNUAL_PERIOD[patch.period]) throw new Error('周期只能是年度 / 半年度');
  const nextBudget = patch.budget !== undefined
    ? Number.isFinite(Number(patch.budget)) && Number(patch.budget) >= 0
      ? Math.round(Number(patch.budget) * 100) / 100
      : null
    : item.budget;
  const changed = (patch.text !== undefined && nextText !== item.text)
    || (patch.period !== undefined && patch.period !== item.period)
    || (patch.budget !== undefined && nextBudget !== item.budget);
  if (structural && changed && item.adjustments >= ANNUAL_ADJUST_LIMIT) {
    throw new Error(`这桩大事今年已调整 ${ANNUAL_ADJUST_LIMIT} 次，不能再改了（进度照旧可记）`);
  }
  if (patch.text !== undefined) item.text = nextText;
  if (patch.period !== undefined) item.period = patch.period;
  if (patch.budget !== undefined) item.budget = nextBudget;
  if (patch.progress !== undefined) {
    const p = clampPct(patch.progress);
    item.progress = p;
    item.status = p >= 100 ? 'done' : p > 0 ? 'doing' : 'pending';
  }
  if (patch.status !== undefined) {
    if (!['pending', 'doing', 'done'].includes(patch.status)) throw new Error('状态不对');
    item.status = patch.status;
    if (patch.status === 'done') item.progress = 100;
    if (patch.status === 'pending') item.progress = 0;
  }
  if (changed) item.adjustments += 1;
  touch(item);
  return s;
}

export function removeAnnualLocal(state, id) {
  const s = normalizeCourtState(state);
  if (!s.annual.items.some((i) => i.id === id)) throw new Error('找不到这件大事');
  s.annual.items = s.annual.items.filter((i) => i.id !== id);
  s.annual.deleted = { ...s.annual.deleted, [id]: isoOf(new Date()) };
  return s;
}

/* ------------------------------ 六部差事 ------------------------------ */

const section = (state, dept) => {
  state.tasks[dept] = state.tasks[dept] ?? { items: [], deleted: {} };
  return state.tasks[dept];
};

export function addTaskLocal(state, dept, { text, by = null, progress = 0, due = null } = {}) {
  if (!DEPT_IDS.includes(dept)) throw new Error(`没有这个部：${dept}`);
  const t = String(text ?? '').trim();
  if (!t) throw new Error('圣旨总得写句话');
  if (t.length > 80) throw new Error('旨意写短点，80 字以内');
  const dueMs = due ? Date.parse(due) : NaN;
  const s = normalizeCourtState(state);
  const at = isoOf(new Date());
  const p = clampPct(progress);
  section(s, dept).items.push({
    id: genId(),
    dept,
    text: t,
    note: '',
    progress: p,
    status: p >= 100 ? 'done' : p > 0 ? 'doing' : 'pending',
    due: Number.isFinite(dueMs) ? bjIsoFromMs(dueMs) : null,
    by: by ?? null,
    createdAt: at,
    updatedAt: at,
  });
  return s;
}

export function updateTaskLocal(state, dept, id, patch = {}) {
  const s = normalizeCourtState(state);
  const item = section(s, dept).items.find((t) => t.id === id);
  if (!item) throw new Error('找不到这道旨意');
  if (patch.progress !== undefined) {
    const p = clampPct(patch.progress);
    item.progress = p;
    item.status = p >= 100 ? 'done' : p > 0 ? 'doing' : 'pending';
  }
  if (patch.text !== undefined) {
    const t = String(patch.text).trim();
    if (!t) throw new Error('内容不能为空');
    item.text = t;
  }
  if (patch.due !== undefined) {
    const dueMs = patch.due ? Date.parse(patch.due) : NaN;
    item.due = patch.due && Number.isFinite(dueMs) ? bjIsoFromMs(dueMs) : null;
  }
  touch(item);
  return s;
}

export function removeTaskLocal(state, dept, id) {
  const s = normalizeCourtState(state);
  const sec = section(s, dept);
  if (!sec.items.some((t) => t.id === id)) throw new Error('找不到这道旨意');
  sec.items = sec.items.filter((t) => t.id !== id);
  sec.deleted = { ...sec.deleted, [id]: isoOf(new Date()) };
  return s;
}

/* ------------------------------ 户部流水 ------------------------------ */

/** 司礼监确认后直接落一笔（账目可精确到日期、可改可删） */
export function addLedgerEntryLocal(state, { item, amount, date = null }, { by = null, now = new Date() } = {}) {
  const name = String(item ?? '').trim();
  const value = Math.round(Number(amount) * 100) / 100;
  if (!name) return { ok: false, state: normalizeCourtState(state), error: '这笔账没写名目' };
  if (!Number.isFinite(value) || value <= 0 || value > 1_000_000) {
    return { ok: false, state: normalizeCourtState(state), error: '金额得是 0 到 100 万之间的正数' };
  }
  const s = normalizeCourtState(state);
  const day = dateOrToday(date, now);
  const at = atForDate(day, now);
  const category = categorize(name);
  const entry = {
    id: genId(),
    at,
    date: day,
    by: by ?? null,
    amount: value,
    item: name.slice(0, 40),
    categoryId: category.id,
    categoryLabel: category.label,
    raw: name,
    updatedAt: isoOf(now),
  };
  s.ledger.entries = [...s.ledger.entries, entry]
    .sort((a, b) => String(a.at).localeCompare(String(b.at)))
    .slice(-2000);
  return { ok: true, state: s, entry };
}

/** 改一笔记错的账：名目、金额、日期都能改，归类随名目重算 */
export function updateLedgerLocal(state, id, patch = {}) {
  const s = normalizeCourtState(state);
  const entry = s.ledger.entries.find((e) => e.id === id);
  if (!entry) throw new Error('找不到这笔账');
  const nextItem = patch.item !== undefined ? String(patch.item).trim() : entry.item;
  if (!nextItem) throw new Error('名目不能空着');
  const nextAmount = patch.amount !== undefined ? Math.round(Number(patch.amount) * 100) / 100 : entry.amount;
  if (!Number.isFinite(nextAmount) || nextAmount <= 0 || nextAmount > 1_000_000) throw new Error('金额得是正数');
  const nextDate = patch.date !== undefined ? dateOrToday(patch.date) : entry.date;
  const oldDate = entry.date;
  if (nextItem !== entry.item) {
    const category = categorize(nextItem);
    entry.categoryId = category.id;
    entry.categoryLabel = category.label;
  }
  entry.item = nextItem.slice(0, 40);
  entry.amount = nextAmount;
  entry.date = nextDate;
  if (nextDate !== oldDate) entry.at = atForDate(nextDate);
  entry.updatedAt = isoOf(new Date());
  s.ledger.entries = [...s.ledger.entries].sort((a, b) => String(a.at).localeCompare(String(b.at)));
  return s;
}

export function removeLedgerLocal(state, id) {
  const s = normalizeCourtState(state);
  if (!s.ledger.entries.some((e) => e.id === id)) throw new Error('找不到这笔账');
  s.ledger.entries = s.ledger.entries.filter((e) => e.id !== id);
  s.ledger.deleted = { ...s.ledger.deleted, [id]: isoOf(new Date()) };
  return s;
}

export function addLedgerLocal(state, text, { by = null, now = new Date() } = {}) {
  const parsed = parseLedgerText(text);
  if (!parsed.ok) {
    return { ok: false, state: normalizeCourtState(state), error: parsed.error, unparsed: parsed.unparsed ?? [] };
  }
  const s = normalizeCourtState(state);
  const at = isoOf(now);
  const date = dateOf(now);
  const entries = parsed.entries.map((e) => ({
    id: genId(), at, date, by: by ?? null, ...e, updatedAt: at,
  }));
  s.ledger.entries = [...s.ledger.entries, ...entries]
    .sort((a, b) => String(a.at).localeCompare(String(b.at)))
    .slice(-2000);
  return { ok: true, state: s, entries, unparsed: parsed.unparsed ?? [] };
}

export function summarizeLedgerLocal(state, { days = 30, now = new Date() } = {}) {
  return summarizeLedger(state?.ledger?.entries ?? [], { days, now });
}

/** 按日分组的账目，供户部按日期翻看。range: today | 7 | month | all */
export function groupLedger(state, { range = '7', now = new Date() } = {}) {
  const today = bjDateOf(now);
  const since = range === 'today'
    ? today
    : range === 'month'
      ? `${today.slice(0, 7)}-01`
      : range === 'all'
        ? ''
        : bjDateOf(new Date(now.getTime() - 6 * 86400000));
  const rows = (state?.ledger?.entries ?? []).filter((e) => {
    const day = String(e.date ?? '');
    return day && day <= today && (!since || day >= since);
  });
  const byDay = new Map();
  for (const e of rows) {
    const day = String(e.date);
    if (!byDay.has(day)) byDay.set(day, []);
    byDay.get(day).push(e);
  }
  const days = [...byDay.entries()]
    .sort((a, b) => b[0].localeCompare(a[0]))
    .map(([date, entries]) => {
      const sorted = [...entries].sort((a, b) => String(a.at).localeCompare(String(b.at)));
      return {
        date,
        count: sorted.length,
        total: Math.round(sorted.reduce((a, e) => a + (Number(e.amount) || 0), 0) * 100) / 100,
        entries: sorted,
      };
    });
  const total = Math.round(rows.reduce((a, e) => a + (Number(e.amount) || 0), 0) * 100) / 100;
  const todayRows = rows.filter((e) => e.date === today);
  const monthRows = rows.filter((e) => String(e.date).startsWith(today.slice(0, 7)));
  const sum = (list) => Math.round(list.reduce((a, e) => a + (Number(e.amount) || 0), 0) * 100) / 100;
  return {
    range, days, count: rows.length, total,
    todayCount: todayRows.length, todayTotal: sum(todayRows),
    monthCount: monthRows.length, monthTotal: sum(monthRows),
  };
}
