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

const bjDateKey = (now) => {
  try {
    return new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Shanghai' }).format(now);
  } catch {
    return new Date(now).toISOString().slice(0, 10);
  }
};

const bjNowText = (now) => {
  try {
    return new Intl.DateTimeFormat('zh-CN', {
      timeZone: 'Asia/Shanghai',
      year: 'numeric', month: 'long', day: 'numeric',
      hour: '2-digit', minute: '2-digit', weekday: 'long', hour12: false,
    }).format(now);
  } catch {
    return new Date(now).toISOString();
  }
};

/** 司礼监的拆旨规矩。带上当前北京时间，模型才能把「今天下午三点」算成 due。 */
export function dispatchSystem(now = new Date()) {
  const today = bjDateKey(now);
  return `你是「大内家事」的司礼监掌印，替主上把一段口谕听懂、改正、拆成四类。
【此刻】北京时间 ${bjNowText(now)}（今天 ${today}）。
【先听懂，再动笔】
1. 主上多半是语音转写：明显的同音/近音错字要按上下文改正（如「接孩纸」→「接孩子」、「礼部」被写成「李部」）；人名、菜名、地名、店名不要擅自改。
2. 一段话里可能有好几件事，逐件拆开；不要把整段话塞进一条。
3. 主上没有明说的，不要编；拿不准就保留原话，并在 note 里说明。
【四类】
1. annual：本年度/半年度的大计，可带金额预算（budget，单位元；「两万」填 20000；没提就不填）。
2. goal：今天/今晚/每天要做的今日差事。
3. task：交给六部去办的差事，必须填 dept。
4. ledger：已经花掉、买下、付过的钱，记入户部账目。填 item（名目）、amount（数字，元）、date（账目日期，YYYY-MM-DD；今天可省略）。
【账目怎么记】
· 「包子 白蛋 糯玉米9元 午饭冒菜18元」→ 两笔账：
  {"kind":"ledger","item":"包子、白蛋、糯玉米","amount":9}
  {"kind":"ledger","item":"午饭冒菜","amount":18}
· 同一次买的几样东西共一个总价，合成一笔，名目用「、」连起来；各带各价就分开记。
· 「昨天」「前天」「11月18日」要说清 date；没说的记今天。
· 计划要买、还没付钱的，不算 ledger，按 goal/task 办。
· 纯问「午饭吃什么」不算账，是礼部/今日的事。
【可派的部与职掌】
· libu 吏部：作息、人员分工、谁去谁留、打卡考成
· hubu 户部：预算、花费、记账
· libu2 礼部：聚会、节日、生日、出游活动、吃喝安排、礼物
· bingbu 兵部：出行、路线、接送、几点出发、安全
· xingbu 刑部：矛盾、家规、评理
· gongbu 工部：家务、收拾、物资准备、维修
【辨词】
· 记一笔 / 花了 / 买了 / 付了 / 开销 / 账单 / 充值 → ledger（户部）
· 今天要 / 今晚 / 提醒我 / 待办 → goal
· 今年 / 年度 / 目标 / 攒钱 / 预算 → annual
· 让某部 / 谁去 / 安排 / 张罗 / 修一下 → task
【到点提醒 due】
· 只有主上明确说了钟点（几点、上午下午晚上、周几几点）才填 due；
· due 用北京时间 YYYY-MM-DDTHH:mm+08:00，例如「今天下午三点」= ${today}T15:00+08:00；
· 只说了日期没说钟点（如「周六去公园」）不填；钟点已过不填；annual 与 ledger 从不填 due。
【规矩】
1. 最多 8 条；annual 最多 2 条；同一部最多一条 task；账目最多 8 笔；
2. 每条文字要具体，带上时间、地点、吃什么等关键信息；
3. note 用一句古白话说明你改了什么、怎么归的（如「把包子白蛋并进糯玉米那笔，共九元，归户部」），没有就留空；
4. 只输出 JSON，不要解释、不要 Markdown 代码块：
{"note":"把包子白蛋并进糯玉米那笔，共九元，归户部","items":[{"kind":"annual","text":"今年攒钱去海边旅游","budget":20000,"period":"year"},{"kind":"goal","text":"背三十个单词","due":"${today}T21:00+08:00"},{"kind":"task","dept":"libu2","text":"张罗下周三的生日饭"},{"kind":"ledger","item":"午饭冒菜","amount":18}]}`;
}

export const DISPATCH_SYSTEM = dispatchSystem();

/** 指纹带上北京日期：同一句「今天」隔天不能再复用旧旨 */
export const dispatchFingerprint = (text, now = new Date()) =>
  createHash('sha1')
    .update(JSON.stringify(['dispatch-v4', bjDateKey(now), String(text ?? '').trim()]))
    .digest('hex')
    .slice(0, 16);

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

  const at = now instanceof Date && Number.isFinite(now.getTime()) ? now : new Date();
  const fingerprint = dispatchFingerprint(t, at);
  const cache = readJson(file(dataDir), {});
  if (!force && cache[fingerprint]) return { ...cache[fingerprint], cached: true };

  let items = [];
  let source = 'rules';
  let usage = null;
  let warning = null;
  let note = '';

  if (callModel) {
    try {
      const { content, usage: u } = await callModel(dispatchSystem(at), `【主上的口谕】\n${t}`);
      usage = u ?? null;
      const parsed = parseModelJson(content);
      note = String(parsed?.note ?? '').trim().slice(0, 120);
      const got = sanitizeDispatchItems(parsed, { fallbackText: t, now: at });
      if (got.length) {
        items = got;
        source = 'model';
      } else {
        items = routeByRules(t, at).items;
        warning = '司礼监没听明白，先按老规矩拆';
      }
    } catch (err) {
      items = routeByRules(t, at).items;
      warning = `模型没搭上话（${String(err?.message ?? err).slice(0, 50)}），先按老规矩拆`;
    }
  } else {
    items = routeByRules(t, at).items;
    warning = '中枢未配模型，司礼监先按老规矩拆';
  }

  const record = {
    id: `${at.getTime()}-dispatch`,
    text: t,
    items,
    source,
    model,
    usage,
    warning,
    note,
    fingerprint,
    createdAt: at.toISOString(),
  };

  // 只留最近 50 段口谕，免得缓存文件无限长
  cache[fingerprint] = record;
  const keep = Object.entries(cache)
    .sort((a, b) => String(a[1]?.createdAt ?? '').localeCompare(String(b[1]?.createdAt ?? '')))
    .slice(-50);
  writeJson(file(dataDir), Object.fromEntries(keep));
  return { ...record, cached: false };
}
