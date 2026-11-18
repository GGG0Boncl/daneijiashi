/**
 * 局域网同步
 *
 * 发现：优先用原生插件 LanDiscovery（浏览器发不了 UDP 广播）；
 *      拿不到就让用户在设置里手填中枢地址（http://192.168.x.x:8787）。
 * 同步：POST /api/sync 带上本机最近 N 天的记录，服务端双向合并后回传全量，
 *      本地再用同一套 merge 规则合并一次（幂等）。
 */
import { mergeRecords } from './merge.js';

export const DEFAULT_HUB_PORT = 8787;
// 同步窗口要盖住"保留一年"的全部数据，否则老记录上传不了、还会在合并时从内存里消失
const SYNC_DAYS = 400;

export function nativePlugin(name) {
  try {
    return globalThis.Capacitor?.Plugins?.[name] ?? null;
  } catch {
    return null;
  }
}

/**
 * 局域网自动发现中枢，返回 { url } 或 null。
 * 原生插件会一边发问一边听中枢的广播（announce），所以即使手机发的广播传不到电脑
 * （热点/路由器隔离），只要中枢在广播就能找到。
 */
export async function discoverHub(timeoutMs = 3000) {
  const plugin = nativePlugin('LanDiscovery');
  if (!plugin?.discover) return null;
  try {
    const res = await plugin.discover({ timeoutMs });
    if (res?.httpPort) {
      const host = res.ip ?? res.address;
      if (host) {
        return {
          url: `http://${host}:${res.httpPort}`,
          host: res.ip ?? null,
          name: res.host ?? null,
          via: res.via ?? 'reply',
        };
      }
    }
  } catch (err) {
    console.warn('发现中枢失败', err);
  }
  return null;
}

export function normalizeHubUrl(input) {
  let s = String(input ?? '').trim();
  if (!s) return '';
  if (!/^https?:\/\//i.test(s)) s = `http://${s}`;
  s = s.replace(/\/+$/, '');
  return s;
}

async function httpJson(url, options = {}, timeoutMs = 6000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...options, signal: ctrl.signal, headers: { 'Content-Type': 'application/json', ...(options.headers ?? {}) } });
    const text = await res.text();
    let body = null;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      body = { raw: text };
    }
    if (!res.ok) throw new Error((body && body.error) || `HTTP ${res.status}`);
    return body;
  } finally {
    clearTimeout(timer);
  }
}

export async function testHub(url) {
  const base = normalizeHubUrl(url);
  if (!base) throw new Error('还没填中枢地址');
  const info = await httpJson(`${base}/api/health`, { method: 'GET' });
  if (!info || info.app !== 'family-checkin-hub') throw new Error('这个地址不是大内家事中枢');
  return info;
}

/** 同步：返回 { records, serverTime, stats, written, pruned, retention } */
export async function syncWithHub({ url, token, memberId, memberName, deviceId, records, mode = 'auto' }) {
  const base = normalizeHubUrl(url);
  if (!base) throw new Error('还没配置中枢地址');
  const recent = (records ?? [])
    .filter((r) => typeof r.date === 'string')
    .slice(-SYNC_DAYS);
  const res = await httpJson(`${base}/api/sync`, {
    method: 'POST',
    headers: token ? { 'x-hub-token': token } : {},
    // mode 让中枢看板能区分"自动同步"和"我手动点的"
    body: JSON.stringify({ memberId, memberName, deviceId, mode, records: recent }),
  }, 12000);
  if (!res?.ok) throw new Error('中枢没有返回 ok');
  const merged = mergeRecords(recent, res.records ?? []);
  return {
    records: merged,
    serverTime: res.serverTime,
    stats: res.stats,
    written: res.written,
    pruned: res.pruned ?? 0,
    retention: res.retention ?? null,
  };
}

/**
 * 让中枢调用 DeepSeek 做单人复盘。
 * 中枢会自己组素材包 + 调模型；数据没变时会直接返回上次结果（cached=true，不花 token）。
 */
