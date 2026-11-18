#!/usr/bin/env node
/**
 * 造一份"像真人"的演示数据，只为了验证复盘素材包和界面。
 *
 * 安全阀：默认写到临时目录；要写进真实数据目录必须显式 --force。
 *
 * 用法：
 *   node tools/seed-demo.mjs                    # 写到系统临时目录并打印路径
 *   node tools/seed-demo.mjs --days 30 --name 小满
 *   CHECKIN_DATA_DIR=... node tools/seed-demo.mjs --force   # 写进指定目录（危险，仅演示用）
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { addDays, bjToday, rangeDates } from '../checkin.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REAL_DATA = path.resolve(HERE, '..', 'data');

const argv = process.argv.slice(2);
const getFlag = (name, fallback) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : fallback;
};
const force = argv.includes('--force');
const days = Number(getFlag('--days', 30));
const name = getFlag('--name', '小满');

const dir = process.env.CHECKIN_DATA_DIR
  ? path.resolve(process.env.CHECKIN_DATA_DIR)
  : path.join(os.tmpdir(), `checkin-demo-${Date.now()}`);

if (path.resolve(dir) === REAL_DATA && !force) {
  console.error('✗ 拒绝直接往真实数据目录写演示数据（确认要写请加 --force）');
  process.exit(1);
}

const TZ = 'Asia/Shanghai';
const bj = (d) => {
  const s = new Intl.DateTimeFormat('sv-SE', {
    timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  }).format(d);
  return `${s.replace(' ', 'T')}+08:00`;
};
const at = (date, hh, mm) => `${date}T${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}:00+08:00`;

// 假的"真人节奏"：前期贪多，中期卡在练字/冥想，周末容易断
const rotation = [
  ['背单词', '跑步 3 公里', '练字半小时', '写周报', '读书 20 页'],
  ['背单词', '跑步 3 公里', '练字半小时', '冥想 10 分钟'],
  ['背单词', '练字', '读书 20 页', '早睡'],
  ['背单词', '跑步 3 公里', '读书 20 页'],
  ['背单词', '练字半小时', '写周报', '跑步'],
];
const notesOn = {
  '练字半小时': ['写完手酸，明天早点写', '开会到九点，没劲了', ''],
  '练字': ['笔没水了', ''],
  '冥想 10 分钟': ['躺下就睡着了', ''],
  '早睡': ['刷手机又刷过头', ''],
  '读 20 页': [''],
  '读书 20 页': ['在地铁上看完了', ''],
  '跑步 3 公里': ['膝盖有点疼，改成散步', ''],
  '跑步': ['下雨', ''],
  '写周报': ['加班太晚', ''],
};

const today = bjToday();
const dates = rangeDates(addDays(today, -(days - 1)), today);
const skip = new Set(dates.filter((d, i) => i % 9 === 4)); // 约每 9 天断一次

const records = [];
let seq = 0;
for (const [idx, date] of dates.entries()) {
  if (skip.has(date)) continue;
  const set = rotation[idx % rotation.length];
  seq += 1;
  const goals = set.map((text, gi) => {
    const id = `g${gi + 1}`;
    const created = at(date, 7, 20 + gi);
    // 前期贪多：前 8 天额外加两条
    return { id, text, createdAt: created };
  });
  if (idx < 8) {
    goals.push({ id: `g${goals.length + 1}`, text: '写代码 1 小时', createdAt: at(date, 7, 40) });
    goals.push({ id: `g${goals.length + 1}`, text: '练字', createdAt: at(date, 7, 41) });
  }

  const isWeekend = [0, 6].includes(new Date(`${date}T00:00:00+08:00`).getDay());
  const finished = goals.map((g, gi) => {
    // 周末完成更差；练字/冥想几乎不完成
    const hard = /练字|冥想|早睡|写代码/.test(g.text);
    let status = 'pending';
    if (hard) status = isWeekend ? 'pending' : 'failed';
    else status = Math.random() < (isWeekend ? 0.5 : 0.85) ? 'done' : 'failed';
    if (status === 'pending' && gi === 0) status = 'done';
    const hh = isWeekend ? 22 : 21;
    const checkedAt = status === 'pending' ? null : at(date, hh, 10 + gi * 3);
    const notePool = notesOn[g.text] ?? [''];
    const note = status === 'done' ? '' : notePool[(idx + gi) % notePool.length];
    return { ...g, status, checkedAt, note, updatedAt: checkedAt ?? g.createdAt, deleted: false };
  });

  records.push({
    memberId: name,
    memberName: name,
    date,
    version: 2,
    submittedAt: at(date, 7, 18),
    updatedAt: finished.reduce((a, g) => (g.updatedAt > a ? g.updatedAt : a), at(date, 7, 18)),
    deviceId: 'dev-demo',
    goals: finished,
  });
}

fs.mkdirSync(path.join(dir, 'records', name), { recursive: true });
for (const rec of records) {
  fs.writeFileSync(path.join(dir, 'records', name, `${rec.date}.json`), `${JSON.stringify(rec, null, 2)}\n`, 'utf8');
}
const membersFile = path.join(dir, 'members.json');
const members = fs.existsSync(membersFile) ? JSON.parse(fs.readFileSync(membersFile, 'utf8')) : [];
if (!members.some((m) => m.id === name)) {
  members.push({ id: name, name, active: true, shareToFamily: false, feishuChatId: null, createdAt: bj(new Date()), source: 'demo' });
}
fs.writeFileSync(membersFile, `${JSON.stringify(members, null, 2)}\n`, 'utf8');

console.log(`✓ 演示数据已生成：${dir}`);
console.log(`  成员：${name}　记录：${records.length} 天（${dates[0]} ~ ${dates.at(-1)}）`);
console.log(`  用它可以跑：CHECKIN_DATA_DIR="${dir}" node tools/analyze.mjs "${name}" --days 7`);
console.log(`  别忘了这不是真数据，别把结论当真。`);
