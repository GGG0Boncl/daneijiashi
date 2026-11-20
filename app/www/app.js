/**
 * 家庭打卡 · 界面逻辑
 * 刻意不引框架：页面小、改起来快、出问题好定位。
 */
import * as core from './core.js';
import * as court from './court.js';
import * as lunar from './lunar.js';
import { COURT_DEPTS as DEFAULT_DEPTS } from './depts.js';
import { DEPT_NAMES, routeByRules, sanitizeDispatchItems } from './dispatch-rules.js';
import { store } from './db.js';
import { mergeRecords } from './merge.js';
import { memberIdProblem, normalizeMemberId } from './member-id.js';
import {
  discoverHub, normalizeHubUrl, syncWithHub, testHub, analyzeWithHub, listAnalysesOnHub, getAnalysis,
  getCourtConfig, setCourtRole, summonDept, dispatchWithHub, listMemorials, getMemorial, disposeMemorial, courtMeeting,
  getUsage, pushCourtState, uploadAvatar,
} from './sync.js';
import {
  applyPlan, ensurePermission, ensureChannel, sendTestNotification,
  notificationStatus, openExactAlarmSetting,
} from './notify.js';

const $ = (sel) => document.querySelector(sel);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const state = {
  identity: null,
  hub: { url: '', token: '', lastSyncAt: null, lastError: null, hubTime: null },
  ui: { showAll: {}, ledgerRange: '7' },
  ai: { available: null, model: null, days: [7, 14, 30, 90], lastDays: 30, reason: null, history: [], loadingHistory: false },
  court: {
    config: null,
    memorials: [],
    roles: {},
    role: 'member',
    roleLabel: '家人',
    depts: [],
    state: court.emptyCourtState(),
    loading: false,
    syncing: false,
    current: null,
    currentDept: null,
  },
  usage: { balance: null, today: null, month: null, recent: [], loading: false },
  avatar: { dataUrl: null },
  aiLoading: false,
  records: [],
  page: 'court',
  calMonth: core.monthKey(core.bjToday()),
  retention: 12,
  syncing: false,
  dirty: 0,
  online: navigator.onLine !== false,
};

/* ------------------------------- 小工具 ------------------------------- */

let toastTimer = null;
function toast(msg, ms = 2200) {
  const el = $('#toast');
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, ms);
}

function whatTime(iso) {
  if (!iso) return '还没同步过';
  return String(iso).slice(11, 16);
}

function dayOfWeek(date) {
  return core.weekdayLabel(date);
}

function fmtDateTime(iso) {
  if (!iso) return '—';
  return `${iso.slice(5, 10)} ${iso.slice(11, 16)}`;
}

/** 到点提醒的统一写法：今天/明天只写时刻，往后写月日 */
function dueLabel(due) {
  const ms = Date.parse(String(due ?? ''));
  if (!Number.isFinite(ms)) return '';
  const p = core.bjParts(new Date(ms));
  const time = p.time.slice(0, 5);
  if (p.date === core.bjToday()) return `⏰ 今天 ${time}`;
  if (p.date === core.addDays(core.bjToday(), 1)) return `⏰ 明天 ${time}`;
  return `⏰ ${p.date.slice(5).replace('-', '/')} ${time}`;
}

/** 小额也留 4 位：调一次模型常常只花几厘钱 */
const fmtYuan = (n, digits = 4) => {
  const v = Number(n) || 0;
  return v <= 0 ? '¥0' : `¥${v.toFixed(digits)}`;
};

/* ------------------------------- 身份 ------------------------------- */

function newDeviceId() {
  return `dev-${Math.random().toString(36).slice(2, 8)}`;
}

async function loadIdentity() {
  const saved = await store.getMeta('identity', null);
  if (saved?.memberId) {
    state.identity = saved;
    return saved;
  }
  return null;
}

async function saveIdentity(name) {
  const memberId = normalizeMemberId(name);
  const problem = memberIdProblem(memberId);
  if (problem) throw new Error(problem);
  const identity = { memberId, memberName: memberId, deviceId: newDeviceId(), createdAt: new Date().toISOString() };
  await store.setMeta('identity', identity);
  state.identity = identity;
  return identity;
}

/* ------------------------------- 数据 ------------------------------- */

async function loadAll() {
  state.records = await store.allRecords();
  state.hub.url = (await store.getMeta('hubUrl', '')) ?? '';
  state.hub.token = (await store.getMeta('hubToken', '')) ?? '';
  state.hub.lastSyncAt = (await store.getMeta('lastSyncAt', null)) ?? null;
  state.retention = Number((await store.getMeta('retentionMonths', 12)) ?? 12);
}

/**
 * 历史保留：只留最近 N 个月（3 / 6 / 12，最长一年）。
 * 只删这台手机上的旧记录，中枢上还有一份；换手机前请先「复制全部数据」。
 */
async function applyRetention({ notify = false } = {}) {
  const { kept, removed } = core.pruneRecords(state.records, state.retention);
  if (!removed.length) return 0;
  for (const rec of removed) await store.deleteRecord(rec.date);
  state.records = kept;
  if (notify) toast(`已清理 ${removed.length} 天超过保留期的记录`);
  return removed.length;
}

function retentionLabel() {
  const opt = core.RETENTION_OPTIONS.find((o) => o.months === state.retention);
  return opt ? opt.label : `${state.retention} 个月`;
}

const todayRecord = () => state.records.find((r) => r.date === core.bjToday()) ?? null;

async function updateDay(date, mutator) {
  const idx = state.records.findIndex((r) => r.date === date);
  const base = idx >= 0 ? state.records[idx] : core.createRecord(state.identity, date);
  const next = mutator(base);
  if (idx >= 0) state.records[idx] = next;
  else state.records.push(next);
  state.records.sort((a, b) => a.date.localeCompare(b.date));
  await store.putRecord(next);
  render();
  afterChange();
}

const updateToday = (fn) => updateDay(core.bjToday(), fn);

/** 重排提醒：打卡计划 + 国事里带钟点的差事 */
const replan = () => applyPlan(state.records, new Date(), state.court.state);

let syncTimer = null;
function afterChange() {
  void replan();
  markDirty();
  clearTimeout(syncTimer);
  syncTimer = setTimeout(() => { void runSync(false); }, 1500);
}

/** 记下"还有东西没传"，驿路上的小牌牌会如实说 */
function markDirty() {
  state.dirty = Math.min(99, (state.dirty ?? 0) + 1);
  renderSyncPill();
}

/* ------------------------------- 同步 ------------------------------- */

async function runSync(manual = false) {
  if (state.syncing) return;
  if (!state.hub.url) {
    const found = await discoverHub();
    if (found) {
      state.hub.url = found.url;
      await store.setMeta('hubUrl', found.url);
    } else if (manual) {
      toast('没找到家里的中枢，检查是否连了同一个 WiFi，或手填地址');
      return;
    } else {
      return;
    }
  }
  state.syncing = true;
  renderSyncPill();
  try {
    const res = await syncWithHub({
      url: state.hub.url,
      token: state.hub.token,
      memberId: state.identity.memberId,
      memberName: state.identity.memberName,
      deviceId: state.identity.deviceId,
      mode: manual ? 'manual' : 'auto',
      records: state.records,
    });
    // 和本地已有记录再合并一次：中枢没见过的老记录不会因为"这次没上传"就从内存里丢掉
    const mergedLocal = mergeRecords(state.records, res.records);
    await store.putRecords(mergedLocal);
    state.records = mergedLocal;
    state.hub.lastSyncAt = res.serverTime;
    state.hub.hubTime = res.serverTime;
    state.hub.lastError = null;
    state.dirty = 0;
    renderSyncPill();
    await store.setMeta('lastSyncAt', res.serverTime);
    if (manual) toast(`同步完成，中枢写入了 ${res.written ?? 0} 天`);
    await applyPlan(state.records, new Date(), state.court.state);
    void loadAiInfo();
    void loadAiHistory();
    render();
    // 国事、奏疏、账单各推各取；哪一样出错都不耽误打卡同步
    await syncCourtNow({ quiet: !manual });
    await ensureCourt();
  } catch (err) {
    state.hub.lastError = String(err?.message ?? err);
    if (manual) toast(`同步失败：${state.hub.lastError}`);
    renderSyncPill();
  } finally {
    state.syncing = false;
    renderSyncPill();
  }
}

/** 问中枢要一下"能不能做 AI 复盘、能用哪些天数" */
async function loadAiInfo(force = false) {
  if (!state.hub.url) return state.ai;
  if (!force && state.ai.available !== null) return state.ai;
  try {
    const info = await testHub(state.hub.url);
    if (info?.analysis) {
      state.ai = {
        ...state.ai,
        available: Boolean(info.analysis.available),
        model: info.analysis.model ?? null,
        days: Array.isArray(info.analysis.days) && info.analysis.days.length ? info.analysis.days : state.ai.days,
        reason: info.analysis.reason ?? null,
      };
    }
  } catch {
    /* 离线就保持原样，下次同步再问 */
  }
  return state.ai;
}

/** 拉自己的历史复盘（中枢已按"每个天数最多 3 条"筛好） */
async function loadAiHistory() {
  if (!state.hub.url || !state.identity || state.ai.loadingHistory) return;
  state.ai.loadingHistory = true;
  try {
    state.ai.history = await listAnalysesOnHub({
      url: state.hub.url,
      token: state.hub.token,
      memberId: state.identity.memberId,
    });
  } catch {
    /* 离线时保持旧列表，不清空 */
  } finally {
    state.ai.loadingHistory = false;
  }
  if (state.page === 'daily') renderAI();
}

async function runAiAnalysis(days, force = false) {
  if (!state.hub.url) {
    toast('还没连上家里中枢，连上再做 AI 复盘');
    return;
  }
  if (!state.identity) return;
  const n = Math.trunc(Number(days));
  if (!Number.isFinite(n) || n < 1 || n > 365) {
    toast('推演天数写 1 到 365 之间的整数');
    return;
  }
  days = n;
  state.ai.lastDays = days;
  if (force && !confirm(`重新生成最近 ${days} 天的复盘？会重新调用模型（消耗 token）。`)) return;
  state.aiLoading = true;
  renderAI();
  openSheet(`<h3>AI 正在复盘最近 ${days} 天…</h3><p class="s">${force ? '这次是强制重新生成' : '数据没变化的话会直接用上次结果，不花 token'}，通常 10~40 秒</p>`);
  try {
    const a = await analyzeWithHub({
      url: state.hub.url,
      token: state.hub.token,
      memberId: state.identity.memberId,
      days,
      force,
    });
    closeSheet();
    showAnalysisSheet(a);
    applyQuota(a.quota, a.cached ? '旧推演' : '钦天监推演完毕');
    if (a.cached) toast('数据没变，用的是上次结果（未耗分文）', 3000);
    void loadAiHistory();
  } catch (err) {
    closeSheet();
    toast(`复盘失败：${String(err?.message ?? err)}`, 4200);
  } finally {
    state.aiLoading = false;
    renderAI();
  }
}

/** 复盘结果弹层（缓存的结果可以在里面强制重算） */
function showAnalysisSheet(a) {
  const badge = a.cached ? ' · 缓存' : '';
  openSheet(`
    <h3>${esc(a.memberName)} · 最近 ${a.days} 天复盘${badge}</h3>
    <p class="s">${esc(a.model)} · ${a.cached ? '未消耗 token' : `${a.usage?.total_tokens ?? '?'} tokens`} · ${a.from} ~ ${a.to}</p>
    <pre class="ai-result">${esc(a.text)}</pre>
    <div class="sheet-actions">
      <button class="btn ghost" id="aiRegen">重新生成</button>
      <button class="btn" id="aiClose">关上</button>
    </div>
  `, (root) => {
    root.querySelector('#aiClose').addEventListener('click', closeSheet);
    root.querySelector('#aiRegen').addEventListener('click', () => {
      closeSheet();
      void runAiAnalysis(a.days, true);
    });
  });
}