export async function analyzeWithHub({ url, token, memberId, days, force = false }) {
  const base = normalizeHubUrl(url);
  if (!base) throw new Error('还没连上家里中枢，没法做 AI 复盘');
  const body = await httpJson(`${base}/api/analyze`, {
    method: 'POST',
    headers: token ? { 'x-hub-token': token } : {},
    body: JSON.stringify({ memberId, days, force }),
  }, 150000); // 模型生成可能要几十秒
  if (!body?.ok || !body.analysis) throw new Error(body?.error || '中枢没有返回复盘内容');
  return { ...body.analysis, quota: body.quota ?? null };
}

/** 拉取该成员的历史复盘（中枢已按"每个天数最多 3 条"筛好） */
export async function listAnalysesOnHub({ url, token, memberId }) {
  const base = normalizeHubUrl(url);
  if (!base) throw new Error('还没连上家里中枢');
  const qs = new URLSearchParams({ memberId, limit: '30' });
  const body = await httpJson(`${base}/api/analyses?${qs}`, {
    method: 'GET',
    headers: token ? { 'x-hub-token': token } : {},
  }, 8000);
  return body?.analyses ?? [];
}

/** 按 id 取一份复盘的全文（列表接口只给摘要） */
export async function getAnalysis({ url, token, id }) {
  const base = normalizeHubUrl(url);
  if (!base) throw new Error('还没连上家里中枢');
  const qs = new URLSearchParams({ id });
  const body = await httpJson(`${base}/api/analysis?${qs}`, {
    method: 'GET',
    headers: token ? { 'x-hub-token': token } : {},
  }, 8000);
  if (!body?.ok || !body.analysis) throw new Error(body?.error || '拿不到这份复盘');
  return body.analysis;
}

/* --------------------------- 家是小国 · 朝廷 --------------------------- */

const COURT_TIMEOUT = 150000; // 召唤六部要跑模型

export async function getCourtConfig({ url, token }) {
  const base = normalizeHubUrl(url);
  if (!base) throw new Error('还没连上家里中枢');
  return httpJson(`${base}/api/court/config`, { method: 'GET', headers: token ? { 'x-hub-token': token } : {} }, 8000);
}

export async function setCourtRole({ url, token, memberId, role }) {
  const base = normalizeHubUrl(url);
  if (!base) throw new Error('还没连上家里中枢');
  return httpJson(`${base}/api/court/role`, {
    method: 'POST',
    headers: token ? { 'x-hub-token': token } : {},
    body: JSON.stringify({ memberId, role }),
  }, 8000);
}

export async function summonDept({ url, token, memberId, dept, focus = '', force = false }) {
  const base = normalizeHubUrl(url);
  if (!base) throw new Error('还没连上家里中枢');
  const body = await httpJson(`${base}/api/court/summon`, {
    method: 'POST',
    headers: token ? { 'x-hub-token': token } : {},
    body: JSON.stringify({ memberId, dept, focus, force }),
  }, COURT_TIMEOUT);
  if (!body?.ok) throw new Error(body?.error || '上奏失败');
  return { memorial: body.memorial, cached: body.cached === true, quota: body.quota ?? null };
}

export async function dispatchWithHub({ url, token, memberId, text, force = false }) {
  const base = normalizeHubUrl(url);
  if (!base) throw new Error('还没连上家里中枢');
  const body = await httpJson(`${base}/api/court/dispatch`, {
    method: 'POST',
    headers: token ? { 'x-hub-token': token } : {},
    body: JSON.stringify({ memberId, text, force }),
  }, COURT_TIMEOUT);
  if (!body?.ok) throw new Error(body?.error || '司礼监拟旨失败');
  return { items: body.items ?? [], source: body.source ?? 'rules', warning: body.warning ?? null, cached: body.cached === true, quota: body.quota ?? null, id: body.id ?? null };
}

