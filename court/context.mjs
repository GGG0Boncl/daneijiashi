/**
 * 给各部 Agent 准备"能读到的数据"。
 *
 * 每个部只拿到自己领域的摘要——这就是文档要求的"独立隔离、不跨部乱说"。
 * 摘要同时充当缓存指纹的依据（数据没变就不重新生成奏疏）。
 */
import {
  bjToday, addDays, rangeDates, listMembers, readRecord, statsFor, dateToWeekday,
} from '../checkin.mjs';
import { summarizeLedger } from './ledger.mjs';
import { listLedger, listItems, listMemorials, readMemory, readBudget, STATUS } from './store.mjs';
import { annualDigest } from './annual.mjs';
import { tasksDigest } from './tasks.mjs';

const pct = (x) => (x === null || x === undefined ? '—' : `${Math.round(x * 100)}%`);
const money = (n) => `¥${Number(n).toFixed(2)}`;

function memberLines(days, now) {
  const dates = rangeDates(addDays(bjToday(now), -(days - 1)), bjToday(now));
  const members = listMembers({ activeOnly: true });
  const out = [];
  for (const m of members) {
    const stats = statsFor(m.id, dates);
    const recent3 = rangeDates(addDays(bjToday(now), -2), bjToday(now));
    const s3 = statsFor(m.id, recent3);
    const stuck = (stats.repeatStuck ?? []).slice(0, 3).map((s) => `${s.text}(${s.times}次/${s.done}成)`);
    out.push({
      id: m.id,
      name: m.name,
      submitted: stats.submittedDays,
      days: dates.length,
      done: stats.done,
      total: stats.totalGoals,
      rate: stats.completionRate,
      recentRate: s3.completionRate,
      streak: stats.currentStreakBackwards,
      lateNight: stats.lateNightChecks ?? 0,
      stuck,
    });
  }
  return out;
}

function linbuDigest(now) {
  const rows = memberLines(7, now);
  const dates = rangeDates(addDays(bjToday(now), -6), bjToday(now));
  const lines = [`统计区间：最近 7 天（${dates[0]} ~ ${dates.at(-1)}）`];
  if (!rows.length) {
    lines.push('成员：暂无（还没有人同步过打卡数据）');
  } else {
    lines.push(`成员：${rows.map((r) => r.name).join('、')}`);
    for (const r of rows) {
      lines.push(`· ${r.name}：提交 ${r.submitted}/${r.days} 天，完成 ${r.done}/${r.total} 条（${pct(r.rate)}），最近 3 天完成率 ${pct(r.recentRate)}，连续提交 ${r.streak} 天${r.stuck.length ? `；反复卡住：${r.stuck.join('、')}` : ''}`);
    }
    const avgGoals = rows.reduce((a, r) => a + (r.total / Math.max(1, r.submitted)), 0) / rows.length;
    lines.push(`整体：人均每天 ${avgGoals.toFixed(1)} 条目标`);
  }
  const late = rows.reduce((a, r) => a + r.lateNight, 0);
  if (late) lines.push(`22 点之后才打卡：${late} 次`);
  return { text: lines.join('\n'), facts: rows };
}

function hubuDigest(dataDir, now) {
  const entries = listLedger(dataDir);
  const s = summarizeLedger(entries, { days: 30, now });
  const budget = readBudget(dataDir);
  const lines = [`统计区间：最近 30 天`, `流水 ${s.count} 笔，合计 ${money(s.total)}`];
  if (s.byCategory.length) {
    lines.push(`分类：${s.byCategory.map((c) => `${c.label} ${money(c.amount)}`).join('；')}`);
  }
  if (s.topItems.length) {
    lines.push(`金额最高的项：${s.topItems.map((i) => `${i.item} ${money(i.amount)}`).join('；')}`);
  }
  if (budget.monthly) {
    const ratio = s.total / budget.monthly;
    lines.push(`月度预算 ${money(budget.monthly)}，近 30 天已用 ${pct(ratio)}${ratio > 1 ? '（已超支）' : ''}`);
  } else {
    lines.push('还没有设置月度预算');
  }
  if (!s.count) lines.push('（还没有记账记录，可用「一句话记账」先记几笔）');
  return { text: lines.join('\n'), facts: s };
}

