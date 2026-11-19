/**
 * App 界面冒烟（jsdom + fake-indexeddb）
 *
 * 这一版盯着用户点名的几件事：
 *   · 两页：朝廷（内阁 / 御书房 / 奏疏）与起居（今日差事 / 行事历 / 钦天监）
 *   · 内阁不自己添事，统一走司礼监传旨；内阁大事带预算
 *   · 今日差事也由司礼监传旨生成
 *   · 朕的私事在底栏最右
 *   · 全程不连中枢也能记
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { JSDOM } from 'jsdom';
import 'fake-indexeddb/auto';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WWW = path.resolve(HERE, '..', 'www');
const flush = (ms = 60) => new Promise((r) => setTimeout(r, ms));
const fire = (el, type) => el.dispatchEvent(new window.Event(type, { bubbles: true }));

function setupDom() {
  const raw = fs.readFileSync(path.join(WWW, 'index.html'), 'utf8');
  const html = raw.replace(/<script[\s\S]*?<\/script>/g, '');
  const dom = new JSDOM(html, { url: 'https://localhost/', pretendToBeVisual: true });
  globalThis.window = dom.window;
  globalThis.document = dom.window.document;
  globalThis.HTMLElement = dom.window.HTMLElement;
  globalThis.Event = dom.window.Event;
  try {
    Object.defineProperty(globalThis, 'navigator', { value: dom.window.navigator, configurable: true, writable: true });
  } catch {
    /* 忽略 */
  }
  globalThis.confirm = () => true;
  return dom;
}

