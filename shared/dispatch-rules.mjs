/**
 * 司礼监传旨：把主上的一段话拆成三类差事
 *
 *   annual 内阁大事（本年度计划，可带金额预算）
 *   goal   今日差事（今天/今晚/每天要做的）
 *   task   六部差事（交给某部去办的）
 *
 * 两端共用：
 *   - 中枢 court/dispatch.mjs 先请模型拆；模型不可用或拆不出时，退回这里的关键词规矩
 *   - App 断网时直接按这里的规矩拆
 *
 * 司礼监是"拆旨的人"，不给自己派差事。
 */

export const DISPATCH_DEPTS = ['libu', 'hubu', 'libu2', 'bingbu', 'xingbu', 'gongbu'];

export const DEPT_NAMES = {
  libu: '吏部',
  hubu: '户部',
  libu2: '礼部',
  bingbu: '兵部',
  xingbu: '刑部',
  gongbu: '工部',
  silijian: '司礼监',
};

export const DISPATCH_PERIODS = ['year', 'half'];

export const clipTask = (text, max = 80) => {
  const t = String(text ?? '').trim().replace(/\s+/g, ' ');
  return t.length <= max ? t : `${t.slice(0, max - 1)}…`;
};

const TODAY_RE = /今天|今日|今晚|明早|明天|每天|每日|本周内/;
const ANNUAL_RE = /今年|本年|年度|全年|预算|攒|年终/;

/* ------------------------------ 银钱估算 ------------------------------ */

const CN_DIGIT = { 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 };

function cnNumber(s) {
  if (/^\d+(?:\.\d+)?$/.test(s)) return Number(s);
  if (s === '十') return 10;
  if (/^十[一二三四五六七八九]$/.test(s)) return 10 + CN_DIGIT[s[1]];
  if (/^[一二两三四五六七八九]十$/.test(s)) return CN_DIGIT[s[0]] * 10;
  if (/^[一二两三四五六七八九]十[一二三四五六七八九]$/.test(s)) return CN_DIGIT[s[0]] * 10 + CN_DIGIT[s[2]];
  if (s.length === 1 && CN_DIGIT[s]) return CN_DIGIT[s];
  return null;
}

/** 从话里抠预算金额（元）：认「两万」「2万」「预算 5000」「花 300 元」 */
export function findBudget(text) {
  const t = String(text ?? '');
  const re = /(\d+(?:\.\d+)?|[一二两三四五六七八九十]+)\s*(万|千|w|k)?\s*(元|块|块钱|rmb|¥)?/gi;
  let m;
  while ((m = re.exec(t)) !== null) {
    const num = cnNumber(m[1]);
    if (!Number.isFinite(num) || num <= 0) continue;
    const unit = String(m[2] ?? '').toLowerCase();
    const currency = String(m[3] ?? '');
    const before = t.slice(Math.max(0, m.index - 8), m.index);
    const moneyContext = /预算|攒|花|准备|控制在|不超过|最多|大约|大概|合计|一共/.test(before);
    if (!unit && !currency && !moneyContext) continue;
    let value = num;
    if (unit === '万' || unit === 'w') value *= 10000;
    else if (unit === '千' || unit === 'k') value *= 1000;
    if (value > 1e8) continue;
    return Math.round(value * 100) / 100;
  }
  return null;
}

/* ------------------------------ 关键词规矩 ------------------------------ */

const RULES = [
  {
    dept: 'libu2',
    words: ['生日', '聚会', '请客', '礼物', '节日', '纪念', '庆祝', '活动', '出游', '旅行', '出去玩', '玩', '吃', '喝', '聚餐', '火锅', '烧烤', '野餐', '电影', '公园', '门票', '周六', '周日', '周末'],
    make: (t) => `筹办行程与吃喝安排：${t}`,
  },
  {
    dept: 'bingbu',
    words: ['几点', '点去', '点走', '点出发', '出发', '接送', '接孩子', '送孩子', '路线', '开车', '打车', '地铁', '公交', '高铁', '机票', '车票', '停车', '出门', '出行', '导航', '走高速'],
    make: (t) => `把出行时间、路线与接送定好：${t}`,
  },
  {
    dept: 'hubu',
    words: ['预算', '花费', '花多少', '多少钱', '人均', '买单', '记账', '账', '票', '贵', '省钱', '吃'],
    make: (t) => `核算这次的花费并记账：${t}`,
  },
  {
    dept: 'gongbu',
    words: ['收拾', '打扫', '整理', '准备', '带', '搬', '修', '装备', '物品', '采购', '家务', '洗', '晾', '垃圾'],
    make: (t) => `备办物件、收拾妥当：${t}`,
  },
  {
    dept: 'libu',
    words: ['谁去', '谁不', '分工', '协调', '陪同', '集合', '几点到', '轮班', '值班', '打卡', '作息', '安排人'],
    make: (t) => `排好谁去谁留与分工：${t}`,
  },
  {
    dept: 'xingbu',
    words: ['吵', '争', '矛盾', '家规', '惩罚', '评理', '道歉', '不听话', '罚', '公平'],
    make: (t) => `按家规定个公允说法：${t}`,
  },
];

