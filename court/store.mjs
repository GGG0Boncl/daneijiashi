/**
 * 朝廷档案库：奏疏 / 批示 / 记忆 / 各部台账
 *
 * 全部是本地 JSON/JSONL，和打卡数据同住一个 data 目录，随时可整体备份。
 */
import fs from 'node:fs';
import path from 'node:path';

export const STATUS = {
  pending: '待批阅',
  approved: '已朱批',
  held: '留中',
  rejected: '已驳回',
  counciling: '待合议',
};

export const ROLES = ['emperor', 'empress', 'member'];
export const ROLE_LABEL = { emperor: '陛下', empress: '皇后', member: '家人' };
export const canDispose = (role) => role === 'emperor' || role === 'empress';

function courtDir(dataDir) {
  return path.join(dataDir, 'court');
}

export function ensureCourtDirs(dataDir) {
  for (const sub of ['memorials', 'memory', 'items', 'ledger']) {
    fs.mkdirSync(path.join(courtDir(dataDir), sub), { recursive: true });
  }
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

const readJsonl = (file) => {
  try {
    return fs
      .readFileSync(file, 'utf8')
      .split('\n')
      .filter(Boolean)
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
};

const appendJsonl = (file, row) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, `${JSON.stringify(row)}\n`, 'utf8');
};

/* ------------------------------ 身份 ------------------------------ */

const rolesFile = (dataDir) => path.join(courtDir(dataDir), 'roles.json');

export function readRoles(dataDir) {
  return readJson(rolesFile(dataDir), {});
}

export function roleOf(dataDir, memberId) {
  return readRoles(dataDir)[memberId] ?? 'member';
}

export function setRole(dataDir, memberId, role) {
  if (!ROLES.includes(role)) throw new Error(`未知身份：${role}`);
  const roles = readRoles(dataDir);
  roles[memberId] = role;
  writeJson(rolesFile(dataDir), roles);
  return role;
}

/* ------------------------------ 奏疏 ------------------------------ */

export const memorialDir = (dataDir) => path.join(courtDir(dataDir), 'memorials');

export function newMemorialId(now = new Date()) {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
}

export function saveMemorial(dataDir, memorial) {
  writeJson(path.join(memorialDir(dataDir), `${memorial.id}.json`), memorial);
  pruneMemorials(dataDir, memorial.dept);
  return memorial;
}

export function readMemorial(dataDir, id) {
  if (!id || /[\\/]/.test(id) || id.includes('..')) return null;
  return readJson(path.join(memorialDir(dataDir), `${id}.json`), null);
}

export function listMemorials(dataDir, { dept = null, status = null, limit = 30 } = {}) {
  const dir = memorialDir(dataDir);
  if (!fs.existsSync(dir)) return [];
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.json')).sort().reverse();
  const out = [];
  for (const f of files) {
    const m = readJson(path.join(dir, f), null);
    if (!m) continue;
    if (dept && m.dept !== dept) continue;
    if (status && m.status !== status) continue;
    out.push(m);
    if (out.length >= limit) break;
  }
  return out;
}

/** 每部最多留 20 份，防止档案无限膨胀 */
export function pruneMemorials(dataDir, dept, keep = 20) {
  const mine = listMemorials(dataDir, { dept, limit: 999 });
  for (const extra of mine.slice(keep)) {
    try {
      fs.unlinkSync(path.join(memorialDir(dataDir), `${extra.id}.json`));
    } catch {
      /* 删不掉就算了 */
    }
  }
}

/**
 * 批阅状态机：只有帝后能批；已批的不能重复批；驳回必须带批注（好让该部记住）。
 * 返回更新后的奏疏。
 */
