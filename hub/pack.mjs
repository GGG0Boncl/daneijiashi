/**
 * 复盘素材包（中枢和 CLI 共用）
 *
 * 定性复盘最要紧的是"人话"——反复卡住的目标、断掉的日子、备注里的原话。
 * 这个模块把它们挑出来排好，模型只负责"想"和"写"。
 *
 * 规则（写进代码里，防止跑偏）：
 *   · 一次只读一个人的数据，不做跨成员比较
 *   · 只输出事实与信号，不下结论、不打分、不批评
 */
import {
  STATUS,
  ICON,
  bjToday,
  nowIso,
  isValidDate,
  dateToWeekday,
  addDays,
  rangeDates,
  readRecord,
  listMembers,
  statsFor,
} from '../checkin.mjs';

export const ALLOWED_DAYS = [3, 7, 14, 30, 60, 90, 180, 365];

const pct = (x) => (x === null || x === undefined ? '—' : `${Math.round(x * 100)}%`);
const ftime = (iso) => (iso ? String(iso).slice(11, 16) : '');

/** 解析区间：优先 from/to，其次 days（默认 7，上限 365） */
export function resolveRange({ days = 7, from = null, to = null } = {}, now = new Date()) {
  if (from || to) {
    const a = String(from ?? to);
    const b = String(to ?? from);
    if (!isValidDate(a) || !isValidDate(b)) throw new Error(`日期格式应为 YYYY-MM-DD：${a} ~ ${b}`);
    if (a > b) throw new Error('from 不能晚于 to');
    return rangeDates(a, b);
  }
  const n = Number.isFinite(Number(days)) ? Math.floor(Number(days)) : 7;
  if (n < 1 || n > 365) throw new Error('天数需在 1~365 之间（最长一年）');
  const end = bjToday(now);
  return rangeDates(addDays(end, -(n - 1)), end);
}

/** 找出成员（不存在就报错，不瞎编） */
export function findMember(memberId) {
  const id = String(memberId ?? '').trim();
  if (!id) throw new Error('缺少成员ID');
  const member = listMembers().find((m) => m.id === id || m.name === id);
  if (!member) throw new Error(`找不到成员「${id}」`);
  return member;
}

function readWindow(memberId, dates) {
  return dates.map((d) => readRecord(memberId, d)).filter(Boolean);
}

/** 备注原话：定性分析的金矿 */
function collectNotes(records) {
  const out = [];
  for (const rec of records) {
    for (const g of rec.goals ?? []) {
      if (g.deleted) continue;
      if (g.note) out.push({ date: rec.date, goal: g.text, status: g.status, note: g.note });
    }
  }
  return out;
}

/** 相近文本聚类：找出"换个说法还是那件事"（包含匹配，够用） */
function clusterStuck(records, minTimes = 2) {
  const rows = [];
  for (const rec of records) {
    for (const g of rec.goals ?? []) {
      if (g.deleted) continue;
      rows.push({ text: String(g.text ?? '').trim(), status: g.status, date: rec.date });
    }
  }
  const groups = new Map();
  for (const r of rows) {
    if (!r.text) continue;
    let key = null;
    for (const k of groups.keys()) {
      if (k === r.text || (k.length >= 2 && (r.text.includes(k) || k.includes(r.text)))) {
        key = k;
        break;
      }
    }
    if (!key) key = r.text;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(r);
  }
  return [...groups.entries()]
    .map(([text, items]) => ({
      text,
      times: items.length,
      done: items.filter((i) => i.status === 'done').length,
      failed: items.filter((i) => i.status === 'failed').length,
      pending: items.filter((i) => i.status === 'pending').length,
    }))
    .filter((g) => g.times >= minTimes && g.done / g.times < 0.6)
    .sort((a, b) => b.times - a.times || a.done / a.times - b.done / b.times);
}

function dayDetails(memberId, dates) {
  return dates.map((d) => {
    const rec = readRecord(memberId, d);
    const goals = (rec?.goals ?? []).filter((g) => !g.deleted);
    return {
      date: d,
      weekday: dateToWeekday(d),
      submitted: Boolean(rec) && goals.length > 0,
      goals: goals.map((g) => ({
        text: g.text,
        status: g.status,
        statusLabel: STATUS[g.status] ?? g.status,
        at: g.checkedAt,
        note: g.note ?? '',
      })),
    };
  });
}

