/**
 * 家是小国：账本解析、档案状态机、人格 Prompt、Agent 缓存
 * 全在临时目录跑，不碰真实数据。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseLedgerLine, parseLedgerText, summarizeLedger, categorize } from '../court/ledger.mjs';
import { emptyCourtState, mergeLedgerSections, normalizeCourtState } from '../shared/court-state.mjs';
import { writeCourtState, readCourtState } from '../court/state.mjs';
import { COURT_DEPTS, systemPrompt, userPrompt, extractTitle } from '../court/personas.mjs';
import {
  ensureCourtDirs, setRole, roleOf, listMemorials, saveMemorial, disposeMemorial, readMemory, listLedger,
} from '../court/store.mjs';
import { summon, meeting } from '../court/agents.mjs';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'court-'));

test('一句话记账：金额、事项、分类', () => {
  const a = parseLedgerLine('买菜 35');
  assert.equal(a.ok, true);
  assert.equal(a.amount, 35);
  assert.equal(a.item, '买菜');
  assert.equal(a.categoryLabel, '吃喝');

  const b = parseLedgerLine('外卖 28.5 元');
  assert.equal(b.amount, 28.5);
  assert.equal(b.categoryId, 'food');

  const c = parseLedgerLine('交电费 200 块');
  assert.equal(c.amount, 200);
  assert.equal(c.categoryLabel, '水电燃气');

  const d = parseLedgerLine('给娃买绘本 68');
  assert.equal(d.categoryLabel, '孩子');

  assert.equal(categorize('加油 300').label, '交通');
  assert.equal(categorize('看电影 60').label, '娱乐');
  assert.equal(categorize('不知道是啥 10').id, 'other');
});

test('一句话记账：坏输入给出人话提示，不瞎猜', () => {
  assert.equal(parseLedgerLine('').ok, false);
  assert.match(parseLedgerLine('买菜').error, /认出来|金额/);
  assert.equal(parseLedgerLine('0').ok, false);
  assert.match(parseLedgerLine('买菜 9999999').error, /认出来|太大|正数/);
});

test('一行记多笔：包子4 deepseek50 午饭18', () => {
  const r = parseLedgerText('包子4 deepseek50 午饭18');
  assert.equal(r.ok, true);
  assert.equal(r.entries.length, 3);
  const byItem = Object.fromEntries(r.entries.map((x) => [x.item, x.amount]));
  assert.equal(byItem['包子'], 4);
  assert.equal(byItem['deepseek'], 50);
  assert.equal(byItem['午饭'], 18);
  assert.equal(r.entries.find((x) => x.item === 'deepseek').categoryLabel, '数码订阅');

  const spaced = parseLedgerText('买菜 35，外卖 28.5');
  assert.equal(spaced.ok, true);
  assert.equal(spaced.entries.length, 2);
  assert.equal(spaced.entries[0].amount, 35);
});

test('语音原句：几样东西共一个价，也要并成一笔', () => {
  const r = parseLedgerText('包子 白蛋 糯玉米9元 午饭冒菜18元');
  assert.equal(r.ok, true);
  assert.equal(r.entries.length, 2);
  assert.deepEqual(r.entries.map((e) => [e.item, e.amount]), [
    ['包子、白蛋、糯玉米', 9],
    ['午饭冒菜', 18],
  ]);
  assert.equal(r.entries[0].categoryLabel, '吃喝');
  assert.equal(r.entries[1].categoryLabel, '吃喝');
});

test('流水汇总按天数过滤并分类', () => {
  const now = new Date('2026-11-18T20:00:00+08:00');
  const mk = (date, amount, categoryLabel, item) => ({ date, amount, categoryLabel, item });
  const entries = [
    mk('2026-11-17', 35, '吃喝', '买菜'),
    mk('2026-11-18', 60, '吃喝', '外卖'),
    mk('2026-11-18', 200, '水电燃气', '电费'),
    mk('2025-01-01', 999, '其他', '旧账'), // 早于 30 天，应被过滤
  ];
  const s = summarizeLedger(entries, { days: 30, now });
  assert.equal(s.count, 3);
  assert.equal(s.total, 295);
  assert.equal(s.byCategory[0].label, '水电燃气');
  assert.equal(s.byCategory.find((c) => c.label === '吃喝').amount, 95);
});

test('身份与批阅：只有帝后能批，驳回必须写原因并记进记忆', () => {
  const dir = tmp();
  ensureCourtDirs(dir);
  setRole(dir, '大龙龙', 'emperor');
  setRole(dir, '瑞瑞🥚', 'empress');
  assert.equal(roleOf(dir, '大龙龙'), 'emperor');
  assert.equal(roleOf(dir, '路人'), 'member');

  const m = saveMemorial(dir, {
    id: 'm1', dept: 'libu', deptName: '吏部', office: '考成司',
    title: '本周考成', body: '臣 吏部 启奏…', status: 'pending',
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    dispositions: [], replies: [],
  });

  assert.throws(() => disposeMemorial(dir, { id: 'm1', action: 'approve', role: 'member' }), /只有陛下与皇后/);
  assert.throws(() => disposeMemorial(dir, { id: 'm1', action: 'reject', role: 'emperor', comment: '  ' }), /原因/);
  assert.throws(() => disposeMemorial(dir, { id: 'nope', action: 'approve', role: 'emperor' }), /找不到/);

  const rejected = disposeMemorial(dir, { id: 'm1', action: 'reject', role: 'emperor', comment: '目标定太满' });
  assert.equal(rejected.status, 'rejected');
  assert.ok(readMemory(dir, 'libu').some((x) => x.includes('目标定太满')), '驳回原因要记进该部记忆');

  // 第二次驳回后再批（模拟改完重奏的新一份）
  const m2 = saveMemorial(dir, { ...m, id: 'm2', status: 'pending' });
  const approved = disposeMemorial(dir, { id: 'm2', action: 'approve', role: 'empress', comment: '准' });
  assert.equal(approved.status, 'approved');
  assert.throws(() => disposeMemorial(dir, { id: 'm2', action: 'approve', role: 'empress' }), /已经朱批/);

  // 圣旨/懿旨要存档
  const edicts = fs.readdirSync(path.join(dir, 'court', 'edicts'));
  assert.equal(edicts.length, 1);
  const edict = JSON.parse(fs.readFileSync(path.join(dir, 'court', 'edicts', edicts[0]), 'utf8'));
  assert.equal(edict.type, '懿旨');
  assert.equal(edict.comment, '准');
});

test('七部的人格都带权责、禁则与奏疏格式', () => {
  assert.equal(COURT_DEPTS.length, 7);
  for (const d of COURT_DEPTS) {
    const p = systemPrompt(d);
    assert.match(p, /【身份】/, `${d.name} 缺身份`);
    assert.match(p, /【直属主上】/);
    assert.match(p, /【你禁止做的事】/);
    assert.match(p, /伏候圣裁/, `${d.name} 缺奏疏结尾`);
    assert.match(p, /皇后/, `${d.name} 应说明皇后同权`);
    assert.match(p, new RegExp(d.name));
  }
});

test('userPrompt 会把数据、记忆、口谕都带上', () => {
  const dept = COURT_DEPTS[0];
  const p = userPrompt(dept, { digest: '提交 5/7 天', memory: ['上次被驳回：太抽象'], focus: '重点看小朋友' });
  assert.match(p, /提交 5\/7 天/);
  assert.match(p, /上次被驳回/);
  assert.match(p, /重点看小朋友/);

  const t = extractTitle('标题：本周考成小结\n臣 吏部 启奏…', dept, '2026-11-18');
  assert.equal(t, '本周考成小结');
  assert.match(extractTitle('没有标题的正文', dept, '2026-11-18'), /吏部日常奏疏/);
});

test('summon：同一份数据不重复花 token（缓存），force 才重来', async () => {
  const dir = tmp();
  ensureCourtDirs(dir);
  let calls = 0;
  const callModel = async () => {
    calls += 1;
    return {
      content: '标题：测试奏疏\n臣 吏部 启奏陛下、皇后娘娘：\n现状：1 条数据\n问题：无\n方案：一、继续观察\n臣建议：先观察\n伏候圣裁',
      usage: { total_tokens: 0 },
    };
  };

  const first = await summon(dir, { deptId: 'libu', callModel, now: new Date('2026-11-18T20:00:00+08:00') });
  assert.equal(first.cached, false);
  assert.equal(first.status, 'pending');
  assert.equal(first.title, '测试奏疏');
  assert.equal(calls, 1);

  const again = await summon(dir, { deptId: 'libu', callModel, now: new Date('2026-11-18T20:00:00+08:00') });
  assert.equal(again.cached, true);
  assert.equal(calls, 1, '缓存命中不该再调模型');

  const forced = await summon(dir, { deptId: 'libu', callModel, force: true, now: new Date('2026-11-18T20:00:00+08:00') });
  assert.equal(forced.cached, false);
  assert.equal(calls, 2);

  assert.equal(listMemorials(dir, { dept: 'libu' }).length, 2);
});

test('朝会：六部依次有简报，且不走模型', () => {
  const dir = tmp();
  ensureCourtDirs(dir);
  const mt = meeting(dir, { now: new Date('2026-11-18T20:00:00+08:00') });
  assert.equal(mt.items.length, 6);
  assert.deepEqual(mt.items.map((i) => i.deptId), ['libu', 'hubu', 'libu2', 'bingbu', 'xingbu', 'gongbu']);
  assert.match(mt.brief, /本日朝会/);
  assert.equal(typeof mt.pendingTotal, 'number');
});

test('账目合并：新的改动赢，旧账盖不回来，墓碑能删账', () => {
  const mk = (id, amount, updatedAt, date = '2026-11-18') => ({
    id, at: `${date}T12:00:00+08:00`, date, item: '午饭', amount,
    categoryId: 'food', categoryLabel: '吃喝', updatedAt,
  });
  const server = normalizeCourtState({ ledger: { entries: [mk('l1', 18, '2026-11-18T12:00:00+08:00')], deleted: {} } });
  const changed = normalizeCourtState({ ledger: { entries: [mk('l1', 20, '2026-11-18T13:00:00+08:00')], deleted: {} } });
  assert.equal(mergeLedgerSections(changed.ledger, server.ledger).entries[0].amount, 20);

  const stale = normalizeCourtState({ ledger: { entries: [mk('l1', 15, '2026-11-18T11:00:00+08:00')], deleted: {} } });
  assert.equal(mergeLedgerSections(stale.ledger, server.ledger).entries[0].amount, 18, '旧改动不能盖回新账');

  const removed = normalizeCourtState({ ledger: { entries: [], deleted: { l1: '2026-11-18T14:00:00+08:00' } } });
  assert.equal(mergeLedgerSections(removed.ledger, server.ledger).entries.length, 0, '删掉的账不能被旧账复活');
});

test('账目落盘：改过、删掉的账都留得住', () => {
  const dir = tmp();
  ensureCourtDirs(dir);
  const entry = {
    id: 'l1', at: '2026-11-18T12:00:00+08:00', date: '2026-11-18',
    item: '午饭', amount: 18, categoryId: 'food', categoryLabel: '吃喝',
    updatedAt: '2026-11-18T12:00:00+08:00',
  };
  const state = emptyCourtState();
  state.ledger.entries = [entry];
  writeCourtState(dir, state);
  assert.equal(readCourtState(dir).ledger.entries.length, 1);

  state.ledger.entries = [];
  state.ledger.deleted = { l1: '2026-11-18T14:00:00+08:00' };
  writeCourtState(dir, state);
  const after = readCourtState(dir);
  assert.equal(after.ledger.entries.length, 0);
  assert.ok(after.ledger.deleted.l1, '墓碑要写进 tombstones.json');
});

test('台账：记账写入后能被汇总读到', () => {
  const dir = tmp();
  ensureCourtDirs(dir);
  const { appendLedger } = { appendLedger: null };
  void appendLedger;
  // 直接写一条，验证 listLedger 读取（写入路径由 e2e 覆盖）
  fs.writeFileSync(
    path.join(dir, 'court', 'ledger', 'entries.jsonl'),
    `${JSON.stringify({ date: '2026-11-18', amount: 35, categoryLabel: '吃喝', item: '买菜' })}\n`,
    'utf8',
  );
  const rows = listLedger(dir);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].amount, 35);
});