export function disposeMemorial(dataDir, { id, action, comment = '', role, by = null, at }) {
  if (!canDispose(role)) {
    const err = new Error('只有陛下与皇后可以批阅');
    err.statusCode = 403;
    throw err;
  }
  const memorial = readMemorial(dataDir, id);
  if (!memorial) {
    const err = new Error('找不到这份奏疏');
    err.statusCode = 404;
    throw err;
  }
  if (memorial.status === 'approved') {
    const err = new Error('这份已经朱批过了');
    err.statusCode = 409;
    throw err;
  }
  if (!['approve', 'hold', 'reject', 'council'].includes(action)) {
    const err = new Error(`未知批示：${action}`);
    err.statusCode = 400;
    throw err;
  }
  if (action === 'reject' && !String(comment).trim()) {
    const err = new Error('驳回请写一句原因，好让该部知道怎么改');
    err.statusCode = 400;
    throw err;
  }

  const nextStatus = { approve: 'approved', hold: 'held', reject: 'rejected', council: 'counciling' }[action];
  const disposition = { action, comment: String(comment).trim(), role, by, at };
  memorial.status = nextStatus;
  memorial.dispositions = [...(memorial.dispositions ?? []), disposition];
  memorial.updatedAt = at;

  if (action === 'reject') {
    appendMemory(dataDir, memorial.dept, `《${memorial.title}》被${ROLE_LABEL[role]}驳回：${disposition.comment}`);
  }
  if (action === 'approve') {
    appendMemory(dataDir, memorial.dept, `《${memorial.title}》已获${ROLE_LABEL[role]}朱批${disposition.comment ? `：${disposition.comment}` : ''}`);
    writeJson(path.join(courtDir(dataDir), 'edicts', `${memorial.id}-${Date.now()}.json`), {
      type: role === 'empress' ? '懿旨' : '圣旨',
      memorialId: memorial.id,
      dept: memorial.dept,
      title: memorial.title,
      comment: disposition.comment,
      by: by ?? ROLE_LABEL[role],
      at,
    });
  }
  writeJson(path.join(memorialDir(dataDir), `${memorial.id}.json`), memorial);
  return memorial;
}

/** 六部收到批示后回奏一句进展 */
export function addReply(dataDir, { id, text, by = null, at }) {
  const memorial = readMemorial(dataDir, id);
  if (!memorial) {
    const err = new Error('找不到这份奏疏');
    err.statusCode = 404;
    throw err;
  }
  const reply = { text: String(text ?? '').trim(), by, at };
  if (!reply.text) {
    const err = new Error('回奏内容不能为空');
    err.statusCode = 400;
    throw err;
  }
  memorial.replies = [...(memorial.replies ?? []), reply];
  memorial.updatedAt = at;
  writeJson(path.join(memorialDir(dataDir), `${memorial.id}.json`), memorial);
  return memorial;
}

/* ------------------------------ 记忆 ------------------------------ */

const memoryFile = (dataDir, dept) => path.join(courtDir(dataDir), 'memory', `${dept}.json`);

export function readMemory(dataDir, dept) {
  return readJson(memoryFile(dataDir, dept), []);
}

export function appendMemory(dataDir, dept, note) {
  const list = readMemory(dataDir, dept);
  list.push(String(note));
  writeJson(memoryFile(dataDir, dept), list.slice(-30));
  return list;
}

/* ------------------------------ 各部台账 ------------------------------ */

const itemsFile = (dataDir, dept) => path.join(courtDir(dataDir), 'items', `${dept}.jsonl`);

export function appendItem(dataDir, dept, { text, by = null, kind = 'note', at }) {
  const row = { id: `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`, dept, text: String(text ?? '').trim(), kind, by, at };
  if (!row.text) {
    const err = new Error('内容不能为空');
    err.statusCode = 400;
    throw err;
  }
  appendJsonl(itemsFile(dataDir, dept), row);
  return row;
}

export function listItems(dataDir, dept, { limit = 50 } = {}) {
  return readJsonl(itemsFile(dataDir, dept)).slice(-limit);
}

/* ------------------------------ 户部流水 ------------------------------ */

const ledgerFile = (dataDir) => path.join(courtDir(dataDir), 'ledger', 'entries.jsonl');

export function appendLedger(dataDir, entry) {
  appendJsonl(ledgerFile(dataDir), entry);
  return entry;
}

export function listLedger(dataDir) {
  return readJsonl(ledgerFile(dataDir));
}

export const budgetFile = (dataDir) => path.join(courtDir(dataDir), 'budget.json');

export function readBudget(dataDir) {
  return readJson(budgetFile(dataDir), { monthly: null });
}

export function setBudget(dataDir, monthly) {
  const value = Number(monthly);
  if (!Number.isFinite(value) || value <= 0) {
    const err = new Error('预算要是正数');
    err.statusCode = 400;
    throw err;
  }
  writeJson(budgetFile(dataDir), { monthly: Math.round(value * 100) / 100 });
  return readBudget(dataDir);
}
