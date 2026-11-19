import test from 'node:test';
import assert from 'node:assert/strict';
import {
  bjParts, addDays, weekdayLabel, summarize, liveGoals, pendingGoals,
  createRecord, addGoal, setGoalStatus, toggleGoalDone, setGoalNote, renameGoal,
  removeGoal, planReminders, dayLabel, recentStats, bjToday,
  monthKey, addMonths, monthRange, earliestMonth, calendarGrid, monthSummary, pruneRecords,
  RETENTION_OPTIONS, exportRecordsAsText,
} from '../www/core.js';

const ME = { memberId: 'alice', memberName: '妈妈', deviceId: 'dev-a' };
const at = (iso) => new Date(iso);
const rec = (over = {}) => {
  const base = createRecord(ME, '2026-11-18', at('2026-11-18T07:00:00+08:00'));
  return { ...base, ...over };
};
const withGoals = (texts, over = {}) => {
  let r = rec(over);
  for (const t of texts) r = addGoal(r, t, at('2026-11-18T07:05:00+08:00'));
  return r;
};

test('北京时间换算', () => {
  const p = bjParts(at('2026-11-18T00:00:00Z'));
  assert.equal(p.date, '2026-11-18');
  assert.equal(p.minutes, 8 * 60);
  assert.equal(p.iso, '2026-11-18T08:00:00+08:00');

  assert.equal(bjParts(at('2026-11-18T20:00:00Z')).date, '2026-11-19');
  assert.equal(addDays('2026-11-18', 1), '2026-11-19');
  assert.equal(addDays('2026-12-31', 1), '2027-01-01');
  assert.equal(weekdayLabel('2026-11-18'), '周三');
});

test('新增目标：初始未打卡、编号递增、重复与空值被拒', () => {
  let r = withGoals(['背单词']);
  assert.equal(r.goals[0].status, 'pending');
  assert.equal(r.goals[0].id, 'g1');
  assert.equal(r.goals[0].checkedAt, null);
  r = addGoal(r, '跑步', at('2026-11-18T07:06:00+08:00'));
  assert.equal(r.goals[1].id, 'g2');
  assert.throws(() => addGoal(r, '背单词'), /已经在了/);
  assert.throws(() => addGoal(r, '   '), /不能为空/);
  assert.throws(() => addGoal(r, 'x'.repeat(61)), /太长/);
});

test('打卡三态流转与时间戳', () => {
  let r = withGoals(['背单词']);
  const v0 = r.version;

  r = toggleGoalDone(r, 'g1', at('2026-11-18T09:00:00+08:00'));
  assert.equal(r.goals[0].status, 'done');
  assert.equal(r.goals[0].checkedAt, '2026-11-18T09:00:00+08:00');
  assert.equal(r.version, v0 + 1);

  r = toggleGoalDone(r, 'g1', at('2026-11-18T09:05:00+08:00'));
  assert.equal(r.goals[0].status, 'pending');
  assert.equal(r.goals[0].checkedAt, null);

  r = setGoalStatus(r, 'g1', 'failed', at('2026-11-18T21:10:00+08:00'), '加班太晚');
  assert.equal(r.goals[0].status, 'failed');
  assert.equal(r.goals[0].note, '加班太晚');
  assert.equal(r.updatedAt, '2026-11-18T21:10:00+08:00');

  assert.throws(() => setGoalStatus(r, 'g1', 'whatever'), /未知状态/);
  assert.throws(() => setGoalStatus(r, 'g99', 'done'), /找不到/);
});

test('备注与改名不会改状态', () => {
  let r = withGoals(['背单词']);
  r = setGoalNote(r, 'g1', '早上效率高', at('2026-11-18T08:00:00+08:00'));
  assert.equal(r.goals[0].note, '早上效率高');
  assert.equal(r.goals[0].status, 'pending');
  r = renameGoal(r, 'g1', '背 30 个单词', at('2026-11-18T08:01:00+08:00'));
  assert.equal(r.goals[0].text, '背 30 个单词');
  assert.throws(() => renameGoal(r, 'g1', ''), /不能为空/);
});

test('删除是墓碑：展示与统计都不算，但记录里还在', () => {
  let r = withGoals(['背单词', '跑步']);
  r = removeGoal(r, 'g1', at('2026-11-18T08:30:00+08:00'));
  assert.equal(r.goals.length, 2);
  assert.deepEqual(liveGoals(r).map((g) => g.id), ['g2']);
  assert.equal(summarize(r).total, 1);
  assert.equal(dayLabel(r), '已办 0% · 办了 0/1 桩');
});

