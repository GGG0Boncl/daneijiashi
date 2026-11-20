// 由 tools/sync-assets.mjs 从 shared/court-state.mjs 复制，别直接改这里
/**
 * 国事状态（国家大事 / 六部差事 / 户部流水）的纯数据层
 *
 * 这份代码两端共用：
 *   - 中枢：court/state.mjs 读写磁盘、按身份把关
 *   - App ：tools/sync-assets.mjs 拷成 app/www/court-state.js
 *
 * 所以这里不许 import 任何 Node 专有的东西，也不许有 DOM。
 *
 * 同步原则：手机先记，中枢随后合并；两边都按 updatedAt 取新，
 * 删除用"墓碑"（tombstone，记下删除时刻），比墓碑旧的记录一律不复活。
 */

/** 七部 id：与 court/personas.mjs 保持一致（有单测盯着） */
export const DEPT_IDS = ['libu', 'hubu', 'libu2', 'bingbu', 'xingbu', 'gongbu', 'silijian'];

export const ANNUAL_STATUS = { pending: '还没动', doing: '在办', done: '已办成' };
export const ANNUAL_PERIOD = { year: '年度', half: '半年度' };
export const ANNUAL_ADJUST_LIMIT = 3;
export const TASK_STATUS = { pending: '未开工', doing: '在办', done: '已办成' };

const LEDGER_MAX = 2000;

const nowIso = () => new Date().toISOString();

/** 时间字符串 → 毫秒；认不出来算 0（最旧） */
export function asTime(value) {
  const t = Date.parse(String(value ?? ''));
  return Number.isFinite(t) ? t : 0;
}

export const clampPct = (n) => Math.max(0, Math.min(100, Math.round(Number(n) || 0)));

const pad2 = (n) => String(n).padStart(2, '0');

