/**
 * 国家大事：这个家的年度 / 半年度要事。
 *
 * 规矩（用户定）：每桩大事每年最多调整 3 次——改太多就不叫"大事"了。
 */
import fs from 'node:fs';
import path from 'node:path';

const file = (dataDir) => path.join(dataDir, 'court', 'annual.json');

const readJson = (f, fallback) => {
  try {
    return JSON.parse(fs.readFileSync(f, 'utf8'));
  } catch {
    return fallback;
  }
};

const writeJson = (f, v) => {
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, `${JSON.stringify(v, null, 2)}\n`, 'utf8');
};

export const ANNUAL_STATUS = { pending: '还没动', doing: '在办', done: '已办成' };
export const ANNUAL_PERIOD = { year: '年度', half: '半年度' };
export const ANNUAL_ADJUST_LIMIT = 3;

export function listAnnual(dataDir) {
  const data = readJson(file(dataDir), { items: [] });
  return Array.isArray(data.items) ? data.items.map((i) => ({
    progress: 0,
    status: 'pending',
    period: 'year',
    adjustments: 0,
    adjustmentsYear: new Date().getFullYear(),
    ...i,
  })) : [];
}

function save(dataDir, items) {
  writeJson(file(dataDir), { items });
  return items.map((i) => ({ ...i }));
}

/** 同步用：整份覆盖（调用方已合并好） */
export function saveAnnualItems(dataDir, items) {
  return save(dataDir, Array.isArray(items) ? items : []);
}

const clamp = (n) => Math.max(0, Math.min(100, Math.round(Number(n) || 0)));

export function addAnnual(dataDir, { text, owner = null, note = '', period = 'year', budget = null, year = new Date().getFullYear() }) {
  const t = String(text ?? '').trim();
  if (!t) {
    const err = new Error('国家大事得写一句话');
    err.statusCode = 400;
    throw err;
  }
  if (t.length > 60) {
    const err = new Error('大事写短一点，60 字以内');
    err.statusCode = 400;
    throw err;
  }
  const items = listAnnual(dataDir);
  const amount = Number(budget);
  const item = {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    text: t,
    owner: owner || null,
    note: String(note ?? ''),
    period: ANNUAL_PERIOD[period] ? period : 'year',
    budget: Number.isFinite(amount) && amount >= 0 ? Math.round(amount * 100) / 100 : null,
    year: Number(year) || new Date().getFullYear(),
    status: 'pending',
    progress: 0,
    adjustments: 0,
    adjustmentsYear: new Date().getFullYear(),
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  items.push(item);
  save(dataDir, items);
  return item;
}

/**
 * 改国家大事。
 *
 * 只有"改措辞 / 改周期"才算调整，才吃那 3 次名额；
 * 拖动进度、记进度变化属于日常汇报，不该把名额耗光。
 */
export function updateAnnual(dataDir, { id, text, status, note, owner, progress, period, budget }) {
  const items = listAnnual(dataDir);
  const item = items.find((x) => x.id === id);
  if (!item) {
    const err = new Error('找不到这件大事');
    err.statusCode = 404;
    throw err;
  }
  const year = new Date().getFullYear();
  if (item.adjustmentsYear !== year) {
    item.adjustmentsYear = year;
    item.adjustments = 0;
  }

  // 先算出改完是什么样，只有真变了才算一次调整（没改分毫就不耗名额）
  const nextText = text !== undefined ? String(text).trim() : item.text;
  if (text !== undefined && !nextText) {
    const err = new Error('内容不能为空');
    err.statusCode = 400;
    throw err;
  }
  if (period !== undefined && !ANNUAL_PERIOD[period]) {
    const err = new Error('周期只能是年度 / 半年度');
    err.statusCode = 400;
    throw err;
  }
  const nextBudget = budget !== undefined
    ? Number.isFinite(Number(budget)) && Number(budget) >= 0
      ? Math.round(Number(budget) * 100) / 100
      : null
    : item.budget ?? null;
  const changed = (text !== undefined && nextText !== item.text)
    || (period !== undefined && period !== item.period)
    || (budget !== undefined && nextBudget !== (item.budget ?? null));
  if (changed && item.adjustments >= ANNUAL_ADJUST_LIMIT) {
    const err = new Error(`这桩大事今年已调整 ${ANNUAL_ADJUST_LIMIT} 次，不能再改了（进度照旧可记）`);
    err.statusCode = 409;
    throw err;
  }
  if (text !== undefined) item.text = nextText;
  if (period !== undefined) item.period = period;
  if (budget !== undefined) item.budget = nextBudget;

  if (progress !== undefined) {
    const p = clamp(progress);
    item.progress = p;
    item.status = p >= 100 ? 'done' : p > 0 ? 'doing' : item.status === 'done' ? 'doing' : item.status;
    if (p < 100 && item.status === 'done') item.status = 'doing';
  }
  if (status !== undefined) {
    if (!ANNUAL_STATUS[status]) {
      const err = new Error(`状态只能是 ${Object.keys(ANNUAL_STATUS).join('/')}`);
      err.statusCode = 400;
      throw err;
    }
    item.status = status;
    if (status === 'done') item.progress = 100;
    if (status === 'pending') item.progress = 0;
  }
  if (note !== undefined) item.note = String(note);
  if (owner !== undefined) item.owner = owner || null;
  if (changed) item.adjustments += 1;
  item.updatedAt = new Date().toISOString();
  save(dataDir, items);
  return { ...item, adjustmentsLeft: Math.max(0, ANNUAL_ADJUST_LIMIT - item.adjustments) };
}

export function removeAnnual(dataDir, { id }) {
  const items = listAnnual(dataDir);
  const next = items.filter((x) => x.id !== id);
  if (next.length === items.length) {
    const err = new Error('找不到这件大事');
    err.statusCode = 404;
    throw err;
  }
  save(dataDir, next);
  return { id, removed: true };
}

/** 给礼部/司礼监看的摘要 */
export function annualDigest(dataDir) {
  const items = listAnnual(dataDir);
  if (!items.length) return '国家大事：暂无（可在御书房添加今年想办成的事）';
  const by = (s) => items.filter((i) => i.status === s).length;
  const avg = Math.round(items.reduce((a, i) => a + (i.progress ?? 0), 0) / items.length);
  const budget = Math.round(items.reduce((a, i) => a + (Number(i.budget) || 0), 0) * 100) / 100;
  const lines = [`内阁大事 ${items.length} 桩：已办成 ${by('done')}、在办 ${by('doing')}、还没动 ${by('pending')}，平均进度 ${avg}%，预算合计 ¥${budget}`];
  for (const i of items.filter((x) => x.status !== 'done').slice(0, 8)) {
    const money = Number(i.budget) > 0 ? ` · 预算 ¥${i.budget}` : '';
    lines.push(`· ${i.text}（${ANNUAL_PERIOD[i.period] ?? '年度'} · ${i.progress ?? 0}%${money} · ${ANNUAL_STATUS[i.status] ?? i.status}）`);
  }
  return lines.join('\n');
}