/** 打开历史里的一份复盘（按 id 取全文） */
async function openHistoryAnalysis(id) {
  openSheet('<h3>正在读取…</h3>');
  try {
    const a = await getAnalysis({ url: state.hub.url, token: state.hub.token, id });
    closeSheet();
    showAnalysisSheet({ ...a, cached: false });
  } catch (err) {
    closeSheet();
    toast(`打不开：${String(err?.message ?? err)}`);
  }
}

function renderSyncPill() {
  const el = $('#syncPill');
  if (!el) return;
  el.classList.remove('on', 'off');
  if (state.syncing) {
    el.textContent = '驿马在途…';
    return;
  }
  if (!state.hub.url) {
    el.textContent = '驿路未通 · 点我找中枢';
    el.classList.add('off');
    return;
  }
  if (state.hub.lastError) {
    el.textContent = '驿马受阻 · 点我重试';
    el.classList.add('off');
    return;
  }
  if (state.dirty > 0) {
    el.textContent = `待传 ${state.dirty} 处 · 点我传书`;
    return;
  }
  el.textContent = state.hub.lastSyncAt ? `已同步 ${whatTime(state.hub.lastSyncAt)}` : '待同步 · 点我传书';
  el.classList.add('on');
}

/** 顶上那块小牌牌就是同步按钮：没连上就找中枢，有未传的就传书 */
async function syncFromPill() {
  if (!state.hub.url) {
    const found = await discoverHub();
    if (!found) {
      toast('没找着中枢：确认电脑上 start-hub.cmd 在跑，或到「朕的私事」里手填地址', 4600);
      openSettingsSheet();
      return;
    }
    state.hub.url = found.url;
    await store.setMeta('hubUrl', found.url);
    render();
    toast(`找到中枢：${found.url}`, 2600);
  }
  await runSync(true);
}

/* ------------------------------- 渲染 ------------------------------- */

function renderHeader() {
  const today = core.bjToday();
  const identity = state.identity ?? {};
  const role = state.court.role;
  const title = role === 'emperor' ? '陛下' : role === 'empress' ? '娘娘' : '';
  $('#greet').textContent = `${title ? `${title}·` : ''}${identity.memberName ?? '客官'}`;
  $('#subline').textContent = role === 'member'
    ? '有事上奏，无事退朝；今日的差事办了几桩？'
    : '朕与娘娘共治此国，六部奏疏俱在御书房候着';
  $('#dateLine').textContent = today.slice(5).replace('-', ' / ');
  const lunarLine = lunar.fullLabel(today);
  $('#weekdayLine').textContent = lunarLine ? `${dayOfWeek(today)} · ${lunarLine}` : dayOfWeek(today);
  const rec = todayRecord();
  const s = core.summarize(rec);
  $('#todayNote').textContent = s.settled ? `已了 ${s.done}/${s.total} 桩` : '';

  // 头像：本地有就显示，没有就显示身份字
  const img = $('#avatarImg');
  const fallback = $('#avatarFallback');
  if (img && fallback) {
    if (state.avatar.dataUrl) {
      img.src = state.avatar.dataUrl;
      img.hidden = false;
      fallback.hidden = true;
    } else {
      img.hidden = true;
      fallback.hidden = false;
      fallback.textContent = role === 'emperor' ? '朕' : role === 'empress' ? '后' : '臣';
    }
  }
}

/** 圆圈进度：不占地方，点开才弹滑块；圈里直接写百分比 */
function pctDot(pct, attrs = '', extraClass = '') {
  const p = Math.max(0, Math.min(100, Math.round(Number(pct) || 0)));
  const cls = p >= 100 ? 'done' : p > 0 ? 'doing' : '';
  return `<button type="button" class="pct-dot ${cls} ${extraClass}" style="--p:${p}" data-p="${p}" ${attrs} aria-label="办到几成"><span>${p}%</span></button>`;
}

function goalRow(g) {
  const pct = Number.isFinite(Number(g.progress)) ? Number(g.progress) : g.status === 'done' ? 100 : 0;
  const meta = [];
  if (g.due) meta.push(`<span class="goal-due">${esc(dueLabel(g.due))}</span>`);
  if (g.checkedAt) meta.push(`回话于 ${whatTime(g.checkedAt)}`);
  if (g.note) meta.push(`<span class="note">附言：${esc(g.note)}</span>`);
  return `<div class="goal" data-id="${esc(g.id)}">
    ${pctDot(pct, `data-progress-open="goal" data-goal="${esc(g.id)}"`)}
    <div class="goal-main">
      <div class="goal-text ${pct >= 100 ? 'done' : ''}" data-act="edit">${esc(g.text)}</div>
      ${meta.length ? `<div class="goal-meta">${meta.join(' · ')}</div>` : ''}
    </div>
    <div class="acts">
      <button class="icon-btn ${g.status === 'failed' ? 'warn' : ''}" data-act="fail" aria-label="没办成">✗</button>
      <button class="icon-btn" data-act="more" aria-label="更多">⋯</button>
    </div>
  </div>`;
}

function renderToday() {
  const rec = todayRecord();
  const all = core.liveGoals(rec);
  const s = core.summarize(rec);
  const showAll = Boolean(state.ui.showAll.today);
  const goals = showAll ? all : all.filter((g) => (Number(g.progress) || (g.status === 'done' ? 100 : 0)) < 100 && g.status !== 'failed');
  const hidden = all.length - goals.length;

  const list = goals.length
    ? goals.map(goalRow).join('')
    : `<div class="empty"><span class="cat">🐱</span>${all.length ? '今日差事俱已办成' : '今日尚无差事，由司礼监传旨生成'}</div>`;

  const pct = all.length ? Math.round(all.reduce((a, g) => a + (Number(g.progress) || (g.status === 'done' ? 100 : 0)), 0) / all.length) : 0;

  $('#todayCard').innerHTML = `
    <div class="ai-head">
      <span>📜 今日差事</span>
      <span class="ai-tag">${all.length ? `均 ${pct}%` : '尚未着落'}</span>
      ${hidden > 0 ? `<button class="mini-btn" data-showall="today">查看全部（${all.length}）</button>` : ''}
      ${showAll && all.length ? '<button class="mini-btn" data-showall="today">只看未了</button>' : ''}
    </div>
    ${list}
    <div class="ai-note">今日差事也由司礼监传旨生成；在朝廷页「司礼监 · 传旨」里说一声即可。</div>
  `;

  const hint = [];
  if (s.settled && s.done === s.total) hint.push('今日差事俱已办成，且去歇着');
  else if (s.settled) hint.push(`尚有 ${s.pending} 桩未了，点前面的圈记进度`);
  if (!state.hub.url) hint.push('驿路未通，诸事照记本机，连上自会传书');
  $('#todayHint').textContent = hint.join(' · ');
}

function renderHistory() {
  const now = new Date();
  const key = state.calMonth;
  const cells = core.calendarGrid(key, state.records, now);
  const sum = core.monthSummary(key, state.records, now);
  const earliest = core.earliestMonth(now, state.retention);
  const latest = core.monthKey(core.bjToday(now));
  const canPrev = key > earliest;
  const canNext = key < latest;
  const [y, m] = key.split('-');
  const week = ['一', '二', '三', '四', '五', '六', '日'];

  const cellsHtml = cells.map((c) => {
    if (c.blank) return '<div class="cal-cell blank"></div>';
    const pct = c.total ? Math.round((c.done / c.total) * 100) : 0;
    const mini = c.total ? `<span class="mini"><i style="width:${pct}%"></i></span>` : '';
    const lunarText = lunar.lunarLabel(c.date);
    const festival = lunar.festivalOf(c.date);
    const lunarHtml = lunarText
      ? `<span class="lunar ${festival ? 'fest' : ''}">${esc(lunarText)}</span>`
      : '';
    const cls = ['cal-cell', `l${c.level}`, c.isToday ? 'today' : '', c.future ? 'future' : '']
      .filter(Boolean)
      .join(' ');
    return `<button type="button" class="${cls}" data-date="${c.date}" ${c.future ? 'disabled' : ''}
      aria-label="${c.date} ${esc(lunarText)}">${`<span class="dnum">${c.day}</span>`}${mini}${lunarHtml}</button>`;
  }).join('');

  const monthly = sum.submitted
    ? `本月记下 ${sum.submitted} 天 · 办成 ${sum.done}/${sum.total} 桩（${Math.round(sum.rate * 100)}%）`
    : '本月尚无记录';

  $('#historyCard').innerHTML = `
    <div class="ai-head" style="margin-bottom:8px"><span>🗓 行事历</span><span class="ai-tag">${monthly}</span></div>
    <div class="cal-head">
      <button class="cal-nav" data-cal="prev" ${canPrev ? '' : 'disabled'} aria-label="上个月">‹</button>
      <div class="cal-title">${y} 年 ${Number(m)} 月</div>
      <button class="cal-nav" data-cal="next" ${canNext ? '' : 'disabled'} aria-label="下个月">›</button>
      <button class="cal-today btn ghost" data-cal="today">回到本月</button>
    </div>
    <div class="cal-week">${week.map((w) => `<span>${w}</span>`).join('')}</div>
    <div class="cal-grid">${cellsHtml}</div>
    <div class="cal-legend">
      <span><i class="lg l0"></i>无记录</span>
      <span><i class="lg l1"></i>没办成</span>
      <span><i class="lg l2"></i>半途</span>
      <span><i class="lg l3"></i>俱办成</span>
    </div>
  `;
  $('#historySummary').textContent = `${monthly} · 可回看 ${retentionLabel()}`;
  renderAI();
  void loadAiHistory();
}

/** 历史页底部的 "让 AI 复盘" 卡片（含历史复盘列表） */
function renderAI() {
  const el = $('#aiCard');
  if (!el) return;
  const ai = state.ai;
  const usable = ai.available === true && !state.aiLoading;
  const stateText = ai.available === null
    ? '还没连上中枢'
    : ai.available
      ? `中枢在线 · ${ai.model ?? 'deepseek'}`
      : '中枢说暂时不能复盘';
  const dayValue = Math.max(1, Math.min(365, Math.trunc(Number(ai.lastDays) || 30)));

  const history = ai.history ?? [];
  const histHtml = history.length
    ? `<div class="ai-hist">${history.map((h) => `
        <button type="button" class="ai-hist-item" data-ai-id="${esc(h.id)}">
          <span>${String(h.createdAt ?? '').slice(5, 16).replace('T', ' ')}</span>
          <span class="ai-hist-days">${h.days} 天</span>
          <span class="ai-hist-chars">${h.chars ?? ''} 字</span>
        </button>`).join('')}
      </div>`
    : `<div class="ai-note">${ai.available === false ? '' : '尚无旧推演。填个天数，让钦天监算一卦；算过之后可随时翻看。'}</div>`;

  el.innerHTML = `
    <div class="ai-head">
      <span>🧭 钦天监推演</span>
      <span class="ai-tag ${usable ? 'on' : ''}">${esc(state.aiLoading ? '正在掐算…' : stateText)}</span>
    </div>
    <div class="ai-note"><b>此为何用：</b>把最近这些天的差事、进度与未了的账，交给钦天监（DeepSeek 模型）算一卦——哪几桩拖住了、哪几天最勤、往后先办哪件。写个天数即可推演，1 到 365 天都成。</div>
    <div class="ai-days">
      <label class="ai-days-label">推演
        <input id="aiDaysInput" type="number" inputmode="numeric" min="1" max="365" step="1" value="${dayValue}" ${usable ? '' : 'disabled'}>
        天
      </label>
      <button type="button" class="ai-btn" id="aiRun" ${usable ? '' : 'disabled'}>掐算</button>
    </div>
    <div class="ai-note">${ai.available === false
      ? esc(ai.reason || '中枢还没配置模型 key，看板页有说明')
      : '同一段天下事只算一次：没变化就翻旧卦，不费分文；想看新的再点「重新推演」。推演要连中枢，离线可翻旧卦存档。'}</div>
    ${histHtml}
  `;
}

/* ---------------------- 家国：国家大事 / 账房 / 流水 ---------------------- */