test('统计与文案', () => {
  let r = withGoals(['a', 'b', 'c']);
  r = setGoalStatus(r, 'g1', 'done', at('2026-11-18T09:00:00+08:00'));
  r = setGoalStatus(r, 'g2', 'failed', at('2026-11-18T21:00:00+08:00'));
  const s = summarize(r);
  assert.deepEqual(
    { total: s.total, done: s.done, failed: s.failed, pending: s.pending },
    { total: 3, done: 1, failed: 1, pending: 1 },
  );
  assert.equal(pendingGoals(r).length, 1);
  assert.equal(dayLabel(r), '已办 33% · 办了 1/3 桩');
  assert.equal(dayLabel(rec()), '还没有目标');

  const allDone = setGoalStatus(r, 'g3', 'done', at('2026-11-18T21:30:00+08:00'));
  assert.equal(dayLabel(allDone), '已办 67% · 办了 2/3 桩');
});

test('07:30 提醒：没提交才排，已过点不排，未来 6 天都排', () => {
  const early = planReminders([], at('2026-11-18T06:00:00+08:00'));
  const sevenThirty = early.filter((p) => p.kind === '0730');
  assert.equal(sevenThirty.length, 7);
  assert.equal(sevenThirty[0].at, '2026-11-18T07:30:00+08:00');
  assert.equal(sevenThirty.at(-1).at, '2026-11-24T07:30:00+08:00');

  const late = planReminders([], at('2026-11-18T08:00:00+08:00'));
  const sevenLate = late.filter((p) => p.kind === '0730');
  assert.equal(sevenLate.length, 6);
  assert.equal(sevenLate[0].at, '2026-11-19T07:30:00+08:00');

  const submitted = planReminders([withGoals(['背单词'])], at('2026-11-18T06:00:00+08:00'));
  assert.equal(submitted.filter((p) => p.kind === '0730').length, 6);
  assert.ok(!submitted.some((p) => p.at === '2026-11-18T07:30:00+08:00'));
});

test('21:30 提醒：只针对有未打卡的人，且过了点不再排', () => {
  const r = withGoals(['背单词', '跑步']);
  const evening = planReminders([r], at('2026-11-18T20:00:00+08:00'));
  const nine = evening.filter((p) => p.kind === '2130');
  assert.equal(nine.length, 1);
  assert.equal(nine[0].at, '2026-11-18T21:30:00+08:00');
  assert.equal(nine[0].extra.pending, 2);

  const partially = setGoalStatus(r, 'g1', 'done', at('2026-11-18T19:00:00+08:00'));
  const nine2 = planReminders([partially], at('2026-11-18T20:00:00+08:00')).filter((p) => p.kind === '2130');
  assert.equal(nine2.length, 1);

  const allDone = setGoalStatus(setGoalStatus(r, 'g1', 'done', at('2026-11-18T19:00:00+08:00')), 'g2', 'failed', at('2026-11-18T19:30:00+08:00'));
  assert.equal(planReminders([allDone], at('2026-11-18T20:00:00+08:00')).filter((p) => p.kind === '2130').length, 0);

  assert.equal(planReminders([r], at('2026-11-18T22:00:00+08:00')).filter((p) => p.kind === '2130').length, 0);
  assert.equal(planReminders([], at('2026-11-18T20:00:00+08:00')).filter((p) => p.kind === '2130').length, 0);
});

test('提醒 id 稳定，重复排期不会撞', () => {
  const plan = planReminders([], at('2026-11-18T06:00:00+08:00'));
  const ids = plan.map((p) => p.id);
  assert.equal(new Set(ids).size, ids.length);
  const again = planReminders([], at('2026-11-18T06:00:00+08:00'));
  assert.deepEqual(again.map((p) => p.id), ids);
});

test('近 n 天统计按自然日补空洞', () => {
  const today = bjToday(at('2026-11-18T20:00:00+08:00'));
  assert.equal(today, '2026-11-18');
  const records = [
    { ...withGoals(['a', 'b']), date: '2026-11-18' },
    { ...withGoals(['c']), date: '2026-11-16' },
  ];
  records[0] = setGoalStatus(records[0], 'g1', 'done', at('2026-11-18T12:00:00+08:00'));
  records[0] = setGoalStatus(records[0], 'g2', 'failed', at('2026-11-18T12:30:00+08:00'));
  records[1] = setGoalStatus(records[1], 'g1', 'done', at('2026-11-16T12:00:00+08:00'));

  const s = recentStats(records, 7, at('2026-11-18T20:00:00+08:00'));
  assert.equal(s.days, 7);
  assert.equal(s.submitted, 2);
  assert.equal(s.total, 3);
  assert.equal(s.done, 2);
  assert.ok(Math.abs(s.rate - 2 / 3) < 1e-9);
});

