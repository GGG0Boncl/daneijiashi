/**
 * 六部任务（把"发圣旨"落成可跟踪的差事）
 *
 * 帝后给某个部下一道旨 → 变成该部的一条任务，带百分制进度；
 * 部里上奏时会看到自己名下的任务，进度也会进看板。
 */
import fs from 'node:fs';
import path from 'node:path';

const file = (dataDir, dept) => path.join(dataDir, 'court', 'tasks', `${dept}.json`);

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

const clamp = (n) => Math.max(0, Math.min(100, Math.round(Number(n) || 0)));

export const TASK_STATUS = { pending: '未开工', doing: '在办', done: '已办成' };

export function listTasks(dataDir, dept) {
  const data = readJson(file(dataDir, dept), { items: [] });
  return Array.isArray(data.items) ? data.items : [];
}

function save(dataDir, dept, items) {
  writeJson(file(dataDir, dept), { items });
  return items;
}

/** 同步用：整份覆盖（调用方已合并好） */
export function saveTaskItems(dataDir, dept, items) {
  return save(dataDir, dept, Array.isArray(items) ? items : []);
}

export function addTask(dataDir, dept, { text, by = null, progress = 0, note = '' }) {
  const t = String(text ?? '').trim();
  if (!t) {
    const err = new Error('圣旨总得写句话');
    err.statusCode = 400;
    throw err;
  }
  if (t.length > 80) {
    const err = new Error('旨意写短点，80 字以内');
    err.statusCode = 400;
    throw err;
  }
  const items = listTasks(dataDir, dept);
  const p = clamp(progress);
  const item = {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    dept,
    text: t,
    note: String(note ?? ''),
    progress: p,
    status: p >= 100 ? 'done' : p > 0 ? 'doing' : 'pending',
    by: by || null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  items.push(item);
  save(dataDir, dept, items);
  return item;
}

export function updateTask(dataDir, dept, { id, progress, text, note }) {
  const items = listTasks(dataDir, dept);
  const item = items.find((x) => x.id === id);
  if (!item) {
    const err = new Error('找不到这道旨意');
    err.statusCode = 404;
    throw err;
  }
  if (progress !== undefined) {
    const p = clamp(progress);
    item.progress = p;
    item.status = p >= 100 ? 'done' : p > 0 ? 'doing' : 'pending';
  }
  if (text !== undefined) {
    const t = String(text).trim();
    if (!t) {
      const err = new Error('内容不能为空');
      err.statusCode = 400;
      throw err;
    }
    item.text = t;
  }
  if (note !== undefined) item.note = String(note);
  item.updatedAt = new Date().toISOString();
  save(dataDir, dept, items);
  return item;
}

export function removeTask(dataDir, dept, { id }) {
  const items = listTasks(dataDir, dept);
  const next = items.filter((x) => x.id !== id);
  if (next.length === items.length) {
    const err = new Error('找不到这道旨意');
    err.statusCode = 404;
    throw err;
  }
  save(dataDir, dept, next);
  return { id, removed: true };
}

/** 给该部上奏时用的任务摘要 */
export function tasksDigest(dataDir, dept) {
  const items = listTasks(dataDir, dept);
  if (!items.length) return '御赐差事：暂无（可在御书房给该部下旨）';
  const open = items.filter((i) => i.progress < 100);
  const avg = Math.round(items.reduce((a, i) => a + i.progress, 0) / items.length);
  const lines = [`御赐差事 ${items.length} 道：在办 ${open.length} 道，平均进度 ${avg}%`];
  for (const i of items.slice(0, 6)) {
    lines.push(`· ${i.text}（${i.progress}%${i.status === 'done' ? '，已办成' : ''}）`);
  }
  return lines.join('\n');
}