const splitClauses = (text) => String(text ?? '')
  .split(/[，。；;、！!？?\n]+/)
  .map((s) => s.trim())
  .filter(Boolean);

/**
 * 按关键词拆旨（确定性、免费、断网可用）。
 * 一段话里可能同时有内阁大事、今日差事、六部差事，各归各堆。
 */
export function routeByRules(text) {
  const t = String(text ?? '').trim();
  if (!t) return { items: [], matched: [] };
  const hasToday = TODAY_RE.test(t);
  const hasAnnual = ANNUAL_RE.test(t);
  const clauses = splitClauses(t);

  const annualClauses = [];
  const goals = [];
  const tasks = [];
  const seenDept = new Set();

  for (const clause of clauses) {
    if (ANNUAL_RE.test(clause)) {
      annualClauses.push(clause);
      continue;
    }
    if (TODAY_RE.test(clause)) {
      const body = clause.replace(/^(今天|今日|今晚|明早|明天|每天|每日)[，,]?\s*/, '').trim();
      if (body) goals.push(body);
      continue;
    }
    const hits = RULES.filter((r) => r.words.some((w) => clause.includes(w)));
    if (hits.length) {
      for (const rule of hits) {
        if (seenDept.has(rule.dept)) continue;
        seenDept.add(rule.dept);
        tasks.push({ kind: 'task', dept: rule.dept, text: clipTask(rule.make(clause)) });
      }
    } else if (hasToday) {
      goals.push(clause);
    }
  }

  const items = [];
  if (hasAnnual) {
    const annualText = annualClauses.length ? annualClauses.join('；') : t;
    items.push({ kind: 'annual', text: clipTask(annualText), budget: findBudget(t), period: 'year' });
  }

  const seenGoal = new Set();
  for (const g of goals) {
    const text = clipTask(g);
    if (!text || seenGoal.has(text)) continue;
    seenGoal.add(text);
    items.push({ kind: 'goal', text });
    if (seenGoal.size >= 5) break;
  }

  items.push(...tasks);

  if (!items.length) {
    if (hasToday) items.push({ kind: 'goal', text: clipTask(t) });
    else if (hasAnnual) items.push({ kind: 'annual', text: clipTask(t), budget: findBudget(t), period: 'year' });
    else items.push({ kind: 'task', dept: 'libu2', text: clipTask(`先行统筹此事：${t}`) });
  }

  return {
    items: items.slice(0, 10),
    matched: items.filter((i) => i.kind !== 'annual' && i.kind !== 'goal').map((i) => i.dept),
  };
}

/** 把模型吐出来的东西收成统一形状；兼容旧式 {dept, task} */
export function sanitizeDispatchItems(raw, { fallbackText = '' } = {}) {
  const list = Array.isArray(raw) ? raw : Array.isArray(raw?.items) ? raw.items : [];
  const out = [];
  const seenTaskDept = new Set();
  const seenGoal = new Set();
  let annualCount = 0;

  for (const item of list) {
    const kind = String(item?.kind ?? '').trim() || (item?.dept ? 'task' : 'goal');
    let text = clipTask(item?.text ?? item?.task ?? '');
    if (!text) continue;
    if (kind === 'goal') text = clipTask(text.replace(/^(今天|今日|今晚|明早|明天|每天|每日)[，,、]?\s*/, ''));
    if (!text) continue;
    if (kind === 'annual') {
      if (annualCount >= 2) continue;
      const budgetRaw = item?.budget ?? null;
      const budget = budgetRaw === null || budgetRaw === '' ? null : Number(budgetRaw);
      out.push({
        kind: 'annual',
        text,
        budget: Number.isFinite(budget) && budget >= 0 ? Math.round(budget * 100) / 100 : null,
        period: DISPATCH_PERIODS.includes(String(item?.period)) ? item.period : 'year',
      });
      annualCount += 1;
      continue;
    }
    if (kind === 'goal') {
      if (seenGoal.has(text)) continue;
      seenGoal.add(text);
      out.push({ kind: 'goal', text });
      continue;
    }
    const dept = String(item?.dept ?? '').trim();
    if (!DISPATCH_DEPTS.includes(dept) || seenTaskDept.has(dept)) continue;
    seenTaskDept.add(dept);
    out.push({ kind: 'task', dept, text });
  }

  if (!out.length && String(fallbackText ?? '').trim()) return routeByRules(fallbackText).items;
  return out.slice(0, 10);
}
