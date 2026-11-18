/**
 * 司礼监传旨：主上说一段话 → 拆成给六部的差事
 *
 * 流程：模型先拆（带指纹缓存，同一段话不重复花钱）→ 拆不出或模型不可用 → 退回关键词规矩。
 * 只出方案、不直接落任务：App 把清单给主上过目，确认后才在各部名下生成差事。
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { routeByRules, sanitizeDispatchItems } from '../shared/dispatch-rules.mjs';

const file = (dataDir) => path.join(dataDir, 'court', 'dispatch-cache.json');

const readJson = (f, fallback) => {
  try {
    return JSON.parse(fs.readFileSync(f, 'utf8').replace(/^\uFEFF/, ''));
  } catch {
    return fallback;
  }
};

const writeJson = (f, value) => {
  fs.mkdirSync(path.dirname(f), { recursive: true });
  const tmp = `${f}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  fs.renameSync(tmp, f);
};

export const DISPATCH_SYSTEM = `你是「大内家事」的司礼监掌印，替主上把一段口谕拆成三类差事。
【三类】
1. annual：本年度（或半年）的大计，可带金额预算（budget，单位元；主上说「两万」就填 20000；没提就不填）。
2. goal：今天 / 今晚 / 每天要做的今日差事。
3. task：交给六部去办的差事，必须填 dept。
【可派的部与职掌】
· libu 吏部：作息、人员分工、谁去谁留、打卡考成
· hubu 户部：预算、花费、记账
· libu2 礼部：聚会、节日、生日、出游活动、吃喝安排、礼物
· bingbu 兵部：出行、路线、接送、几点出发、安全
· xingbu 刑部：矛盾、家规、评理
· gongbu 工部：家务、收拾、物资准备、维修
【规矩】
1. 只拆真正相关的，最多 8 条；annual 最多 2 条；同一部最多一条 task；
2. 每条 text / task 要具体，带上主上说的关键信息（时间、地点、吃什么）；
3. 只输出 JSON，不要解释、不要 Markdown 代码块：
{"items":[{"kind":"annual","text":"今年攒钱去海边旅游","budget":20000,"period":"year"},{"kind":"goal","text":"背三十个单词"},{"kind":"task","dept":"libu2","task":"张罗下周三的生日饭"}]}`;

export const dispatchFingerprint = (text) =>
  createHash('sha1').update(JSON.stringify(['dispatch-v2', String(text ?? '').trim()])).digest('hex').slice(0, 16);

/** 从模型输出里抠出 JSON（允许前后有废话） */
function parseModelJson(content) {
  const text = String(content ?? '');
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
}

/**
 * 拟旨。
 * callModel 由中枢注入；没有模型（未配 key / 关了 AI）就只按关键词规矩拆。
 */
export async function dispatchEdict(dataDir, {
  text, force = false, callModel = null, model = 'deepseek-chat', now = new Date(),
} = {}) {
  const t = String(text ?? '').trim();
  if (!t) {
    const err = new Error('先写一段口谕，比如「周六去公园玩，中午吃火锅」');
    err.statusCode = 400;
    throw err;
  }
  if (t.length > 300) {
    const err = new Error('口谕短一点，300 字以内');
    err.statusCode = 400;
    throw err;
  }

  const fingerprint = dispatchFingerprint(t);
  const cache = readJson(file(dataDir), {});
  if (!force && cache[fingerprint]) return { ...cache[fingerprint], cached: true };

  let items = [];
  let source = 'rules';
  let usage = null;
  let warning = null;

  if (callModel) {
    try {
      const { content, usage: u } = await callModel(DISPATCH_SYSTEM, `【主上的口谕】\n${t}`);
      usage = u ?? null;
      const parsed = parseModelJson(content);
      const got = sanitizeDispatchItems(parsed, { fallbackText: t });
      if (got.length) {
        items = got;
        source = 'model';
      } else {
        items = routeByRules(t).items;
        warning = '司礼监没听明白，先按老规矩拆';
      }
    } catch (err) {
      items = routeByRules(t).items;
      warning = `模型没搭上话（${String(err?.message ?? err).slice(0, 50)}），先按老规矩拆`;
    }
  } else {
    items = routeByRules(t).items;
    warning = '中枢未配模型，司礼监先按老规矩拆';
  }

  const record = {
    id: `${Date.now()}-dispatch`,
    text: t,
    items,
    source,
    model,
    usage,
    warning,
    fingerprint,
    createdAt: now.toISOString(),
  };

  // 只留最近 50 段口谕，免得缓存文件无限长
  cache[fingerprint] = record;
  const keep = Object.entries(cache)
    .sort((a, b) => String(a[1]?.createdAt ?? '').localeCompare(String(b[1]?.createdAt ?? '')))
    .slice(-50);
  writeJson(file(dataDir), Object.fromEntries(keep));
  return { ...record, cached: false };
}