export async function listMemorials({ url, token, dept = '', status = '', limit = 30 }) {
  const base = normalizeHubUrl(url);
  if (!base) throw new Error('还没连上家里中枢');
  const qs = new URLSearchParams({ limit: String(limit) });
  if (dept) qs.set('dept', dept);
  if (status) qs.set('status', status);
  const body = await httpJson(`${base}/api/court/memorials?${qs}`, {
    method: 'GET',
    headers: token ? { 'x-hub-token': token } : {},
  }, 8000);
  return body?.memorials ?? [];
}

export async function getMemorial({ url, token, id }) {
  const base = normalizeHubUrl(url);
  if (!base) throw new Error('还没连上家里中枢');
  const body = await httpJson(`${base}/api/court/memorial?id=${encodeURIComponent(id)}`, {
    method: 'GET',
    headers: token ? { 'x-hub-token': token } : {},
  }, 8000);
  if (!body?.ok) throw new Error(body?.error || '找不到这份奏疏');
  return body.memorial;
}

export async function disposeMemorial({ url, token, memberId, id, action, comment = '' }) {
  const base = normalizeHubUrl(url);
  if (!base) throw new Error('还没连上家里中枢');
  const body = await httpJson(`${base}/api/court/dispose`, {
    method: 'POST',
    headers: token ? { 'x-hub-token': token } : {},
    body: JSON.stringify({ memberId, id, action, comment }),
  }, 12000);
  if (!body?.ok) throw new Error(body?.error || '批阅失败');
  return body.memorial;
}

export async function courtMeeting({ url, token }) {
  const base = normalizeHubUrl(url);
  if (!base) throw new Error('还没连上家里中枢');
  const body = await httpJson(`${base}/api/court/meeting`, {
    method: 'GET',
    headers: token ? { 'x-hub-token': token } : {},
  }, 12000);
  return body;
}

export async function addLedger({ url, token, memberId, text }) {
  const base = normalizeHubUrl(url);
  if (!base) throw new Error('还没连上家里中枢');
  const body = await httpJson(`${base}/api/court/ledger`, {
    method: 'POST',
    headers: token ? { 'x-hub-token': token } : {},
    body: JSON.stringify({ memberId, text }),
  }, 8000);
  if (!body?.ok) throw new Error(body?.error || '记账失败');
  return body;
}

export async function ledgerSummary({ url, token, days = 30 }) {
  const base = normalizeHubUrl(url);
  if (!base) throw new Error('还没连上家里中枢');
  const body = await httpJson(`${base}/api/court/ledger?days=${days}`, {
    method: 'GET',
    headers: token ? { 'x-hub-token': token } : {},
  }, 8000);
  return body?.summary ?? null;
}

/* --------------------------- 国事状态（国家大事 / 差事 / 流水） --------------------------- */

/** 取中枢那一份全量国事（含删除墓碑） */
export async function getCourtState({ url, token, memberId }) {
  const base = normalizeHubUrl(url);
  if (!base) throw new Error('还没连上家里中枢');
  const q = memberId ? `?memberId=${encodeURIComponent(memberId)}` : '';
  return httpJson(`${base}/api/court/state${q}`, {
    method: 'GET',
    headers: token ? { 'x-hub-token': token } : {},
  }, 10000);
}

/** 把本机记的国事推给中枢，拿回合并后的全量 */
export async function pushCourtState({ url, token, memberId, state }) {
  const base = normalizeHubUrl(url);
  if (!base) throw new Error('还没连上家里中枢');
  const body = await httpJson(`${base}/api/court/state`, {
    method: 'POST',
    headers: token ? { 'x-hub-token': token } : {},
    body: JSON.stringify({ memberId, state }),
  }, 15000);
  if (!body?.ok) throw new Error(body?.error || '国事传不上去');
  return body;
}

/* --------------------------- 账单 / 国家大事 / 头像 --------------------------- */

export async function getUsage({ url, token }) {
  const base = normalizeHubUrl(url);
  if (!base) throw new Error('还没连上家里中枢');
  return httpJson(`${base}/api/usage`, { method: 'GET', headers: token ? { 'x-hub-token': token } : {} }, 10000);
}