/** 组出完整素材包（纯数据，不含 IO 之外的副作用） */
export function buildPack(memberOrId, { days = 7, from = null, to = null } = {}, now = new Date()) {
  const member = typeof memberOrId === 'string' ? findMember(memberOrId) : memberOrId;
  const dates = resolveRange({ days, from, to }, now);
  const records = readWindow(member.id, dates);
  const stats = statsFor(member.id, dates);
  const notes = collectNotes(records);
  const stuck = clusterStuck(records);
  const details = dayDetails(member.id, dates);

  // 中长期：区间够长就多给一个"前半程 vs 后半程"
  let contrast = null;
  if (dates.length >= 14) {
    const mid = Math.floor(dates.length / 2);
    const earlyDates = dates.slice(0, mid);
    const lateDates = dates.slice(mid);
    const early = statsFor(member.id, earlyDates);
    const late = statsFor(member.id, lateDates);
    contrast = {
      early: { from: earlyDates[0], to: earlyDates.at(-1), submittedDays: early.submittedDays, days: earlyDates.length, rate: early.completionRate, goals: early.totalGoals },
      late: { from: lateDates[0], to: lateDates.at(-1), submittedDays: late.submittedDays, days: lateDates.length, rate: late.completionRate, goals: late.totalGoals },
    };
  }

  return {
    member: { id: member.id, name: member.name },
    range: { from: dates[0], to: dates.at(-1), days: dates.length },
    generatedAt: nowIso(now),
    stats,
    contrast,
    stuck,
    notes,
    details,
  };
}

/** 人话版素材包（给模型看的正文） */
export function renderPackText(pack) {
  const { member, range, stats, contrast, stuck, notes, details } = pack;
  const L = [];
  const push = (s = '') => L.push(s);

  push(`🐱 复盘素材 · ${member.name} · ${range.from} ~ ${range.to}（${range.days} 天）`);
  push('');
  push('一、提交与完成（辅助数字，不是重点）');
  push(`  提交 ${stats.submittedDays}/${stats.daysInRange} 天（${pct(stats.submissionRate)}）`);
  push(`  目标 ${stats.totalGoals} 条：完成 ${stats.done}、主动标记未完成 ${stats.failed}、一直没打卡 ${stats.pending}`);
  push(`  完成率 ${pct(stats.completionRate)}`);
  if (stats.goalsPerDay) push(`  每日目标量 ${stats.goalsPerDay.min}~${stats.goalsPerDay.max} 条，平均 ${stats.goalsPerDay.avg.toFixed(1)}`);
  push(`  最长连续提交 ${stats.longestStreak} 天${stats.longestStreakRange ? `（${stats.longestStreakRange[0]} ~ ${stats.longestStreakRange[1]}）` : ''}，当前连续 ${stats.currentStreakBackwards} 天`);
  if (stats.missingDates.length) {
    const shown = stats.missingDates.slice(0, 12).join('、');
    push(`  没提交的日子（${stats.missingDates.length} 天）：${shown}${stats.missingDates.length > 12 ? ' …' : ''}`);
  }

  push('');
  push('二、节奏信号（这些才是"为什么"）');
  if (stats.heavyDays.days) push(`  · 目标 ≥5 条的日子 ${stats.heavyDays.days} 天，完成率 ${pct(stats.heavyDays.completionRate)}`);
  if (stats.lightDays.days) push(`  · 目标 ≤3 条的日子 ${stats.lightDays.days} 天，完成率 ${pct(stats.lightDays.completionRate)}`);
  if (stats.heavyDays.completionRate !== null && stats.lightDays.completionRate !== null) {
    const gap = stats.lightDays.completionRate - stats.heavyDays.completionRate;
    if (gap > 0.15) push(`  · 轻量日比重量日高 ${pct(gap)}：量一多就掉，这是"安排过满"的信号`);
  }
  if (stats.lateNightChecks) push(`  · 22:00 之后才打卡 ${stats.lateNightChecks} 次（拖到睡前才结算）`);
  const wd = (stats.weekday ?? []).filter((w) => w.days >= 2).sort((a, b) => a.rate - b.rate);
  if (wd.length >= 2) push(`  · 完成率最低：${wd[0].weekday} ${pct(wd[0].rate)}（${wd[0].days} 天）；最高：${wd.at(-1).weekday} ${pct(wd.at(-1).rate)}`);
  if (stats.pending) push(`  · 还有 ${stats.pending} 条从头到尾没表态（可能是"忘了"，也可能是"不想面对"）`);
  if (contrast) {
    push(`  · 前半程 ${contrast.early.from}~${contrast.early.to}：提交 ${contrast.early.submittedDays}/${contrast.early.days}，完成率 ${pct(contrast.early.rate)}`);
    push(`  · 后半程 ${contrast.late.from}~${contrast.late.to}：提交 ${contrast.late.submittedDays}/${contrast.late.days}，完成率 ${pct(contrast.late.rate)}`);
    const drift = contrast.late.rate - contrast.early.rate;
    if (Math.abs(drift) >= 0.1) push(`  · 趋势：${drift > 0 ? '后半程更好' : '后半程在走低'}（${drift > 0 ? '+' : ''}${pct(drift)}）`);
  }

  push('');
  push('三、反复卡住的目标（出现 ≥2 次且完成率 <60%）');
  if (stuck.length) {
    for (const s of stuck) push(`  · ${s.text}：出现 ${s.times} 次，完成 ${s.done}、未完成 ${s.failed}、未打卡 ${s.pending}`);
  } else {
    push('  （没有明显的重复卡壳，目标本身可能选得挺合适）');
  }

  push('');
  push('四、逐日明细（含原话备注）');
  for (const d of details) {
    if (!d.submitted) {
      push(`  ${d.date} ${d.weekday}　没提交`);
      continue;
    }
    const done = d.goals.filter((g) => g.status === 'done').length;
    push(`  ${d.date} ${d.weekday}　${d.goals.length} 条 · 完成 ${done}`);
    for (const g of d.goals) {
      const mark = ICON[g.status] ?? '⬜';
      const time = g.at ? `（${ftime(g.at)}）` : '';
      const note = g.note ? `　「${g.note}」` : '';
      push(`      ${mark} ${g.text}${time}${note}`);
    }
  }

  if (notes.length) {
    push('');
    push('五、备注原话（写分析时最值得引用的部分）');
    for (const n of notes.slice(0, 30)) {
      push(`  ${n.date} · ${n.goal}（${STATUS[n.status] ?? n.status}）：「${n.note}」`);
    }
    if (notes.length > 30) push(`  …还有 ${notes.length - 30} 条`);
  }

  push('');
  push('六、写分析时的自我提醒');
  push('  · 只分析这一个人，绝不和别的成员比');
  push('  · 先讲清"发生了什么、为什么"，数字只做辅证，不要变成表格堆砌');
  push('  · 结构固定：①现状复盘 ②识别到的问题 ③温和、能落地的小调整');
  push('  · 语气像家里人聊天，别用"执行力不足"这类考评词');
  push('  · 引用 1~2 句本人备注原话，比任何百分比都有说服力');

  return L.join('\n');
}

