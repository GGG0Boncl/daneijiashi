/**
 * 用量账簿：每次调用模型都记一笔（含缓存命中=0 token），并查 DeepSeek 余额。
 *
 * 为什么要单独记：用户要求"每次调用都在手机上看到消耗与余额"，
 * 而缓存命中不花钱也必须留下痕迹，否则账对不上。
 */
import fs from 'node:fs';
import path from 'node:path';
import { costOfUsageRow, priceTable, round4 } from './pricing.mjs';

const TZ = 'Asia/Shanghai';
const bjNow = () =>
  new Intl.DateTimeFormat('sv-SE', {
    timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  }).format(new Date()).replace(' ', 'T');

export const bjDate = () => bjNow().slice(0, 10);
export const bjIso = () => `${bjNow()}+08:00`;

const file = (dataDir) => path.join(dataDir, 'usage.jsonl');

export function appendUsage(dataDir, entry) {
  fs.mkdirSync(dataDir, { recursive: true });
  fs.appendFileSync(file(dataDir), `${JSON.stringify(entry)}\n`, 'utf8');
  return entry;
}

export function readUsage(dataDir, { limit = 50 } = {}) {
  try {
    const rows = fs
      .readFileSync(file(dataDir), 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((l) => {
        try {
          return JSON.parse(l);
        } catch {
          return null;
        }
      })
      .filter(Boolean);
    return rows.slice(-limit);
  } catch {
    return [];
  }
}

/** 汇总：今天 / 本月 / 累计，外加最近 N 条明细（每条带这次花了多少钱） */
export function summarizeUsage(dataDir, { limit = 20 } = {}) {
  const rows = readUsage(dataDir, { limit: 100000 });
  const today = bjDate();
  const month = today.slice(0, 7);
  const price = priceTable();
  const costOf = (r) => costOfUsageRow(r, { price });
  const wasEstimated = (r) => !r.cached && r.fake !== true && !Number.isFinite(Number(r.cost)) && Number(r.tokens) > 0;
  const sum = (list) => ({
    calls: list.length,
    tokens: list.reduce((a, r) => a + (Number(r.tokens) || 0), 0),
    paidTokens: list.reduce((a, r) => a + (r.cached ? 0 : Number(r.tokens) || 0), 0),
    cost: round4(list.reduce((a, r) => a + costOf(r), 0)),
    costEstimated: list.some(wasEstimated),
  });
  return {
    today: sum(rows.filter((r) => String(r.at).slice(0, 10) === today)),
    month: sum(rows.filter((r) => String(r.at).slice(0, 7) === month)),
    total: sum(rows),
    price,
    recent: rows.slice(-limit).reverse().map((r) => ({
      ...r,
      cost: costOf(r),
      costEstimated: wasEstimated(r),
    })),
  };
}

/* ------------------------------ 余额 ------------------------------ */

let balanceCache = { at: 0, value: null };

/**
 * DeepSeek 余额查询（GET /user/balance）。
 * 失败不抛错，返回 { ok:false, error }，前端显示"暂时查不到"即可。
 */
export async function fetchBalance({ apiKey, baseUrl }) {
  const now = Date.now();
  if (balanceCache.value && now - balanceCache.at < 60_000) return balanceCache.value;
  try {
    const res = await fetch(`${baseUrl}/user/balance`, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(8000),
    });
    const data = await res.json().catch(() => null);
    if (!res.ok) {
      balanceCache = { at: now, value: { ok: false, error: data?.error?.message ?? `HTTP ${res.status}` } };
      return balanceCache.value;
    }
    const info = (data?.balance_infos ?? [])[0] ?? {};
    const value = {
      ok: true,
      available: data?.is_available !== false,
      currency: info.currency ?? 'CNY',
      total: Number(info.total_balance ?? 0),
      granted: Number(info.granted_balance ?? 0),
      toppedUp: Number(info.topped_up_balance ?? 0),
      at: bjIso(),
    };
    balanceCache = { at: now, value };
    return value;
  } catch (err) {
    const value = { ok: false, error: String(err?.message ?? err) };
    balanceCache = { at: now, value };
    return value;
  }
}
