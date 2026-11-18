/**
 * 国事本机逻辑（不碰 DOM / 不碰网络）
 *
 * 用户要求：不管连没连中枢，App 都得能记。于是国家大事、差事、账目
 * 先在本机改，再整份推给中枢合并；这一份单测盯的就是"合并别把东西弄丢"。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WWW = path.resolve(HERE, '..', 'www');
const ROOT = path.resolve(HERE, '..', '..');

const court = await import(pathToFileURL(path.join(WWW, 'court.js')).href);
const shared = await import(pathToFileURL(path.join(ROOT, 'shared', 'court-state.mjs')).href);
const personas = await import(pathToFileURL(path.join(ROOT, 'court', 'personas.mjs')).href);
const depts = await import(pathToFileURL(path.join(WWW, 'depts.js')).href);

const at = (iso) => new Date(iso).toISOString();

test('七部 id 与职能两边一致（App 离线也说得清每部管什么）', () => {
  assert.deepEqual(shared.DEPT_IDS, personas.COURT_DEPTS.map((d) => d.id));
  assert.equal(depts.COURT_DEPTS.length, personas.COURT_DEPTS.length);
  for (const p of personas.COURT_DEPTS) {
    const mine = depts.COURT_DEPTS.find((d) => d.id === p.id);
    assert.ok(mine, `App 缺 ${p.name}`);
    assert.equal(mine.name, p.name);
    assert.equal(mine.duty[0], p.duty[0]);
  }
});

test('国家大事：默认年度，进度随便记，改措辞才吃 3 次名额', () => {
  let s = court.emptyCourtState();
  s = court.addAnnualLocal(s, { text: '全家去看一次海', budget: 2000 });
  assert.equal(s.annual.items.length, 1);
  const item = s.annual.items[0];
  assert.equal(item.period, 'year', '默认年度');
  assert.equal(item.budget, 2000, '内阁大事可带预算');
  assert.equal(item.adjustments, 0);

  // 记进度不算调整，记多少次都行
  for (const pct of [10, 30, 60, 60]) {
    s = court.updateAnnualLocal(s, item.id, { progress: pct });
  }
  assert.equal(s.annual.items[0].progress, 60);
  assert.equal(s.annual.items[0].adjustments, 0);
  assert.equal(court.annualSummary(s).budgetTotal, 2000);

  // 改预算也算一次调整
  s = court.updateAnnualLocal(s, item.id, { budget: 2600 });
  assert.equal(s.annual.items[0].adjustments, 1);
  assert.equal(s.annual.items[0].budget, 2600);

  // 再改措辞两次：名额用尽
  for (let i = 1; i <= 2; i += 1) {
    s = court.updateAnnualLocal(s, item.id, { text: `全家去看一次海（第 ${i} 版）` });
    assert.equal(s.annual.items[0].adjustments, i + 1);
  }
  assert.equal(court.adjustmentsLeft(s.annual.items[0]), 0);
  assert.throws(() => court.updateAnnualLocal(s, item.id, { text: '再改一次' }), /3 次/);
  // 原话重交不算改，不该抛错也不耗名额
  const same = court.updateAnnualLocal(s, item.id, { text: s.annual.items[0].text });
  assert.equal(same.annual.items[0].adjustments, 3);
  // 但进度照旧可以记
  s = court.updateAnnualLocal(s, item.id, { progress: 100 });
  assert.equal(s.annual.items[0].status, 'done');
});

test('国家大事：删掉留墓碑，重传旧稿也不会复活', () => {
  let s = court.emptyCourtState();
  s = court.addAnnualLocal(s, { text: '把家谱续上', period: 'half' });
  const item = s.annual.items[0];
  assert.equal(item.period, 'half');

  const oldCopy = court.normalizeCourtState(s);
  s = court.removeAnnualLocal(s, item.id);
  assert.equal(s.annual.items.length, 0);
  assert.ok(s.annual.deleted[item.id]);

  // 另一台机器拿着删除前的旧稿来合并：墓碑更晚，旧稿不该复活
  const merged = court.mergeCourtState(court.normalizeCourtState(s), oldCopy);
  assert.equal(merged.annual.items.length, 0);
  assert.ok(merged.annual.deleted[item.id]);
});

test('合并：取新的一稿；流水按 id 去重取并集', () => {
  const local = shared.normalizeCourtState({
    annual: {
      items: [
        { id: 'a1', text: '本机新稿', progress: 60, updatedAt: at('2026-11-18T10:00:00') },
        { id: 'a2', text: '只在本机', progress: 0, updatedAt: at('2026-11-18T09:00:00') },
      ],
      deleted: {},
    },
    tasks: {},
    ledger: {
      entries: [
        { id: 'l1', at: at('2026-11-18T08:00:00'), amount: 4, item: '包子', categoryId: 'food', categoryLabel: '吃喝' },
      ],
    },
  });
  const remote = shared.normalizeCourtState({
    annual: {
      items: [
        { id: 'a1', text: '中枢旧稿', progress: 20, updatedAt: at('2026-11-18T09:00:00') },
        { id: 'a3', text: '只在远端的', progress: 0, updatedAt: at('2026-11-18T09:30:00') },
      ],
      deleted: {},
    },
    tasks: {},
    ledger: {
      entries: [
        { id: 'l1', at: at('2026-11-18T08:00:00'), amount: 4, item: '包子', categoryId: 'food', categoryLabel: '吃喝' },
        { id: 'l2', at: at('2026-11-18T09:00:00'), amount: 50, item: 'deepseek', categoryId: 'digital', categoryLabel: '数码订阅' },
      ],
    },
  });

  const merged = court.mergeCourtState(local, remote);
  assert.equal(merged.annual.items.length, 3, '两边的都在');
  assert.equal(merged.annual.items.find((i) => i.id === 'a1').text, '本机新稿', '取更新的一稿');
  assert.equal(merged.ledger.entries.length, 2, '同 id 流水只留一笔');
});

test('六部差事：下旨 / 记进度 / 撤旨（撤了也留墓碑）', () => {
  let s = court.emptyCourtState();
  s = court.addTaskLocal(s, 'hubu', { text: '把本月账目理清', by: '妈妈' });
  assert.equal(s.tasks.hubu.items.length, 1);
  const task = s.tasks.hubu.items[0];
  assert.equal(task.progress, 0);

  s = court.updateTaskLocal(s, 'hubu', task.id, { progress: 60 });
  assert.equal(s.tasks.hubu.items[0].progress, 60);
  assert.equal(s.tasks.hubu.items[0].status, 'doing');

  s = court.removeTaskLocal(s, 'hubu', task.id);
  assert.equal(s.tasks.hubu.items.length, 0);
  assert.ok(s.tasks.hubu.deleted[task.id]);

  assert.throws(() => court.addTaskLocal(s, 'bidet', { text: '没有这个部' }), /没有这个部/);
  assert.throws(() => court.addTaskLocal(s, 'hubu', { text: '   ' }), /圣旨/);
});

test('户部账房：一句话多笔、归类、合计', () => {
  const r = court.addLedgerLocal(court.emptyCourtState(), '包子4 deepseek50 午饭18');
  assert.equal(r.ok, true);
  assert.equal(r.entries.length, 3);
  assert.equal(r.entries.find((e) => e.item === '包子').categoryLabel, '吃喝');
  assert.equal(r.entries.find((e) => e.item === 'deepseek').categoryLabel, '数码订阅');
  assert.equal(r.entries.find((e) => e.item === '午饭').categoryLabel, '吃喝');
  assert.equal(r.unparsed.length, 0);

  const sum = court.summarizeLedgerLocal(r.state, { days: 30 });
  assert.equal(sum.count, 3);
  assert.equal(sum.total, 72);
  assert.deepEqual(sum.byCategory, [
    { label: '数码订阅', amount: 50 },
    { label: '吃喝', amount: 22 },
  ].sort((a, b) => b.amount - a.amount));

  const bad = court.addLedgerLocal(r.state, '随便写写');
  assert.equal(bad.ok, false);
  assert.match(bad.error, /一笔都没认出来/);
});
