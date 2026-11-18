/**
 * 端到端同步测试：真起一个中枢进程，用 App 自己的 sync.js 跟它打交道。
 * （不依赖手机：这正是"两层规则必须一致"的地方）
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { syncWithHub, testHub, normalizeHubUrl } from '../../app/www/sync.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
const HUB = path.join(ROOT, 'hub', 'hub.mjs');

const PORT = 8791;
const UDP_PORT = 8792;
const BASE = `http://127.0.0.1:${PORT}`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitForHub(tries = 40) {
  for (let i = 0; i < tries; i += 1) {
    try {
      const info = await testHub(BASE);
      if (info?.ok) return info;
    } catch {
      /* 还没起来 */
    }
    await sleep(250);
  }
  throw new Error('中枢没能在 10 秒内启动');
}

const rec = (over = {}) => ({
  memberId: '妈妈',
  memberName: '妈妈',
  date: '2026-11-18',
  version: 1,
  submittedAt: '2026-11-18T07:30:00+08:00',
  updatedAt: '2026-11-18T07:30:00+08:00',
  deviceId: 'dev-a',
  goals: [
    { id: 'g1', text: '背单词', status: 'pending', checkedAt: null, note: '', createdAt: '2026-11-18T07:30:00+08:00', updatedAt: '2026-11-18T07:30:00+08:00', deleted: false },
  ],
  ...over,
});