/** 每次调模型的"账单"：这次花了多少、今日共多少、账上还剩多少 */
function applyQuota(q, label) {
  if (!q) return;
  state.usage = {
    ...state.usage,
    balance: q.balance ?? state.usage.balance,
    today: q.today ?? state.usage.today,
    month: q.month ?? state.usage.month,
    recent: q.recent ?? state.usage.recent,
  };
  void store.setMeta('usageCache', state.usage);
  renderUsageLine();
  const lastCost = Number(q.recent?.[0]?.cost) || 0;
  const bal = q.balance?.ok ? `账上尚余 ¥${Number(q.balance.total).toFixed(2)}` : '余额暂不可查';
  const thisPart = lastCost > 0 ? `本次约 ${fmtYuan(lastCost)}` : '本次未耗分文';
  toast(`${label}｜${thisPart}，今日约 ${fmtYuan(q.today?.cost)}（${q.today?.tokens ?? 0} tokens），${bal}`, 5000);
}

/** 中枢账房只做一行小字，点开看每次花了多少钱（它不是日常花销，是调模型的钱） */
function renderUsageLine() {
  const el = $('#usageLine');
  if (!el) return;
  const u = state.usage;
  const bal = u.balance?.ok ? `余 ¥${Number(u.balance.total).toFixed(2)}` : '余款不详';
  el.textContent = `🏦 今日已耗 ${fmtYuan(u.today?.cost)}（${u.today?.tokens ?? 0} tokens / ${u.today?.calls ?? 0} 次）· ${bal} · 点看中枢账房`;
  el.onclick = openUsageSheet;
}

function openUsageSheet() {
  const u = state.usage;
  const deptName = (id) => DEPT_NAMES[id] ?? deptList().find((d) => d.id === id)?.name ?? id ?? '六部';
  const kindLabel = (r) => (r.kind === 'analysis' ? '钦天监推演' : r.kind === 'dispatch' ? '司礼监传旨' : `奏疏·${deptName(r.dept)}`);
  const costText = (r) => {
    if (r.cached) return '未耗分文';
    const c = Number(r.cost) || 0;
    return `${r.costEstimated ? '约 ' : ''}${fmtYuan(c)}`;
  };
  const rows = (u.recent ?? []).length
    ? u.recent.slice(0, 15).map((r) => `<div class="usage-row"><span>${String(r.at ?? '').slice(5, 16).replace('T', ' ')}</span><span>${esc(kindLabel(r))}</span><span class="usage-cost">${esc(costText(r))}</span><span class="usage-tok">${r.cached ? '缓存' : `${r.tokens ?? 0} tok`}</span></div>`).join('')
    : '<div class="ai-note">尚无流水；召见六部、传旨或让钦天监推演一次便有了。</div>';
  openSheet(`
    <h3>🏦 中枢账房</h3>
    <p class="s">今日 ${u.today?.calls ?? 0} 次 / ${u.today?.tokens ?? 0} tokens · 约 ${fmtYuan(u.today?.cost)}；今月约 ${fmtYuan(u.month?.cost)} · ${u.balance?.ok ? `账上尚余 ¥${Number(u.balance.total).toFixed(2)}` : '余额暂不可查'}</p>
    <div class="usage-list">${rows}</div>
    <div class="ai-note">金额按 DeepSeek 价目估算（闲时半价已算进去；缓存命中记 0），最终以账户扣费为准。${
      u.price ? `现价：输入 ¥${u.price.miss}/百万、输出 ¥${u.price.out}/百万 tokens。` : ''
    }</div>
    <div class="sheet-actions"><button class="btn block" id="usageClose">关上</button></div>
  `, (root) => root.querySelector('#usageClose').addEventListener('click', closeSheet));
}

/* ---------------------- 国事（本机先记，中枢后合） ---------------------- */

let courtSyncTimer = null;
function scheduleCourtSync(delay = 1500) {
  clearTimeout(courtSyncTimer);
  courtSyncTimer = setTimeout(() => { void syncCourtNow(); }, delay);
}

/** 拉/推国事状态；离线时静默失败，改动留在本机 */
async function syncCourtNow({ quiet = true } = {}) {
  if (!state.hub.url || !state.identity || state.court.syncing) return;
  state.court.syncing = true;
  try {
    const me = state.identity.memberId;
    const wantedRole = state.court.roles?.[me];
    let res = await pushCourtState({
      url: state.hub.url,
      token: state.hub.token,
      memberId: me,
      state: state.court.state,
    });
    if (!res?.state) return;

    // 中枢不认本机的身份（常见：身份只在本机设过）→ 把本机身份推给中枢再传一次
    let rejectedTasks = res.rejected?.tasks === true;
    if (rejectedTasks && (wantedRole === 'emperor' || wantedRole === 'empress')) {
      try {
        await setCourtRole({ url: state.hub.url, token: state.hub.token, memberId: me, role: wantedRole });
        const retry = await pushCourtState({
          url: state.hub.url,
          token: state.hub.token,
          memberId: me,
          state: state.court.state,
        });
        if (retry?.state) {
          res = retry;
          rejectedTasks = retry.rejected?.tasks === true;
        }
      } catch {
        /* 推不上去就保持本机 */
      }
    }

    const merged = court.mergeCourtState(state.court.state, res.state);
    if (res.rejected?.annual) merged.annual = res.state.annual;
    // 六部差事被中枢拒绝时，保留本机这份（别让刚传的旨凭空消失）
    state.court.state = merged;
    await store.setMeta('courtState', merged);
    if (res.role && state.court.roles?.[me] !== res.role) {
      state.court.roles = { ...state.court.roles, [me]: res.role };
      await store.setMeta('courtRoles', state.court.roles);
    }
    refreshRole();
    renderAnnual();
    renderDispatchCard();
    renderCourt();
    state.dirty = 0;
    renderSyncPill();
    if (!quiet) toast('六部台账已与中枢对账', 2200);
    if (res.rejected?.annual) toast('内阁大事只能由陛下与皇后定夺，本机改动已退回', 4200);
    if (res.rejected?.annualIds?.length) toast('有一桩内阁大事今年调整次数已满，措辞未准', 4200);
    if (rejectedTasks && !state.court.roleWarned) {
      state.court.roleWarned = true;
      toast('中枢没认六部差事：到「朕的私事」把身份设为陛下 / 皇后，再点驿牌传书', 5200);
    }
  } catch {
    /* 驿路未通：记在本机，回头再传 */
  } finally {
    state.court.syncing = false;
  }
}

/** 改一次本机国事：存盘 → 重画 → 稍后推给中枢 */
async function applyCourt(mutator, { rerender = true } = {}) {
  const next = mutator(state.court.state);
  state.court.state = court.normalizeCourtState(next);
  await store.setMeta('courtState', state.court.state);
  void replan();
  markDirty();
  if (rerender) render();
  scheduleCourtSync();
  return state.court.state;
}

const ANNUAL_LABEL = { pending: '还没动', doing: '在办', done: '已办成' };
const ANNUAL_PERIOD_LABEL = { year: '年度', half: '半年度' };

function annualRow(item) {
  const left = court.adjustmentsLeft(item);
  const pct = item.progress ?? 0;
  const budget = Number(item.budget) > 0 ? `<span class="annual-money">预算 ¥${item.budget}</span>` : '';
  return `<div class="annual-item">
    ${pctDot(pct, `data-progress-open="annual" data-annual="${esc(item.id)}"`)}
    <div class="annual-main">
      <div class="annual-text ${item.status === 'done' ? 'done' : ''}">${esc(item.text)}</div>
      <div class="annual-sub">
        <span class="annual-period">${ANNUAL_PERIOD_LABEL[item.period] ?? '年度'}</span>
        <span>${ANNUAL_LABEL[item.status] ?? item.status}</span>
        ${budget}
        <span>本年可调 ${left} 次</span>
      </div>
    </div>
    ${canRule() ? `<button class="annual-more" data-annual-more="${esc(item.id)}" aria-label="改这桩">⋯</button>` : ''}
  </div>`;
}

function renderAnnual() {
  const el = $('#annualCard');
  if (!el) return;
  const all = state.court.state?.annual?.items ?? [];
  const showAll = Boolean(state.ui.showAll.annual);
  const items = showAll ? all : all.filter((i) => i.status !== 'done');
  const hidden = all.length - items.length;
  const sum = court.annualSummary(state.court.state);
  const canEdit = canRule();
  const tag = all.length
    ? `${sum.done}/${sum.total} 办成${sum.budgetTotal > 0 ? ` · 预算 ¥${sum.budgetTotal}` : ` · 均 ${sum.avg}%`}`
    : '尚未立事';
  el.innerHTML = `
    <div class="ai-head">
      <span>🏯 内阁</span>
      <span class="ai-tag">${tag}</span>
      ${hidden > 0 ? `<button class="mini-btn" data-showall="annual">查看全部（${all.length}）</button>` : ''}
      ${showAll && all.length ? '<button class="mini-btn" data-showall="annual">只看未办成</button>' : ''}
    </div>
    <div class="ai-note">本年度的大计与银钱：计划带预算，进度随时可记。内阁不自添事——都由司礼监传旨定夺；改措辞或预算每桩每年限 ${court.ANNUAL_ADJUST_LIMIT} 次。</div>
    ${items.length ? `<div class="annual-list">${items.map(annualRow).join('')}</div>` : ''}
    ${!items.length && all.length ? '<div class="ai-note">内阁大事俱已办成，可「查看全部」翻旧账。</div>' : ''}
    ${!all.length
      ? (canEdit
        ? '<div class="annual-empty-note"><span class="cat">🏯</span><b>内阁还无一桩大事</b><span>到司礼监传旨，定下今年的计划与预算</span></div>'
        : '<div class="empty">内阁还无一桩大事，由陛下与皇后定夺。</div>')
      : ''}
    ${canEdit && all.length ? '<div class="ai-note">要添新事、改预算，都去司礼监传旨。</div>' : ''}
    ${!canEdit && all.length ? '<div class="ai-note">（内阁大事由陛下与皇后定夺）</div>' : ''}
  `;
}

function openAnnualEditSheet(id) {
  const item = (state.court.state.annual.items ?? []).find((i) => i.id === id);
  if (!item) return;
  const left = court.adjustmentsLeft(item);
  const locked = left <= 0;
  openSheet(`
    <h3>改这桩内阁大事</h3>
    <p class="s">本年还可调整 ${left} 次。改措辞、周期或预算才算一次；记进度不算。</p>
    <input id="annualEditText" type="text" maxlength="60" value="${esc(item.text)}" ${locked ? 'disabled' : ''}>
    <div class="field" style="margin-top:14px">
      <label>算作</label>
      <div class="ai-days" id="annualEditPeriod">
        <button type="button" class="period-chip ${item.period === 'year' ? 'on' : ''}" data-annual-period="year" ${locked ? 'disabled' : ''}>年度</button>
        <button type="button" class="period-chip ${item.period === 'half' ? 'on' : ''}" data-annual-period="half" ${locked ? 'disabled' : ''}>半年度</button>
      </div>
    </div>
    <div class="field" style="margin-top:14px">
      <label>预算（元，可空）</label>
      <input id="annualEditBudget" type="number" min="0" step="100" placeholder="譬如 20000" value="${item.budget ?? ''}" ${locked ? 'disabled' : ''}>
    </div>
    ${locked ? '<div class="ai-note">这桩今年已调满 3 次，只认进度，不再改措辞与预算；真要换，先划掉再请司礼监传新旨。</div>' : ''}
    <div class="sheet-actions">
      <button class="btn ghost" id="annualEditDelete">划掉</button>
      <button class="btn" id="annualEditSave" ${locked ? 'disabled' : ''}>记上</button>
    </div>
    <div class="sheet-actions"><button class="btn ghost block" id="annualEditClose">关上</button></div>
  `, (root) => {
    let period = item.period;
    root.querySelectorAll('[data-annual-period]').forEach((b) => b.addEventListener('click', () => {
      if (locked) return;
      period = b.dataset.annualPeriod;
      root.querySelectorAll('[data-annual-period]').forEach((x) => x.classList.toggle('on', x === b));
    }));
    root.querySelector('#annualEditClose').addEventListener('click', closeSheet);
    root.querySelector('#annualEditDelete').addEventListener('click', () => {
      closeSheet();
      void removeAnnualGoal(id);
    });
    root.querySelector('#annualEditSave').addEventListener('click', async () => {
      const text = root.querySelector('#annualEditText').value.trim();
      const budgetRaw = root.querySelector('#annualEditBudget').value.trim();
      if (!text) {
        toast('总得写一句话');
        return;
      }
      try {
        await applyCourt((s) => court.updateAnnualLocal(s, id, {
          text,
          period,
          budget: budgetRaw === '' ? null : Number(budgetRaw),
        }));
        closeSheet();
        toast('已改（耗一次调整名额）', 2600);
      } catch (err) {
        toast(`改不动：${String(err?.message ?? err)}`, 4200);
      }
    });
  });
}

