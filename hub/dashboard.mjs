/**
 * 中枢看板页面（纯渲染，不含业务逻辑）
 *
 * 交互原则（用户要求）：点谁的卡片就看谁，别把所有信息堆在下面。
 *  - 顶部只有一排成员卡片 + 一行全局状态
 *  - 下面只显示"当前选中成员"的详情：今日目标、同步记录、备份下载、AI 复盘与历史
 *  - 每 5 秒刷新，但正在看的复盘结果不会被刷掉
 */

const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const fmtTime = (iso) => (iso ? String(iso).slice(5, 16).replace('T', ' ') : '—');
const fmtBytes = (n) => (n > 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(0, Math.round((n ?? 0) / 1024))} KB`);

export function renderDashboardPage({ today, analysis, dataDir, allowedDays }) {
  const boot = {
    today,
    dataDir,
    analysis: {
      available: Boolean(analysis?.available),
      model: analysis?.model ?? null,
      keySource: analysis?.keySource ?? null,
      reason: analysis?.reason ?? null,
      days: Array.isArray(allowedDays) && allowedDays.length ? allowedDays : [3, 7, 14, 30, 90],
    },
  };

  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>大内家事 · 看板</title>
<style>
  :root{color-scheme:light}
  body{margin:0;background:#f7f3ea;color:#23201c;font-family:-apple-system,"PingFang SC","Microsoft YaHei",sans-serif;line-height:1.5}
  header{padding:18px 18px 6px}
  h1{font-size:1.22rem;margin:0 0 4px}
  .topline{color:#8a8072;font-size:.78rem}
  .wrap{padding:10px 18px 34px;display:grid;gap:12px;max-width:1080px}
  .cards{display:grid;gap:10px;grid-template-columns:repeat(auto-fill,minmax(178px,1fr))}
  .card{border:1px solid #e6ddcc;border-radius:13px;padding:11px 13px;background:#fffdf8;cursor:pointer;transition:.12s}
  .card:hover{border-color:#cbb99a}
  .card.sel{border-color:#9E2B25;background:#fff8f2;box-shadow:0 0 0 2px rgba(158,43,37,.10)}
  .card .name{font-weight:600;display:flex;align-items:center;gap:6px;font-size:.95rem}
  .dot{width:8px;height:8px;border-radius:50%;background:#d8cfbf;flex:none}
  .dot.on{background:#4A6B4A;box-shadow:0 0 0 3px rgba(74,107,74,.15)}
  .card .st{margin:5px 0 2px;font-size:.84rem;color:#4a443a}
  .card .meta{color:#8a8072;font-size:.72rem}
  .bar{height:5px;background:#eee5d5;border-radius:99px;overflow:hidden;margin:6px 0 4px}
  .bar i{display:block;height:100%;background:#9E2B25}
  section.panel{background:#fffdf8;border:1px solid #e6ddcc;border-radius:14px;padding:14px 16px}
  section.panel h2{font-size:.95rem;margin:0 0 10px;display:flex;gap:8px;align-items:center;flex-wrap:wrap}
  section.panel h2 small{color:#8a8072;font-weight:400;font-size:.72rem}
  .who-title{font-size:1.02rem;font-weight:700}
  .goalrow{display:flex;gap:9px;align-items:flex-start;padding:8px 0;border-bottom:1px dashed #eee3cf;font-size:.86rem}
  .goalrow:last-child{border-bottom:0}
  .goalrow .mark{flex:none;width:22px;text-align:center}
  .goalrow .txt{flex:1}
  .goalrow .sub{color:#8a8072;font-size:.75rem}
  .note{color:#9E2B25}
  .feed div{font-size:.8rem;padding:6px 0;border-bottom:1px dashed #eee3cf;color:#3f3a32}
  .feed div:last-child{border-bottom:0}
  .tag{display:inline-block;font-size:.68rem;padding:1px 7px;border-radius:99px;border:1px solid #ddd0b8;color:#6b6257;margin-left:4px}
  .tag.auto{background:#f1f6ef;border-color:#bfd3bf;color:#4A6B4A}
  .tag.manual{background:#fbf1ea;border-color:#e6c9b6;color:#9E2B25}
  .tag.cache{background:#f2f0fa;border-color:#cfc9e6;color:#5b4b8a}
  .btn{border:1px solid #ddd0b8;background:#fffdf8;color:#3f3a32;border-radius:9px;padding:6px 11px;font-size:.78rem;cursor:pointer;font-family:inherit;text-decoration:none;display:inline-block}
  .btn:hover{background:#f6eedf}
  .btn:disabled{opacity:.45;cursor:not-allowed}
  .btn.primary{background:#9E2B25;border-color:#9E2B25;color:#fff}
  .btnrow{display:flex;gap:6px;flex-wrap:wrap;margin:8px 0 2px}
  .ai-days{display:flex;gap:6px;flex-wrap:wrap;margin:4px 0 6px}
  .ai-row{display:flex;gap:8px;align-items:center;flex-wrap:wrap;padding:7px 0;border-bottom:1px dashed #eee3cf}
  .ai-row:last-child{border-bottom:0}
  .ai-row .who{font-size:.84rem;min-width:88px;font-weight:600}
  pre.out{white-space:pre-wrap;word-break:break-word;background:#fbf7ee;border:1px solid #eee3cf;border-radius:10px;padding:12px;font-size:.82rem;line-height:1.68;max-height:56vh;overflow:auto;margin:10px 0 0;font-family:inherit}
  .hist div{font-size:.78rem;color:#3f3a32;padding:6px 0;border-bottom:1px dashed #eee3cf;cursor:pointer;display:flex;justify-content:space-between;gap:8px}
  .hist div:last-child{border-bottom:0}
  .hist div:hover{color:#9E2B25}
  .hint{color:#8a8072;font-size:.76rem;margin-top:6px;line-height:1.5}
  code{background:#eee5d5;border-radius:5px;padding:1px 5px;font-size:.84em;word-break:break-all}
  .path{background:#fbf7ee;border:1px dashed #ddd0b8;border-radius:8px;padding:7px 9px;font-size:.75rem;word-break:break-all}
  .row-between{display:flex;justify-content:space-between;align-items:center;gap:10px;flex-wrap:wrap}
  .empty{color:#8a8072;font-size:.82rem;padding:10px 0}
</style></head><body>
<header>
  <h1>🐱 大内家事 · ${esc(today)}</h1>
  <div class="topline" id="topline">加载中…</div>
</header>
<div class="wrap">
  <div class="cards" id="cards"><div class="empty">加载中…</div></div>

  <section class="panel" id="memberPanel" hidden>
    <h2><span class="who-title" id="memberName"></span><small id="memberSub"></small></h2>
    <div id="memberBody"></div>
  </section>

  <section class="panel">
    <h2>六部台账 <small>点一部看它的差事与奏疏</small></h2>
    <div class="cards" id="deptCards"><div class="empty">加载中…</div></div>
    <div id="deptBody"></div>
  </section>

  <section class="panel">
    <h2>本地备份 <small>数据只在这台电脑上</small></h2>
    <div class="path" id="dataDir">—</div>
    <div class="btnrow">
      <button class="btn" id="openFolder">在电脑上打开数据文件夹</button>
      <button class="btn" id="openAnalyses">打开复盘记录文件夹</button>
    </div>
    <div class="hint">每位成员的下载按钮在点开他的卡片之后。</div>
  </section>
</div>
<script>
const BOOT = ${JSON.stringify(boot)};
const esc = ${esc.toString()};
const fmtTime = ${fmtTime.toString()};
const fmtBytes = ${fmtBytes.toString()};
let selected = null;
let lastOut = null; // {title, text, days, cached}

function renderTopline(st) {
  const s = (st.syncs || [])[0];
  const el = document.getElementById('topline');
  if (!st.members || !st.members.length) { el.textContent = '还没有成员同步过数据'; return; }
  const online = (st.devices || []).filter((d) => d.online).length;
  el.textContent = '在线 ' + online + '/' + st.members.length + ' 人'
    + (s ? ' · 最近同步 ' + esc(s.memberName || s.memberId) + '（' + (s.mode === 'manual' ? '手动' : '自动') + '）' + fmtTime(s.at) : '')
    + ' · 服务时间 ' + fmtTime(st.serverTime);
}

function renderCards(st) {
  const online = new Map((st.devices || []).filter((d) => d.online).map((d) => [d.memberId, d]));
  const el = document.getElementById('cards');
  const rows = st.members || [];
  if (!rows.length) { el.innerHTML = '<div class="empty">还没有成员同步过数据。手机端装好 App、连上同一网络后会出现在这里。</div>'; return; }
  el.innerHTML = rows.map((r) => {
    const dev = online.get(r.memberId);
    const pct = r.total ? Math.round((r.done / r.total) * 100) : 0;
    return '<div class="card ' + (selected === r.memberId ? 'sel' : '') + '" data-member="' + esc(r.memberId) + '">'
      + '<div class="name"><span class="dot ' + (dev ? 'on' : '') + '"></span>' + esc(r.name) + '</div>'
      + '<div class="st">' + (r.submitted ? r.done + '/' + r.total + ' 完成' : '今天还没提交') + '</div>'
      + '<div class="bar"><i style="width:' + pct + '%"></i></div>'
      + '<div class="meta">' + (dev ? '在线 · ' + (dev.lastMode === 'manual' ? '手动' : '自动') + ' ' + fmtTime(dev.lastSeen) : (r.lastDate ? '最近 ' + r.lastDate : '还没同步过')) + '</div>'
      + '</div>';
  }).join('');
}

function goalRow(g) {
  const icon = g.status === 'done' ? '✅' : g.status === 'failed' ? '❌' : '⬜';
  const label = g.status === 'done' ? '已完成' : g.status === 'failed' ? '未完成' : '未打卡';
  const when = g.checkedAt ? ' · ' + fmtTime(g.checkedAt) : '';
  const note = g.note ? ' · <span class="note">「' + esc(g.note) + '」</span>' : '';
  return '<div class="goalrow"><span class="mark">' + icon + '</span><div class="txt">' + esc(g.text)
    + '<div class="sub">' + label + when + note + '</div></div></div>';
}

function renderMember(m, st) {
  const panel = document.getElementById('memberPanel');
  panel.hidden = false;
  document.getElementById('memberName').textContent = m.member.name;
  const dev = (m.devices || [])[0];
  document.getElementById('memberSub').textContent = ''
    + (dev ? (dev.online ? '在线' : '离线') + ' · 最近' + (dev.lastMode === 'manual' ? '手动' : '自动') + '同步 ' + fmtTime(dev.lastSeen) + (dev.ip ? ' · ' + dev.ip : '') : '没有同步记录')
    + ' · 共 ' + m.stats.days + ' 天记录（' + fmtBytes(m.stats.bytes) + '）';

  const a = (st.analysis) || {};
  const days = a.days || BOOT.analysis.days;
  const btns = days.map((d) => '<button class="btn" data-analyze="' + d + '"' + (a.available ? '' : ' disabled') + '>' + d + ' 天</button>').join('');

  const goals = m.today.goals.length
    ? m.today.goals.map(goalRow).join('')
    : '<div class="empty">今天还没有目标</div>';

  const syncs = (m.syncs || []).length
    ? m.syncs.map((s) => '<div>' + fmtTime(s.at) + ' <span class="tag ' + (s.mode === 'manual' ? 'manual' : 'auto') + '">' + (s.mode === 'manual' ? '手动' : '自动') + '</span>'
        + (s.written ? ' <span style="color:#8a8072">写入 ' + s.written + ' 天</span>' : '')
        + (s.ip ? ' <span style="color:#8a8072">' + esc(s.ip) + '</span>' : '') + '</div>').join('')
    : '<div class="empty">还没有同步记录</div>';

  const analyses = (m.analyses || []).length
    ? m.analyses.map((x) => '<div data-analysis="' + esc(x.id) + '"><span>' + fmtTime(x.createdAt) + ' · ' + x.days + ' 天' + (x.cached ? ' <span class="tag cache">缓存</span>' : '') + '</span><span style="color:#8a8072">' + x.chars + ' 字</span></div>').join('')
    : '<div class="empty">还没有复盘</div>';

  document.getElementById('memberBody').innerHTML =
    '<h2 style="margin-top:4px">今天的目标</h2>' + goals
    + '<div class="row-between" style="margin-top:12px"><h2 style="margin:0">AI 复盘</h2>'
    + '<span class="hint" style="margin:0">' + (a.available ? '模型 ' + esc(a.model || '') : esc(a.reason || '未配置模型')) + '</span></div>'
    + '<div class="ai-days">' + btns + '</div>'
    + '<div class="hint">同一个人 + 同一区间 + 数据没变 → 直接用上次结果，不花 token。</div>'
    + '<div class="hist" id="memberAnalyses" style="margin-top:8px">' + analyses + '</div>'
    + '<h2 style="margin-top:14px">这台设备的同步</h2><div class="feed">' + syncs + '</div>'
    + '<div class="btnrow" style="margin-top:12px">'
    + '<a class="btn" href="/api/backup/download?memberId=' + encodeURIComponent(m.member.id) + '">下载 JSON</a>'
    + '<a class="btn" href="/api/backup/text?memberId=' + encodeURIComponent(m.member.id) + '">下载 TXT（每天一行）</a>'
    + '</div>';

  // 复盘结果区独立于成员面板，刷新不会把它清掉
  let out = document.getElementById('analysisOut');
  if (!out) {
    out = document.createElement('pre');
    out.className = 'out';
    out.id = 'analysisOut';
    out.hidden = true;
    panel.appendChild(out);
  }
  if (lastOut) {
    out.hidden = false;
    out.textContent = lastOut.title + '\\n\\n' + lastOut.text;
  }
}

async function refresh() {
  try {
    const st = await (await fetch('/api/status')).json();
    renderTopline(st);
    if (!selected && st.members && st.members.length) selected = st.members[0].memberId;
    renderCards(st);
    document.getElementById('dataDir').textContent = BOOT.dataDir || '—';
    if (selected) {
      const m = await (await fetch('/api/member?memberId=' + encodeURIComponent(selected))).json();
      if (m.ok) renderMember(m, st);
    }
    await refreshCourt();
  } catch (e) {
    document.getElementById('topline').textContent = '中枢连接异常：' + e.message;
  }
}

/* ------------------------- 六部台账 ------------------------- */
let selectedDept = null;
let courtData = null;

const STATUS_CN = { pending: '待批阅', approved: '已朱批', held: '留中', rejected: '已驳回', counciling: '待合议' };

async function refreshCourt() {
  const r = await fetch('/api/court/overview');
  if (!r.ok) return;
  courtData = await r.json();
  renderDeptCards();
  renderDeptBody();
}

function renderDeptCards() {
  const el = document.getElementById('deptCards');
  const depts = courtData?.depts ?? [];
  if (!depts.length) {
    el.innerHTML = '<div class="empty">还没有六部台账</div>';
    return;
  }
  el.innerHTML = depts.map((d) => {
    const open = d.openTasks;
    const avg = d.avgProgress === null || d.avgProgress === undefined ? '—' : d.avgProgress + '%';
    return '<div class="card ' + (selectedDept === d.id ? 'sel' : '') + '" data-dept="' + esc(d.id) + '">'
      + '<div class="name">' + esc(d.icon || '') + ' ' + esc(d.name) + '</div>'
      + '<div class="st">在办 ' + open + ' 道 · 均 ' + avg + '</div>'
      + '<div class="meta">待批奏疏 ' + d.pendingMemorials + ' · 近奏 ' + d.memorials.length + '</div>'
      + '</div>';
  }).join('');
  if (!selectedDept) selectedDept = depts[0].id;
}

function renderDeptBody() {
  const el = document.getElementById('deptBody');
  const dept = (courtData?.depts ?? []).find((d) => d.id === selectedDept);
  if (!dept) {
    el.innerHTML = '';
    return;
  }
  const tasks = dept.tasks.length
    ? dept.tasks.map((t) => '<div class="goalrow"><span class="mark">' + (t.progress >= 100 ? '✅' : '◐') + '</span>'
        + '<div class="txt">' + esc(t.text) + '<div class="sub">' + t.progress + '% · ' + esc(t.status) + '</div>'
        + '<div class="bar" style="margin-top:4px"><i style="width:' + t.progress + '%"></i></div></div></div>').join('')
    : '<div class="empty">该部尚无御赐差事</div>';
  const mems = dept.memorials.length
    ? dept.memorials.map((m) => '<div>' + fmtTime(m.createdAt) + ' 《' + esc(m.title) + '》'
        + ' <span class="tag ' + (m.status === 'approved' ? 'auto' : m.status === 'pending' ? 'manual' : '') + '">'
        + (STATUS_CN[m.status] || m.status) + '</span></div>').join('')
    : '<div class="empty">还没有奏疏</div>';
  el.innerHTML = '<h2 style="margin-top:10px">' + esc(dept.name) + ' · 御赐差事</h2>'
    + (dept.duty ? '<div style="color:#8A7B65;font-size:12px;margin:-4px 0 10px">本职：' + esc(dept.duty) + '</div>' : '')
    + tasks
    + '<h2 style="margin-top:12px">近来的奏疏</h2><div class="feed">' + mems + '</div>';
}

document.addEventListener('click', (e) => {
  const card = e.target.closest('.card[data-dept]');
  if (card) {
    selectedDept = card.dataset.dept;
    renderDeptCards();
    renderDeptBody();
  }
});

async function analyze(days, force) {
  if (!selected) return;
  const out = document.getElementById('analysisOut');
  out.hidden = false;
  out.textContent = force ? '正在重新生成（会消耗 token）…' : '正在分析…数据没变化的话会直接用上次结果，不花 token。';
  try {
    const res = await fetch('/api/analyze', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ memberId: selected, days, force: !!force }),
    });
    const body = await res.json();
    if (!res.ok || !body.ok) {
      out.textContent = '复盘失败：' + (body.error || ('HTTP ' + res.status));
      return;
    }
    const a = body.analysis;
    const tag = a.cached ? '（缓存结果，没花 token）' : '';
    lastOut = { title: '🐱 ' + a.memberName + ' · 最近 ' + a.days + ' 天' + tag + ' · ' + a.model + ' · ' + fmtTime(a.createdAt), text: a.text, days: a.days, cached: !!a.cached };
    out.textContent = lastOut.title + '\\n\\n' + lastOut.text;
    if (document.getElementById('regen')) document.getElementById('regen').remove();
    if (a.cached) {
      const btn = document.createElement('button');
      btn.className = 'btn';
      btn.id = 'regen';
      btn.style.marginTop = '8px';
      btn.textContent = '重新生成（会消耗 token）';
      btn.addEventListener('click', () => analyze(a.days, true));
      out.insertAdjacentElement('afterend', btn);
    }
    refresh();
  } catch (e) {
    out.textContent = '复盘失败：' + e.message;
  }
}

document.addEventListener('click', async (e) => {
  const card = e.target.closest('.card[data-member]');
  if (card) { selected = card.dataset.member; lastOut = null; const old = document.getElementById('regen'); if (old) old.remove(); const o = document.getElementById('analysisOut'); if (o) o.remove(); refresh(); return; }

  const aiBtn = e.target.closest('[data-analyze]');
  if (aiBtn && !aiBtn.disabled) { analyze(Number(aiBtn.dataset.analyze), false); return; }

  const histItem = e.target.closest('[data-analysis]');
  if (histItem) {
    const res = await fetch('/api/analysis?id=' + encodeURIComponent(histItem.dataset.analysis));
    const body = await res.json();
    if (body.ok) {
      const a = body.analysis;
      lastOut = { title: '🐱 ' + a.memberName + ' · 最近 ' + a.days + ' 天 · ' + a.model + ' · ' + fmtTime(a.createdAt), text: a.text };
      const out = document.getElementById('analysisOut');
      out.hidden = false;
      out.textContent = lastOut.title + '\\n\\n' + lastOut.text;
    }
    return;
  }

  if (e.target.id === 'openFolder' || e.target.id === 'openAnalyses') {
    const which = e.target.id === 'openAnalyses' ? 'analyses' : '';
    try {
      const res = await fetch('/api/open-folder', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ which }) });
      const body = await res.json();
      if (!body.ok) alert(body.error || '打不开');
    } catch (err) { alert('打不开：' + err.message); }
  }
});

refresh();
setInterval(refresh, 5000);
</script>
</body></html>`;
}

export { esc };
