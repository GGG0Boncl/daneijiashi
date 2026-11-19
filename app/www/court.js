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
import { parseLedgerText, summarizeLedger } from './ledger.js';

export {
  ANNUAL_ADJUST_LIMIT, ANNUAL_PERIOD, DEPT_IDS, annualSummary, clampPct,
  emptyCourtState, mergeCourtState, normalizeCourtState, taskSummary,
};

const genId = () => `c-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
const pad = (n) => String(n).padStart(2, '0');
const isoOf = (d) => d.toISOString();
const dateOf = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

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

export function addLedgerLocal(state, text, { by = null, now = new Date() } = {}) {
  const parsed = parseLedgerText(text);
  if (!parsed.ok) {
    return { ok: false, state: normalizeCourtState(state), error: parsed.error, unparsed: parsed.unparsed ?? [] };
  }
  const s = normalizeCourtState(state);
  const at = isoOf(now);
  const date = dateOf(now);
  const entries = parsed.entries.map((e) => ({ id: genId(), at, date, by: by ?? null, ...e }));
  s.ledger.entries = [...s.ledger.entries, ...entries]
    .sort((a, b) => String(a.at).localeCompare(String(b.at)))
    .slice(-2000);
  return { ok: true, state: s, entries, unparsed: parsed.unparsed ?? [] };
}

export function summarizeLedgerLocal(state, { days = 30, now = new Date() } = {}) {
  return summarizeLedger(state?.ledger?.entries ?? [], { days, now });
}
