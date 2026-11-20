// 由 tools/sync-assets.mjs 从 shared/dispatch-rules.mjs 复制，别直接改这里
/**
 * 司礼监传旨：把主上的一段话拆成三类差事
 *
 *   annual 内阁大事（本年度计划，可带金额预算）
 *   goal   今日差事（今天/今晚/每天要做的）
 *   task   六部差事（交给某部去办的）
 *   ledger 户部账目（已经花掉/买下/付过的钱）
 *
 * 两端共用：
 *   - 中枢 court/dispatch.mjs 先请模型拆；模型不可用或拆不出时，退回这里的关键词规矩
 *   - App 断网时直接按这里的规矩拆
 *
 * 司礼监是"拆旨的人"，不给自己派差事。
 */
import { parseLedgerText } from './ledger.js';

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

const NAMED_DEPTS = [
  ['吏部', 'libu'], ['户部', 'hubu'], ['礼部', 'libu2'],
  ['兵部', 'bingbu'], ['刑部', 'xingbu'], ['工部', 'gongbu'],
];
const namedDept = (clause) => NAMED_DEPTS.find(([name]) => clause.includes(name))?.[1] ?? null;
const DEPT_PREFIX_RE = /^(?:让|叫|请|命|着|烦请|安排)?\s*(?:吏部|户部|礼部|兵部|刑部|工部)\s*[，,：:]?\s*/;

/* ------------------------------ 时刻 ------------------------------ */

const pad2 = (n) => String(n).padStart(2, '0');

/** 北京时间的年/月/日/时/分 */
function bjParts(now) {
  const s = new Intl.DateTimeFormat('sv-SE', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(now);
  const [date, time] = s.split(' ');
  const [y, mo, d] = date.split('-').map(Number);
  const [h, mi] = time.split(':').map(Number);
  return { y, mo, d, h, mi, date };
}

/** 北京时间的 ISO 字符串：2026-11-19T15:00+08:00 */
export function bjIso(y, mo, d, h, mi = 0) {
  return `${y}-${pad2(mo)}-${pad2(d)}T${pad2(h)}:${pad2(mi)}+08:00`;
}

/** 北京时间的日期串：2026-11-19 */
function bjDate(now = new Date()) {
  const p = bjParts(now);
  return `${p.y}-${pad2(p.mo)}-${pad2(p.d)}`;
}

/** 北京时间「今天」加减几天，返回日期串 */
function bjShiftDate(days, now = new Date()) {
  const p = bjParts(now);
  return bjDate(new Date(Date.UTC(p.y, p.mo - 1, p.d) + days * 86400000));
}

/**
 * 账目日期：认「今天/昨天/前天」「11月18日」「2026-11-18」。
 * 账是已经花掉的钱，不收未来日期；没写日期返回 null（由 App 记今天）。
 */
export function normalizeLedgerDate(value, now = new Date()) {
  const s = String(value ?? '').trim();
  if (!s || /今天|今日|当天/.test(s)) return s ? bjDate(now) : null;
  if (/昨天|昨日/.test(s)) return bjShiftDate(-1, now);
  if (/前天/.test(s)) return bjShiftDate(-2, now);
  const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (iso) {
    const out = `${iso[1]}-${iso[2]}-${iso[3]}`;
    const today = bjDate(now);
    const oldest = bjShiftDate(-365, now);
    return out <= today && out >= oldest ? out : null;
  }
  const md = /(\d{1,2})\s*月\s*(\d{1,2})\s*[日号]?/.exec(s);
  if (md) {
    const mo = Number(md[1]);
    const d = Number(md[2]);
    if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
    const p = bjParts(now);
    let y = p.y;
    let out = `${y}-${pad2(mo)}-${pad2(d)}`;
    if (out > bjDate(now)) {
      y -= 1;
      out = `${y}-${pad2(mo)}-${pad2(d)}`;
    }
    const oldest = bjShiftDate(-365, now);
    return out >= oldest ? out : null;
  }
  return null;
}

function parseCnInt(s) {
  const n = cnNumber(String(s ?? '').trim());
  return Number.isFinite(n) ? Math.trunc(n) : null;
}

/** 从一句话里认时刻：下午三点半、15:30、八点……认不出返回 null */
function findTime(text) {
  const t = String(text ?? '');
  const colon = /(\d{1,2})\s*[:：]\s*(\d{1,2})/.exec(t);
  if (colon) {
    const h = Number(colon[1]);
    const mi = Number(colon[2]);
    if (h >= 0 && h <= 23 && mi >= 0 && mi <= 59) return { h, mi };
  }
  const m = /(凌晨|早上|早晨|上午|中午|下午|傍晚|晚上|今晚|明晚|夜里|夜间)?\s*(\d{1,2}|[一二两三四五六七八九十]{1,3})\s*(?:点|時|时)\s*(半|\d{1,2}|[一二两三四五六七八九十]{1,3})?\s*分?/.exec(t);
  if (!m) return null;
  let h = parseCnInt(m[2]);
  if (h === null || h < 0 || h > 23) return null;
  let mi = 0;
  if (m[3] === '半') mi = 30;
  else if (m[3]) {
    const parsed = parseCnInt(m[3]);
    if (parsed === null || parsed < 0 || parsed > 59) return null;
    mi = parsed;
  }
  const period = m[1] ?? '';
  if ((period === '下午' || period === '傍晚' || period === '晚上' || period === '今晚' || period === '明晚' || period === '夜里' || period === '夜间') && h < 12) h += 12;
  if (period === '中午' && h < 11) h += 12;
  if (period === '凌晨' && h === 12) h = 0;
  return { h, mi };
}

/** 北京时间的“今天”零点，用 UTC 表示，方便加减天数 */
function bjMidnightMs(y, mo, d) {
  return Date.UTC(y, mo - 1, d) - 8 * 3600 * 1000;
}

/**
 * 从口谕里找“什么时候办”。
 * 只认带钟点的（“周六”不算），免得把没定时间的差事硬塞个闹钟。
 * 返回 +08:00 的 ISO；认不出、或给的是已经过去的“今天几点”，返回 null。
 */
export function findDue(text, now = new Date()) {
  const t = String(text ?? '');
  const time = findTime(t);
  if (!time) return null;
  const base = bjParts(now);
  const todayMs = bjMidnightMs(base.y, base.mo, base.d);
  let dayMs = todayMs;
  let explicitToday = false;

  const explicit = /(\d{1,2})\s*月\s*(\d{1,2})\s*[日号]/.exec(t);
  if (explicit) {
    const mo = Number(explicit[1]);
    const d = Number(explicit[2]);
    if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
    let y = base.y;
    if (mo < base.mo || (mo === base.mo && d < base.d)) y += 1;
    dayMs = bjMidnightMs(y, mo, d);
  } else if (/大后天/.test(t)) {
    dayMs = todayMs + 3 * 86400000;
  } else if (/后天/.test(t)) {
    dayMs = todayMs + 2 * 86400000;
  } else if (/明天|明日|明早|明晚/.test(t)) {
    dayMs = todayMs + 86400000;
  } else if (/今天|今日|今晚|今夜/.test(t)) {
    explicitToday = true;
  } else {
    const wd = /(下周|下星期|下礼拜|周|星期|礼拜)\s*([一二三四五六日天])/.exec(t);
    if (wd) {
      const map = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 日: 0, 天: 0 };
      const target = map[wd[2]];
      const cur = new Date(Date.UTC(base.y, base.mo - 1, base.d)).getUTCDay();
      const curMon = (cur + 6) % 7;
      const targetMon = (target + 6) % 7;
      let delta = (targetMon - curMon + 7) % 7;
      if (wd[1].startsWith('下') && delta === 0) delta = 7;
      dayMs = todayMs + delta * 86400000;
    }
  }

  const atMs = dayMs + (time.h * 3600 + time.mi * 60) * 1000;
  if (explicitToday) {
    // 主上明说“今天三点”，已经过点了就不排（免得一确认就弹旧提醒）
    return atMs > now.getTime() ? bjIso(base.y, base.mo, base.d, time.h, time.mi) : null;
  }
  // 只说“三点”没说哪天：过点了就顺到明天
  if (atMs <= now.getTime()) {
    const p = bjParts(new Date(dayMs + 86400000));
    return bjIso(p.y, p.mo, p.d, time.h, time.mi);
  }
  const p = bjParts(new Date(atMs));
  return bjIso(p.y, p.mo, p.d, time.h, time.mi);
}

