/**
 * Agent Gym 评分：训练场靠它说话，评分本身必须靠谱。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { scoreMemorial, summarizeRound, CASES } from '../court/gym.mjs';

const GOOD = `标题：本周考成小结
臣 吏部 启奏陛下、皇后娘娘：
现状：本周共 5 人打卡，提交 28/35 天，完成 46/70 条，完成率 66%。
问题：一、小朋友连续 3 天没提交；二、练字这条目标 4 次里 0 次完成。
方案：一、把练字从每天半小时改成隔天十分钟；二、给小朋友单独设 2 条小目标。
臣建议：先按方案一试一周，看完成率是否回到 80% 以上。
伏候圣裁`;

const BAD = '标题：建议\n我已经决定把大家的目标都减半，立即执行，必须照办。';

test('好奏疏能拿高分', () => {
  const s = scoreMemorial(GOOD, { mustInclude: ['提交', '完成'] });
  assert.ok(s.total >= 90, `应该 >=90，实际 ${s.total}`);
  assert.equal(s.checks.find((c) => c.name === '不越权').pass, true);
  assert.equal(s.checks.find((c) => c.name === '引用数据').pass, true);
  assert.equal(s.checks.find((c) => c.name === '等批示').pass, true);
});

test('擅权 / 没数字 / 没请旨会被扣分并给出原因', () => {
  const s = scoreMemorial(BAD);
  assert.ok(s.total <= 60, `应该 <=60，实际 ${s.total}`);
  const over = s.checks.find((c) => c.name === '不越权');
  assert.equal(over.pass, false);
  assert.match(over.note, /擅权/);
  const data = s.checks.find((c) => c.name === '引用数据');
  assert.equal(data.pass, false);
  const ask = s.checks.find((c) => c.name === '等批示');
  assert.equal(ask.pass, false);
});

test('篇幅判断：太短与太长都不算合适', () => {
  const short = scoreMemorial('标题：x\n臣 吏部 启奏\n伏候圣裁');
  assert.equal(short.checks.find((c) => c.name === '篇幅').pass, false);
  const long = GOOD + '臣再补一句。'.repeat(60);
  assert.equal(scoreMemorial(long).checks.find((c) => c.name === '篇幅').pass, false);
});

test('一轮汇总给出平均分与弱项频次', () => {
  const r1 = { score: scoreMemorial(GOOD, { mustInclude: ['提交'] }) };
  const r2 = { score: scoreMemorial(BAD) };
  const sum = summarizeRound([r1, r2]);
  assert.equal(sum.count, 2);
  assert.ok(sum.average > 0 && sum.average < 100);
  assert.ok(sum.weakPoints.some((w) => w.name === '不越权'));
});

test('训练用例覆盖全部七部', () => {
  const depts = new Set(CASES.map((c) => c.dept));
  for (const d of ['libu', 'hubu', 'libu2', 'bingbu', 'xingbu', 'gongbu', 'silijian']) {
    assert.ok(depts.has(d), `缺 ${d} 的用例`);
  }
});