/* ------------------------------ 日历 ------------------------------ */

test('月份工具：跨年、月末天数、可回溯范围', () => {
  assert.equal(monthKey('2026-11-18'), '2026-11');
  assert.equal(addMonths('2026-11', 1), '2026-12');
  assert.equal(addMonths('2026-12', 1), '2027-01');
  assert.equal(addMonths('2026-01', -1), '2025-12');
  assert.equal(monthRange('2026-02').length, 28);
  assert.equal(monthRange('2024-02').length, 29);
  assert.equal(monthRange('2026-11').at(-1), '2026-11-30');

  // 2026-11-18 往前推：保留 12 个月 → 最早 2025-12；3 个月 → 2026-09
  const now = at('2026-11-18T20:00:00+08:00');
  assert.equal(earliestMonth(now, 12), '2025-12');
  assert.equal(earliestMonth(now, 3), '2026-09');
  assert.equal(earliestMonth(now, 6), '2026-06');
  assert.deepEqual(RETENTION_OPTIONS.map((o) => o.months), [3, 6, 12]);
});

test('月历网格：周一对齐、空格补齐、当天与未来标记', () => {
  const now = at('2026-11-18T20:00:00+08:00');
  const rec = { ...withGoals(['a', 'b']), date: '2026-11-18' };
  const done = setGoalStatus(rec, 'g1', 'done', at('2026-11-18T12:00:00+08:00'));

  const cells = calendarGrid('2026-11', [done], now);
  assert.equal(cells.length % 7, 0, '网格必须是整周');

  // 2026-11-01 是周日 → 周一起排需要 6 个空格
  const firstReal = cells.findIndex((c) => !c.blank);
  assert.equal(firstReal, 6, '11 月 1 日应该落在第 7 格（周日起点在周一排法里是最后一列）');
  assert.equal(cells[firstReal].date, '2026-11-01');
  assert.equal(cells.filter((c) => c.blank).length, 6 + 6, '前面 6 格 + 末尾补齐 6 格');
  assert.ok(cells.at(-1).blank, '末尾补齐到整周');

  const day1 = cells.find((c) => c.date === '2026-11-01');
  assert.ok(day1, '应该有 11 月 1 日');
  assert.equal(day1.submitted, false);
  assert.equal(day1.level, 0);

  const day18 = cells.find((c) => c.date === '2026-11-18');
  assert.equal(day18.isToday, true);
  assert.equal(day18.done, 1);
  assert.equal(day18.total, 2);
  assert.equal(day18.level, 2, '部分完成 → level 2');

  const day19 = cells.find((c) => c.date === '2026-11-19');
  assert.equal(day19.future, true);

  // 全完成 → level 3；全没成 → level 1
  const allDone = setGoalStatus(done, 'g2', 'done', at('2026-11-18T13:00:00+08:00'));
  assert.equal(calendarGrid('2026-11', [allDone], now).find((c) => c.date === '2026-11-18').level, 3);
  const allFailed = setGoalStatus(setGoalStatus(rec, 'g1', 'failed', at('2026-11-18T12:00:00+08:00')), 'g2', 'failed', at('2026-11-18T12:10:00+08:00'));
  assert.equal(calendarGrid('2026-11', [allFailed], now).find((c) => c.date === '2026-11-18').level, 1);
});

test('月汇总只统计已过去的天', () => {
  const now = at('2026-11-18T20:00:00+08:00');
  const r = setGoalStatus(withGoals(['a', 'b']), 'g1', 'done', at('2026-11-18T12:00:00+08:00'));
  const s = monthSummary('2026-11', [{ ...r, date: '2026-11-18' }], now);
  assert.equal(s.days, 18, '1~18 号共 18 天');
  assert.equal(s.submitted, 1);
  assert.equal(s.total, 2);
  assert.equal(s.done, 1);

  const empty = monthSummary('2026-11', [], now);
  assert.equal(empty.submitted, 0);
  assert.equal(empty.rate, 0);
});