/** 校验并规范化模型给的 due；必须是未来 60 天内 */
export function normalizeDue(value, now = new Date()) {
  if (!value) return null;
  const raw = String(value).trim();
  let ms = Date.parse(raw);
  // 模型常给“2026-11-19 15:00”这种没带时区的，按北京时间算
  if (Number.isFinite(ms) && !/[zZ]|[+-]\d{2}:?\d{2}$/.test(raw)) {
    ms = Date.parse(`${raw.replace(' ', 'T')}+08:00`);
  }
  if (!Number.isFinite(ms)) return null;
  if (ms <= now.getTime() || ms > now.getTime() + 60 * 86400000) return null;
  const p = bjParts(new Date(ms));
  return bjIso(p.y, p.mo, p.d, p.h, p.mi);
}


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

/* ------------------------------ 账目识别 ------------------------------ */

const MONEY_RE = /\d+(?:\.\d{1,2})?\s*(?:元|块|块钱|rmb|¥|￥)/i;

/** 一句话像不像“已经花掉的钱”。只认带钱单位的，免得把「买30个单词」当账。 */
function looksLikeLedger(text) {
  const t = String(text ?? '');
  if (!MONEY_RE.test(t)) return false;
  if (/预算|攒|目标|年度|本年|计划|打算|准备买|要买|想买/.test(t)) return false;
  return true;
}