/** 给模型的 system prompt（固定三段式，语气要求） */
export const SYSTEM_PROMPT = [  '你是大内家事小助手，语气温和、生活化，像家里人说话。',
  '你会收到一位成员最近一段时间的打卡素材，请写一份定性复盘，不要只堆数字。',
  '必须严格按三段输出，用中文：',
  '① 现状复盘总结：两三句话讲清这段时间实际是怎么过的；',
  '② 识别到的问题：挑 2~4 个具体问题，每个都带证据（哪天、哪条目标、哪句原话）；',
  '③ 建议：2~3 条明天就能试的小调整，越小越好。',
  '禁止：严厉批评、用"执行力不足/自律性差/拖延症"这类考评词、跨成员比较、编造素材里没有的数据。',
  '如果素材里某段时间没有记录，就直说"这段时间没有记录，先不判断"。',
  '输出用简短的小标题 + 段落，不要输出 Markdown 表格。',
].join('\n');

/**
 * 纯文本导出（用户指定格式，给「复制全部数据」和看板下载用）：
 *   2026年11月18日：具体事项1；具体事项2；…；具体事项N。
 * 一天一行；没目标的日子不占行；删除的目标不出现。
 */
export function recordsAsText(records) {
  return (records ?? [])
    .filter((r) => /^\d{4}-\d{2}-\d{2}$/.test(String(r?.date ?? '')))
    .map((r) => ({
      date: r.date,
      goals: (r.goals ?? []).filter((g) => !g.deleted && String(g.text ?? '').trim()),
    }))
    .filter((r) => r.goals.length > 0)
    .sort((a, b) => a.date.localeCompare(b.date))
    .map((r) => {
      const [y, m, d] = r.date.split('-').map(Number);
      const items = r.goals
        .map((g) => String(g.text).replace(/[；;]+/g, '，').trim())
        .filter(Boolean)
        .join('；');
      return `${y}年${m}月${d}日：${items}。`;
    })
    .join('\n');
}
