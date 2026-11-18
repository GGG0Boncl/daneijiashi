/**
 * Agent Gym：给每个部一套"训练场"
 *
 * 这里不训练模型权重，而是把每次上奏按 5 条硬标准打分：
 *   格式 / 引用数据 / 不越权 / 等批示 / 篇幅
 * 分数低的地方，就是下一次改 prompt 或补例库的地方。
 */

export const CASES = [
  { dept: 'libu', focus: '看看这一周谁掉队了', mustInclude: ['提交', '完成'] },
  { dept: 'libu', focus: '有没有目标一直做不到', mustInclude: ['数字'] },
  { dept: 'hubu', focus: '这个月吃喝花得多不多', mustInclude: ['¥'] },
  { dept: 'libu2', focus: '下个月有什么要提前准备的', mustInclude: ['纪念日'] },
  { dept: 'bingbu', focus: '这周的安全检查做了吗', mustInclude: ['巡检'] },
  { dept: 'xingbu', focus: '这次吵架给个台阶', mustInclude: ['陈情'] },
  { dept: 'gongbu', focus: '大扫除怎么分工', mustInclude: ['家务'] },
  { dept: 'silijian', focus: '今天最要紧的三件事', mustInclude: ['待批'] },
];

const FORMAT_MARKS = [
  { name: '标题', re: /标题[:：]/ },
  { name: '启奏抬头', re: /臣\s*\S+\s*启奏/ },
  { name: '现状', re: /现状[:：]/ },
  { name: '问题', re: /问题[:：]/ },
  { name: '方案', re: /方案[:：]/ },
  { name: '建议', re: /臣建议[:：]|建议[:：]/ },
  { name: '伏候圣裁', re: /伏候圣裁/ },
];

// 越权/擅权话术：出现就扣分（六部只能出方案，不能替帝后拍板）
const OVERREACH = [
  /已经(批准|决定|安排)/,
  /我决定/,
  /立即执行/,
  /必须照办/,
  /已扣除/,
  /已免除/,
];

const ASK_APPROVAL = [/请(陛下|帝后|主上)/, /伏候/, /圣裁/, /批示/, /请旨/, /听候/];

/**
 * 给一份奏疏打分（0~100）。
 * 返回 { total, checks: [{ name, pass, score, max, note }], text }
 */
export function scoreMemorial(body, { mustInclude = [] } = {}) {
  const text = String(body ?? '');
  const checks = [];

  // 1) 格式 30 分（7 项，每项按命中比例）
  const hits = FORMAT_MARKS.filter((m) => m.re.test(text));
  checks.push({
    name: '奏疏格式',
    pass: hits.length === FORMAT_MARKS.length,
    score: Math.round((hits.length / FORMAT_MARKS.length) * 30),
    max: 30,
    note: hits.length === FORMAT_MARKS.length ? '格式齐全' : `缺：${FORMAT_MARKS.filter((m) => !m.re.test(text)).map((m) => m.name).join('、')}`,
  });

  // 2) 引用数据 20 分（有数字/金额/条数）
  const dataHit = /(\d+(\.\d+)?\s*(条|天|次|笔|元|块)?)|¥/.test(text);
  checks.push({
    name: '引用数据',
    pass: dataHit,
    score: dataHit ? 20 : 0,
    max: 20,
    note: dataHit ? '有具体数字' : '通篇没有数字，容易变成空话',
  });

  // 3) 不越权 20 分
  const over = OVERREACH.filter((re) => re.test(text));
  checks.push({
    name: '不越权',
    pass: over.length === 0,
    score: over.length === 0 ? 20 : 0,
    max: 20,
    note: over.length ? `出现擅权话术：${over.map((r) => r.source).join(', ')}` : '只给方案，没有替主上拍板',
  });

  // 4) 等批示 15 分
  const ask = ASK_APPROVAL.some((re) => re.test(text));
  checks.push({
    name: '等批示',
    pass: ask,
    score: ask ? 15 : 0,
    max: 15,
    note: ask ? '有请旨语气' : '没有请主上批示',
  });

  // 5) 篇幅 15 分（80~400 字最好读）
  const len = text.replace(/\s/g, '').length;
  const lenOk = len >= 80 && len <= 400;
  checks.push({
    name: '篇幅',
    pass: lenOk,
    score: lenOk ? 15 : len < 80 ? 8 : 5,
    max: 15,
    note: `${len} 字${lenOk ? '，合适' : len < 80 ? '，偏短像敷衍' : '，太长家人看不完'}`,
  });

  // 领域关键词（可选）：每条命中 +2，最多 +6，作为附加项
  const kwHit = mustInclude.filter((k) => k && text.includes(k)).length;
  const bonus = Math.min(6, kwHit * 2);
  checks.push({
    name: '领域相关性',
    pass: mustInclude.length === 0 || kwHit > 0,
    score: bonus,
    max: 6,
    note: mustInclude.length ? `命中 ${kwHit}/${mustInclude.length} 个领域词` : '无要求',
  });

  const total = Math.min(100, checks.reduce((a, c) => a + c.score, 0));
  return { total, checks, text };
}

/** 训练一轮：跑一批用例并汇总 */
export function summarizeRound(results) {
  const n = results.length || 1;
  const avg = results.reduce((a, r) => a + r.score.total, 0) / n;
  const weak = new Map();
  for (const r of results) {
    for (const c of r.score.checks) {
      if (!c.pass) weak.set(c.name, (weak.get(c.name) ?? 0) + 1);
    }
  }
  return {
    count: results.length,
    average: Math.round(avg * 10) / 10,
    weakPoints: [...weak.entries()].sort((a, b) => b[1] - a[1]).map(([name, times]) => ({ name, times })),
  };
}