async function removeAnnualGoal(id) {
  if (!confirm('真要划掉这桩大事？')) return;
  try {
    await applyCourt((s) => court.removeAnnualLocal(s, id));
    toast('已从大事记里划掉', 2400);
  } catch (err) {
    toast(`划不掉：${String(err?.message ?? err)}`, 4200);
  }
}

/* ---------------------- 点圈记进度 ---------------------- */

function findProgressTarget(kind, id, dept) {
  if (kind === 'goal') {
    const g = core.liveGoals(todayRecord()).find((x) => x.id === id);
    return g ? { title: g.text, pct: Number(g.progress) || (g.status === 'done' ? 100 : 0), kind, id } : null;
  }
  if (kind === 'annual') {
    const item = (state.court.state.annual.items ?? []).find((x) => x.id === id);
    return item ? { title: item.text, pct: item.progress ?? 0, kind, id } : null;
  }
  if (kind === 'task') {
    const task = (state.court.state.tasks?.[dept]?.items ?? []).find((x) => x.id === id);
    return task ? { title: task.text, pct: task.progress ?? 0, kind, id, dept } : null;
  }
  return null;
}

function openProgressSheet(kind, id, dept) {
  const target = findProgressTarget(kind, id, dept);
  if (!target) return;
  const canEdit = kind === 'goal' || canRule();
  const pct = Math.max(0, Math.min(100, Math.round(target.pct)));
  openSheet(`
    <h3>办到几成了？</h3>
    <p class="s">${esc(target.title)}</p>
    <div class="pct-big" id="pctBig">${pct}%</div>
    <input id="pctRange" class="pct" type="range" min="0" max="100" step="10" value="${pct}" aria-label="进度">
    <div class="pct-chips">${[0, 25, 50, 75, 100].map((n) => `<button type="button" class="period-chip" data-pct-set="${n}">${n}%</button>`).join('')}</div>
    <div class="sheet-actions">
      <button class="btn ghost" id="pctCancel">关上</button>
      <button class="btn" id="pctSave" ${canEdit ? '' : 'disabled'}>记上</button>
    </div>
  `, (root) => {
    const range = root.querySelector('#pctRange');
    const big = root.querySelector('#pctBig');
    const paint = () => {
      big.textContent = `${range.value}%`;
    };
    range.addEventListener('input', paint);
    root.querySelectorAll('[data-pct-set]').forEach((b) => b.addEventListener('click', () => {
      range.value = b.dataset.pctSet;
      paint();
    }));
    root.querySelector('#pctCancel').addEventListener('click', closeSheet);
    root.querySelector('#pctSave').addEventListener('click', () => { void saveProgress(target, Number(range.value)); });
  });
}

async function saveProgress(target, pct) {
  try {
    if (target.kind === 'goal') {
      await updateToday((r) => core.setGoalProgress(r, target.id, pct));
    } else if (target.kind === 'annual') {
      await applyCourt((s) => court.updateAnnualLocal(s, target.id, { progress: pct }));
    } else if (target.kind === 'task') {
      await applyCourt((s) => court.updateTaskLocal(s, target.dept, target.id, { progress: pct }));
    }
    closeSheet();
    toast(`已记 ${pct}%`, 1800);
    if (target.kind === 'task' && state.court.currentDept) await openDeptSheet(state.court.currentDept);
  } catch (err) {
    toast(`改不动：${String(err?.message ?? err)}`, 4200);
  }
}

/* ---------------------- 头像 ---------------------- */

function fileToAvatar(file, size = 160) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('这张图读不出来'));
    reader.onload = () => {
      const img = new Image();
      img.onerror = () => reject(new Error('这张图打不开'));
      img.onload = () => {
        try {
          const canvas = document.createElement('canvas');
          canvas.width = size;
          canvas.height = size;
          const ctx = canvas.getContext('2d');
          const scale = Math.max(size / img.width, size / img.height);
          const w = img.width * scale;
          const h = img.height * scale;
          ctx.drawImage(img, (size - w) / 2, (size - h) / 2, w, h);
          resolve(canvas.toDataURL('image/jpeg', 0.85));
        } catch (err) {
          reject(err);
        }
      };
      img.src = reader.result;
    };
    reader.readAsDataURL(file);
  });
}

async function onAvatarPicked(file) {
  if (!file) return;
  try {
    const dataUrl = await fileToAvatar(file);
    state.avatar.dataUrl = dataUrl;
    await store.setMeta('avatar', dataUrl);
    renderHeader();
    if (state.hub.url) {
      try {
        await uploadAvatar({ url: state.hub.url, token: state.hub.token, memberId: state.identity.memberId, dataUrl });
        toast('龙颜已换，六部都瞧见了', 3000);
      } catch (err) {
        toast(`先存本机；驿站说：${String(err?.message ?? err)}`, 4200);
      }
    } else {
      toast('先存本机，连上中枢再传给六部', 3000);
    }
  } catch (err) {
    toast(`换不了：${String(err?.message ?? err)}`, 4200);
  }
}

/* ---------------------- 家是小国 · 御书房 ---------------------- */

const MEMORIAL_STATUS = { pending: '待批阅', approved: '已朱批', held: '留中', rejected: '已驳回', counciling: '待合议' };
const ROLE_LABELS = { emperor: '陛下', empress: '皇后', member: '家人' };
const canRule = () => state.court.role === 'emperor' || state.court.role === 'empress';

/** 开机先把本机那一份读出来：没网也能看见国家大事、差事、账目 */
async function loadCourtCache() {
  state.court.state = court.normalizeCourtState((await store.getMeta('courtState', null)) ?? null);
  state.court.roles = (await store.getMeta('courtRoles', null)) ?? {};
  const cfg = await store.getMeta('courtConfig', null);
  if (cfg) {
    state.court.config = cfg;
    if (cfg.depts?.length) state.court.depts = cfg.depts;
  }
  state.court.memorials = (await store.getMeta('courtMemorials', null)) ?? [];
  const usage = await store.getMeta('usageCache', null);
  if (usage) state.usage = { ...state.usage, ...usage };
  refreshRole();
  if (!state.court.depts?.length) state.court.depts = DEFAULT_DEPTS;
}

/** 身份：中枢说了算；中枢不在时用本机记的 */
function refreshRole() {
  const id = state.identity?.memberId;
  const hubRole = id ? state.court.config?.roles?.[id] : null;
  const localRole = id ? state.court.roles?.[id] : null;
  const role = hubRole ?? localRole ?? 'member';
  state.court.role = role;
  state.court.roleLabel = state.court.config?.roleLabels?.[role] ?? ROLE_LABELS[role] ?? '家人';
}

function dutyOf(d) {
  const duty = Array.isArray(d?.duty) ? d.duty[0] : String(d?.duty ?? '');
  return duty || d?.focusHint || '';
}

/** 七部名号：中枢没回话就用内置的同一份（离线也说得清每部管什么） */
function deptList() {
  const src = state.court.config?.depts?.length
    ? state.court.config.depts
    : state.court.depts?.length
      ? state.court.depts
      : DEFAULT_DEPTS;
  return src.map((d) => ({
    ...d,
    dutyText: dutyOf(d),
    briefText: String(d.brief ?? '').trim()
      || DEFAULT_DEPTS.find((x) => x.id === d.id)?.brief
      || dutyOf(d),
  }));
}

function latestDeptMemorial(deptId) {
  return (state.court.memorials ?? []).find((m) => m.dept === deptId) ?? null;
}

async function loadCourtConfig(force = false) {
  if (!state.hub.url || !state.identity) return null;
  if (!force && state.court.config) return state.court.config;
  try {
    const cfg = await getCourtConfig({ url: state.hub.url, token: state.hub.token });
    state.court.config = cfg;
    if (cfg.depts?.length) state.court.depts = cfg.depts;
    state.court.roles = { ...state.court.roles, ...(cfg.roles ?? {}) };
    await store.setMeta('courtConfig', cfg);
    await store.setMeta('courtRoles', state.court.roles);
    refreshRole();
  } catch {
    /* 离线就沿用本机缓存 */
  }
  return state.court.config;
}

async function loadMemorials() {
  if (!state.hub.url) return;
  try {
    state.court.memorials = await listMemorials({ url: state.hub.url, token: state.hub.token, limit: 30 });
    await store.setMeta('courtMemorials', state.court.memorials);
  } catch {
    /* 断线时保留旧列表 */
  }
}

/** 进御书房时把能问的都问一遍；连不上也照样用本机那份 */
async function ensureCourt() {
  state.court.loading = true;
  try {
    await loadCourtConfig();
    await loadMemorials();
    await loadUsage();
  } finally {
    state.court.loading = false;
  }
  refreshRole();
  renderCourt();
}

/** 「重新探报」已并入顶部驿牌：牌上写着待传/已同步，点一下就传书 */
function deptRow(d) {
  const st = court.taskSummary(state.court.state, d.id);
  const latest = latestDeptMemorial(d.id);
  let summary = null;
  if (st.total) summary = `差事 ${st.total} 道 · 在办 ${st.open} · 均 ${st.avg}%`;
  else if (d.id === 'libu') {
    const s = core.summarize(todayRecord());
    if (s.total) summary = `今日 ${s.done}/${s.total} 桩已了${s.pending ? ` · ${s.pending} 桩未打卡` : ''}`;
  } else if (d.id === 'hubu') {
    const sum = court.summarizeLedgerLocal(state.court.state, { days: 30 });
    if (sum.count) summary = `近卅日 ${sum.count} 笔 · 合计 ¥${sum.total}`;
  } else if (latest) summary = `近奏《${latest.title}》`;
  return `<button type="button" class="dept-row${state.ui.flashDepts?.includes(d.id) ? ' flash' : ''}" data-dept="${esc(d.id)}">
    <span class="dept-ico">${d.icon ?? ''}</span>
    <span class="dept-info">
      <span class="dept-name">${esc(d.name)}<em>${esc(d.office ?? '')}</em></span>
      ${summary ? `<span class="dept-sum">${esc(summary)}</span>` : ''}
      <span class="dept-brief">${esc(d.briefText)}</span>
    </span>
    <span class="dept-side">${st.total ? `${st.avg}%` : '›'}</span>
  </button>`;
}

function renderDispatchCard() {
  const el = $('#dispatchCard');
  if (!el) return;
  const canEdit = canRule();
  el.innerHTML = `
    <div class="ai-head">
      <span>🖋️ 司礼监 · 传旨</span>
      <span class="ai-tag ${canEdit ? 'on' : ''}">${esc(state.court.roleLabel)}可传旨</span>
    </div>
    <div class="ai-note">管传旨分派：把话原样说来，司礼监先纠错、听懂，再拆成内阁大事（带预算）、今日差事、六部差事与户部账目；拟好先给你过目，点头才下旨。</div>
    <button type="button" class="btn block dispatch-open-btn" data-open-dispatch ${canEdit ? '' : 'disabled'}>拟旨分发</button>
  `;
}

