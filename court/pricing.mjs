/**
 * 模型花费折算（人民币）
 *
 * 用户要求：账房里每花一次 token，都要看见"这次花了多少钱"。
 * 这里按 DeepSeek 官方价目折算，默认取峰时价、闲时对折；
 * 价目可用环境变量覆盖（单位：元 / 百万 tokens）：
 *   HUB_PRICE_INPUT_HIT / HUB_PRICE_INPUT_MISS / HUB_PRICE_OUTPUT
 *
 * 说明：官方价目随时会调，余额仍以 DeepSeek 账户扣费为准，这里标"估算"。
 */

export const DEFAULT_PRICE_CNY_PER_M = {
  hit: 0.043, // 输入·缓存命中
  miss: 2.16, // 输入·缓存未命中（峰时）
  out: 8.64, // 输出（峰时）
};

const num = (v, fallback) => {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
};

export function priceTable(env = process.env) {
  return {
    hit: num(env.HUB_PRICE_INPUT_HIT, DEFAULT_PRICE_CNY_PER_M.hit),
    miss: num(env.HUB_PRICE_INPUT_MISS, DEFAULT_PRICE_CNY_PER_M.miss),
    out: num(env.HUB_PRICE_OUTPUT, DEFAULT_PRICE_CNY_PER_M.out),
    unit: '元 / 百万 tokens',
    currency: 'CNY',
  };
}

/** DeepSeek 峰时：UTC 周一至周五 01:00–04:00、06:00–10:00；其余（含周末）闲时半价 */
export function isPeak(now = new Date()) {
  const day = now.getUTCDay();
  if (day === 0 || day === 6) return false;
  const hour = now.getUTCHours();
  return (hour >= 1 && hour < 4) || (hour >= 6 && hour < 10);
}

/**
 * 算一次调用的花费。
 * usage 里若有 prompt/completion（以及缓存命中数）就精算；只有 total_tokens 就按七三粗估。
 */
export function estimateCny(usage, { now = new Date(), price = priceTable() } = {}) {
  const u = usage ?? {};
  const total = num(u.total_tokens, 0);
  const prompt = num(u.prompt_tokens, 0);
  const completion = num(u.completion_tokens, 0);
  const hit = num(u.prompt_cache_hit_tokens, 0);
  const miss = u.prompt_cache_miss_tokens !== undefined
    ? num(u.prompt_cache_miss_tokens, 0)
    : Math.max(0, prompt - hit);

  let cny = 0;
  let estimated = false;
  if (prompt || completion) {
    cny = (hit * price.hit + miss * price.miss + completion * price.out) / 1e6;
  } else if (total) {
    // 老流水只有总数：按"输入七成、输出三成"估，标明是粗算
    cny = (total * 0.7 * price.miss + total * 0.3 * price.out) / 1e6;
    estimated = true;
  }

  const peak = isPeak(now);
  if (!peak) cny /= 2;
  return {
    cny: Math.round(cny * 1e6) / 1e6,
    estimated,
    peak,
    price,
  };
}

/** 一条流水记录花了多少钱（缓存命中/假模型 = 0） */
export function costOfUsageRow(row, { price = priceTable() } = {}) {
  if (!row) return 0;
  if (row.cached === true || row.fake === true) return 0;
  if (Number.isFinite(Number(row.cost))) return Number(row.cost);
  const at = Number.isFinite(Date.parse(String(row.at ?? ''))) ? new Date(row.at) : new Date();
  return estimateCny({ total_tokens: row.tokens }, { now: at, price }).cny;
}

export const round4 = (n) => Math.round((Number(n) || 0) * 10000) / 10000;

/** 给手机看的一句话金额：小额也留 4 位小数 */
export function formatCny(n) {
  const v = Number(n) || 0;
  if (v <= 0) return '¥0';
  return `¥${v.toFixed(4)}`;
}