function ledgerItemsFromClause(clause, now) {
  if (!looksLikeLedger(clause)) return [];
  const parsed = parseLedgerText(clause);
  if (!parsed.ok) return [];
  const date = normalizeLedgerDate(clause, now);
  return parsed.entries.map((e) => ({
    kind: 'ledger',
    item: e.item,
    amount: e.amount,
    date,
  }));
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
export function routeByRules(text, now = new Date()) {
  const t = String(text ?? '').trim();
  if (!t) return { items: [], matched: [] };
  const hasToday = TODAY_RE.test(t);
  const hasAnnual = ANNUAL_RE.test(t);
  const clauses = splitClauses(t);

  const annualClauses = [];
  const goals = [];
  const tasks = [];
  const ledger = [];
  const seenDept = new Set();

  for (const clause of clauses) {
    // 带钱单位的先认账，别让「午饭18元」被当成今日差事
    const ledgerItems = ledgerItemsFromClause(clause, now);
    if (ledgerItems.length) {
      ledger.push(...ledgerItems);
      continue;
    }
    if (ANNUAL_RE.test(clause)) {
      annualClauses.push(clause);
      continue;
    }
    // 点名哪部就落哪部：即便带「明天」也还是该部的差事
    const dept = namedDept(clause);
    if (dept) {
      const body = clause.replace(DEPT_PREFIX_RE, '').trim() || clause;
      tasks.push({ kind: 'task', dept, text: clipTask(body), due: findDue(clause, now) });
      continue;
    }
    if (TODAY_RE.test(clause)) {
      const body = clause.replace(/^(今天|今日|今晚|明早|明天|每天|每日)[，,]?\s*/, '').trim();
      if (body) goals.push({ text: body, due: findDue(clause, now) });
      continue;
    }
    const hits = RULES.filter((r) => r.words.some((w) => clause.includes(w)));
    if (hits.length) {
      for (const rule of hits) {
        if (seenDept.has(rule.dept)) continue;
        seenDept.add(rule.dept);
        tasks.push({ kind: 'task', dept: rule.dept, text: clipTask(rule.make(clause)), due: findDue(clause, now) });
      }
    } else if (hasToday) {
      goals.push({ text: clause, due: findDue(clause, now) });
    }
  }

  const items = [];
  if (hasAnnual) {
    const annualText = annualClauses.length ? annualClauses.join('；') : t;
    items.push({ kind: 'annual', text: clipTask(annualText), budget: findBudget(annualText), period: 'year' });
  }

  const seenGoal = new Set();
  for (const g of goals) {
    const text = clipTask(g.text);
    if (!text || seenGoal.has(text)) continue;
    seenGoal.add(text);
    items.push({ kind: 'goal', text, due: g.due ?? null });
    if (seenGoal.size >= 5) break;
  }

  items.push(...tasks);
  items.push(...ledger);

  if (!items.length) {
    if (hasToday) items.push({ kind: 'goal', text: clipTask(t), due: findDue(t, now) });
    else if (hasAnnual) items.push({ kind: 'annual', text: clipTask(t), budget: findBudget(t), period: 'year' });
    else items.push({ kind: 'task', dept: 'libu2', text: clipTask(`先行统筹此事：${t}`), due: findDue(t, now) });
  }

  return {
    items: items.slice(0, 10),
    matched: items.filter((i) => i.kind === 'task').map((i) => i.dept),
  };
}

/** 把模型吐出来的东西收成统一形状；兼容旧式 {dept, task} */
export function sanitizeDispatchItems(raw, { fallbackText = '', now = new Date() } = {}) {
  const list = Array.isArray(raw) ? raw : Array.isArray(raw?.items) ? raw.items : [];
  const out = [];
  const seenTaskDept = new Set();
  const seenGoal = new Set();
  const seenLedger = new Set();
  let annualCount = 0;
  let ledgerCount = 0;

  for (const item of list) {
    const kind = String(item?.kind ?? '').trim() || (item?.dept ? 'task' : 'goal');
    if (kind === 'ledger') {
      if (ledgerCount >= 8) continue;
      const amount = Math.round(Number(item?.amount) * 100) / 100;
      const name = clipTask(item?.item ?? item?.text ?? item?.task ?? '', 60);
      if (!name || !Number.isFinite(amount) || amount <= 0 || amount > 1_000_000) continue;
      let date = normalizeLedgerDate(item?.date, now);
      if (!date && /^\d{4}-\d{2}-\d{2}/.test(String(item?.at ?? ''))) date = String(item.at).slice(0, 10);
      const key = `${name}|${amount}|${date ?? ''}`;
      if (seenLedger.has(key)) continue;
      seenLedger.add(key);
      out.push({ kind: 'ledger', item: name, amount, date });
      ledgerCount += 1;
      continue;
    }
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
    const due = normalizeDue(item?.due, now) ?? findDue(`${item?.text ?? ''} ${item?.task ?? ''}`, now);
    if (kind === 'goal') {
      if (seenGoal.has(text)) continue;
      seenGoal.add(text);
      out.push({ kind: 'goal', text, due });
      continue;
    }
    const dept = String(item?.dept ?? '').trim();
    if (!DISPATCH_DEPTS.includes(dept) || seenTaskDept.has(dept)) continue;
    seenTaskDept.add(dept);
    out.push({ kind: 'task', dept, text, due });
  }

  if (!out.length && String(fallbackText ?? '').trim()) return routeByRules(fallbackText, now).items;
  return out.slice(0, 10);
}