export async function getAnnual({ url, token }) {
  const base = normalizeHubUrl(url);
  if (!base) throw new Error('还没连上家里中枢');
  return httpJson(`${base}/api/annual`, { method: 'GET', headers: token ? { 'x-hub-token': token } : {} }, 8000);
}

export async function addAnnual({ url, token, memberId, text, period = 'year' }) {
  const base = normalizeHubUrl(url);
  if (!base) throw new Error('还没连上家里中枢');
  const body = await httpJson(`${base}/api/annual`, {
    method: 'POST',
    headers: token ? { 'x-hub-token': token } : {},
    body: JSON.stringify({ memberId, text, period }),
  }, 8000);
  if (!body?.ok) throw new Error(body?.error || '加不上');
  return body;
}

export async function updateAnnual({ url, token, memberId, id, status, text, progress, period }) {
  const base = normalizeHubUrl(url);
  if (!base) throw new Error('还没连上家里中枢');
  const body = await httpJson(`${base}/api/annual/update`, {
    method: 'POST',
    headers: token ? { 'x-hub-token': token } : {},
    body: JSON.stringify({ memberId, id, status, text, progress, period }),
  }, 8000);
  if (!body?.ok) throw new Error(body?.error || '改不了');
  return body;
}

/* --------------------------- 六部任务（发圣旨） --------------------------- */

export async function listDeptTasks({ url, token, dept }) {
  const base = normalizeHubUrl(url);
  if (!base) throw new Error('还没连上家里中枢');
  return httpJson(`${base}/api/court/tasks?dept=${encodeURIComponent(dept)}`, {
    method: 'GET',
    headers: token ? { 'x-hub-token': token } : {},
  }, 8000);
}

export async function addDeptTask({ url, token, memberId, dept, text }) {
  const base = normalizeHubUrl(url);
  if (!base) throw new Error('还没连上家里中枢');
  const body = await httpJson(`${base}/api/court/tasks`, {
    method: 'POST',
    headers: token ? { 'x-hub-token': token } : {},
    body: JSON.stringify({ memberId, dept, text }),
  }, 8000);
  if (!body?.ok) throw new Error(body?.error || '下旨失败');
  return body;
}

export async function updateDeptTask({ url, token, dept, id, progress, text }) {
  const base = normalizeHubUrl(url);
  if (!base) throw new Error('还没连上家里中枢');
  const body = await httpJson(`${base}/api/court/task/update`, {
    method: 'POST',
    headers: token ? { 'x-hub-token': token } : {},
    body: JSON.stringify({ dept, id, progress, text }),
  }, 8000);
  if (!body?.ok) throw new Error(body?.error || '改不动');
  return body;
}

export async function deleteDeptTask({ url, token, memberId, dept, id }) {
  const base = normalizeHubUrl(url);
  if (!base) throw new Error('还没连上家里中枢');
  const body = await httpJson(`${base}/api/court/task/delete`, {
    method: 'POST',
    headers: token ? { 'x-hub-token': token } : {},
    body: JSON.stringify({ memberId, dept, id }),
  }, 8000);
  if (!body?.ok) throw new Error(body?.error || '撤不掉');
  return body;
}

export async function deleteAnnual({ url, token, memberId, id }) {
  const base = normalizeHubUrl(url);
  if (!base) throw new Error('还没连上家里中枢');
  const body = await httpJson(`${base}/api/annual/delete`, {
    method: 'POST',
    headers: token ? { 'x-hub-token': token } : {},
    body: JSON.stringify({ memberId, id }),
  }, 8000);
  if (!body?.ok) throw new Error(body?.error || '删不掉');
  return body;
}

export async function uploadAvatar({ url, token, memberId, dataUrl }) {
  const base = normalizeHubUrl(url);
  if (!base) throw new Error('还没连上家里中枢');
  const body = await httpJson(`${base}/api/avatar`, {
    method: 'POST',
    headers: token ? { 'x-hub-token': token } : {},
    body: JSON.stringify({ memberId, dataUrl }),
  }, 15000);
  if (!body?.ok) throw new Error(body?.error || '头像传不上去');
  return body;
}
