/**
 * 司礼监传旨：一段话拆成 内阁大事（带预算）/ 今日差事 / 六部差事
 *
 * 用户要求：今日差事与内阁计划都由司礼监传旨生成；断网时按关键词规矩拆。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  DEPT_NAMES, DISPATCH_DEPTS, routeByRules, sanitizeDispatchItems, clipTask, findBudget,
  findDue, normalizeDue,
} from '../shared/dispatch-rules.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');

const tasksOf = (items) => items.filter((i) => i.kind === 'task');

test('「周六去哪玩、吃什么、几点去」能拆到礼、兵、户、吏', () => {
  const said = '我周六想去哪里玩，吃什么东西，几点去';
  const { items } = routeByRules(said);
  const depts = tasksOf(items).map((i) => i.dept);
  for (const dept of ['libu2', 'bingbu', 'hubu']) {
    assert.ok(depts.includes(dept), `该派 ${DEPT_NAMES[dept]}：${depts.join('/')}`);
  }
  assert.ok(items.every((i) => i.kind === 'task'));
  assert.ok(items.every((i) => i.text.length <= 80));
  assert.ok(tasksOf(items).length <= 5, '一次最多派五道，别把家事全压一天');
});

test('说清了谁去谁留，吏部也要有差事', () => {
  const { items } = routeByRules('周六上午十点去湿地公园玩，中午吃火锅，谁去谁留也定一下');
  const depts = tasksOf(items).map((i) => i.dept);
  assert.ok(depts.includes('libu'), '谁去谁留归吏部分工');
  assert.ok(depts.includes('bingbu'), '十点去是出行时间，归兵部');
  assert.ok(depts.includes('libu2'), '去哪儿玩、吃什么归礼部');
  assert.ok(depts.includes('hubu'), '吃火锅的花费归户部');
  assert.equal(new Set(depts).size, depts.length, '同一部只出一条');
});

test('三类混着说：内阁带预算、今日差事、六部差事各归各堆', () => {
  const said = '今年攒两万去海边旅游，今天背三十个单词、跑步半小时，周六去公园玩';
  const { items } = routeByRules(said);
  const annual = items.filter((i) => i.kind === 'annual');
  const goals = items.filter((i) => i.kind === 'goal');
  const tasks = tasksOf(items);
  assert.equal(annual.length, 1, '今年的事归内阁');
  assert.match(annual[0].text, /海边旅游/);
  assert.equal(annual[0].budget, 20000, '「两万」要认成 20000');
  assert.equal(annual[0].period, 'year');
  assert.equal(goals.length, 2, '今天背单词、跑步各一条');
  assert.deepEqual(goals.map((g) => g.text).sort(), ['背三十个单词', '跑步半小时'].sort());
  assert.ok(tasks.some((t) => t.dept === 'libu2'), '周六去公园归礼部');
  assert.ok(items.every((i) => i.kind === 'task' ? DISPATCH_DEPTS.includes(i.dept) : true));
});

test('「两万」「5000 元」「预算 3 千」都认得', () => {
  assert.equal(findBudget('今年攒两万去旅游'), 20000);
  assert.equal(findBudget('今年预算 5000 元买台电脑'), 5000);
  assert.equal(findBudget('今年攒三万'), 30000);
  assert.equal(findBudget('预算 3 千'), 3000);
  assert.equal(findBudget('周六去公园玩'), null, '没提钱就不瞎猜');
  assert.equal(findBudget('2026 年去旅游'), null, '年份不算预算');
});

test('一句没头绪的话也要有个落脚处（礼部先统筹）', () => {
  const { items } = routeByRules('天气不错');
  assert.equal(items.length, 1);
  assert.equal(items[0].kind, 'task');
  assert.equal(items[0].dept, 'libu2');
  assert.match(items[0].text, /天气不错/);
  // 说了「今天」，就记成今日差事
  const today = routeByRules('今天天气不错');
  assert.equal(today.items.length, 1);
  assert.equal(today.items[0].kind, 'goal');
  assert.equal(today.items[0].text, '天气不错');
  assert.deepEqual(routeByRules('   '), { items: [], matched: [] });
});

test('模型吐出的 JSON 要过筛：三类都收、只收六部、去重、限量、限长', () => {
  const dirty = {
    items: [
      { kind: 'annual', text: '今年攒钱去旅游', budget: '20000', period: 'year' },
      { kind: 'annual', text: '今年换个大冰箱', budget: 8000 },
      { kind: 'annual', text: '第三条年度计划' },
      { kind: 'goal', text: '  背三十个单词  ' },
      { kind: 'goal', text: '背三十个单词' },
      { kind: 'goal', text: 'x'.repeat(200) },
      { kind: 'task', dept: 'silijian', task: '司礼监不该给自己派活' },
      { kind: 'task', dept: 'unknown', task: '不存在的部' },
      { kind: 'task', dept: 'hubu', task: '  算算这次火锅多少钱  ' },
      { kind: 'task', dept: 'hubu', task: '重复的户部' },
      { dept: 'bingbu', task: '旧式形状也要收' },
      { kind: 'task', dept: 'gongbu', task: '带上野餐垫' },
    ],
  };
  const items = sanitizeDispatchItems(dirty);
  assert.ok(items.length <= 10);
  assert.equal(items.filter((i) => i.kind === 'annual').length, 2, '年度计划最多两条');
  assert.equal(items.filter((i) => i.kind === 'goal').length, 2, '重复今日差事只留一条');
  assert.equal(items[0].budget, 20000);
  assert.ok(tasksOf(items).every((i) => DISPATCH_DEPTS.includes(i.dept)));
  assert.equal(tasksOf(items).filter((i) => i.dept === 'hubu').length, 1);
  assert.equal(tasksOf(items)[0].text, '算算这次火锅多少钱');
  assert.ok(tasksOf(items).some((i) => i.dept === 'bingbu' && i.text === '旧式形状也要收'));
  assert.equal(sanitizeDispatchItems(null, { fallbackText: '周六去吃火锅' }).length > 0, true, '模型没吐出东西时按规矩兜底');
  assert.equal(clipTask('  a   b  '), 'a b');
});

test('传旨带钟点：今天/明早/周六都能算出北京时间，已过点不硬排', () => {
  const now = new Date('2026-11-19T09:00:00+08:00'); // 周四上午九点
  assert.equal(findDue('今天下午三点开会', now), '2026-11-19T15:00+08:00');
  assert.equal(findDue('今晚六点吃饭', now), '2026-11-19T18:00+08:00');
  assert.equal(findDue('明早八点出发', now), '2026-11-20T08:00+08:00');
  assert.equal(findDue('周六上午十点去公园', now), '2026-11-21T10:00+08:00');
  assert.equal(findDue('今天上午八点已经过了', now), null, '明说今天又已过点，不排旧提醒');
  assert.equal(findDue('周六去公园', now), null, '只说日期没说钟点，不硬塞闹钟');
  assert.equal(findDue('下午三点', now), '2026-11-19T15:00+08:00', '只说钟点、还没到，算今天');

  // 模型给的 due 也过筛：未来 60 天内才收
  assert.equal(normalizeDue('2026-11-19T15:00+08:00', now), '2026-11-19T15:00+08:00');
  assert.equal(normalizeDue('2026-11-19 15:00', now), '2026-11-19T15:00+08:00', '没带时区按北京时间');
  assert.equal(normalizeDue('2026-11-19T08:00+08:00', now), null, '过去的 due 不收');
  assert.equal(normalizeDue('2027-03-01T08:00+08:00', now), null, '太远的 due 不收');

  const items = sanitizeDispatchItems({
    items: [
      { kind: 'goal', text: '下午三点接孩子', due: '2026-11-19T15:00+08:00' },
      { kind: 'task', dept: 'bingbu', task: '五点前去学校', due: '2026-11-19T17:00+08:00' },
      { kind: 'annual', text: '今年攒两万', budget: 20000, due: '2026-11-20T10:00+08:00' },
    ],
  }, { now });
  assert.equal(items.find((i) => i.kind === 'goal').due, '2026-11-19T15:00+08:00');
  assert.equal(items.find((i) => i.kind === 'task').due, '2026-11-19T17:00+08:00');
  assert.equal(items.find((i) => i.kind === 'annual').due, undefined, 'annual 不带 due');

  const routed = routeByRules('今天下午四点去接孩子，兵部定路线', now);
  assert.equal(routed.items.find((i) => i.kind === 'goal').due, '2026-11-19T16:00+08:00');
  assert.equal(routed.items.find((i) => i.kind === 'task').due, null, '另一句没说钟点，不硬塞');
});

test('每部只留一句简短职责，App 离线也用得上', async () => {
  const depts = await import(pathToFileURL(path.join(ROOT, 'app', 'www', 'depts.js')).href);
  const six = depts.COURT_DEPTS.filter((d) => d.id !== 'silijian');
  assert.equal(six.length, 6);
  const briefs = six.map((d) => d.brief);
  assert.ok(briefs.every((b) => b && b.length >= 3 && b.length <= 8), '每部一句短职责（3~8 字）');
  assert.equal(new Set(briefs).size, 6, '职责不能六部共用一句');
  assert.match(six.find((d) => d.id === 'hubu').brief, /钱粮|账/);
  assert.match(six.find((d) => d.id === 'bingbu').brief, /出行|安全/);
  // 举例已经撤掉，别再回到 UI
  assert.equal(six.find((d) => d.id === 'hubu').example, undefined);
});

test('App 副本与共享规则一致（改了一边别忘了另一边）', () => {
  for (const [srcFile, copyFile] of [
    [path.join(ROOT, 'shared', 'dispatch-rules.mjs'), path.join(ROOT, 'app', 'www', 'dispatch-rules.js')],
    [path.join(ROOT, 'shared', 'court-state.mjs'), path.join(ROOT, 'app', 'www', 'court-state.js')],
  ]) {
    const src = fs.readFileSync(srcFile, 'utf8');
    const copy = fs.readFileSync(copyFile, 'utf8');
    assert.ok(copy.startsWith('// 由 tools/sync-assets.mjs'), '副本要带"别直接改"的提示');
    assert.equal(copy.slice(copy.indexOf('export')), src.slice(src.indexOf('export')), `${path.basename(copyFile)} 与源不一致，跑 node tools/sync-assets.mjs`);
  }
});