test('App ↔ 中枢 端到端同步', async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'checkin-hub-'));
  const child = spawn(process.execPath, [HUB], {
    env: {
      ...process.env,
      CHECKIN_DATA_DIR: dataDir,
      HUB_PORT: String(PORT),
      HUB_UDP_PORT: String(UDP_PORT),
      HUB_DEEPSEEK: 'off', // 测试里不打真实模型，避免花钱和不确定性
    },
    stdio: 'ignore', // 沙箱内不能用管道
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

  const info = await waitForHub();
  await t.test('健康检查', () => {
    assert.equal(info.app, 'family-checkin-hub');
    assert.match(info.today, /^\d{4}-\d{2}-\d{2}$/);
  });

  await t.test('地址归一化', () => {
    assert.equal(normalizeHubUrl('192.168.1.5:8787'), 'http://192.168.1.5:8787');
    assert.equal(normalizeHubUrl('http://192.168.1.5:8787/'), 'http://192.168.1.5:8787');
    assert.equal(normalizeHubUrl('  '), '');
  });

  let firstSync;
  await t.test('第一次同步：新记录进中枢并落盘', async () => {
    firstSync = await syncWithHub({
      url: BASE,
      memberId: '妈妈',
      memberName: '妈妈',
      deviceId: 'dev-a',
      records: [rec()],
    });
    assert.equal(firstSync.written, 1);
    assert.equal(firstSync.records.length, 1);
    const file = path.join(dataDir, 'records', '妈妈', '2026-11-18.json');
    assert.ok(fs.existsSync(file), '中枢应该把记录写成 checkin.mjs 能读的 JSON');
    const onDisk = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.equal(onDisk.memberId, '妈妈');
    assert.equal(onDisk.goals[0].text, '背单词');
    // 落盘时间统一成北京时间
    assert.ok(onDisk.submittedAt.endsWith('+08:00'), `时间应该带 +08:00，实际 ${onDisk.submittedAt}`);
  });

  await t.test('重复同步幂等：不重复写、version 不涨', async () => {
    const again = await syncWithHub({
      url: BASE,
      memberId: '妈妈',
      memberName: '妈妈',
      deviceId: 'dev-a',
      records: [rec()],
    });
    assert.equal(again.written, 0);
    assert.equal(again.records[0].version, firstSync.records[0].version);
  });

  await t.test('另一台设备改了更晚的状态 → 合并后胜出', async () => {
    const newer = rec({
      deviceId: 'dev-b',
      version: 2,
      updatedAt: '2026-11-18T21:40:00+08:00',
      goals: [
        { id: 'g1', text: '背单词', status: 'done', checkedAt: '2026-11-18T21:40:00+08:00', note: '睡前补上', createdAt: '2026-11-18T07:30:00+08:00', updatedAt: '2026-11-18T21:40:00+08:00', deleted: false },
        { id: 'g2', text: '跑步 3 公里', status: 'pending', checkedAt: null, note: '', createdAt: '2026-11-18T21:40:00+08:00', updatedAt: '2026-11-18T21:40:00+08:00', deleted: false },
      ],
    });
    const merged = await syncWithHub({ url: BASE, memberId: '妈妈', memberName: '妈妈', deviceId: 'dev-b', records: [newer] });
    const g1 = merged.records[0].goals.find((g) => g.id === 'g1');
    const g2 = merged.records[0].goals.find((g) => g.id === 'g2');
    assert.equal(g1.status, 'done');
    assert.equal(g1.note, '睡前补上');
    assert.equal(g2.status, 'pending', '新目标也要保留');
  });

  await t.test('删除以墓碑同步，另一台设备不会复活', async () => {
    const deleted = rec({
      deviceId: 'dev-b',
      version: 9,
      updatedAt: '2026-11-18T23:00:00+08:00',
      goals: [
        { id: 'g1', text: '背单词', status: 'done', checkedAt: '2026-11-18T21:40:00+08:00', note: '', createdAt: '2026-11-18T07:30:00+08:00', updatedAt: '2026-11-18T23:00:00+08:00', deleted: true },
      ],
    });
    // 旧设备又拿老数据来推一次
    const merged = await syncWithHub({ url: BASE, memberId: '妈妈', memberName: '妈妈', deviceId: 'dev-a', records: [deleted, rec({ deviceId: 'dev-a' })] });
    const g1 = merged.records[0].goals.find((g) => g.id === 'g1');
    assert.equal(g1.deleted, true, '删除不应该被旧数据复活');
  });

  await t.test('中枢概览接口', async () => {
    const res = await fetch(`${BASE}/api/summary?date=2026-11-18`);
    const body = await res.json();
    assert.equal(res.status, 200);
    assert.equal(body.members.length, 1);
    assert.equal(body.members[0].submitted, true);
  });

  await t.test('看板页面能打开（内容由 /api/status 动态渲染）', async () => {
    const res = await fetch(`${BASE}/`);
    const html = await res.text();
    assert.equal(res.status, 200);
    assert.ok(html.includes('大内家事'), '看板应该渲染出来');
    assert.ok(html.includes('/api/status'), '看板由接口驱动，成员名在客户端渲染');
  });

  await t.test('健康检查带上历史保留期（默认 1 年）', async () => {
    const res = await fetch(`${BASE}/api/health`);
    const body = await res.json();
    assert.equal(body.retention.months, 12);
    assert.match(body.retention.cutoff, /^\d{4}-\d{2}-01$/);
  });

  await t.test('超过保留期的旧记录：不落盘、旧文件被清掉', async () => {
    // 1) 手机硬塞一条两年前的记录 —— 中枢不该存
    const ancient = rec({
      date: '2024-06-01',
      updatedAt: '2024-06-01T21:00:00+08:00',
      submittedAt: '2024-06-01T07:30:00+08:00',
      goals: [
        { id: 'g1', text: '考古目标', status: 'done', checkedAt: '2024-06-01T21:00:00+08:00', note: '', createdAt: '2024-06-01T07:30:00+08:00', updatedAt: '2024-06-01T21:00:00+08:00', deleted: false },
      ],
    });
    const res = await syncWithHub({ url: BASE, memberId: '妈妈', memberName: '妈妈', deviceId: 'dev-old', records: [ancient] });
    // 注意：syncWithHub 会把"本地发出去的记录"和"服务端返回"合并，
    // 所以这里要查的是服务端事实（落盘 + /api/records），不是合并后的数组。
    assert.ok(!fs.existsSync(path.join(dataDir, 'records', '妈妈', '2024-06-01.json')), '超期数据不该落盘');
    const serverRecords = await (await fetch(`${BASE}/api/records?memberId=${encodeURIComponent('妈妈')}`)).json();
    assert.ok(!serverRecords.records.some((r) => r.date === '2024-06-01'), '超期数据不该出现在中枢的查询结果里');
    assert.equal(res.retention.months, 12);

    // 2) 磁盘上已有的超期文件，下次同步时应被清掉
    const oldFile = path.join(dataDir, 'records', '妈妈', '2025-01-02.json');
    fs.writeFileSync(oldFile, JSON.stringify({ ...rec(), date: '2025-01-02' }, null, 2), 'utf8');
    const res2 = await syncWithHub({ url: BASE, memberId: '妈妈', memberName: '妈妈', deviceId: 'dev-a', records: [rec()] });
    assert.ok(res2.pruned >= 1, `应该清掉至少 1 个超期文件，实际 ${res2.pruned}`);
    assert.ok(!fs.existsSync(oldFile), '超期文件应该被删除');
    assert.ok(fs.existsSync(path.join(dataDir, 'records', '妈妈', '2026-11-18.json')), '保留期内的记录必须还在');
  });

  /* --------- CORS：手机 App 从 https://localhost 跨源访问中枢，少了这个就 "Failed to fetch" --------- */
  await t.test('CORS：普通响应带 ACAO，预检回 204', async () => {
    const origin = 'https://localhost';
    const get = await fetch(`${BASE}/api/health`, { headers: { Origin: origin } });
    assert.equal(get.status, 200);
    assert.equal(get.headers.get('access-control-allow-origin'), '*', 'GET 必须允许跨源');

    const pre = await fetch(`${BASE}/api/sync`, {
      method: 'OPTIONS',
      headers: {
        Origin: origin,
        'Access-Control-Request-Method': 'POST',
        'Access-Control-Request-Headers': 'content-type',
      },
    });
    assert.equal(pre.status, 204);
    assert.equal(pre.headers.get('access-control-allow-origin'), '*');
    assert.match(pre.headers.get('access-control-allow-methods') ?? '', /POST/);
    assert.match(pre.headers.get('access-control-allow-headers') ?? '', /content-type/i);
  });

  await t.test('同步会记下"自动/手动"，并登记设备在线', async () => {
    await syncWithHub({ url: BASE, memberId: '妈妈', memberName: '妈妈', deviceId: 'dev-a', mode: 'manual', records: [rec()] });
    const st = await (await fetch(`${BASE}/api/status`)).json();
    const dev = st.devices.find((d) => d.deviceId === 'dev-a');
    assert.ok(dev, '应该登记这台设备');
    assert.equal(dev.lastMode, 'manual');
    assert.ok(dev.manualCount >= 1);
    assert.ok(dev.online, '刚同步完应该在在线状态');
    assert.equal(st.syncs[0].mode, 'manual', '最近同步动态里要标手动');
    assert.ok(Array.isArray(st.members) && st.members.length >= 1, 'status 里要有成员概览');
  });

  await t.test('备份接口：能列出数据目录并下载某个成员的 JSON', async () => {
    const bk = await (await fetch(`${BASE}/api/backup`)).json();
    assert.ok(bk.ok);
    assert.equal(bk.dataDir, dataDir);
    assert.ok(bk.totalDays >= 1);
    const row = bk.members.find((m) => m.memberId === '妈妈');
    assert.ok(row, '备份列表里应该有这位成员');
    assert.ok(row.days >= 1);

    const dl = await fetch(`${BASE}/api/backup/download?memberId=${encodeURIComponent('妈妈')}`);
    assert.equal(dl.status, 200);
    assert.match(dl.headers.get('content-disposition') ?? '', /attachment/);
    const body = await dl.json();
    assert.ok(Array.isArray(body.records) && body.records.length >= 1);
  });

  await t.test('AI 复盘的降级路径：没配 key 时给出可操作的报错，而不是崩', async () => {
    const res = await fetch(`${BASE}/api/analyze`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ memberId: '妈妈', days: 7 }),
    });
    assert.equal(res.status, 503);
    const body = await res.json();
    assert.equal(body.ok, false);
    assert.match(body.error, /关闭|Key|配置/i);
    // 健康检查要如实告诉前端"能不能分析"
    const health = await (await fetch(`${BASE}/api/health`)).json();
    assert.equal(health.analysis.available, false);
    assert.ok(Array.isArray(health.analysis.days) && health.analysis.days.includes(7));
  });

  await t.test('看板页面包含成员、同步动态、备份与 AI 复盘区块', async () => {
    const html = await (await fetch(`${BASE}/`)).text();
    for (const needle of ['最近同步', 'AI 复盘', '本地备份', '成员']) {
      assert.ok(html.includes(needle), `看板缺少「${needle}」区块`);
    }
    assert.ok(html.includes('/api/status'), '看板应由 /api/status 驱动');
  });

  /* --------- 回归：成员名字带 emoji（瑞瑞🥚）曾经同步失败 --------- */
  await t.test('带 emoji 的成员能正常同步并落盘', async () => {
    const id = '瑞瑞🥚';
    const res = await syncWithHub({
      url: BASE,
      memberId: id,
      memberName: id,
      deviceId: 'dev-egg',
      mode: 'auto',
      records: [rec({ memberId: id, memberName: id, deviceId: 'dev-egg' })],
    });
    assert.equal(res.written, 1, 'emoji 成员的记录应该写进去');
    assert.ok(fs.existsSync(path.join(dataDir, 'records', id, '2026-11-18.json')), '目录名就是「瑞瑞🥚」');
    const st = await (await fetch(`${BASE}/api/status`)).json();
    assert.ok(st.members.some((m) => m.memberId === id), '看板要能看到这位成员');
    assert.ok(st.devices.some((d) => d.memberId === id), '设备登记也不能漏');
  });

  await t.test('真正危险的称呼会被明确拒绝，不会写坏目录', async () => {
    const res = await fetch(`${BASE}/api/sync`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ memberId: '坏/名字', memberName: '坏/名字', deviceId: 'x', records: [] }),
    });
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.match(body.error, /不能有/);
    assert.ok(!fs.existsSync(path.join(dataDir, 'records', '坏')), '不该创建坏掉的目录');
  });
});