function renderCourt() {
  const card = $('#courtCard');
  const listCard = $('#courtListCard');
  if (!card || !listCard) return;
  const hubOk = Boolean(state.hub.url);
  const canEdit = canRule();
  const depts = deptList().filter((d) => d.id !== 'silijian');

  card.innerHTML = `
    <div class="ai-head">
      <span>🏛 御书房</span>
      <span class="ai-tag ${canEdit ? 'on' : ''}">我的身份：${esc(state.court.roleLabel)}</span>
    </div>
    <div class="ai-note">六部各管一摊，点进去可看进度、催上奏、撤旨。${
      hubOk ? '' : '驿路未通，差事与账先记本机，连上中枢自会传。'
    }</div>
    <div class="dept-list">${depts.map(deptRow).join('')}</div>
    <div class="btnrow" style="margin-top:10px">
      <button type="button" class="btn" id="courtMeeting" ${hubOk ? '' : 'disabled'}>召集六部朝会</button>
    </div>
    <div class="ai-note">${hubOk
      ? '上奏与朝会靠中枢里的模型；同一份数据只算一次，没变化就翻旧奏，不费分文。'
      : '朝会与上奏得靠中枢里的模型，连上才成；差事、账目、大事本机照记。'}</div>
  `;

  listCard.hidden = false;
  const list = state.court.memorials ?? [];
  listCard.innerHTML = `
    <div class="ai-head"><span>奏疏</span><span class="ai-tag">${list.length} 份</span></div>
    ${list.length
      ? list.map((m) => `
        <button type="button" class="mem-item" data-memorial="${esc(m.id)}">
          <span class="mem-dept">${esc(m.deptName)}</span>
          <span class="mem-title">${esc(m.title)}</span>
          <span class="mem-status ${m.status}">${MEMORIAL_STATUS[m.status] ?? m.status}</span>
          <span class="mem-time">${String(m.createdAt ?? '').slice(5, 16).replace('T', ' ')}</span>
        </button>`).join('')
      : `<div class="ai-note">${hubOk ? '还没有奏疏。点上面的部名，让对应部门上一份。' : '本机还没有存下奏疏。连上中枢让某部上一份，看过的会存一份在本机。'}</div>`}
  `;
}

function ledgerSectionHtml() {
  const range = state.ui.ledgerRange || '7';
  const g = court.groupLedger(state.court.state, { range });
  const ranges = [
    ['today', '今日'], ['7', '近七日'], ['month', '本月'], ['all', '全部'],
  ].map(([key, label]) => `<button type="button" class="ledger-range-btn ${range === key ? 'on' : ''}" data-ledger-range="${key}">${label}</button>`).join('');
  const days = g.days.map((day) => `
    <div class="ledger-day">
      <div class="ledger-day-head">
        <span>${day.date.slice(5).replace('-', '/')} ${dayOfWeek(day.date)}</span>
        <span>${day.count} 笔 · ¥${day.total}</span>
      </div>
      ${day.entries.map((e) => `
        <div class="ledger-row">
          <span class="ledger-item">${esc(e.item)}</span>
          <span class="ledger-tag">${esc(e.categoryLabel)}</span>
          <span class="ledger-amt">¥${e.amount}</span>
          <button type="button" class="ledger-edit" data-ledger-edit="${esc(e.id)}" aria-label="改这笔账">✎</button>
        </div>`).join('')}
    </div>`).join('');
  return `<div class="dept-ledger">
    <div class="dept-ledger-head"><span>💰 户部账目</span><span>今日 ${g.todayCount} 笔 ¥${g.todayTotal} · 本月 ¥${g.monthTotal}</span></div>
    <div class="ledger-range">${ranges}</div>
    <div class="ledger-range-sum">${g.count} 笔 · 合计 ¥${g.total}</div>
    ${days || '<div class="ai-note">这几日还没有账。要记新账，去司礼监说一句「记一笔，午饭18」。</div>'}
    <button type="button" class="btn block" id="ledgerToDispatch" style="margin-top:8px">去司礼监记一笔 / 改错账</button>
    <div class="ai-note">账目按日排好了；点每笔后面的「✎」可改名目、金额、日期。新账只从司礼监进。</div>
  </div>`;
}

function openLedgerEditSheet(id) {
  const entry = (state.court.state.ledger?.entries ?? []).find((e) => e.id === id);
  if (!entry) {
    toast('这笔账找不着了');
    return;
  }
  openSheet(`
    <h3>✎ 改这笔账</h3>
    <p class="s">名目、金额、日期都能改；归类随名目自动重算。</p>
    <div class="field"><label>名目</label><input id="ledgerItem" type="text" maxlength="40" value="${esc(entry.item)}"></div>
    <div class="field"><label>金额（元）</label><input id="ledgerAmount" type="number" min="0.01" step="0.01" value="${esc(entry.amount)}"></div>
    <div class="field"><label>日期</label><input id="ledgerDate" type="date" max="${core.bjToday()}" value="${esc(entry.date)}"></div>
    <div class="ai-note">眼下归在「${esc(entry.categoryLabel)}」；改完名目会重新归类。</div>
    <div class="sheet-actions">
      <button class="btn" id="ledgerSave">存上</button>
      <button class="btn ghost" id="ledgerDelete">删掉这笔</button>
      <button class="btn ghost" id="ledgerCancel">罢了</button>
    </div>
  `, (root) => {
    root.querySelector('#ledgerCancel').addEventListener('click', closeSheet);
    root.querySelector('#ledgerSave').addEventListener('click', async () => {
      const item = root.querySelector('#ledgerItem').value.trim();
      const amount = Number(root.querySelector('#ledgerAmount').value);
      const date = root.querySelector('#ledgerDate').value;
      try {
        await applyCourt((s) => court.updateLedgerLocal(s, id, { item, amount, date }));
        closeSheet();
        toast('账目已改');
        if (state.court.currentDept === 'hubu') void openDeptSheet('hubu');
      } catch (err) {
        toast(`改不成：${String(err?.message ?? err)}`, 4200);
      }
    });
    root.querySelector('#ledgerDelete').addEventListener('click', async () => {
      if (!confirm('真要把这笔账删掉？')) return;
      try {
        await applyCourt((s) => court.removeLedgerLocal(s, id));
        closeSheet();
        toast('这笔账已删');
        if (state.court.currentDept === 'hubu') void openDeptSheet('hubu');
      } catch (err) {
        toast(`删不掉：${String(err?.message ?? err)}`, 4200);
      }
    });
  });
}

async function openDeptSheet(deptId) {
  const dept = deptList().find((d) => d.id === deptId);
  if (!dept) return;
  state.court.currentDept = deptId;
  const canEdit = canRule();
  const tasks = state.court.state.tasks?.[deptId]?.items ?? [];
  const rows = tasks.length
    ? tasks.map((t) => `
      <div class="dept-task">
        ${pctDot(t.progress, `data-progress-open="task" data-task="${esc(t.id)}" data-dept="${esc(deptId)}"`)}
        <div class="dept-task-main">
          <div class="annual-text ${t.progress >= 100 ? 'done' : ''}">${esc(t.text)}</div>
          <div class="annual-sub"><span>${ANNUAL_LABEL[t.status] ?? t.status}</span>${t.due ? `<span class="task-due">${esc(dueLabel(t.due))}</span>` : ''}<span>${String(t.createdAt ?? '').slice(5, 10).replace('-', '/')} 下的旨</span></div>
        </div>
        ${canEdit ? `<button class="annual-del" data-task-del="${esc(t.id)}" aria-label="撤旨">×</button>` : ''}
      </div>`).join('')
    : '<div class="ai-note">该部尚无御赐差事</div>';

  openSheet(`
    <h3>${dept.icon ?? ''} ${esc(dept.name)} · ${esc(dept.office ?? '')}</h3>
    <p class="s">职责：${esc(dept.briefText)}</p>
    <div class="dept-tasks">${rows}</div>
    ${deptId === 'hubu' ? ledgerSectionHtml() : ''}
    ${canEdit ? `
      <button type="button" class="btn block" id="deptToDispatch" data-dept="${deptId}" style="margin-top:12px">去司礼监下旨</button>
      <div class="ai-note">所有新建差事都从司礼监进；这里只查看进度、撤旨与上奏。</div>` : '<div class="ai-note">下旨的事由陛下与皇后定夺；家人可以先看着。</div>'}
    <div class="sheet-actions">
      <button class="btn" id="deptSummon" data-dept="${deptId}" ${state.hub.url ? '' : 'disabled'}>让该部上奏</button>
      <button class="btn ghost" id="deptClose">退下</button>
    </div>
    ${state.hub.url ? '' : '<div class="ai-note">上奏要靠中枢里的模型，连上中枢才成；差事与账目本机照记。</div>'}
  `, (root) => {
    root.querySelector('#deptClose').addEventListener('click', closeSheet);
  });
}

async function removeDeptTask(deptId, id) {
  if (!confirm('真要撤销这道旨意？')) return;
  try {
    await applyCourt((s) => court.removeTaskLocal(s, deptId, id));
    await openDeptSheet(deptId);
  } catch (err) {
    toast(`撤不掉：${String(err?.message ?? err)}`, 4200);
  }
}

/* ---------------------- 司礼监 · 传旨分发 ---------------------- */

function openDispatchSheet() {
  if (!canRule()) {
    toast('传旨要陛下或皇后；家人可以先看奏疏');
    return;
  }
  openSheet(`
    <h3>🖋️ 司礼监 · 传旨</h3>
    <p class="s">把您的话原样说来。司礼监先改正语音错字、听懂整段话，再拆成四堆：内阁大事、今日差事、六部差事、户部账目。拆完先给您过目，点头才落库。</p>
    <textarea id="dispatchText" rows="5" maxlength="300" placeholder="例：包子 白蛋 糯玉米9元 午饭冒菜18元；今天下午三点去接孩子；今年攒两万去海边旅游"></textarea>
    <div class="ai-note">辨词：「记一笔 / 花了 / 买了」进户部账目，「今天要 / 提醒我」进今日差事，「今年 / 年度」进内阁，其余按六部职掌分。</div>
    <div class="sheet-actions">
      <button class="btn ghost" id="dispatchClose">罢了</button>
      <button class="btn" id="dispatchGo">让司礼监拟旨</button>
    </div>
    <div id="dispatchResult"></div>
  `, (root) => {
    root.querySelector('#dispatchClose').addEventListener('click', closeSheet);
    root.querySelector('#dispatchGo').addEventListener('click', () => { void runDispatch(root); });
    root.querySelector('#dispatchText').focus();
  });
}

async function runDispatch(root) {
  const text = root?.querySelector('#dispatchText')?.value?.trim() ?? '';
  if (!text) {
    toast('先说一句话');
    return;
  }
  const resultEl = root.querySelector('#dispatchResult');
  resultEl.innerHTML = '<div class="ai-note">司礼监正在听…</div>';
  let items = [];
  let source = 'rules';
  let warning = null;
  let note = '';

  if (state.hub.url) {
    try {
      const res = await dispatchWithHub({
        url: state.hub.url,
        token: state.hub.token,
        memberId: state.identity.memberId,
        text,
      });
      items = res.items ?? [];
      source = res.source ?? 'rules';
      warning = res.warning ?? null;
      note = res.note ?? '';
      if (res.quota) applyQuota(res.quota, res.cached ? '旧旨（未耗分文）' : '司礼监拟旨完毕');
    } catch (err) {
      const msg = String(err?.message ?? err);
      warning = /陛下|皇后|403/.test(msg)
        ? '中枢没认你的身份（传旨要陛下或皇后）：先到「朕的私事」把身份传上去；眼下这份只记在本机'
        : `中枢没搭上话（${msg.slice(0, 50)}），先按老规矩拆`;
    }
  } else {
    warning = '驿路未通，司礼监按老规矩拆（不花分文）';
  }

  if (!items.length) {
    items = sanitizeDispatchItems(null, { fallbackText: text });
    source = 'rules';
  }
  if (!items.length) {
    items = routeByRules(text).items;
  }
  renderDispatchResult(root, items, { source, warning, note });
}

const DISPATCH_GROUPS = [
  { kind: 'annual', title: '🏯 内阁大事', hint: '计入本年计划，预算可改' },
  { kind: 'goal', title: '📜 今日差事', hint: '记进今天' },
  { kind: 'task', title: '🏛 六部差事', hint: '落到各部名下' },
  { kind: 'ledger', title: '💰 户部账目', hint: '已花掉的钱，按笔记' },
];

