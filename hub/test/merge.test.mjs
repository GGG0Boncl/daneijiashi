import test from 'node:test';
import assert from 'node:assert/strict';
import { mergeRecord, mergeRecords, liveGoals, pickNewerGoal, toBjIso } from '../merge.mjs';

const g = (id, over = {}) => ({
  id,
  text: `目标${id}`,
  status: 'pending',
  checkedAt: null,
  note: '',
  createdAt: '2026-11-18T08:00:00+08:00',
  updatedAt: '2026-11-18T08:00:00+08:00',
  deleted: false,
  ...over,
});

const rec = (over = {}) => ({
  memberId: 'alice',
  memberName: '妈妈',
  date: '2026-11-18',
  version: 1,
  submittedAt: '2026-11-18T07:35:00+08:00',
  updatedAt: '2026-11-18T07:35:00+08:00',
  deviceId: 'dev-a',
  goals: [],
  ...over,
});

test('远端更新的打卡状态胜出', () => {
  const local = rec({ goals: [g('g1')] });
  const remote = rec({
    deviceId: 'dev-b',
    updatedAt: '2026-11-18T20:00:00+08:00',
    goals: [g('g1', { status: 'done', checkedAt: '2026-11-18T20:00:00+08:00', updatedAt: '2026-11-18T20:00:00+08:00' })],
  });
  const m = mergeRecord(local, remote);
  assert.equal(m.goals[0].status, 'done');
  assert.equal(m.deviceId, 'dev-b');
});

test('本地更新的状态不会被旧的远端覆盖', () => {
  const local = rec({
    goals: [g('g1', { status: 'failed', updatedAt: '2026-11-18T21:00:00+08:00' })],
    updatedAt: '2026-11-18T21:00:00+08:00',
  });
  const remote = rec({
    goals: [g('g1', { status: 'done', updatedAt: '2026-11-18T09:00:00+08:00' })],
    updatedAt: '2026-11-18T09:00:00+08:00',
  });
  const m = mergeRecord(local, remote);
  assert.equal(m.goals[0].status, 'failed');
});

test('两边各自新增的目标都会保留，并按编号排序', () => {
  const local = rec({ goals: [g('g1'), g('g3')] });
  const remote = rec({ goals: [g('g2')] });
  const m = mergeRecord(local, remote);
  assert.deepEqual(m.goals.map((x) => x.id), ['g1', 'g2', 'g3']);
});

test('删除是墓碑，不会被另一台设备复活', () => {
  const local = rec({
    goals: [g('g1', { deleted: true, updatedAt: '2026-11-18T22:00:00+08:00' })],
    updatedAt: '2026-11-18T22:00:00+08:00',
  });
  const remote = rec({ goals: [g('g1', { updatedAt: '2026-11-18T08:00:00+08:00' })] });
  const m = mergeRecord(local, remote);
  assert.equal(m.goals.length, 1);
  assert.equal(m.goals[0].deleted, true);
  assert.deepEqual(liveGoals(m), []);
});

test('内容没变化时 version 不变，有变化才 +1', () => {
  const same = mergeRecord(rec({ goals: [g('g1')] }), rec({ goals: [g('g1')] }));
  assert.equal(same.version, 1);

  const changed = mergeRecord(
    rec({ goals: [g('g1')] }),
    rec({ goals: [g('g1', { status: 'done', updatedAt: '2026-11-18T20:00:00+08:00' })] }),
  );
  assert.equal(changed.version, 2);
});

test('submittedAt 取最早，updatedAt 取最晚', () => {
  const m = mergeRecord(
    rec({ submittedAt: '2026-11-18T09:00:00+08:00', updatedAt: '2026-11-18T09:00:00+08:00', goals: [g('g1')] }),
    rec({ submittedAt: '2026-11-18T07:30:00+08:00', updatedAt: '2026-11-18T11:00:00+08:00', goals: [g('g2')] }),
  );
  assert.equal(m.submittedAt, '2026-11-18T07:30:00+08:00');
  assert.equal(m.updatedAt, '2026-11-18T11:00:00+08:00');
});

test('同刻冲突时结果确定（本地胜），连续合并幂等', () => {
  const t = '2026-11-18T10:00:00+08:00';
  const a = rec({ goals: [g('g1', { text: '本地文案', updatedAt: t })], updatedAt: t });
  const b = rec({ goals: [g('g1', { text: '远端文案', updatedAt: t })], updatedAt: t });
  assert.equal(pickNewerGoal(a.goals[0], b.goals[0]).text, '本地文案');
  const once = mergeRecord(a, b);
  const twice = mergeRecord(once, b);
  assert.deepEqual(once.goals, twice.goals);
});

test('一侧为空时直接返回另一侧', () => {
  assert.equal(mergeRecord(null, null), null);
  assert.equal(mergeRecord(null, rec({ goals: [g('g1')] })).goals.length, 1);
  assert.equal(mergeRecord(rec({ goals: [g('g1')] }), null).goals.length, 1);
});

test('memberId / date 不一致时拒绝合并', () => {
  assert.throws(() => mergeRecord(rec(), rec({ memberId: 'bob' })), /memberId/);
  assert.throws(() => mergeRecord(rec(), rec({ date: '2026-11-17' })), /date/);
});

test('mergeRecords 按日期合并两组记录', () => {
  const locals = [rec({ date: '2026-11-17', goals: [g('g1')] }), rec({ date: '2026-11-18', goals: [g('g1')] })];
  const remotes = [
    rec({ date: '2026-11-18', goals: [g('g2', { updatedAt: '2026-11-18T12:00:00+08:00' })] }),
    rec({ date: '2026-11-16', goals: [g('g1')] }),
  ];
  const out = mergeRecords(locals, remotes);
  assert.deepEqual(out.map((r) => r.date), ['2026-11-16', '2026-11-17', '2026-11-18']);
  assert.equal(out[2].goals.length, 2);
});

test('非法的 status 会被归一成 pending，缺 id 直接报错', () => {
  const m = mergeRecord(null, rec({ goals: [g('g1', { status: 'whatever' })] }));
  assert.equal(m.goals[0].status, 'pending');
  assert.throws(() => mergeRecord(null, rec({ goals: [{ text: '没有id' }] })), /id/);
});

test('UTC 时间统一落成北京时间，避免"晚者胜"和展示错乱', () => {
  assert.equal(toBjIso('2026-11-18T03:27:26.595Z'), '2026-11-18T11:27:26+08:00');
  assert.equal(toBjIso('2026-11-18T11:27:26+08:00'), '2026-11-18T11:27:26+08:00');
  assert.equal(toBjIso(null), null);
  assert.equal(toBjIso('不是时间'), '不是时间');

  const utcRec = {
    memberId: 'alice',
    date: '2026-11-18',
    version: 1,
    submittedAt: '2026-11-18T00:00:00Z',
    updatedAt: '2026-11-18T00:30:00Z',
    goals: [g('g1', { status: 'done', checkedAt: '2026-11-18T00:30:00Z', updatedAt: '2026-11-18T00:30:00Z' })],
  };
  const m = mergeRecord(null, utcRec);
  assert.equal(m.submittedAt, '2026-11-18T08:00:00+08:00');
  assert.equal(m.updatedAt, '2026-11-18T08:30:00+08:00');
  assert.equal(m.goals[0].checkedAt, '2026-11-18T08:30:00+08:00');

  // 未打卡的目标不该带打卡时间
  const p = mergeRecord(null, rec({ goals: [g('g2', { checkedAt: '2026-11-18T00:30:00Z' })] }));
  assert.equal(p.goals[0].checkedAt, null);
});