/** 毫秒 → 北京时间 ISO（差事的“到点”用它，跨端才不会差八小时） */
export function bjIsoFromMs(ms) {
  const s = new Intl.DateTimeFormat('sv-SE', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(new Date(ms));
  return `${s.replace(' ', 'T')}+08:00`;
}

function cleanDue(value) {
  if (!value) return null;
  const t = asTime(value);
  return t > 0 ? bjIsoFromMs(t) : null;
}

const str = (v, max = 200) => String(v ?? '').slice(0, max);

export function validId(id) {
  if (typeof id !== 'string') return false;
  if (!id || id.length > 120) return false;
  if (/[\\/]/.test(id) || id.includes('..')) return false;
  return true;
}

export const emptyCourtState = () => ({ annual: { items: [], deleted: {} }, tasks: {}, ledger: { entries: [], deleted: {} } });

function cleanDeleted(raw) {
  const out = {};
  if (!raw || typeof raw !== 'object') return out;
  for (const [id, at] of Object.entries(raw)) {
    if (validId(id) && Number.isFinite(asTime(at)) && asTime(at) > 0) out[id] = new Date(asTime(at)).toISOString();
  }
  return out;
}

function cleanText(text, max = 200) {
  return str(text, max).trim();
}

export function normalizeAnnualItem(raw) {
  const id = validId(raw?.id) ? raw.id : null;
  const text = cleanText(raw?.text, 120);
  if (!id || !text) return null;
  const progress = clampPct(raw?.progress);
  let status = ANNUAL_STATUS[raw?.status] ? raw.status : progress >= 100 ? 'done' : progress > 0 ? 'doing' : 'pending';
  if (progress >= 100) status = 'done';
  const createdAt = Number.isFinite(asTime(raw?.createdAt)) && asTime(raw?.createdAt) > 0 ? new Date(asTime(raw.createdAt)).toISOString() : nowIso();
  const updatedAt = Number.isFinite(asTime(raw?.updatedAt)) && asTime(raw?.updatedAt) > 0 ? new Date(asTime(raw.updatedAt)).toISOString() : createdAt;
  const year = Number(raw?.year) || new Date(createdAt).getFullYear();
  const rawBudget = raw?.budget;
  const budget = rawBudget === null || rawBudget === undefined || rawBudget === ''
    ? null
    : Number.isFinite(Number(rawBudget)) && Number(rawBudget) >= 0
      ? Math.round(Number(rawBudget) * 100) / 100
      : null;
  return {
    id,
    text,
    period: ANNUAL_PERIOD[raw?.period] ? raw.period : 'year',
    status,
    progress,
    budget,
    adjustments: Math.max(0, Math.trunc(Number(raw?.adjustments) || 0)),
    adjustmentsYear: Number(raw?.adjustmentsYear) || new Date(createdAt).getFullYear(),
    owner: raw?.owner ? str(raw.owner, 40) : null,
    note: str(raw?.note, 200),
    year,
    createdAt,
    updatedAt,
  };
}

export function normalizeTask(raw, dept) {
  const id = validId(raw?.id) ? raw.id : null;
  const text = cleanText(raw?.text, 120);
  if (!id || !text) return null;
  const progress = clampPct(raw?.progress);
  const createdAt = Number.isFinite(asTime(raw?.createdAt)) && asTime(raw?.createdAt) > 0 ? new Date(asTime(raw.createdAt)).toISOString() : nowIso();
  const updatedAt = Number.isFinite(asTime(raw?.updatedAt)) && asTime(raw?.updatedAt) > 0 ? new Date(asTime(raw.updatedAt)).toISOString() : createdAt;
  return {
    id,
    dept,
    text,
    note: str(raw?.note, 200),
    progress,
    status: progress >= 100 ? 'done' : progress > 0 ? 'doing' : 'pending',
    due: cleanDue(raw?.due),
    by: raw?.by ? str(raw.by, 40) : null,
    createdAt,
    updatedAt,
  };
}

export function normalizeLedgerEntry(raw) {
  const id = validId(raw?.id) ? raw.id : null;
  const amount = Number(raw?.amount);
  const item = cleanText(raw?.item, 40);
  if (!id || !item || !Number.isFinite(amount) || amount <= 0) return null;
  const at = Number.isFinite(asTime(raw?.at)) && asTime(raw?.at) > 0 ? new Date(asTime(raw.at)).toISOString() : nowIso();
  const updatedAt = Number.isFinite(asTime(raw?.updatedAt)) && asTime(raw.updatedAt) > 0 ? new Date(asTime(raw.updatedAt)).toISOString() : at;
  const date = /^\d{4}-\d{2}-\d{2}$/.test(String(raw?.date ?? '')) ? raw.date : at.slice(0, 10);
  return {
    id,
    at,
    date,
    by: raw?.by ? str(raw.by, 40) : null,
    amount: Math.round(amount * 100) / 100,
    item,
    categoryId: str(raw?.categoryId, 20) || 'other',
    categoryLabel: str(raw?.categoryLabel, 12) || '其他',
    raw: str(raw?.raw, 120),
    updatedAt,
  };
}

/** 容错：任何来路的数据都收成这一副形状 */
export function normalizeCourtState(raw) {
  const out = emptyCourtState();
  if (!raw || typeof raw !== 'object') return out;

  const annual = raw.annual && typeof raw.annual === 'object' ? raw.annual : {};
  const annualItems = Array.isArray(annual.items) ? annual.items : Array.isArray(raw.annual) ? raw.annual : [];
  out.annual.items = annualItems.map(normalizeAnnualItem).filter(Boolean);
  out.annual.deleted = cleanDeleted(annual.deleted);

  const tasks = raw.tasks && typeof raw.tasks === 'object' ? raw.tasks : {};
  for (const dept of DEPT_IDS) {
    const section = tasks[dept];
    const items = Array.isArray(section?.items) ? section.items : Array.isArray(section) ? section : [];
    out.tasks[dept] = {
      items: items.map((t) => normalizeTask(t, dept)).filter(Boolean),
      deleted: cleanDeleted(section?.deleted),
    };
  }

  const ledger = raw.ledger && typeof raw.ledger === 'object' ? raw.ledger : {};
  const entries = Array.isArray(ledger.entries) ? ledger.entries : Array.isArray(raw.ledger) ? raw.ledger : [];
  out.ledger.entries = entries
    .map(normalizeLedgerEntry)
    .filter(Boolean)
    .sort((a, b) => asTime(a.at) - asTime(b.at))
    .slice(-LEDGER_MAX);
  out.ledger.deleted = cleanDeleted(ledger.deleted);
  return out;
}

/* ------------------------------ 合并 ------------------------------ */

function mergeDeleted(a, b) {
  const out = { ...(a ?? {}) };
  for (const [id, at] of Object.entries(b ?? {})) {
    if (!out[id] || asTime(at) > asTime(out[id])) out[id] = at;
  }
  return out;
}

/**
 * 两摞记录取新合并：先铺 remote，再让 local 里更新的盖上去；
 * 同一时刻（并列）以 remote 为准——手机重传旧稿不会把别人的新稿盖掉。
 */
function mergeItemMaps(localItems, remoteItems) {
  const map = new Map();
  for (const it of remoteItems) map.set(it.id, it);
  for (const it of localItems) {
    const prev = map.get(it.id);
    if (!prev || asTime(it.updatedAt) > asTime(prev.updatedAt)) map.set(it.id, it);
  }
  return map;
}

export function mergeAnnualSections(localSection, remoteSection) {
  const local = localSection ?? { items: [], deleted: {} };
  const remote = remoteSection ?? { items: [], deleted: {} };
  const deleted = mergeDeleted(local.deleted, remote.deleted);
  const map = mergeItemMaps(local.items, remote.items);
  for (const [id, item] of [...map.entries()]) {
    const at = deleted[id];
    if (at && asTime(at) >= asTime(item.updatedAt)) map.delete(id);
  }
  const items = [...map.values()].sort((a, b) => asTime(a.createdAt) - asTime(b.createdAt) || a.id.localeCompare(b.id));
  return { items, deleted };
}

export function mergeTaskSections(dept, localSection, remoteSection) {
  const local = localSection ?? { items: [], deleted: {} };
  const remote = remoteSection ?? { items: [], deleted: {} };
  const deleted = mergeDeleted(local.deleted, remote.deleted);
  const map = mergeItemMaps(local.items, remote.items);
  for (const [id, item] of [...map.entries()]) {
    const at = deleted[id];
    if (at && asTime(at) >= asTime(item.updatedAt)) map.delete(id);
  }
  const items = [...map.values()].sort((a, b) => asTime(a.createdAt) - asTime(b.createdAt) || a.id.localeCompare(b.id));
  return { items: items.map((t) => ({ ...t, dept })), deleted };
}

export function mergeLedgerSections(localSection, remoteSection) {
  const deleted = mergeDeleted(localSection?.deleted, remoteSection?.deleted);
  const map = new Map();
  for (const e of [...(remoteSection?.entries ?? []), ...(localSection?.entries ?? [])]) {
    const prev = map.get(e.id);
    // 账目可改：按 updatedAt 取新；同一时刻以远端为准，旧稿不会盖回新账
    if (!prev || asTime(e.updatedAt) > asTime(prev.updatedAt)) map.set(e.id, e);
  }
  for (const [id, entry] of [...map.entries()]) {
    const at = deleted[id];
    if (at && asTime(at) >= asTime(entry.updatedAt)) map.delete(id);
  }
  const entries = [...map.values()].sort((a, b) => asTime(a.at) - asTime(b.at)).slice(-LEDGER_MAX);
  return { entries, deleted };
}

export function mergeCourtState(localRaw, remoteRaw) {
  const local = normalizeCourtState(localRaw);
  const remote = normalizeCourtState(remoteRaw);
  const tasks = {};
  for (const dept of DEPT_IDS) tasks[dept] = mergeTaskSections(dept, local.tasks[dept], remote.tasks[dept]);
  return {
    annual: mergeAnnualSections(local.annual, remote.annual),
    tasks,
    ledger: mergeLedgerSections(local.ledger, remote.ledger),
  };
}

/* ------------------------------ 统计 ------------------------------ */

export function annualSummary(state) {
  const items = state?.annual?.items ?? [];
  const done = items.filter((i) => i.status === 'done').length;
  const avg = items.length ? Math.round(items.reduce((a, i) => a + (i.progress ?? 0), 0) / items.length) : 0;
  const budgetTotal = items.reduce((a, i) => a + (Number(i.budget) || 0), 0);
  const budgeted = items.filter((i) => Number(i.budget) > 0).length;
  return { total: items.length, done, avg, open: items.length - done, budgetTotal: Math.round(budgetTotal * 100) / 100, budgeted };
}

export function taskSummary(state, dept) {
  const items = state?.tasks?.[dept]?.items ?? [];
  const done = items.filter((t) => t.progress >= 100).length;
  const avg = items.length ? Math.round(items.reduce((a, t) => a + (t.progress ?? 0), 0) / items.length) : 0;
  return { total: items.length, done, open: items.length - done, avg };
}