test('App 两页：朝廷与起居（离线可用）', async (t) => {
  const dom = setupDom();
  const { document } = globalThis;
  await import(pathToFileURL(path.join(WWW, 'app.js')).href);
  await flush(160);
  const $ = (sel) => document.querySelector(sel);

  const openDispatch = async (text) => {
    const entry = document.querySelector('[data-open-dispatch]');
    assert.ok(entry, '应有司礼监传旨入口');
    entry.click();
    await flush(70);
    assert.ok($('#dispatchText'), '应弹出传旨面板');
    $('#dispatchText').value = text;
    $('#dispatchGo').click();
    await flush(240);
  };

  await t.test('首次启动：起名引导', () => {
    assert.ok($('#sheetMask'));
    assert.ok($('#onboardName'));
  });

  await t.test('取名后先落在朝廷页，起居页收着', async () => {
    $('#onboardName').value = '妈妈';
    $('#onboardSave').click();
    await flush(200);
    assert.equal($('#sheetMask'), null);
    assert.equal($('#app').hidden, false);
    assert.match($('#greet').textContent, /妈妈/);
    assert.equal($('#pageCourt').hidden, false);
    assert.equal($('#pageDaily').hidden, true);
    assert.ok($('#syncPill'), '顶上驿牌仍在');
  });

  await t.test('朝廷页：内阁 → 司礼监 → 御书房 → 奏疏', () => {
    for (const id of ['annualCard', 'dispatchCard', 'courtCard', 'courtListCard']) {
      assert.ok($(`#${id}`), `朝廷页缺 ${id}`);
      assert.ok($(`#pageCourt #${id}`), `${id} 应在朝廷页`);
    }
    const cards = [...document.querySelectorAll('#pageCourt > section')].map((x) => x.id);
    assert.deepEqual(cards.slice(0, 4), ['annualCard', 'dispatchCard', 'courtCard', 'courtListCard']);
    assert.equal($('#ledgerCard'), null, '账房不再单独占卡');
    assert.match($('#annualCard').textContent, /内阁/);
    assert.match($('#dispatchCard').textContent, /司礼监 · 传旨/);
    assert.ok($('#dispatchCard [data-open-dispatch]'), '传旨入口只在司礼监');
  });

  await t.test('起居页：今日差事 / 行事历 / 钦天监，切页能来回', async () => {
    for (const id of ['todayCard', 'historyCard', 'aiCard']) {
      assert.ok($(`#pageDaily #${id}`), `${id} 应在起居页`);
    }
    const tabs = [...document.querySelectorAll('.bottom-bar [data-page]')].map((x) => x.dataset.page);
    assert.deepEqual(tabs, ['court', 'daily']);
    document.querySelector('#tabDaily').click();
    await flush(40);
    assert.equal($('#pageDaily').hidden, false);
    assert.equal($('#pageCourt').hidden, true);
    document.querySelector('#tabCourt').click();
    await flush(40);
    assert.equal($('#pageCourt').hidden, false);
    assert.equal($('#pageDaily').hidden, true);
  });

  await t.test('朕的私事在底栏最右；今日差事不再手填', () => {
    const bar = document.querySelector('.bottom-bar');
    const last = bar.lastElementChild;
    assert.equal(last.id, 'openSettings');
    assert.match(last.textContent, /朕的私事/);
    assert.equal($('#newGoal'), null, '今日差事改为司礼监传旨生成');
    assert.equal($('#addBtn'), null);
    assert.equal($('#todayCard [data-open-dispatch]'), null, '起居页不再单设传旨入口');
    assert.match($('#todayCard').textContent, /由司礼监传旨生成/);
  });

  await t.test('离线也照记：先把自己认作帝后（写在本机）', async () => {
    $('#openSettings').click();
    await flush(70);
    const roleBtn = document.querySelector('[data-court-role="emperor"]');
    assert.ok(roleBtn, '私事里应有身份选择');
    roleBtn.click();
    await flush(140);
    assert.match($('#courtCard').textContent, /我的身份：陛下/);
    $('#settingsClose')?.click();
    await flush(40);
  });

  await t.test('内阁空着：没有添事按钮，只提示到司礼监传旨', () => {
    const text = $('#annualCard').textContent;
    assert.match(text, /内阁还无一桩大事/);
    assert.match(text, /到司礼监传旨/);
    assert.equal($('#annualAddOpen'), null, '内阁不该自己添事');
    assert.equal($('#annualText'), null);
    assert.equal($('#annualCard [data-open-dispatch]'), null, '内阁不再单设传旨入口');
    assert.equal($('#courtCard [data-open-dispatch]'), null, '御书房里不再放传旨入口');
  });

  await t.test('司礼监传旨：一次拆出内阁大事（带预算）与六部差事', async () => {
    await openDispatch('今年攒两万去海边旅游，周六去公园玩，谁去谁留定一下');
    const result = $('#dispatchResult').textContent;
    assert.match(result, /内阁大事/);
    assert.match(result, /六部差事/);
    const annualRow = document.querySelector('[data-dispatch-budget]');
    assert.ok(annualRow, '内阁那行要有预算输入框');
    assert.equal(annualRow.value, '20000', '「两万」要认成 20000');
    $('#dispatchConfirm').click();
    await flush(260);
    assert.equal($('#sheetMask'), null);
    const cabinet = $('#annualCard').textContent;
    assert.match(cabinet, /海边旅游/);
    assert.match(cabinet, /预算 ¥20000/);
    assert.match(cabinet, /本年可调 3 次/);
  });

  await t.test('今日差事也由司礼监传旨生成（两件）', async () => {
    document.querySelector('#tabCourt').click();
    await flush(40);
    document.querySelector('#dispatchCard [data-open-dispatch]').click();
    await flush(70);
    $('#dispatchText').value = '今天背三十个单词、跑步半小时';
    $('#dispatchGo').click();
    await flush(240);
    assert.match($('#dispatchResult').textContent, /今日差事/);
    assert.equal(document.querySelectorAll('[data-dispatch-pick]').length, 2);
    assert.equal(document.querySelectorAll('[data-dispatch-due]').length, 2, '每条今日差事都能定到点');
    $('#dispatchConfirm').click();
    await flush(260);
    assert.equal($('#sheetMask'), null);
    document.querySelector('#tabDaily').click();
    await flush(40);
    assert.equal(document.querySelectorAll('.goal').length, 2);
    assert.match($('#todayCard').textContent, /背三十个单词/);
    assert.match($('#todayCard').textContent, /跑步半小时/);
  });

  await t.test('今日差事：圈里 0%，点圈弹滑块记 50%', async () => {
    const dot = document.querySelector('.goal .pct-dot');
    assert.ok(dot);
    assert.equal(dot.textContent.trim(), '0%');
    dot.click();
    await flush(60);
    assert.ok($('#sheetMask'));
    $('#pctRange').value = '50';
    fire($('#pctRange'), 'input');
    assert.equal($('#pctBig').textContent, '50%');
    $('#pctSave').click();
    await flush(160);
    assert.equal(document.querySelector('.goal .pct-dot').textContent.trim(), '50%');
    assert.match($('#todayCard').textContent, /均 25%/);
  });

  await t.test('记到 100%：办成后默认隐藏，可「查看全部」', async () => {
    document.querySelector('.goal .pct-dot').click();
    await flush(60);
    $('#pctRange').value = '100';
    $('#pctSave').click();
    await flush(180);
    assert.equal(document.querySelectorAll('.goal').length, 1, '办成一件，只剩跑步');
    assert.match($('#todayCard').textContent, /均 50%/);
  });

  await t.test('点开差事写附言', async () => {
    document.querySelector('.goal [data-act="more"]').click();
    await flush(60);
    assert.ok($('#sheetMask'));
    $('#editNote').value = '跑了二十分钟';
    $('#sheetSave').click();
    await flush(140);
    assert.equal($('#sheetMask'), null);
    assert.match(document.querySelector('.goal .goal-meta').textContent, /跑了二十分钟/);
  });

  await t.test('内阁进度：点圈记 40%，不耗调整次数', async () => {
    document.querySelector('#tabCourt').click();
    await flush(40);
    document.querySelector('#annualCard .pct-dot').click();
    await flush(60);
    $('#pctRange').value = '40';
    $('#pctSave').click();
    await flush(160);
    assert.equal(document.querySelector('#annualCard .pct-dot').textContent.trim(), '40%');
    assert.match($('#annualCard').textContent, /本年可调 3 次/, '记进度不算调整');
  });

  await t.test('内阁 ⋯：改措辞与预算，耗一次调整名额', async () => {
    document.querySelector('#annualCard [data-annual-more]').click();
    await flush(70);
    assert.ok($('#annualEditBudget'), '改事的面板里要能改预算');
    $('#annualEditText').value = '今年攒两万去海边旅游（改稿）';
    $('#annualEditBudget').value = '25000';
    $('#annualEditSave').click();
    await flush(180);
    assert.match($('#annualCard').textContent, /改稿/);
    assert.match($('#annualCard').textContent, /预算 ¥25000/);
    assert.match($('#annualCard').textContent, /本年可调 2 次/);
    assert.equal(document.querySelector('#annualCard .pct-dot').textContent.trim(), '40%', '改措辞不动进度');
  });

  await t.test('御书房：六部各一行，各一句职能；司礼监在隔壁卡片', () => {
    const rows = [...document.querySelectorAll('.dept-row')];
    assert.equal(rows.length, 6, '六部各占一行');
    for (const d of ['吏部', '户部', '礼部', '兵部', '刑部', '工部']) {
      assert.ok($('#courtCard').textContent.includes(d), `缺 ${d}`);
    }
    assert.ok(document.querySelector('.dept-row[data-dept="silijian"]') === null, '司礼监不该混在六部里');
    assert.equal($('#courtCard [data-open-dispatch]'), null, '传旨入口不在御书房里');
    assert.match($('#courtCard').textContent, /管考成与分工/);
    assert.match($('#courtCard').textContent, /管钱粮账目/);
    assert.match($('#courtCard').textContent, /管出行安全/);
    assert.ok(!$('#courtCard').textContent.includes('湿地公园'), '御书房不再摆下旨举例');
    // 传旨落下来的差事要能在部里看到统计
    assert.match(document.querySelector('.dept-row[data-dept="libu2"] .dept-sum').textContent, /差事 1 道/);
    assert.match(document.querySelector('.dept-row[data-dept="libu"] .dept-sum').textContent, /差事 1 道/);
  });

  await t.test('各部下旨不再带举例，只留一句职责', async () => {
    document.querySelector('.dept-row[data-dept="bingbu"]').click();
    await flush(70);
    assert.match($('#deptTaskInput').placeholder, /给兵部下旨/);
    assert.ok(!$('#deptTaskInput').placeholder.includes('湿地公园'), '举例已删');
    assert.ok($('#deptTaskDue'), '部里下旨也能定到点');
    assert.match($('#sheetMask').textContent, /职责：管出行安全/);
    $('#deptClose').click();
    await flush(40);
  });

  await t.test('户部：下旨、记多笔账，账房就收在这一片里', async () => {
    document.querySelector('.dept-row[data-dept="hubu"]').click();
    await flush(70);
    assert.match($('#sheetMask').textContent, /职责：管钱粮账目/);
    assert.ok($('#courtLedger'), '户部里有记账入口');
    $('#deptTaskInput').value = '把本月账目理清';
    $('#deptTaskAdd').click();
    await flush(180);
    assert.match($('#sheetMask').textContent, /把本月账目理清/);
    assert.equal(document.querySelector('.dept-task .pct-dot').textContent.trim(), '0%');

    $('#courtLedger').value = '包子4 deepseek50 午饭18';
    $('#courtLedgerBtn').click();
    await flush(220);
    const text = $('#sheetMask').textContent;
    assert.match(text, /近卅日 3 笔/);
    assert.match(text, /合计 ¥72/);
    assert.match(text, /吃喝/);
    assert.match(text, /数码订阅/);
  });

  await t.test('差事进度也走圆圈弹层，60% 记上', async () => {
    document.querySelector('.dept-task .pct-dot').click();
    await flush(60);
    $('#pctRange').value = '60';
    $('#pctSave').click();
    await flush(220);
    assert.equal(document.querySelector('.dept-task .pct-dot').textContent.trim(), '60%');
  });

  await t.test('头像：换过一次后，再点头像仍能唤出选图', async () => {
    let picked = 0;
    $('#avatarFile').addEventListener('click', () => { picked += 1; });
    $('#avatarImg').hidden = false;
    $('#avatarFallback').hidden = true;
    $('#avatarImg').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    await flush(30);
    assert.equal(picked, 1, '点到图片本身也要认作头像按钮');
    $('#avatarBtn').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    await flush(30);
    assert.equal(picked, 2);
  });

  await t.test('钦天监：讲清它是干什么的，直接填天数，离线按钮灰', () => {
    assert.match($('#aiCard').textContent, /此为何用/);
    const input = $('#aiDaysInput');
    assert.ok(input, '应有一个填天数的输入框');
    assert.equal(input.type, 'number');
    assert.equal(input.min, '1');
    assert.equal(input.max, '365');
    assert.ok(input.disabled);
    const run = $('#aiRun');
    assert.ok(run);
    assert.ok(run.disabled);
  });

  await t.test('中枢账房：一行小字带上花费金额', () => {
    assert.match($('#usageLine').textContent, /今日已耗/);
    assert.match($('#usageLine').textContent, /¥/);
    assert.match($('#usageLine').textContent, /中枢账房/);
  });

  await t.test('行事历：月历可翻页，今天有标记', async () => {
    assert.ok(document.querySelector('.cal-grid'));
    assert.ok(document.querySelector('.cal-cell.today'));
    const before = document.querySelector('.cal-title').textContent;
    document.querySelector('[data-cal="prev"]').click();
    await flush(50);
    assert.notEqual(document.querySelector('.cal-title').textContent, before);
    document.querySelector('[data-cal="today"]').click();
    await flush(50);
    assert.equal(document.querySelector('.cal-title').textContent, before);
  });

  await t.test('朕的私事弹层：称呼 / 身份 / 头像 / 保留 / 复制', async () => {
    $('#openSettings').click();
    await flush(60);
    const sheet = $('#sheetMask');
    assert.ok(sheet);
    for (const needle of ['我的称呼', '身份', '头像', '历史保留', '复制全部数据']) {
      assert.ok(sheet.textContent.includes(needle), `缺少「${needle}」`);
    }
  });

  await t.test('复制全部数据：一天一行纯文字', async () => {
    $('.sheet #copyData').click();
    await flush(120);
    const sheet = $('#sheetMask');
    const text = sheet.querySelector('pre')?.textContent ?? '';
    assert.match(text, /^\d{4}年\d{1,2}月\d{1,2}日：.*背三十个单词.*跑步半小时.*。$/m, `导出格式不对：${text}`);
    sheet.querySelector('#copyClose')?.click();
    await flush(30);
    assert.equal($('#sheetMask'), null);
  });

  await t.test('数据都在本机：差事、内阁、差事底账', async () => {
    const dbmod = await import(pathToFileURL(path.join(WWW, 'db.js')).href);
    const recs = await dbmod.store.allRecords();
    assert.equal(recs.length, 1);
    assert.equal(recs[0].memberId, '妈妈');
    const goals = recs[0].goals;
    assert.equal(goals.length, 2);
    assert.equal(goals[0].progress, 100);
    assert.equal(goals[0].status, 'done');
    assert.equal(goals[1].progress, 0);
    assert.equal(goals[1].note, '跑了二十分钟');

    const saved = await dbmod.store.getMeta('courtState', null);
    assert.ok(saved, '国事应存在本机 IndexedDB');
    assert.equal(saved.annual.items.length, 1);
    assert.equal(saved.annual.items[0].text, '今年攒两万去海边旅游（改稿）');
    assert.equal(saved.annual.items[0].budget, 25000);
    assert.equal(saved.annual.items[0].progress, 40);
    assert.equal(saved.annual.items[0].adjustments, 1, '改措辞与预算记一次调整');

    const hubuItems = saved.tasks.hubu.items;
    assert.equal(hubuItems.length, 1);
    assert.equal(hubuItems[0].progress, 60);
    assert.equal(saved.tasks.libu2.items.length, 1, '礼部收到了出游的差事');
    assert.equal(saved.tasks.libu.items.length, 1, '吏部收到了谁去谁留的差事');
    assert.equal(saved.ledger.entries.length, 3);
    const items = saved.ledger.entries.map((e) => e.item).sort();
    assert.deepEqual(items, ['deepseek', '包子', '午饭']);
  });

  dom.window.close();
});
