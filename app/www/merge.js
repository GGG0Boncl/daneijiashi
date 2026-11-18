// 由 tools/sync-assets.mjs 从 hub/merge.mjs 复制，别直接改这里
/**
 * 双向合并：以"每条目标"为最小单位，按 updatedAt 晚者胜。
 * 纯函数，无 IO —— 便于用 node:test 直接验证（手机端 UI 我无法真机点击，
 * 合并逻辑必须靠单测锁住）。
 *
 * 记录结构（与 checkin.mjs 对齐，另加同步字段）：
 * {
 *   memberId, memberName, date, version, submittedAt, updatedAt, deviceId,
 *   goals: [{ id, text, status, checkedAt, note, createdAt, updatedAt, deleted }]
 * }
 */

export const STATUSES = ['pending', 'done', 'failed'];

/**
 * 所有时间统一成北京时间（+08:00）落盘：
 * 手机、电脑、第三方都可能是 UTC，混着存会让"晚者胜"与展示都出错。
 */
export function toBjIso(value) {
  if (!value) return null;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return value;
  const s = new Intl.DateTimeFormat('sv-SE', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  }).format(d);
  return `${s.replace(' ', 'T')}+08:00`;
}

const timeOf = (obj) => {
  const t = Date.parse(obj?.updatedAt ?? obj?.checkedAt ?? obj?.createdAt ?? 0);
  return Number.isFinite(t) ? t : 0;
};

/** 两条目标谁更新（同刻则 a 胜，保证确定性；a=本地/旧，b=远端/新） */
export function pickNewerGoal(a, b) {
  if (!a) return b;
  if (!b) return a;
  if (timeOf(b) > timeOf(a)) return b;
  return a;
}

function normalizeGoal(g) {
  if (!g || !g.id) throw new Error('目标缺少 id');
  const status = STATUSES.includes(g.status) ? g.status : 'pending';
  const progress = Number.isFinite(Number(g.progress))
    ? Math.max(0, Math.min(100, Math.round(Number(g.progress))))
    : status === 'done' ? 100 : 0;
  return {
    id: String(g.id),
    text: String(g.text ?? ''),
    status,
    progress,
    checkedAt: g.status === 'pending' ? null : toBjIso(g.checkedAt),
    note: g.note ?? '',
    createdAt: toBjIso(g.createdAt),
    updatedAt: toBjIso(g.updatedAt ?? g.createdAt),
    deleted: g.deleted === true,
  };
}

function normalizeRecord(r) {
  if (!r || !r.memberId || !r.date) throw new Error('记录缺少 memberId/date');
  return {
    memberId: String(r.memberId),
    memberName: r.memberName ?? null,
    date: String(r.date),
    version: Number(r.version ?? 0),
    submittedAt: toBjIso(r.submittedAt),
    updatedAt: toBjIso(r.updatedAt),
    deviceId: r.deviceId ?? null,
    goals: (r.goals ?? []).map(normalizeGoal),
  };
}

/** 合并两份同 (memberId,date) 的记录；任一方为 null 时返回另一方（规范化后副本） */
export function mergeRecord(local, remote) {
  if (!local && !remote) return null;
  if (!local) return normalizeRecord(remote);
  if (!remote) return normalizeRecord(local);

  const a = normalizeRecord(local);
  const b = normalizeRecord(remote);
  if (a.memberId !== b.memberId) throw new Error('memberId 不一致，拒绝合并');
  if (a.date !== b.date) throw new Error('date 不一致，拒绝合并');

  const byId = new Map();
  for (const g of a.goals) byId.set(g.id, g);
  for (const g of b.goals) byId.set(g.id, pickNewerGoal(byId.get(g.id), g));

  const goals = [...byId.values()].sort((x, y) => {
    const nx = Number(String(x.id).replace(/^g/, ''));
    const ny = Number(String(y.id).replace(/^g/, ''));
    if (Number.isFinite(nx) && Number.isFinite(ny) && nx !== ny) return nx - ny;
    return String(x.id).localeCompare(String(y.id));
  });

  // version 只在"两侧内容真的不同"时才 +1；完全一致时保持不动（幂等）
  const canonical = (goals) =>
    JSON.stringify(
      [...goals]
        .sort((x, y) => String(x.id).localeCompare(String(y.id), undefined, { numeric: true }))
        .map((g) => [g.id, g.text, g.status, g.checkedAt, g.note, g.createdAt, g.updatedAt, g.deleted]),
    );
  const changed = canonical(a.goals) !== canonical(b.goals);

  const updatedAt = [a.updatedAt, b.updatedAt].filter(Boolean).sort().at(-1) ?? null;
  const submittedAt = [a.submittedAt, b.submittedAt].filter(Boolean).sort()[0] ?? null;

  return {
    memberId: a.memberId,
    memberName: a.memberName ?? b.memberName ?? null,
    date: a.date,
    version: Math.max(a.version, b.version) + (changed ? 1 : 0),
    submittedAt,
    updatedAt,
    deviceId: timeOf(b) > timeOf(a) ? b.deviceId : a.deviceId,
    goals,
  };
}

/** 合并两组记录（按 date 为键；同一天的多个远端会依次折叠，不会互相覆盖） */
export function mergeRecords(locals, remotes) {
  const byDate = new Map();
  const slot = (date) => {
    let cur = byDate.get(date);
    if (!cur) {
      cur = { local: null, remotes: [] };
      byDate.set(date, cur);
    }
    return cur;
  };
  for (const r of locals ?? []) slot(r.date).local = normalizeRecord(r);
  for (const r of remotes ?? []) slot(r.date).remotes.push(r);

  const out = [];
  for (const [date, { local, remotes: remoteList }] of [...byDate.entries()].sort((x, y) => x[0].localeCompare(y[0]))) {
    let acc = local;
    for (const remote of remoteList) acc = mergeRecord(acc, remote);
    if (acc) out.push(acc);
  }
  return out;
}

/** 未删除的目标（展示/统计用） */
export const liveGoals = (rec) => (rec?.goals ?? []).filter((g) => !g.deleted);
