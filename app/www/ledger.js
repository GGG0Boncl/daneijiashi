// 由 tools/sync-assets.mjs 从 shared/ledger.mjs 复制，别直接改这里
/**
 * 户部 · 一句话记账（两端共用的纯函数）
 *
 * 输入示例：
 *   买菜 35
 *   外卖 28.5 元
 *   交电费 200
 *   包子 白蛋 糯玉米9元 午饭冒菜18元
 *
 * 设计取舍：先用规则解析（快、免费、可单测），解析不出金额时明确报错让人重写，
 * 不偷偷调模型烧 token。司礼监识别口谕时也复用这里的解析与归类。
 */

export const CATEGORIES = [
  { id: 'food', label: '吃喝', words: ['菜', '买菜', '菜市场', '超市', '外卖', '早餐', '早点', '午饭', '晚饭', '宵夜', '水果', '零食', '奶茶', '咖啡', '包子', '馒头', '饺子', '水饺', '面条', '米饭', '饭', '火锅', '烧烤', '肉', '鸡蛋', '白蛋', '玉米', '糯玉米', '冒菜', '蛋', '奶', '饮料', '可乐', '米', '面', '油'] },
  { id: 'utilities', label: '水电燃气', words: ['电费', '水费', '燃气', '煤气', '物业', '宽带', '话费', '网费'] },
  { id: 'transport', label: '交通', words: ['打车', '地铁', '公交', '油费', '加油', '停车', '高铁', '车票'] },
  { id: 'home', label: '家居', words: ['家具', '家电', '收纳', '清洁', '装修', '维修', '五金', '灯', '床品'] },
  { id: 'kids', label: '孩子', words: ['娃', '孩子', '学费', '书', '绘本', '玩具', '补习', '校服'] },
  { id: 'health', label: '医疗', words: ['药', '医院', '看病', '体检', '牙', '挂号'] },
  { id: 'fun', label: '娱乐', words: ['电影', '游戏', '旅游', '门票', '聚会', 'ktv'] },
  { id: 'digital', label: '数码订阅', words: ['deepseek', 'openai', 'chatgpt', 'claude', '会员', '订阅', '网盘', '软件', '域名', 'vpn', 'proxy'] },
  { id: 'other', label: '其他', words: [] },
];

const AMOUNT_RE = /(\d+(?:\.\d{1,2})?)\s*(?:元|块|块钱|rmb|￥|¥)?/i;

// 按词长从长到短匹配：「加油」优先于「油」，否则「加油 300」会被算成吃喝
const WORD_INDEX = CATEGORIES.flatMap((c) => c.words.map((w) => ({ word: w, cat: c }))).sort(
  (a, b) => b.word.length - a.word.length,
);

export function categorize(text) {
  const t = String(text ?? '');
  for (const { word, cat } of WORD_INDEX) {
    if (t.includes(word)) return cat;
  }
  return CATEGORIES.find((c) => c.id === 'other');
}

/** 把「包子 白蛋 糯玉米9元」里的前两项并进后一笔，别丢掉没带金额的品名 */
export function parseLedgerText(input) {
  const text = String(input ?? '').trim();
  if (!text) return { ok: false, error: '写点什么吧，比如「包子 4，午饭 18」' };

  // 先按换行/中文标点/空格切块，再让"事项"与"数字"配对
  const chunks = text
    .split(/[\n,，、;；|]+/)
    .flatMap((s) => s.split(/\s+/))
    .map((s) => s.trim())
    .filter(Boolean);

  const entries = [];
  const unparsed = [];
  const pending = [];

  const push = (item, numStr, raw) => {
    const amount = Number(numStr);
    if (!Number.isFinite(amount) || amount <= 0 || amount > 1_000_000) {
      unparsed.push(raw);
      return;
    }
    const label = String(item).replace(/[:：]$/, '').trim() || '杂项';
    const category = categorize(label);
    entries.push({
      amount: Math.round(amount * 100) / 100,
      item: label,
      categoryId: category.id,
      categoryLabel: category.label,
      raw,
    });
  };

  const rest = () => [...new Set(pending.map((s) => s.replace(/[:：]$/, '').trim()).filter(Boolean))];

  for (const tok of chunks) {
    const onlyNum = tok.match(/^(\d+(?:\.\d{1,2})?)\s*(?:元|块|块钱|rmb|¥)?$/i);
    if (onlyNum) {
      const items = rest();
      if (items.length) {
        push(items.join('、'), onlyNum[1], `${items.join(' ')} ${onlyNum[1]}`);
        pending.length = 0;
      } else {
        unparsed.push(tok);
      }
      continue;
    }
    const both = tok.match(/^(.+?)[\s:：]*(\d+(?:\.\d{1,2})?)\s*(?:元|块|块钱|rmb|¥)?$/i);
    if (both) {
      const items = [...rest(), both[1].replace(/[:：]$/, '').trim()].filter(Boolean);
      push(items.join('、'), both[2], `${items.join(' ')} ${both[2]}`);
      pending.length = 0;
      continue;
    }
    pending.push(tok); // 等下个数来配对
  }
  unparsed.push(...rest());

  if (!entries.length) {
    return { ok: false, error: '一笔都没认出来，照「包子 4，午饭 18」这样写', unparsed };
  }
  return { ok: true, entries, unparsed };
}

export function parseLedgerLine(input) {
  const parsed = parseLedgerText(input);
  if (!parsed.ok) return parsed;
  const first = parsed.entries[0];
  return { ok: true, ...first, raw: first.raw, entries: parsed.entries, unparsed: parsed.unparsed };
}

/** 统计一段时间内的流水 */
export function summarizeLedger(entries, { days = 30, now = new Date() } = {}) {
  const since = new Date(now.getTime() - (days - 1) * 86400000);
  const sinceDate = `${since.getFullYear()}-${String(since.getMonth() + 1).padStart(2, '0')}-${String(since.getDate()).padStart(2, '0')}`;
  const rows = (entries ?? []).filter((e) => (e.date ?? '') >= sinceDate);

  let total = 0;
  const byCat = new Map();
  const byItem = new Map();
  for (const e of rows) {
    total += e.amount;
    byCat.set(e.categoryLabel, (byCat.get(e.categoryLabel) ?? 0) + e.amount);
    byItem.set(e.item, (byItem.get(e.item) ?? 0) + e.amount);
  }
  const round = (n) => Math.round(n * 100) / 100;
  return {
    days,
    count: rows.length,
    total: round(total),
    byCategory: [...byCat.entries()].map(([label, amount]) => ({ label, amount: round(amount) })).sort((a, b) => b.amount - a.amount),
    topItems: [...byItem.entries()].map(([item, amount]) => ({ item, amount: round(amount) })).sort((a, b) => b.amount - a.amount).slice(0, 5),
    entries: rows.slice(-20),
  };
}
