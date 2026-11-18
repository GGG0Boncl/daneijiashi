/**
 * 看板页面的真实交互测试（jsdom + 真中枢进程）
 *
 * 为什么要它：看板是纯前端渲染 + fetch 驱动，服务端测试只能证明"HTML 里有字符串"，
 * 证明不了"点卡片会切换、点天数会出结果"。这里把页面放进 jsdom 真跑一遍。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';
import { syncWithHub } from '../www/sync.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
const HUB = path.join(ROOT, 'hub', 'hub.mjs');

const PORT = 8798;
const UDP_PORT = 8799;
const BASE = `http://127.0.0.1:${PORT}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const rec = (over = {}) => ({
  memberId: '妈妈',
  memberName: '妈妈',
  date: '2026-11-18',
  version: 1,
  submittedAt: '2026-11-18T07:30:00+08:00',
  updatedAt: '2026-11-18T21:00:00+08:00',
  deviceId: 'dev-a',
  goals: [
    { id: 'g1', text: '背单词', status: 'done', checkedAt: '2026-11-18T21:00:00+08:00', note: '', createdAt: '2026-11-18T07:30:00+08:00', updatedAt: '2026-11-18T21:00:00+08:00', deleted: false },
    { id: 'g2', text: '跑步 3 公里', status: 'failed', checkedAt: '2026-11-18T21:10:00+08:00', note: '膝盖疼', createdAt: '2026-11-18T07:30:00+08:00', updatedAt: '2026-11-18T21:10:00+08:00', deleted: false },
  ],
  ...over,
});

test('看板：点卡片切人、点天数出复盘、TXT 下载链接在', async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'checkin-dash-'));
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
      const r = await fetch(`${BASE}/api/health`);
      if (r.ok) break;
    } catch {
      /* 等 */
    }
    await sleep(250);
  }

  await syncWithHub({
    url: BASE,
    memberId: '妈妈',
    memberName: '妈妈',
    deviceId: 'dev-a',
    mode: 'manual',
    records: [rec()],
  });
  await syncWithHub({
    url: BASE,
    memberId: '瑞瑞🥚',
    memberName: '瑞瑞🥚',
    deviceId: 'dev-b',
    mode: 'auto',
    records: [rec({ memberId: '瑞瑞🥚', memberName: '瑞瑞🥚', deviceId: 'dev-b', goals: [
      { id: 'g1', text: '喝够水', status: 'done', checkedAt: '2026-11-18T20:00:00+08:00', note: '', createdAt: '2026-11-18T07:30:00+08:00', updatedAt: '2026-11-18T20:00:00+08:00', deleted: false },
    ] })],
  });

  const html = await (await fetch(`${BASE}/`)).text();
  const dom = new JSDOM(html, {
    url: `${BASE}/`,
    runScripts: 'dangerously',
    pretendToBeVisual: true,
    beforeParse(window) {
      // jsdom 没有 fetch：桥接到 Node 的 fetch（相对路径按页面地址解析）
      window.fetch = (input, init) => fetch(new URL(input, `${BASE}/`), init);
      window.alert = () => {};
      window.confirm = () => true;
    },
  });
  const { window } = dom;
  const { document } = window;

  t.after(() => {
    try {
      window.close();
    } catch {
      /* ignore */
    }
  });

  const waitFor = async (fn, ms = 4000) => {
    const start = Date.now();
    while (Date.now() - start < ms) {
      try {
        const v = fn();
        if (v) return v;
      } catch {
        /* 还没渲染出来 */
      }
      await sleep(100);
    }
    throw new Error('等待超时');
  };

  let cards;
  await t.test('成员卡片渲染出来（两位都在）', async () => {
    cards = await waitFor(() => {
      const list = document.querySelectorAll('.card[data-member]');
      return list.length >= 2 ? list : null;
    });
    const names = [...cards].map((c) => c.textContent).join('|');
    assert.match(names, /妈妈/);
    assert.match(names, /瑞瑞🥚/);
  });

  await t.test('默认选中第一位，成员面板显示今日目标', async () => {
    await waitFor(() => !document.getElementById('memberPanel').hidden);
    const body = document.getElementById('memberBody').textContent;
    assert.match(body, /今天的目标/);
    assert.match(body, /背单词/);
    assert.match(body, /膝盖疼/, '备注要显示出来');
  });

  await t.test('点另一位成员的卡片，面板切过去', async () => {
    const target = [...document.querySelectorAll('.card[data-member]')].find((c) => c.dataset.member === '瑞瑞🥚');
    target.click();
    const body = await waitFor(() => {
      const text = document.getElementById('memberBody').textContent;
      return text.includes('喝够水') ? text : null;
    });
    assert.ok(body.includes('喝够水'));
    assert.ok(!body.includes('背单词'), '不该把别人的目标也堆在这里');
    assert.equal(document.getElementById('memberName').textContent, '瑞瑞🥚');
  });

  await t.test('点「7 天」会调用中枢并显示复盘结果', async () => {
    const btn = document.querySelector('[data-analyze="7"]');
    assert.ok(btn, '应该有 7 天按钮');
    btn.click();
    const out = await waitFor(() => {
      const el = document.getElementById('analysisOut');
      return el && !el.hidden && el.textContent.includes('假模型输出') ? el.textContent : null;
    }, 8000);
    assert.match(out, /最近 7 天/);
  });

  await t.test('成员备份区有 JSON 与 TXT 下载链接', () => {
    const links = [...document.querySelectorAll('#memberBody a')].map((a) => a.getAttribute('href'));
    assert.ok(links.some((h) => h && h.includes('/api/backup/download')), '缺 JSON 下载');
    assert.ok(links.some((h) => h && h.includes('/api/backup/text')), '缺 TXT 下载');
  });

  await t.test('历史复盘列表在，且同天数最多 3 条', async () => {
    // 再点两次 force 由服务端保证；这里只验证列表渲染
    const hist = await waitFor(() => document.querySelectorAll('[data-analysis]').length ? document.querySelectorAll('[data-analysis]') : null);
    assert.ok(hist.length <= 3, `同天数最多 3 条，实际 ${hist.length}`);
  });

  await t.test('六部台账：七部都在，点一部能看它的差事与奏疏', async () => {
    const cards = await waitFor(() => {
      const list = document.querySelectorAll('.card[data-dept]');
      return list.length >= 7 ? list : null;
    }, 6000);
    assert.equal(cards.length, 7);

    // 先让礼部有一桩任务/一份奏疏，再看详情
    const libu2 = [...cards].find((c) => c.dataset.dept === 'libu2');
    libu2.click();
    const body = await waitFor(() => {
      const el = document.getElementById('deptBody');
      return el && el.textContent.includes('御赐差事') ? el.textContent : null;
    }, 6000);
    assert.match(body, /御赐差事/);
    assert.match(body, /近来的奏疏/);
  });
});