/* ------------------------------------------------------------------ *
 * 第二个中枢实例：用假模型（HUB_DEEPSEEK_FAKE）验证缓存与看板接口，
 * 不花钱、不依赖外网。
 * ------------------------------------------------------------------ */
const FAKE_PORT = 8795;
const FAKE_UDP = 8796;
const FAKE_BASE = `http://127.0.0.1:${FAKE_PORT}`;

test('AI 复盘缓存 + 成员详情接口', async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'checkin-cache-'));
  const child = spawn(process.execPath, [HUB], {
    env: {
      ...process.env,
      CHECKIN_DATA_DIR: dataDir,
      HUB_PORT: String(FAKE_PORT),
      HUB_UDP_PORT: String(FAKE_UDP),
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
      if ((await testHub(FAKE_BASE))?.ok) break;
    } catch {
      /* 等它起来 */
    }
    await sleep(250);
  }

  const post = async (pathname, body) =>
    (await fetch(`${FAKE_BASE}${pathname}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })).json();

  const baseRec = {
    memberId: '妈妈',
    memberName: '妈妈',
    date: '2026-11-18',
    version: 1,
    submittedAt: '2026-11-18T07:30:00+08:00',
    updatedAt: '2026-11-18T21:00:00+08:00',
    deviceId: 'dev-a',
    goals: [
      { id: 'g1', text: '背单词', status: 'done', checkedAt: '2026-11-18T21:00:00+08:00', note: '', createdAt: '2026-11-18T07:30:00+08:00', updatedAt: '2026-11-18T21:00:00+08:00', deleted: false },
      { id: 'g2', text: '跑步', status: 'failed', checkedAt: '2026-11-18T21:10:00+08:00', note: '太累', createdAt: '2026-11-18T07:30:00+08:00', updatedAt: '2026-11-18T21:10:00+08:00', deleted: false },
    ],
  };

  await t.test('先同步一份数据', async () => {
    const r = await syncWithHub({ url: FAKE_BASE, memberId: '妈妈', memberName: '妈妈', deviceId: 'dev-a', mode: 'manual', records: [baseRec] });
    assert.equal(r.written, 1);
  });

  let firstId;
  await t.test('第一次分析会真的"生成"', async () => {
    const body = await post('/api/analyze', { memberId: '妈妈', days: 7 });
    assert.equal(body.ok, true);
    assert.equal(body.analysis.cached, false);
    assert.match(body.analysis.text, /假模型输出/);
    firstId = body.analysis.id;
  });

  await t.test('同一份数据再点一次：直接返回缓存，不花 token', async () => {
    const body = await post('/api/analyze', { memberId: '妈妈', days: 7 });
    assert.equal(body.analysis.cached, true);
    assert.equal(body.analysis.id, firstId, '应该复用同一份结果');
  });

  await t.test('数据变了以后缓存失效，会重新生成', async () => {
    const changed = {
      ...baseRec,
      version: 2,
      updatedAt: '2026-11-18T22:00:00+08:00',
      goals: baseRec.goals.map((g) => (g.id === 'g2' ? { ...g, note: '今天改成散步了', updatedAt: '2026-11-18T22:00:00+08:00' } : g)),
    };
    await syncWithHub({ url: FAKE_BASE, memberId: '妈妈', memberName: '妈妈', deviceId: 'dev-a', records: [changed] });
    const body = await post('/api/analyze', { memberId: '妈妈', days: 7 });
    assert.equal(body.analysis.cached, false);
    assert.notEqual(body.analysis.id, firstId);
  });

  await t.test('force=true 会强制重新生成', async () => {
    const body = await post('/api/analyze', { memberId: '妈妈', days: 7, force: true });
    assert.equal(body.analysis.cached, false);
  });

  await t.test('同一个天数最多只列 3 条历史', async () => {
    for (let i = 0; i < 4; i += 1) await post('/api/analyze', { memberId: '妈妈', days: 3, force: true });
    const list = await (await fetch(`${FAKE_BASE}/api/analyses?memberId=${encodeURIComponent('妈妈')}`)).json();
    const perDays = list.analyses.filter((a) => a.days === 3);
    assert.ok(perDays.length <= 3, `同天数最多 3 条，实际 ${perDays.length}`);
    assert.ok(perDays.length >= 1);
    // 列表只给摘要，不带正文
    assert.ok(!('text' in perDays[0]), '列表不该返回全文');
  });

  await t.test('历史复盘能按 id 取回全文（中文 id 也行）', async () => {
    const list = await (await fetch(`${FAKE_BASE}/api/analyses?memberId=${encodeURIComponent('妈妈')}`)).json();
    const one = await (await fetch(`${FAKE_BASE}/api/analysis?id=${encodeURIComponent(list.analyses[0].id)}`)).json();
    assert.equal(one.ok, true);
    assert.ok(one.analysis.text.length > 0);
  });

  await t.test('成员详情接口：今日目标 + 同步记录 + 分析历史', async () => {
    const m = await (await fetch(`${FAKE_BASE}/api/member?memberId=${encodeURIComponent('妈妈')}`)).json();
    assert.equal(m.ok, true);
    assert.equal(m.member.id, '妈妈');
    assert.equal(m.today.goals.length, 2);
    assert.equal(m.today.done, 1);
    assert.equal(m.today.failed, 1);
    assert.ok(m.syncs.length >= 1);
    assert.equal(m.syncs[0].mode, 'auto');
    assert.ok(Array.isArray(m.analyses));
    assert.ok(m.stats.days >= 1);
  });

  await t.test('备份 TXT 是按天一行、用户要的格式', async () => {
    const res = await fetch(`${FAKE_BASE}/api/backup/text?memberId=${encodeURIComponent('妈妈')}`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type') ?? '', /text\/plain/);
    const text = await res.text();
    assert.equal(text.trim(), '2026年11月18日：背单词；跑步。');
  });
});