function dispatchAnnualRow(item, i) {
  return `<div class="dispatch-item dispatch-annual">
    <label class="dispatch-pick">
      <input type="checkbox" checked data-dispatch-pick="${i}">
      <b>内阁</b>
    </label>
    <div class="dispatch-fields">
      <input type="text" maxlength="80" value="${esc(item.text)}" data-dispatch-task="${i}" aria-label="内阁大事">
      <div class="dispatch-money">
        <span>预算 ¥</span>
        <input type="number" min="0" step="100" placeholder="可空" value="${item.budget ?? ''}" data-dispatch-budget="${i}" aria-label="预算金额">
        <span class="dispatch-period">${item.period === 'half' ? '半年度' : '年度'}</span>
      </div>
    </div>
  </div>`;
}

function dispatchSimpleRow(item, i) {
  const label = item.kind === 'goal' ? '今日' : (DEPT_NAMES[item.dept] ?? item.dept);
  return `<div class="dispatch-item">
    <label class="dispatch-pick">
      <input type="checkbox" checked data-dispatch-pick="${i}">
      <b>${esc(label)}</b>
    </label>
    <input type="text" maxlength="80" value="${esc(item.text)}" data-dispatch-task="${i}" aria-label="${esc(label)}的差事">
    ${item.due ? `<span class="dispatch-due-note">⏰ ${esc(dueLabel(item.due))}（司礼监判的）</span>` : ''}
  </div>`;
}

function dispatchLedgerRow(item, i) {
  const date = item.date || core.bjToday();
  return `<div class="dispatch-item dispatch-ledger">
    <label class="dispatch-pick">
      <input type="checkbox" checked data-dispatch-pick="${i}">
      <b>户部</b>
    </label>
    <div class="dispatch-ledger-fields">
      <input type="text" maxlength="40" value="${esc(item.item)}" data-dispatch-item="${i}" aria-label="账目名目">
      <label class="dispatch-money">¥
        <input type="number" min="0.01" step="0.01" value="${esc(item.amount)}" data-dispatch-amount="${i}" aria-label="账目金额">
      </label>
      <input type="date" value="${esc(date)}" max="${core.bjToday()}" data-dispatch-date="${i}" aria-label="账目日期">
    </div>
  </div>`;
}

function renderDispatchResult(root, items, meta) {
  const el = root.querySelector('#dispatchResult');
  if (!items.length) {
    el.innerHTML = '<div class="ai-note">司礼监没听出该派哪部，换个说法，或逐部下旨。</div>';
    return;
  }
  const groups = DISPATCH_GROUPS.map((g) => {
    const rows = items
      .map((it, i) => ({ it, i }))
      .filter(({ it }) => (it.kind ?? 'task') === g.kind)
      .map(({ it, i }) => {
        if (g.kind === 'annual') return dispatchAnnualRow(it, i);
        if (g.kind === 'ledger') return dispatchLedgerRow(it, i);
        return dispatchSimpleRow(it, i);
      })
      .join('');
    return rows ? `<div class="dispatch-group"><div class="dispatch-group-head"><b>${g.title}</b><span>${g.hint}</span></div>${rows}</div>` : '';
  }).join('');
  const from = meta.source === 'model' ? '司礼监拟的' : '按老规矩拆的';
  const ledgerTotal = Math.round(items
    .filter((it) => it.kind === 'ledger')
    .reduce((a, it) => a + (Number(it.amount) || 0), 0) * 100) / 100;
  el.innerHTML = `
    <div class="dispatch-list">${groups}</div>
    ${meta.note ? `<div class="dispatch-note">🗣️ 司礼监回话：${esc(meta.note)}</div>` : ''}
    <div class="ai-note">${meta.warning ? esc(meta.warning) : `${from}，共 ${items.length} 件${ledgerTotal ? `（账目合计 ¥${ledgerTotal}）` : ''}；改字、勾选都行，点头才下旨。`}到点时刻由司礼监判断，确认后按点响铃。</div>
    <button class="btn block" id="dispatchConfirm">按此下发（${items.length} 件）</button>
    <button class="btn ghost block" id="dispatchRetry" style="margin-top:6px">让司礼监重拟</button>
  `;
  el.querySelector('#dispatchRetry').addEventListener('click', () => { void runDispatch(root); });
  el.querySelector('#dispatchConfirm').addEventListener('click', () => { void confirmDispatch(root, items); });
}

async function confirmDispatch(root, items) {
  const annual = [];
  const goals = [];
  const tasks = [];
  const ledger = [];
  const picks = [...root.querySelectorAll('[data-dispatch-pick]')].filter((cb) => cb.checked);
  for (const cb of picks) {
    const i = Number(cb.dataset.dispatchPick);
    const it = items[i];
    if (!it) continue;
    if (it.kind === 'ledger') {
      const name = root.querySelector(`[data-dispatch-item="${i}"]`)?.value?.trim() ?? '';
      const amount = Number(root.querySelector(`[data-dispatch-amount="${i}"]`)?.value);
      const date = root.querySelector(`[data-dispatch-date="${i}"]`)?.value || core.bjToday();
      if (!name || !Number.isFinite(amount) || amount <= 0) {
        toast('有一笔账的名目或金额不对，改一下再下发');
        return;
      }
      ledger.push({ item: name, amount, date });
      continue;
    }
    const text = root.querySelector(`[data-dispatch-task="${i}"]`)?.value?.trim() ?? '';
    if (!text) continue;
    const due = it.due && Date.parse(it.due) > Date.now() ? it.due : null;
    if (it.kind === 'annual') {
      const raw = root.querySelector(`[data-dispatch-budget="${i}"]`)?.value?.trim() ?? '';
      annual.push({ text, period: it.period ?? 'year', budget: raw === '' ? null : Number(raw) });
    } else if (it.kind === 'goal') {
      goals.push({ text, due });
    } else {
      tasks.push({ dept: it.dept, text, due });
    }
  }
  if (!annual.length && !goals.length && !tasks.length && !ledger.length) {
    toast('一件都没勾');
    return;
  }
  try {
    if (goals.length) {
      await updateToday((r) => goals.reduce((acc, g) => core.addGoal(acc, g.text, new Date(), { due: g.due }), r));
    }
    if (annual.length || tasks.length || ledger.length) {
      await applyCourt((s) => {
        let next = s;
        for (const a of annual) next = court.addAnnualLocal(next, { ...a, by: state.identity.memberId });
        for (const t of tasks) next = court.addTaskLocal(next, t.dept, { text: t.text, due: t.due, by: state.identity.memberId });
        for (const l of ledger) {
          const r = court.addLedgerEntryLocal(next, l, { by: state.identity.memberId });
          if (!r.ok) throw new Error(r.error);
          next = r.state;
        }
        return next;
      });
    }
    closeSheet();
    const parts = [];
    if (annual.length) parts.push(`内阁 ${annual.length} 桩`);
    if (goals.length) parts.push(`今日差事 ${goals.length} 件`);
    if (tasks.length) {
      const names = [...new Set(tasks.map((t) => DEPT_NAMES[t.dept] ?? t.dept))].join('、');
      parts.push(`六部 ${tasks.length} 道（${names}）`);
    }
    if (ledger.length) {
      const total = Math.round(ledger.reduce((a, l) => a + l.amount, 0) * 100) / 100;
      parts.push(`户部账目 ${ledger.length} 笔 ¥${total}`);
    }
    // 让刚接到旨的部在御书房里闪一下，主上能看见落到哪儿了
    const flashed = [...new Set([...tasks.map((t) => t.dept), ...(ledger.length ? ['hubu'] : [])])];
    if (flashed.length && state.page === 'court') {
      state.ui.flashDepts = flashed;
      renderCourt();
      setTimeout(() => {
        state.ui.flashDepts = [];
        renderCourt();
      }, 1800);
    }
    toast(`已下旨：${parts.join('、')}`, 4200);
  } catch (err) {
    toast(`下旨不成：${String(err?.message ?? err)}`, 4200);
  }
}

async function summonOne(deptId) {
  if (!state.hub.url) {
    toast('先连上家里中枢');
    return;
  }
  if (!canRule()) {
    toast('只有陛下与皇后可以召见六部');
    return;
  }
  state.court.loading = true;
  renderCourt();
  openSheet(`<h3>正在召见……</h3><p class="s">让这一部看数据、拟奏疏，通常 10~40 秒</p>`);
  try {
    const { memorial, cached, quota } = await summonDept({
      url: state.hub.url,
      token: state.hub.token,
      memberId: state.identity.memberId,
      dept: deptId,
    });
    closeSheet();
    toast(cached ? '数据没变，翻出的是上次奏疏（未耗分文）' : '奏疏已送入御书房', 3000);
    applyQuota(quota, cached ? '旧奏疏' : '六部拟奏完毕');
    await loadMemorials();
    await openMemorial(memorial.id);
  } catch (err) {
    closeSheet();
    toast(`上奏失败：${String(err?.message ?? err)}`, 4200);
  } finally {
    state.court.loading = false;
    renderCourt();
  }
}

async function openMemorial(id) {
  openSheet('<h3>正在取奏疏…</h3>');
  let m = null;
  if (state.hub.url) {
    try {
      m = await getMemorial({ url: state.hub.url, token: state.hub.token, id });
      await store.setMeta(`memorial:${id}`, m);
    } catch {
      /* 断线就翻本机存的旧奏 */
    }
  }
  if (!m) m = await store.getMeta(`memorial:${id}`, null);
  if (!m) {
    closeSheet();
    toast('这份奏疏还没存到本机，连上中枢再看', 3600);
    return;
  }
  state.court.current = m;
  const disps = (m.dispositions ?? [])
    .map((d) => `<div class="kv"><span>${d.role === 'empress' ? '皇后' : '陛下'}${d.action === 'approve' ? '朱批' : d.action === 'hold' ? '留中' : d.action === 'reject' ? '驳回' : '待合议'}</span><span>${esc(d.comment || '—')}</span></div>`)
    .join('');
  const replies = (m.replies ?? []).map((r) => `<div class="kv"><span>回奏</span><span>${esc(r.text)}</span></div>`).join('');
  const done = m.status === 'approved';
  const editable = canRule() && !done && state.hub.url;

  openSheet(`
    <h3>《${esc(m.title)}》</h3>
    <p class="s">${esc(m.deptName)} · ${esc(m.office ?? '')} · ${String(m.createdAt ?? '').slice(5, 16).replace('T', ' ')} · ${MEMORIAL_STATUS[m.status] ?? m.status}</p>
    <pre class="ai-result">${esc(m.body)}</pre>
    ${disps ? `<div class="kv"><span>批示记录</span><span></span></div>${disps}` : ''}
    ${replies}
    ${editable ? `
      <input id="courtComment" type="text" maxlength="60" placeholder="批注（驳回时必填）" style="margin-top:10px">
      <div class="sheet-actions" style="flex-wrap:wrap">
        <button class="btn" data-dispose="approve">朱批</button>
        <button class="btn ghost" data-dispose="hold">留中</button>
        <button class="btn ghost" data-dispose="reject">驳回</button>
        <button class="btn ghost" data-dispose="council">待合议</button>
      </div>`
      : `<div class="ai-note">${done ? '此奏已朱批，记录在案。' : state.hub.url ? '只有陛下与皇后可以批阅。' : '批阅要连中枢；本机只留了旧奏存档。'}</div>`}
    <div class="sheet-actions"><button class="btn block ghost" id="courtClose">关上</button></div>
  `, (root) => {
    root.querySelector('#courtClose').addEventListener('click', closeSheet);
  });
}

async function courtDisposeAction(action) {
  const m = state.court.current;
  if (!m) return;
  const comment = $('#courtComment')?.value?.trim() ?? '';
  if (action === 'reject' && !comment) {
    toast('驳回请写一句原因，好让该部知道怎么改');
    return;
  }
  try {
    await disposeMemorial({
      url: state.hub.url,
      token: state.hub.token,
      memberId: state.identity.memberId,
      id: m.id,
      action,
      comment,
    });
    closeSheet();
    toast(
      action === 'approve' ? '已朱批，存档为圣旨/懿旨'
        : action === 'reject' ? '已驳回，并记进该部记忆，下次上奏会避开同样问题'
          : action === 'hold' ? '已留中' : '已标为待合议',
      3200,
    );
    await loadMemorials();
    renderCourt();
  } catch (err) {
    toast(`批阅失败：${String(err?.message ?? err)}`, 4200);
  }
}