function libu2Digest(dataDir, now) {
  const items = listItems(dataDir, 'libu2', { limit: 40 });
  const upcoming = items.filter((i) => i.kind === 'event');
  const notes = items.filter((i) => i.kind !== 'event').slice(-5).map((i) => `${i.at.slice(0, 10)} ${i.text}`);
  const lines = [`纪念日/活动清单：${upcoming.length ? upcoming.map((i) => `${i.at.slice(0, 10)} ${i.text}`).join('；') : '暂无'}`];
  lines.push(`家风/活动备注：${notes.length ? notes.join('；') : '暂无'}`);
  lines.push(`近期朝会：${listMemorials(dataDir, { status: 'approved', limit: 3 }).filter((m) => m.dept === 'libu2').length} 次已批准安排`);
  lines.push(annualDigest(dataDir));
  return { text: lines.join('\n'), facts: { upcoming: upcoming.length, notes: notes.length } };
}

function bingbuDigest(dataDir) {
  const items = listItems(dataDir, 'bingbu', { limit: 40 });
  const checks = items.filter((i) => i.kind === 'check');
  const trips = items.filter((i) => i.kind === 'trip');
  const lines = [
    `巡检记录：${checks.length ? checks.slice(-5).map((i) => `${i.at.slice(0, 10)} ${i.text}`).join('；') : '暂无'}`,
    `出行/接送安排：${trips.length ? trips.map((i) => `${i.at.slice(0, 10)} ${i.text}`).join('；') : '暂无'}`,
  ];
  return { text: lines.join('\n'), facts: { checks: checks.length, trips: trips.length } };
}

function xingbuDigest(dataDir) {
  const items = listItems(dataDir, 'xingbu', { limit: 40 });
  const open = items.filter((i) => i.kind === 'dispute');
  const rules = items.filter((i) => i.kind === 'rule');
  const lines = [
    `待调解陈情：${open.length ? open.slice(-5).map((i) => `${i.at.slice(0, 10)} ${i.text}`).join('；') : '暂无'}`,
    `已定家规：${rules.length ? rules.map((i) => i.text).join('；') : '暂无'}`,
  ];
  return { text: lines.join('\n'), facts: { open: open.length, rules: rules.length } };
}

function gongbuDigest(dataDir) {
  const items = listItems(dataDir, 'gongbu', { limit: 40 });
  const chores = items.filter((i) => i.kind === 'chore');
  const repairs = items.filter((i) => i.kind === 'repair');
  const lines = [
    `家务/排班：${chores.length ? chores.slice(-6).map((i) => i.text).join('；') : '暂无'}`,
    `维修登记：${repairs.length ? repairs.slice(-5).map((i) => i.text).join('；') : '暂无'}`,
  ];
  return { text: lines.join('\n'), facts: { chores: chores.length, repairs: repairs.length } };
}

function silijianDigest(dataDir, now) {
  const pending = listMemorials(dataDir, { status: 'pending', limit: 10 });
  const council = listMemorials(dataDir, { status: 'counciling', limit: 5 });
  const held = listMemorials(dataDir, { status: 'held', limit: 5 });
  const lines = [`现在是 ${bjToday(now)}（${dateToWeekday(bjToday(now))}）`];
  lines.push(`待批阅奏疏 ${pending.length} 份：`);
  for (const m of pending) {
    lines.push(`· [${m.deptName}]《${m.title}》（${m.createdAt?.slice(11, 16) ?? ''} 上奏）`);
  }
  if (!pending.length) lines.push('（御书房目前没有待批奏疏）');
  if (council.length) lines.push(`待帝后合议：${council.map((m) => `《${m.title}》`).join('、')}`);
  if (held.length) lines.push(`留中：${held.map((m) => `《${m.title}》`).join('、')}`);
  return { text: lines.join('\n'), facts: { pending: pending.length, council: council.length, held: held.length } };
}

/** 返回 { text, facts, basis } —— basis 用于生成缓存指纹 */
export function digestFor(deptId, { dataDir, now = new Date() } = {}) {
  const map = {
    libu: () => linbuDigest(now),
    hubu: () => hubuDigest(dataDir, now),
    libu2: () => libu2Digest(dataDir, now),
    bingbu: () => bingbuDigest(dataDir),
    xingbu: () => xingbuDigest(dataDir),
    gongbu: () => gongbuDigest(dataDir),
    silijian: () => silijianDigest(dataDir, now),
  };
  const build = map[deptId];
  if (!build) throw new Error(`未知部门：${deptId}`);
  const { text, facts } = build();
  const withTasks = `${text}\n\n${tasksDigest(dataDir, deptId)}`;
  return {
    text: withTasks,
    facts,
    basis: JSON.stringify({ deptId, text: withTasks }),
    memory: readMemory(dataDir, deptId),
  };
}

export { STATUS };
