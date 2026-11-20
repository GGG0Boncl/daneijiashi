#!/usr/bin/env node
/**
 * 把共享逻辑拷进 App 的 www/（WebView 只认真实的 .js 文件，不能跨目录 import）。
 * 源文件唯一，避免两端行为不一致：
 *   - hub/merge.mjs        → 打卡记录的合并规则
 *   - shared/id.mjs        → 成员 ID 规则
 *   - shared/court-state.mjs → 国事合并规则（国家大事 / 差事 / 流水）
 *   - shared/ledger.mjs    → 一句话记账的解析规则
 *   - court/personas.mjs   → 七部名号与职能（离线也要说清每部管什么）
 *
 * 用法：node tools/sync-assets.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');

const jobs = [
  { from: path.join(ROOT, 'hub', 'merge.mjs'), to: path.join(ROOT, 'app', 'www', 'merge.js'), banner: '// 由 tools/sync-assets.mjs 从 hub/merge.mjs 复制，别直接改这里\n' },
  { from: path.join(ROOT, 'shared', 'id.mjs'), to: path.join(ROOT, 'app', 'www', 'member-id.js'), banner: '// 由 tools/sync-assets.mjs 从 shared/id.mjs 复制，别直接改这里\n' },
  { from: path.join(ROOT, 'shared', 'court-state.mjs'), to: path.join(ROOT, 'app', 'www', 'court-state.js'), banner: '// 由 tools/sync-assets.mjs 从 shared/court-state.mjs 复制，别直接改这里\n' },
  { from: path.join(ROOT, 'shared', 'dispatch-rules.mjs'), to: path.join(ROOT, 'app', 'www', 'dispatch-rules.js'), banner: '// 由 tools/sync-assets.mjs 从 shared/dispatch-rules.mjs 复制，别直接改这里\n', transform: (body) => body.replaceAll("from './ledger.mjs'", "from './ledger.js'") },
  { from: path.join(ROOT, 'shared', 'ledger.mjs'), to: path.join(ROOT, 'app', 'www', 'ledger.js'), banner: '// 由 tools/sync-assets.mjs 从 shared/ledger.mjs 复制，别直接改这里\n' },
];

for (const job of jobs) {
  const raw = fs.readFileSync(job.from, 'utf8');
  const body = job.transform ? job.transform(raw) : raw;
  fs.mkdirSync(path.dirname(job.to), { recursive: true });
  fs.writeFileSync(job.to, `${job.banner}${body}`, 'utf8');
  console.log(`✓ ${path.relative(ROOT, job.from)} → ${path.relative(ROOT, job.to)}`);
}

/* 七部名号：只取展示要用的字段，省得把 prompt 也打进 App */
const { COURT_DEPTS } = await import(pathToFileURL(path.join(ROOT, 'court', 'personas.mjs')).href);
const depts = COURT_DEPTS.map((d) => ({
  id: d.id,
  name: d.name,
  office: d.office,
  icon: d.icon,
  brief: d.brief ?? '',
  duty: d.duty,
  focusHint: d.focusHint,
}));
const deptsFile = path.join(ROOT, 'app', 'www', 'depts.js');
fs.writeFileSync(
  deptsFile,
  `// 由 tools/sync-assets.mjs 从 court/personas.mjs 生成，别直接改这里\nexport const COURT_DEPTS = ${JSON.stringify(depts, null, 2)};\n`,
  'utf8',
);
console.log(`✓ court/personas.mjs → ${path.relative(ROOT, deptsFile)}`);