async function openMeeting() {
  openSheet('<h3>正在召集六部…</h3>');
  try {
    const mt = await courtMeeting({ url: state.hub.url, token: state.hub.token });
    closeSheet();
    openSheet(`
      <h3>家庭常朝</h3>
      <p class="s">${String(mt.at ?? '').slice(0, 16).replace('T', ' ')} · 待批 ${mt.pendingTotal ?? 0} 份</p>
      <pre class="ai-result">${esc(mt.brief ?? '')}</pre>
      <div class="sheet-actions"><button class="btn block" id="meetClose">退朝</button></div>
    `, (root) => {
      root.querySelector('#meetClose').addEventListener('click', closeSheet);
    });
  } catch (err) {
    closeSheet();
    toast(`召集失败：${String(err?.message ?? err)}`, 4200);
  }
}

async function setMyCourtRole(role) {
  if (!['emperor', 'empress', 'member'].includes(role)) return;
  state.court.roles = { ...state.court.roles, [state.identity.memberId]: role };
  await store.setMeta('courtRoles', state.court.roles);
  refreshRole();
  render();
  if (!state.hub.url) {
    toast(`身份已记本机：${state.court.roleLabel}（连上中枢再传六部）`, 3000);
    return;
  }
  try {
    await setCourtRole({ url: state.hub.url, token: state.hub.token, memberId: state.identity.memberId, role });
    await loadCourtConfig(true);
    render();
    toast(`身份已设为：${state.court.roleLabel}`, 2600);
  } catch (err) {
    toast(`先记本机；驿站说：${String(err?.message ?? err)}`, 4200);
  }
}

function settingsHtml() {
  const identity = state.identity ?? {};
  const days = state.records.length;
  return `
    <div class="field">
      <label>我的称呼（也是同步用的成员ID）</label>
      <div class="row">
        <input id="nameInput" type="text" maxlength="24" value="${esc(identity.memberName ?? '')}">
        <button class="btn ghost" id="saveName" style="flex:none">保存</button>
      </div>
      <div class="hint">改称呼等于换一个人，历史记录不会跟着走，一般只在第一次设置时用。emoji 可以用，但不能有 / \ : * ? " &lt; &gt; | 。</div>
    </div>

    <div class="field">
      <label>我的模样（头像）</label>
      <div class="row" style="align-items:center">
        <button type="button" class="btn ghost" id="avatarChange" style="flex:none">换一张</button>
        <span class="hint" style="margin:0">点右上角头像也能换；换完会传给家里中枢，看板上也认得出你。</span>
      </div>
    </div>

    <div class="field">
      <label>我在「大内家事」里的身份</label>
      <div class="row" style="flex-wrap:wrap">
        ${[['emperor', '陛下'], ['empress', '皇后'], ['member', '家人']].map(([id, label]) => `
          <button type="button" class="btn ${state.court.role === id ? '' : 'ghost'}" data-court-role="${id}" style="flex:none">${label}</button>`).join('')}
      </div>
      <div class="hint">只有陛下与皇后可以召见六部、批阅奏疏。这是家里自定的身份，改完立即生效。</div>
    </div>

    <div class="field">
      <label>家里中枢地址</label>
      <div class="row">
        <input id="hubInput" type="text" inputmode="url" placeholder="http://192.168.1.10:8787" value="${esc(state.hub.url ?? '')}">
        <button class="btn ghost" id="saveHub" style="flex:none">保存</button>
      </div>
      <div class="row" style="margin-top:8px">
        <button class="btn ghost" id="discoverHub">自动找中枢</button>
        <button class="btn ghost" id="testHub">测试连接</button>
        <button class="btn" id="syncNow">立即同步</button>
      </div>
      <div class="hint">中枢是家里那台 Windows：双击 <b>start-hub.cmd</b> 就会开。同一 WiFi 下点「自动找中枢」即可，找不到再手填。</div>
    </div>

    <div class="field">
      <label>提醒</label>
      <div class="row">
        <button class="btn ghost" id="checkPerm">检查通知权限</button>
        <button class="btn ghost" id="exactAlarm">准点闹钟设置</button>
        <button class="btn ghost" id="testNotify">发测试通知</button>
        <button class="btn ghost" id="replanNow">补排提醒</button>
      </div>
      <div class="notify-status" id="notifyStatus">正在查看提醒底细…</div>
      <div class="hint">07:30 只有当天还没设目标时才响；21:30 只有当天有「未打卡」时才响；传旨里带了钟点的差事，到点也会响。App 不必开在后台——靠的是手机系统闹钟；但要在系统设置里允许「大内家事」自启动、别被省电策略清掉。</div>
    </div>

    <div class="field">
      <label>历史保留</label>
      <select id="retentionSelect">
        ${core.RETENTION_OPTIONS.map((o) => `<option value="${o.months}" ${o.months === state.retention ? 'selected' : ''}>${o.label}</option>`).join('')}
      </select>
      <div class="hint">现在保留 ${retentionLabel()}。更早的记录会从这台手机删掉，日历最多也就只能回看到这里（最长一年）。</div>
    </div>

    <div class="field">
      <label>数据</label>
      <div class="row">
        <button class="btn ghost" id="copyData">复制全部数据</button>
      </div>
      <div class="hint">数据只在这台手机与家中电脑，不劳云端。复制出来是「2026年11月18日：事项一；事项二。」一天一行。 · 大内家事 v1.2</div>
    </div>
  `;
}

async function refreshNotifyStatus() {
  const el = $('#notifyStatus');
  if (!el) return;
  const s = await notificationStatus();
  if (!s.available) {
    el.textContent = `提醒不可用：${s.reason || '当前不是 App 环境'}`;
    return;
  }
  const perm = { granted: '已允许', denied: '被拒了', prompt: '还没问过', prompt_with_rationale: '还没问过' }[s.permission] ?? s.permission;
  const exact = { granted: '已允许', denied: '未允许', not_supported: '这版安卓不支持' }[s.exact] ?? s.exact;
  const channels = s.channels.length ? s.channels.map((c) => c.name || c.id).join('、') : '还没建渠道';
  const next = (s.pending ?? [])
    .map((n) => ({ ...n, ms: Date.parse(n.at) }))
    .filter((n) => Number.isFinite(n.ms))
    .sort((a, b) => a.ms - b.ms)[0];
  const nextText = next
    ? `下一条 ${new Date(next.ms).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false })}`
    : '眼下没有排上的提醒';
  el.textContent = `权限：${perm} · 精确闹钟：${exact} · 渠道：${channels} · 待发 ${s.pending.length} 条 · ${nextText}`;
}

function openSettingsSheet() {
  openSheet(`<h3>朕的私事</h3>${settingsHtml()}<div class="sheet-actions"><button class="btn block" id="settingsClose">关上</button></div>`, (root) => {
    root.querySelector('#settingsClose').addEventListener('click', closeSheet);
    root.querySelector('#avatarChange')?.addEventListener('click', () => $('#avatarFile')?.click());
    void refreshNotifyStatus();
  });
}

function renderPages() {
  const onCourt = state.page !== 'daily';
  const pageCourt = $('#pageCourt');
  const pageDaily = $('#pageDaily');
  if (!pageCourt || !pageDaily) return;
  pageCourt.hidden = !onCourt;
  pageDaily.hidden = onCourt;
  $('#tabCourt')?.classList.toggle('active', onCourt);
  $('#tabDaily')?.classList.toggle('active', !onCourt);
}

function render() {
  if (!state.identity) {
    $('#app').hidden = true;
    openOnboarding();
    return;
  }
  $('#app').hidden = false;
  refreshRole();
  renderPages();
  renderHeader();
  renderSyncPill();
  renderToday();
  renderAnnual();
  renderDispatchCard();
  renderCourt();
  renderUsageLine();
  renderHistory();
  renderAI();
}

/* ------------------------------- 弹层 ------------------------------- */

function closeSheet() {
  const mask = $('#sheetMask');
  if (mask) mask.remove();
}

function openSheet(html, onMount) {
  closeSheet();
  const el = document.createElement('div');
  el.className = 'sheet-mask';
  el.id = 'sheetMask';
  el.innerHTML = `<div class="sheet">${html}</div>`;
  el.addEventListener('click', (e) => { if (e.target === el) closeSheet(); });
  document.body.appendChild(el);
  onMount?.(el);
  return el;
}

function openOnboarding() {
  openSheet(`
    <h3>先给自己起个称呼 🐱</h3>
    <p class="s">写名字就行，比如「妈妈」「瑞瑞🥚」。emoji 也能用，只是不能有 / \ : * ? " &lt; &gt; | 这些符号。每台手机各写各的，数据分开存。</p>
    <input id="onboardName" type="text" maxlength="24" placeholder="你的称呼" enterkeyhint="done">
    <div class="sheet-actions">
      <button class="btn block" id="onboardSave">开始打卡</button>
    </div>
  `, (root) => {
    const input = root.querySelector('#onboardName');
    input.focus();
    const submit = async () => {
      try {
        await saveIdentity(input.value);
        await loadAll();
        closeSheet();
        await ensureChannel();
        await ensurePermission();
        void applyPlan(state.records, new Date(), state.court.state);
        render();
        void runSync(false);
      } catch (err) {
        toast(String(err.message ?? err));
      }
    };
    root.querySelector('#onboardSave').addEventListener('click', submit);
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') submit(); });
  });
}

function openGoalSheet(goalId) {
  const rec = todayRecord();
  const goal = rec?.goals.find((g) => g.id === goalId);
  if (!goal) return;
  openSheet(`
    <h3>${esc(goal.text)}</h3>
    <p class="s">状态：${core.STATUS_LABEL[goal.status]}${goal.checkedAt ? `（${whatTime(goal.checkedAt)}）` : ''}</p>
    <label style="font-size:.8rem;color:var(--ink-3)">改个说法</label>
    <input id="editText" type="text" maxlength="60" value="${esc(goal.text)}" style="margin-bottom:12px">
    <label style="font-size:.8rem;color:var(--ink-3)">备注（今天为什么没做到 / 感受如何）</label>
    <textarea id="editNote" rows="3" placeholder="比如：加班太晚，明天挪到早上">${esc(goal.note ?? '')}</textarea>
    <div class="sheet-actions">
      <button class="btn ghost" id="sheetDelete">删除</button>
      <button class="btn" id="sheetSave">保存</button>
    </div>
  `, (root) => {
    root.querySelector('#sheetSave').addEventListener('click', async () => {
      const text = root.querySelector('#editText').value.trim();
      const note = root.querySelector('#editNote').value;
      try {
        await updateToday((r) => {
          let out = r;
          if (text && text !== goal.text) out = core.renameGoal(out, goalId, text);
          if (note !== (goal.note ?? '')) out = core.setGoalNote(out, goalId, note);
          return out;
        });
        closeSheet();
        toast('已保存');
      } catch (err) {
        toast(String(err.message ?? err));
      }
    });
    root.querySelector('#sheetDelete').addEventListener('click', async () => {
      const ok = confirm(`删除「${goal.text}」？`);
      if (!ok) return;
      await updateToday((r) => core.removeGoal(r, goalId));
      closeSheet();
      toast('已删除');
    });
  });
}

function openDaySheet(date) {
  const rec = state.records.find((r) => r.date === date);
  if (!rec || !core.liveGoals(rec).length) {
    toast('这天没有记录');
    return;
  }
  const s = core.summarize(rec);
  const rows = core.liveGoals(rec).map((g) => {
    const icon = g.status === 'done' ? '✅' : g.status === 'failed' ? '❌' : '⬜';
    const meta = [core.STATUS_LABEL[g.status]];
    if (g.checkedAt) meta.push(whatTime(g.checkedAt));
    return `<div class="goal">
      <div style="flex:none;width:34px;text-align:center">${icon}</div>
      <div class="goal-main">
        <div class="goal-text ${g.status === 'done' ? 'done' : ''}">${esc(g.text)}</div>
        <div class="goal-meta">${meta.join(' · ')}${g.note ? ` · <span class="note">${esc(g.note)}</span>` : ''}</div>
      </div>
    </div>`;
  }).join('');
  openSheet(`
    <h3>${date.slice(5).replace('-', ' / ')}　${dayOfWeek(date)}</h3>
    <p class="s">完成 ${s.done}/${s.total}${s.failed ? ` · 未完成 ${s.failed}` : ''}${s.pending ? ` · 未打卡 ${s.pending}` : ''}</p>
    ${rows}
    <div class="sheet-actions"><button class="btn ghost block" id="sheetClose">关上</button></div>
  `, (root) => {
    root.querySelector('#sheetClose').addEventListener('click', closeSheet);
  });
}

