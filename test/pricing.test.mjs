/**
 * 中枢账房：按 token 估算花掉的钱
 *
 * 用户要求：每消耗一次 token，账房里要看得见"这次花了多少钱"。
 * 这里守住价格表、峰谷价、缓存 0 元、老流水粗算这几件事。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DEFAULT_PRICE_CNY_PER_M, estimateCny, isPeak, priceTable, costOfUsageRow, formatCny,
} from '../court/pricing.mjs';
import { summarizeUsage, appendUsage, bjIso, bjDate } from '../court/usage.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');

const fmt6 = (n) => Math.round(Number(n) * 1e6) / 1e6;

test('峰时判定：UTC 周一至周五 01-04、06-10 点为峰时，周末全闲时', () => {
  // 2026-11-16 是周一
  assert.equal(isPeak(new Date('2026-11-16T02:00:00Z')), true);
  assert.equal(isPeak(new Date('2026-11-16T07:30:00Z')), true);
  assert.equal(isPeak(new Date('2026-11-16T05:00:00Z')), false, '中午空档算闲时');
  assert.equal(isPeak(new Date('2026-11-16T10:00:00Z')), false);
  // 2026-11-21 是周六
  assert.equal(isPeak(new Date('2026-11-21T02:00:00Z')), false);
});

test('精算：命中缓存、未命中、输出分别计价，闲时打对折', () => {
  const usage = {
    prompt_tokens: 1000,
    completion_tokens: 500,
    prompt_cache_hit_tokens: 200,
    prompt_cache_miss_tokens: 800,
    total_tokens: 1500,
  };
  const peak = estimateCny(usage, { now: new Date('2026-11-16T02:00:00Z') });
  const expectPeak = (200 * DEFAULT_PRICE_CNY_PER_M.hit + 800 * DEFAULT_PRICE_CNY_PER_M.miss + 500 * DEFAULT_PRICE_CNY_PER_M.out) / 1e6;
  assert.equal(peak.estimated, false);
  assert.equal(peak.peak, true);
  assert.equal(peak.cny, fmt6(expectPeak));

  const off = estimateCny(usage, { now: new Date('2026-11-16T05:00:00Z') });
  assert.equal(off.peak, false);
  assert.equal(off.cny, fmt6(expectPeak / 2), '闲时半价');
});

test('老流水只有 total_tokens：粗算并标明估算', () => {
  const est = estimateCny({ total_tokens: 1000 }, { now: new Date('2026-11-16T05:00:00Z') });
  assert.equal(est.estimated, true);
  assert.ok(est.cny > 0);
  assert.equal(est.cny, fmt6((1000 * 0.7 * DEFAULT_PRICE_CNY_PER_M.miss + 1000 * 0.3 * DEFAULT_PRICE_CNY_PER_M.out) / 1e6 / 2));
});

test('缓存命中 / 假模型 / 显式 cost 的处理', () => {
  assert.equal(costOfUsageRow({ cached: true, tokens: 9999 }), 0);
  assert.equal(costOfUsageRow({ fake: true, tokens: 9999 }), 0);
  assert.equal(costOfUsageRow({ tokens: 1000, cost: 0.123 }), 0.123);
  assert.equal(priceTable({}).unit, '元 / 百万 tokens');
  assert.equal(formatCny(0.0042), '¥0.0042');
  assert.equal(formatCny(0), '¥0');
});

test('汇总：今日/今月金额、明细每条都带 cost', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'usage-cost-'));
  try {
    const at = bjIso();
    appendUsage(dir, { at, kind: 'court', dept: 'hubu', model: 'deepseek-chat', tokens: 1000, cost: 0.002, costEstimated: false });
    appendUsage(dir, { at, kind: 'analysis', model: 'deepseek-chat', tokens: 2000, cost: 0.01, costEstimated: false });
    appendUsage(dir, { at, kind: 'court', dept: 'libu', model: 'deepseek-chat', tokens: 0, cached: true });
    // 老流水：没有 cost，只有 tokens
    appendUsage(dir, { at, kind: 'court', dept: 'bingbu', model: 'deepseek-chat', tokens: 1000 });

    const s = summarizeUsage(dir, { limit: 10 });
    assert.equal(s.today.calls, 4);
    assert.equal(s.month.calls, 4);
    assert.equal(s.today.tokens, 4000);
    assert.ok(s.today.cost > 0.012, `今日金额应含老流水估算：${s.today.cost}`);
    assert.equal(s.today.costEstimated, true);
    assert.equal(s.recent.length, 4);
    assert.equal(s.recent.find((r) => r.cached).cost, 0, '缓存命中记 0');
    assert.ok(s.recent.every((r) => typeof r.cost === 'number'));
    assert.ok(s.price && s.price.miss > 0);
    assert.equal(bjDate(), at.slice(0, 10));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('副本：price 模块不依赖 App 副本，账房接口字段名保持稳定', () => {
  const usageSrc = fs.readFileSync(path.join(ROOT, 'court', 'usage.mjs'), 'utf8');
  for (const key of ['cost:', 'costEstimated', 'price', 'recent']) {
    assert.ok(usageSrc.includes(key), `用量汇总应带 ${key}`);
  }
});
