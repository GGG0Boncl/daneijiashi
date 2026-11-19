/**
 * 家是小国 · 中枢接口端到端（假模型，不花钱）
 * 覆盖：身份权限、上奏缓存、批阅状态机、圣旨存档、回奏、朝会、记账、台账
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { syncWithHub, testHub } from '../../app/www/sync.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
const HUB = path.join(ROOT, 'hub', 'hub.mjs');

const PORT = 8801;
const UDP_PORT = 8802;
const BASE = `http://127.0.0.1:${PORT}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const post = (p, body) =>
  fetch(`${BASE}${p}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  }).then(async (r) => ({ status: r.status, body: await r.json() }));
const get = (p) => fetch(`${BASE}${p}`).then(async (r) => ({ status: r.status, body: await r.json() }));

const rec = (over = {}) => ({
  memberId: '大龙龙',
  memberName: '大龙龙',
  date: new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Shanghai' }),
  version: 1,
  submittedAt: '2026-11-18T07:30:00+08:00',
  updatedAt: '2026-11-18T21:00:00+08:00',
  deviceId: 'dev-a',
  goals: [
    { id: 'g1', text: '背单词', status: 'done', checkedAt: '2026-11-18T21:00:00+08:00', note: '', createdAt: '2026-11-18T07:30:00+08:00', updatedAt: '2026-11-18T21:00:00+08:00', deleted: false },
    { id: 'g2', text: '跑步', status: 'failed', checkedAt: '2026-11-18T21:05:00+08:00', note: '膝盖疼', createdAt: '2026-11-18T07:30:00+08:00', updatedAt: '2026-11-18T21:05:00+08:00', deleted: false },
  ],
  ...over,
});

test('家是小国：中枢接口全链路（假模型）', async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'court-hub-'));
  const child = spawn(process.execPath, [HUB], {
    env: {
      ...process.env,
      CHECKIN_DATA_DIR: dataDir,
      HUB_PORT: String(PORT),
      HUB_UDP_PORT: String(UDP_PORT),
      HUB_DEEPSEEK_FAKE: '1',
    },
    stdio: 'ignore',
  });
  t.after(() => {
    try {
      child.kill();
    } catch {
      /* ignore */
    }
    try {
      fs.rmSync(dataDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  for (let i = 0; i < 40; i += 1) {
    try {
      if ((await testHub(BASE))?.ok) break;
    } catch {
      /* 等 */
    }
    await sleep(250);
  }

  // 先有一份打卡数据，吏部才有东西可奏
  await syncWithHub({ url: BASE, memberId: '大龙龙', memberName: '大龙龙', deviceId: 'dev-a', mode: 'auto', records: [rec()] });

  await t.test('配置：七部齐全 + 每部职能与下旨举例 + 常驻平等声明', async () => {
    const r = await get('/api/court/config');
    assert.equal(r.status, 200);
    assert.equal(r.body.depts.length, 7);
    assert.ok(r.body.depts.some((d) => d.id === 'libu' && d.name === '吏部'));
    assert.ok(r.body.depts.every((d) => Array.isArray(d.duty) && d.duty[0]));
    assert.ok(r.body.depts.every((d) => d.brief && d.brief.length >= 3 && d.brief.length <= 8), '每部一句短职责');
    assert.equal(r.body.depts.find((d) => d.id === 'gongbu').example, undefined, '下旨举例已撤掉');
    assert.match(r.body.disclaimer, /平等/);
    assert.match(r.body.disclaimer, /皇后/);
  });

  await t.test('设定身份：陛下 / 皇后 / 家人', async () => {
    assert.equal((await post('/api/court/role', { memberId: '大龙龙', role: 'emperor' })).status, 200);
    assert.equal((await post('/api/court/role', { memberId: '瑞瑞🥚', role: 'empress' })).status, 200);
    const roles = await get('/api/court/roles');
    assert.equal(roles.body.roles['大龙龙'], 'emperor');
    assert.equal(roles.body.roles['瑞瑞🥚'], 'empress');
    assert.equal((await post('/api/court/role', { memberId: '大龙龙', role: '神仙' })).status, 400);
  });

  await t.test('家人不能召见六部 / 不能批阅', async () => {
    const summon = await post('/api/court/summon', { dept: 'libu', memberId: '路人' });
    assert.equal(summon.status, 403);
    assert.match(summon.body.error, /只有陛下与皇后/);

    const dispose = await post('/api/court/dispose', { id: 'whatever', action: 'approve', memberId: '路人' });
    assert.equal(dispose.status, 403);
  });

  let memorialId;
  await t.test('吏部上奏：数据来自真实打卡（含数字），且能缓存', async () => {
    const r = await post('/api/court/summon', { dept: 'libu', memberId: '大龙龙' });
    assert.equal(r.status, 200);
    assert.equal(r.body.cached, false);
    assert.equal(r.body.memorial.status, 'pending');
    assert.equal(r.body.memorial.dept, 'libu');
    assert.match(r.body.memorial.body, /伏候圣裁/);
    assert.match(r.body.memorial.digest, /提交/, '素材里要有真实打卡统计');
    memorialId = r.body.memorial.id;

    const again = await post('/api/court/summon', { dept: 'libu', memberId: '大龙龙' });
    assert.equal(again.body.cached, true);
    assert.equal(again.body.memorial.id, memorialId);
  });

  await t.test('皇后批阅：状态变已朱批，圣旨/懿旨存档', async () => {
    const r = await post('/api/court/dispose', { id: memorialId, action: 'approve', comment: '准，先观察半月', memberId: '瑞瑞🥚' });
    assert.equal(r.status, 200);
    assert.equal(r.body.memorial.status, 'approved');
    assert.equal(r.body.memorial.dispositions.length, 1);

    const edictDir = path.join(dataDir, 'court', 'edicts');
    const files = fs.readdirSync(edictDir);
    assert.equal(files.length, 1);
    const edict = JSON.parse(fs.readFileSync(path.join(edictDir, files[0]), 'utf8'));
    assert.equal(edict.type, '懿旨');
    assert.match(edict.comment, /观察半月/);

    // 已批不能再批
    const twice = await post('/api/court/dispose', { id: memorialId, action: 'approve', memberId: '大龙龙' });
    assert.equal(twice.status, 409);
  });

  await t.test('驳回要写原因，并记进该部记忆', async () => {
    const s = await post('/api/court/summon', { dept: 'libu', memberId: '大龙龙', force: true });
    const id = await post('/api/court/summon', { dept: 'libu', memberId: '大龙龙', force: true }).then((x) => x.body.memorial.id);
    const noComment = await post('/api/court/dispose', { id, action: 'reject', comment: '', memberId: '大龙龙' });
    assert.equal(noComment.status, 400);
    assert.match(noComment.body.error, /原因/);

    const r = await post('/api/court/dispose', { id, action: 'reject', comment: '目标定得太满', memberId: '大龙龙' });
    assert.equal(r.status, 200);
    assert.equal(r.body.memorial.status, 'rejected');
    const memory = JSON.parse(fs.readFileSync(path.join(dataDir, 'court', 'memory', 'libu.json'), 'utf8'));
    assert.ok(memory.some((x) => x.includes('目标定得太满')));
    void s;
  });

  await t.test('回奏：六部收到批示后能补一句进展', async () => {
    const r = await post('/api/court/reply', { id: memorialId, text: '已按懿旨调整目标难度', by: '大龙龙' });
    assert.equal(r.status, 200);
    assert.equal(r.body.memorial.replies.length, 1);
  });

  await t.test('户部：一句话记账 → 分类 → 上奏素材里有金额', async () => {
    const bad = await post('/api/court/ledger', { text: '买菜' });
    assert.equal(bad.status, 400);

    const ok = await post('/api/court/ledger', { text: '买菜 35', memberId: '大龙龙' });
    assert.equal(ok.status, 200);
    assert.equal(ok.body.entry.amount, 35);
    assert.equal(ok.body.entry.categoryLabel, '吃喝');

    await post('/api/court/ledger', { text: '外卖 60', memberId: '瑞瑞🥚' });
    const sum = await get('/api/court/ledger?days=30');
    assert.equal(sum.body.summary.count, 2);
    assert.equal(sum.body.summary.total, 95);

    const r = await post('/api/court/summon', { dept: 'hubu', memberId: '大龙龙' });
    assert.equal(r.status, 200);
    assert.match(r.body.memorial.digest, /95/, '户部素材里要有合计金额');
  });

  await t.test('其他部台账：记一笔后能被该部读到', async () => {
    const add = await post('/api/court/item', { dept: 'gongbu', kind: 'chore', text: '周六大扫除', memberId: '大龙龙' });
    assert.equal(add.status, 200);
    const items = await get('/api/court/items?dept=gongbu');
    assert.equal(items.body.items.length, 1);

    const r = await post('/api/court/summon', { dept: 'gongbu', memberId: '大龙龙' });
    assert.equal(r.status, 200);
    assert.match(r.body.memorial.digest, /大扫除/);

    const badDept = await post('/api/court/item', { dept: 'nope', text: 'x' });
    assert.equal(badDept.status, 400);
  });

  await t.test('朝会：六部简要汇报 + 待批计数', async () => {
    const r = await get('/api/court/meeting');
    assert.equal(r.status, 200);
    assert.equal(r.body.items.length, 6);
    assert.match(r.body.brief, /本日朝会/);
    assert.ok(r.body.pendingTotal >= 1);
  });

  await t.test('奏疏列表与详情：列表是摘要，详情带全文', async () => {
    const list = await get('/api/court/memorials?limit=50');
    assert.equal(list.status, 200);
    assert.ok(list.body.memorials.length >= 2);
    assert.ok(!('body' in list.body.memorials[0]), '列表不该带全文');

    const detail = await get(`/api/court/memorial?id=${encodeURIComponent(memorialId)}`);
    assert.equal(detail.status, 200);
    assert.match(detail.body.memorial.body, /伏候圣裁/);
  });

  /* --------- 国家大事 / 头像 / 用量账簿 --------- */

  await t.test('国家大事：帝后可增改删，家人只能看', async () => {
    const created = await post('/api/annual', { text: '全家去看一次海', budget: 1200, memberId: '大龙龙' });
    assert.equal(created.status, 200);
    assert.equal(created.body.item.text, '全家去看一次海');
    assert.equal(created.body.item.budget, 1200, '内阁大事要带预算');
    assert.equal(created.body.items.length, 1);
    const id = created.body.item.id;

    const updated = await post('/api/annual/update', { id, status: 'doing', memberId: '大龙龙' });
    assert.equal(updated.body.item.status, 'doing');

    const rebudget = await post('/api/annual/update', { id, budget: 1500, memberId: '大龙龙' });
    assert.equal(rebudget.body.item.budget, 1500);

    const denied = await post('/api/annual', { text: '家人乱加', memberId: '路人' });
    assert.equal(denied.status, 403);

    const list = await get('/api/annual');
    assert.equal(list.body.items.length, 1);

    const removed = await post('/api/annual/delete', { id, memberId: '瑞瑞🥚' });
    assert.equal(removed.status, 200);
    assert.equal(removed.body.items.length, 0);
  });

  await t.test('礼部上奏能看到国家大事摘要', async () => {
    await post('/api/annual', { text: '全家去看一次海', memberId: '大龙龙' });
    const r = await post('/api/court/summon', { dept: 'libu2', memberId: '大龙龙' });
    assert.equal(r.status, 200);
    assert.match(r.body.memorial.digest, /内阁大事/);
    assert.match(r.body.memorial.digest, /看一次海/);
  });

  await t.test('头像：能传能取，坏图/超大图会被拒', async () => {
    const px = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
    const up = await post('/api/avatar', { memberId: '大龙龙', dataUrl: px });
    assert.equal(up.status, 200);
    assert.ok(up.body.bytes > 0);

    const got = await get(`/api/avatar?memberId=${encodeURIComponent('大龙龙')}`);
    assert.equal(got.status, 200);
    assert.match(got.body.dataUrl, /^data:image\/png;base64,/);

    const bad = await post('/api/avatar', { memberId: '大龙龙', dataUrl: 'nope' });
    assert.equal(bad.status, 400);

    const st = await get('/api/status');
    assert.equal(st.body.members.find((m) => m.memberId === '大龙龙').hasAvatar, true);
  });

  await t.test('用量账簿：每次上奏都留一笔，带金额（假模型记 0）', async () => {
    const before = await get('/api/usage');
    const beforeCalls = before.body.today.calls;

    const r = await post('/api/court/summon', { dept: 'libu', memberId: '大龙龙', force: true });
    assert.equal(r.status, 200);
    assert.ok(r.body.quota, '上奏响应里要带账单');
    assert.equal(typeof r.body.quota.today.tokens, 'number');
    assert.equal(typeof r.body.quota.today.cost, 'number', '账单要有金额');
    assert.ok(r.body.quota.today.cost >= 0);
    assert.equal(r.body.quota.balance.ok, false, '假模型模式不查余额');
    assert.ok(r.body.quota.price && r.body.quota.price.unit.includes('百万'), '账单要带价目');

    const after = await get('/api/usage');
    assert.equal(after.body.today.calls, beforeCalls + 1);
    assert.ok(after.body.recent.some((x) => x.kind === 'court' && x.dept === 'libu'));
    assert.ok(after.body.recent.some((x) => x.cached === false));
    assert.ok(after.body.recent.every((x) => typeof x.cost === 'number'), '每条流水都要有金额');
  });

  await t.test('司礼监传旨：三类事各归各堆，缓存不重复花钱', async () => {
    const said = '今年攒两万去海边旅游，今天背三十个单词、跑步半小时，周六去公园玩，谁去谁留定一下';
    const first = await post('/api/court/dispatch', { memberId: '大龙龙', text: said });
    assert.equal(first.status, 200);
    assert.equal(first.body.source, 'model');
    assert.ok(first.body.items.length >= 3);
    assert.ok(first.body.items.length <= 10);

    const annual = first.body.items.filter((i) => i.kind === 'annual');
    assert.equal(annual.length, 1, '今年的事归内阁');
    assert.equal(annual[0].budget, 20000, '「两万」要认成预算 20000');
    assert.ok(['year', 'half'].includes(annual[0].period));
    const goals = first.body.items.filter((i) => i.kind === 'goal');
    assert.equal(goals.length, 2, '今天背单词、跑步各一条');
    const tasks = first.body.items.filter((i) => i.kind === 'task');
    assert.ok(tasks.length >= 1);
    assert.ok(tasks.every((i) => ['libu', 'hubu', 'libu2', 'bingbu', 'xingbu', 'gongbu'].includes(i.dept)), '只派六部');
    assert.ok(first.body.items.every((i) => i.text && i.text.length <= 80));
    assert.ok(!tasks.some((i) => i.dept === 'silijian'), '司礼监不给自己派活');

    const second = await post('/api/court/dispatch', { memberId: '大龙龙', text: said });
    assert.equal(second.status, 200);
    assert.equal(second.body.cached, true, '同一段话翻旧旨');
    assert.deepEqual(second.body.items, first.body.items);

    const family = await post('/api/court/dispatch', { memberId: '路人', text: said });
    assert.equal(family.status, 403);
    assert.match(family.body.error, /陛下|皇后/);

    const empty = await post('/api/court/dispatch', { memberId: '大龙龙', text: '   ' });
    assert.equal(empty.status, 400);

    const usage = await get('/api/usage');
    assert.ok(usage.body.recent.some((x) => x.kind === 'dispatch' && x.dept === 'silijian'), '传旨也要进账房');
  });

  await t.test('部门任务：帝后下旨、拖进度、上奏素材里带得上', async () => {
    const add = await post('/api/court/tasks', { dept: 'gongbu', text: '把阳台收拾出来', memberId: '大龙龙' });
    assert.equal(add.status, 200);
    assert.equal(add.body.tasks.length, 1);
    const taskId = add.body.task.id;

    const denied = await post('/api/court/tasks', { dept: 'gongbu', text: '家人乱下旨', memberId: '路人' });
    assert.equal(denied.status, 403);

    const upd = await post('/api/court/task/update', { dept: 'gongbu', id: taskId, progress: 60 });
    assert.equal(upd.body.task.progress, 60);
    assert.equal(upd.body.task.status, 'doing');

    const r = await post('/api/court/summon', { dept: 'gongbu', memberId: '大龙龙' });
    assert.match(r.body.memorial.digest, /御赐差事/);
    assert.match(r.body.memorial.digest, /阳台/);

    const del = await post('/api/court/task/delete', { dept: 'gongbu', id: taskId, memberId: '瑞瑞🥚' });
    assert.equal(del.body.tasks.length, 0);
  });

  await t.test('国家大事：年度/半年度，改措辞每桩每年限 3 次（记进度不算）', async () => {
    const created = await post('/api/annual', { text: '把家谱续上', period: 'half', memberId: '大龙龙' });
    assert.equal(created.status, 200);
    assert.equal(created.body.item.period, 'half');

    const id = created.body.item.id;
    for (let i = 1; i <= 3; i += 1) {
      const r = await post('/api/annual/update', { id, text: `把家谱续上（第 ${i} 稿）`, memberId: '大龙龙' });
      assert.equal(r.status, 200, `第 ${i} 次调整应当允许`);
    }
    const denied = await post('/api/annual/update', { id, text: '再改一次', memberId: '大龙龙' });
    assert.equal(denied.status, 409);
    assert.match(denied.body.error, /3 次/);
    const progress = await post('/api/annual/update', { id, progress: 100, memberId: '大龙龙' });
    assert.equal(progress.status, 200, '记进度不该被调整名额拦住');
  });

  await t.test('国事同步：本机稿合并、墓碑删得掉、流水去重、家人改不了大事', async () => {
    const now = new Date().toISOString();
    const today = now.slice(0, 10);
    const state = {
      annual: {
        items: [{ id: 'c-a1', text: '本机立的大事', period: 'year', progress: 30, adjustments: 0, createdAt: now, updatedAt: now }],
        deleted: {},
      },
      tasks: {
        gongbu: { items: [{ id: 'c-t1', dept: 'gongbu', text: '本机下的旨', progress: 20, createdAt: now, updatedAt: now }], deleted: {} },
      },
      ledger: {
        entries: [{ id: 'c-l1', at: now, date: today, amount: 4, item: '包子', categoryId: 'food', categoryLabel: '吃喝' }],
      },
    };
    const push = await post('/api/court/state', { memberId: '大龙龙', state });
    assert.equal(push.status, 200);
    assert.equal(push.body.rejected.annual, false);
    assert.equal(push.body.role, 'emperor');
    assert.ok(push.body.state.annual.items.some((i) => i.id === 'c-a1'));
    assert.ok(push.body.state.tasks.gongbu.items.some((t) => t.id === 'c-t1'));
    assert.ok(push.body.state.ledger.entries.some((e) => e.id === 'c-l1'));

    const again = await post('/api/court/state', { memberId: '大龙龙', state });
    assert.equal(again.body.state.ledger.entries.filter((e) => e.id === 'c-l1').length, 1, '同一笔只收一次');

    const pulled = await get('/api/court/state?memberId=大龙龙');
    assert.equal(pulled.status, 200);
    assert.ok(pulled.body.state.annual.items.some((i) => i.id === 'c-a1'));
    assert.equal(pulled.body.role, 'emperor');

    // 删掉：留墓碑；旧稿再推上来不该复活
    const later = new Date(Date.now() + 2000).toISOString();
    const deleting = {
      annual: { items: [], deleted: { 'c-a1': later } },
      tasks: { gongbu: { items: [], deleted: { 'c-t1': later } } },
      ledger: { entries: [] },
    };
    const del = await post('/api/court/state', { memberId: '大龙龙', state: deleting });
    assert.ok(!del.body.state.annual.items.some((i) => i.id === 'c-a1'));
    const stale = await post('/api/court/state', { memberId: '大龙龙', state });
    assert.ok(!stale.body.state.annual.items.some((i) => i.id === 'c-a1'), '旧稿不该复活');
    assert.ok(!stale.body.state.tasks.gongbu.items.some((t) => t.id === 'c-t1'));

    const tomb = JSON.parse(fs.readFileSync(path.join(dataDir, 'court', 'tombstones.json'), 'utf8'));
    assert.ok(tomb.annual['c-a1']);
    assert.ok(tomb.tasks.gongbu['c-t1']);

    // 家人推大事：不认，退回中枢那一份
    const family = await post('/api/court/state', {
      memberId: '路人',
      state: {
        annual: { items: [{ id: 'c-a9', text: '家人偷加的大事', period: 'year', progress: 0, createdAt: now, updatedAt: now }], deleted: {} },
        tasks: {},
        ledger: { entries: [] },
      },
    });
    assert.equal(family.body.rejected.annual, true);
    assert.ok(!family.body.state.annual.items.some((i) => i.id === 'c-a9'));
  });

  await t.test('看板总览：七部台账 + 国家大事 + 用量', async () => {
    const r = await get('/api/court/overview');
    assert.equal(r.status, 200);
    assert.equal(r.body.depts.length, 7);
    assert.ok(r.body.depts.every((d) => Array.isArray(d.tasks)));
    assert.ok(Array.isArray(r.body.annual));
    assert.ok(r.body.usage && typeof r.body.usage.today.tokens === 'number');
  });
});