/* ------------------------------- 事件 ------------------------------- */

function bindEvents() {
  document.addEventListener('click', (e) => {
    // 头像：图片盖上来后点到的是 <img>，所以用 closest 认按钮
    if (e.target.closest('#avatarBtn')) {
      $('#avatarFile')?.click();
      return;
    }

    // 底栏两页：朝廷 / 起居
    const pageBtn = e.target.closest('[data-page]');
    if (pageBtn) {
      state.page = pageBtn.dataset.page === 'daily' ? 'daily' : 'court';
      renderPages();
      const main = document.querySelector('main');
      if (main) main.scrollTop = 0;
      return;
    }

    const act = e.target.closest('[data-act]');
    if (act) {
      const id = act.closest('.goal')?.dataset.id;
      const kind = act.dataset.act;
      if (!id) return;
      if (kind === 'fail') {
        void updateToday((r) => {
          const goal = core.liveGoals(r).find((g) => g.id === id);
          return core.setGoalStatus(r, id, goal?.status === 'failed' ? 'pending' : 'failed');
        }).catch((err) => toast(String(err.message ?? err)));
      } else if (kind === 'more' || kind === 'edit') {
        openGoalSheet(id);
      }
      return;
    }

    // 点圆圈 → 弹出进度滑块
    const dot = e.target.closest('[data-progress-open]');
    if (dot) {
      openProgressSheet(dot.dataset.progressOpen, dot.dataset.goal ?? dot.dataset.annual ?? dot.dataset.task, dot.dataset.dept);
      return;
    }

    const hitem = e.target.closest('.hitem');
    if (hitem) {
      openDaySheet(hitem.dataset.date);
      return;
    }

    const calBtn = e.target.closest('[data-cal]');
    if (calBtn) {
      const action = calBtn.dataset.cal;
      const now = new Date();
      const earliest = core.earliestMonth(now, state.retention);
      const latest = core.monthKey(core.bjToday(now));
      let next = state.calMonth;
      if (action === 'prev') next = core.addMonths(state.calMonth, -1);
      if (action === 'next') next = core.addMonths(state.calMonth, 1);
      if (action === 'today') next = latest;
      if (next < earliest) next = earliest;
      if (next > latest) next = latest;
      state.calMonth = next;
      renderHistory();
      return;
    }

    const dayCell = e.target.closest('.cal-cell[data-date]');
    if (dayCell && !dayCell.disabled) {
      openDaySheet(dayCell.dataset.date);
      return;
    }

    const aiBtn = e.target.closest('[data-ai-days]');
    if (aiBtn && !aiBtn.disabled) {
      void runAiAnalysis(Number(aiBtn.dataset.aiDays));
      return;
    }
    const aiRun = e.target.closest('#aiRun');
    if (aiRun && !aiRun.disabled) {
      void runAiAnalysis(Number($('#aiDaysInput')?.value));
      return;
    }

    const aiHist = e.target.closest('[data-ai-id]');
    if (aiHist) {
      void openHistoryAnalysis(aiHist.dataset.aiId);
      return;
    }

    /* ---- 御书房 ---- */
    const summonBtn = e.target.closest('[data-summon]');
    if (summonBtn && !summonBtn.disabled) {
      void summonOne(summonBtn.dataset.summon);
      return;
    }
    const memBtn = e.target.closest('[data-memorial]');
    if (memBtn) {
      void openMemorial(memBtn.dataset.memorial);
      return;
    }
    const disposeBtn = e.target.closest('[data-dispose]');
    if (disposeBtn) {
      void courtDisposeAction(disposeBtn.dataset.dispose);
      return;
    }
    const roleBtn = e.target.closest('[data-court-role]');
    if (roleBtn) {
      void setMyCourtRole(roleBtn.dataset.courtRole);
      return;
    }

    /* ---- 国家大事 / 六部 / 私事 ---- */
    const showAllBtn = e.target.closest('[data-showall]');
    if (showAllBtn) {
      const key = showAllBtn.dataset.showall;
      state.ui.showAll[key] = !state.ui.showAll[key];
      render();
      return;
    }
    const deptBtn = e.target.closest('.dept-row[data-dept]');
    if (deptBtn) {
      void openDeptSheet(deptBtn.dataset.dept);
      return;
    }
    const taskDel = e.target.closest('[data-task-del]');
    if (taskDel) {
      void removeDeptTask(state.court.currentDept, taskDel.dataset.taskDel);
      return;
    }
    const annualMore = e.target.closest('[data-annual-more]');
    if (annualMore) {
      openAnnualEditSheet(annualMore.dataset.annualMore);
      return;
    }
    const annualDel = e.target.closest('[data-annual-del]');
    if (annualDel) {
      void removeAnnualGoal(annualDel.dataset.annualDel);
      return;
    }
    const ledgerEdit = e.target.closest('[data-ledger-edit]');
    if (ledgerEdit) {
      openLedgerEditSheet(ledgerEdit.dataset.ledgerEdit);
      return;
    }
    const ledgerRange = e.target.closest('[data-ledger-range]');
    if (ledgerRange) {
      state.ui.ledgerRange = ledgerRange.dataset.ledgerRange;
      if (state.court.currentDept === 'hubu') void openDeptSheet('hubu');
      return;
    }

    // 司礼监传旨：所有新建差事/账目的唯一入口
    if (e.target.closest('[data-open-dispatch]')) {
      openDispatchSheet();
      return;
    }

    switch (e.target.id) {
      case 'deptToDispatch':
        closeSheet();
        openDispatchSheet();
        return;
      case 'ledgerToDispatch':
        closeSheet();
        openDispatchSheet();
        return;
      case 'deptSummon':
        void summonOne(e.target.dataset.dept || e.target.closest('[data-dept]')?.dataset.dept);
        return;
      case 'openSettings':
        openSettingsSheet();
        return;
      case 'avatarChange':
        $('#avatarFile')?.click();
        return;
      default:
    }

    switch (e.target.id) {
      case 'syncPill':
        void syncFromPill();
        return;
      case 'courtMeeting':
        void openMeeting();
        return;
      case 'saveName': {
        const name = $('#nameInput').value.trim();
        saveIdentity(name).then(async () => {
          await loadAll();
          render();
          toast('称呼已更新');
        }).catch((err) => toast(String(err.message ?? err)));
        return;
      }
      case 'saveHub': {
        const url = normalizeHubUrl($('#hubInput').value);
        store.setMeta('hubUrl', url).then(() => {
          state.hub.url = url;
          state.hub.lastError = null;
          renderSyncPill();
          toast(url ? '中枢地址已保存' : '已清空');
        });
        return;
      }
      case 'discoverHub':
        toast('正在找中枢…');
        discoverHub().then(async (found) => {
          if (!found) {
            toast('没找到。确认电脑上 start-hub.cmd 在跑，且手机连的是同一个 WiFi');
            return;
          }
          state.hub.url = found.url;
          await store.setMeta('hubUrl', found.url);
          render();
          toast(`找到中枢：${found.url}`);
        });
        return;
      case 'testHub':
        testHub($('#hubInput').value || state.hub.url).then((info) => {
          toast(`通了！中枢时间 ${fmtDateTime(info.serverTime)}，${info.members?.length ?? 0} 位成员`);
        }).catch((err) => toast(`连不上：${String(err.message ?? err)}`));
        return;
      case 'syncNow':
        void runSync(true);
        return;
      case 'checkPerm':
        ensurePermission().then(async (r) => {
          toast(r.granted ? '通知权限没问题' : `没拿到通知权限：${r.reason ?? '被拒绝'}`);
          await refreshNotifyStatus();
        });
        return;
      case 'exactAlarm':
        openExactAlarmSetting().then(async (r) => {
          toast(r.ok ? '请把「允许设定精确闹钟」打开' : `打不开设置：${r.reason ?? '这版安卓不支持'}`);
          await refreshNotifyStatus();
        });
        return;
      case 'replanNow':
        replan().then(async (r) => {
          toast(r?.applied ? `已排上 ${r.applied} 条提醒` : `没排上：${r?.reason ?? '环境不支持'}`);
          await refreshNotifyStatus();
        });
        return;
      case 'testNotify':
        ensurePermission().then(async (r) => {
          if (!r.granted) {
            toast('先给通知权限');
            return;
          }
          await ensureChannel();
          const sent = await sendTestNotification();
          toast(sent ? '3 秒后应该会弹一条' : '当前环境发不了通知');
        });
        return;
      case 'copyData': {
        // 用户指定格式：2026年11月18日：事项1；事项2。一天一行
        const text = core.exportRecordsAsText(state.records);
        if (!text) {
          toast('还没有可导出的目标');
          return;
        }
        const dayCount = text.split('\n').length;
        if (navigator.clipboard?.writeText) {
          navigator.clipboard.writeText(text)
            .then(() => toast(`已复制 ${dayCount} 天（每天一行：2026年11月18日：事项1；事项2。）`, 3600))
            .catch(() => toast('复制失败，可能是权限问题'));
          return;
        }
        // 没有剪贴板权限时，直接把内容摊出来让人长按复制
        openSheet(`
          <h3>打卡记录（${dayCount} 天）</h3>
          <p class="s">这里不支持一键复制，长按下面的文字选择全部再复制</p>
          <pre class="ai-result">${esc(text)}</pre>
          <div class="sheet-actions"><button class="btn block" id="copyClose">关上</button></div>
        `, (root) => {
          root.querySelector('#copyClose').addEventListener('click', closeSheet);
        });
        return;
      }
      default:
    }
  });

  document.addEventListener('change', (e) => {
    if (e.target.id === 'avatarFile') {
      const file = e.target.files?.[0];
      e.target.value = '';
      void onAvatarPicked(file);
      return;
    }
    if (e.target.id !== 'retentionSelect') return;
    const months = Number(e.target.value);
    if (!Number.isFinite(months) || months < 1) return;
    state.retention = Math.min(12, months);
    store.setMeta('retentionMonths', state.retention).then(async () => {
      const removed = await applyRetention();
      const earliest = core.earliestMonth(new Date(), state.retention);
      if (state.calMonth < earliest) state.calMonth = earliest;
      render();
      toast(removed ? `已清理 ${removed} 天更早的记录` : `历史保留已改成 ${retentionLabel()}`);
    });
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && e.target.id === 'ledgerItem') {
      e.preventDefault();
      document.querySelector('#ledgerSave')?.click();
    }
  });

  window.addEventListener('online', () => { state.online = true; void runSync(false); });
  window.addEventListener('offline', () => { state.online = false; renderSyncPill(); });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      void applyPlan(state.records, new Date(), state.court.state);
      void runSync(false);
    }
  });
}

/* ------------------------------- 启动 ------------------------------- */

async function boot() {
  await ensureChannel();
  const identity = await loadIdentity();
  if (identity) state.identity = identity;
  const savedAvatar = await store.getMeta('avatar', null);
  if (savedAvatar) state.avatar.dataUrl = savedAvatar;
  await loadAll();
  await loadCourtCache();
  await applyRetention();
  // 日历不能停在超出保留范围的月份
  const earliest = core.earliestMonth(new Date(), state.retention);
  const latest = core.monthKey(core.bjToday(new Date()));
  if (state.calMonth < earliest) state.calMonth = earliest;
  if (state.calMonth > latest) state.calMonth = latest;
  render();
  if (state.identity) {
    await ensurePermission().catch(() => {});
    void applyPlan(state.records, new Date(), state.court.state);
    void loadAiInfo().then(() => {
      if (state.page === 'daily') renderAI();
    });
    void ensureCourt();
    void runSync(false);
  }
}

bindEvents();
boot().catch((err) => {
  console.error(err);
  document.body.insertAdjacentHTML('beforeend', `<div class="toast">启动失败：${esc(err?.message ?? err)}</div>`);
});