test('历史保留：可以选 3 / 6 / 12 个月，超出就被清理', () => {
  const now = at('2026-11-18T20:00:00+08:00');
  const records = [
    { date: '2025-11-30', goals: [] }, // 一年零一点，12 个月保留也要删
    { date: '2025-12-01', goals: [] }, // 恰好等于 12 个月的边界 → 保留
    { date: '2026-06-01', goals: [] },
    { date: '2026-09-15', goals: [] },
    { date: '2026-11-18', goals: [] },
  ];

  const r12 = pruneRecords(records, 12, now);
  assert.equal(r12.cutoff, '2025-12-01');
  assert.deepEqual(r12.removed.map((r) => r.date), ['2025-11-30']);
  assert.equal(r12.kept.length, 4);

  const r6 = pruneRecords(records, 6, now);
  assert.equal(r6.cutoff, '2026-06-01');
  assert.deepEqual(r6.removed.map((r) => r.date), ['2025-11-30', '2025-12-01']);
  assert.equal(r6.kept.length, 3);

  const r3 = pruneRecords(records, 3, now);
  assert.equal(r3.cutoff, '2026-09-01');
  assert.deepEqual(r3.removed.map((r) => r.date), ['2025-11-30', '2025-12-01', '2026-06-01']);
  assert.equal(r3.kept.length, 2);

  // 没有旧数据时不该误删
  assert.equal(pruneRecords([], 12, now).removed.length, 0);
});

/* ------------------------- 纯文本导出（复制全部数据） ------------------------- */

test('导出格式：2026年11月18日：事项1；事项2。一天一行', () => {
  const day1 = setGoalStatus(
    addGoal(addGoal(addGoal(rec({ date: '2026-11-18' }), '背单词', at('2026-11-18T07:00:00+08:00')), '跑步', at('2026-11-18T07:01:00+08:00')), '写周报', at('2026-11-18T07:02:00+08:00')),
    'g1',
    'done',
    at('2026-11-18T09:00:00+08:00'),
    '早上效率高',
  );
  const day2 = addGoal(rec({ date: '2026-11-16' }), '读书 20 页', at('2026-11-16T07:00:00+08:00'));

  const text = exportRecordsAsText([day1, day2]);
  assert.equal(text, [
    '2026年11月16日：读书 20 页。',
    '2026年11月18日：背单词；跑步；写周报。',
  ].join('\n'));
});

test('到点提醒：今日差事与六部差事带 due 的排上，办成的与过点的不排', () => {
  const now = at('2026-11-18T07:00:00+08:00');
  let r = addGoal(rec(), '接孩子', now, { due: '2026-11-18T17:00+08:00' });
  assert.equal(r.goals[0].due, '2026-11-18T17:00:00+08:00');
  const court = {
    tasks: {
      bingbu: {
        items: [
          { id: 't1', text: '去学校接孩子', due: '2026-11-18T16:00:00+08:00', progress: 0, status: 'pending' },
          { id: 't2', text: '已经办成的', due: '2026-11-18T18:00:00+08:00', progress: 100, status: 'done' },
          { id: 't3', text: '过点的不排', due: '2026-11-18T06:00:00+08:00', progress: 0, status: 'pending' },
        ],
      },
    },
  };
  const plan = planReminders([r], now, court);
  const due = plan.filter((p) => p.kind === 'due');
  assert.equal(due.length, 2, '一条今日差事、一条兵部差事');
  assert.ok(due.some((p) => p.title.includes('今日差事') && p.body === '接孩子'));
  assert.ok(due.some((p) => p.title.includes('兵部') && p.body === '去学校接孩子'));
  assert.ok(due.every((p) => p.id >= 100000));

  // 勾成 100% 后，差事到点提醒就该撤
  const doneRec = setGoalStatus(r, 'g1', 'done', at('2026-11-18T08:00:00+08:00'));
  const after = planReminders([doneRec], now, { tasks: { bingbu: { items: [] } } });
  assert.equal(after.filter((p) => p.kind === 'due').length, 0, '办成的差事不再响');
});

test('导出细节：按日期排序、跳过空日、删除的目标不出现、分号会被清理', () => {
  const empty = rec({ date: '2026-11-17' });
  const withDeleted = removeGoal(
    addGoal(addGoal(rec({ date: '2026-11-18' }), '要删的', at('2026-11-18T07:00:00+08:00')), '留下的', at('2026-11-18T07:01:00+08:00')),
    'g1',
    at('2026-11-18T08:00:00+08:00'),
  );
  const messy = addGoal(rec({ date: '2026-11-15' }), '任务里有；分号', at('2026-11-15T07:00:00+08:00'));

  const text = exportRecordsAsText([withDeleted, empty, messy]);
  assert.equal(text.split('\n').length, 2, '空日不占行');
  assert.equal(text.split('\n')[0], '2026年11月15日：任务里有，分号。');
  assert.equal(text.split('\n')[1], '2026年11月18日：留下的。');
  assert.equal(exportRecordsAsText([]), '');
  assert.equal(exportRecordsAsText([empty]), '');
});
