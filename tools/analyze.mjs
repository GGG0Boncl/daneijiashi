#!/usr/bin/env node
/**
 * 复盘素材包（命令行版）
 *
 * 用法：
 *   node tools/analyze.mjs <成员ID> [--days 7|14|30|90]
 *   node tools/analyze.mjs <成员ID> --from 2026-11-01 --to 2026-11-18
 *   node tools/analyze.mjs <成员ID> --days 30 --json
 *
 * 真正的取数与排版在 hub/pack.mjs（中枢的"AI 复盘"也用它，保证两边口径一致）。
 */
import { buildPack, renderPackText, ALLOWED_DAYS } from '../hub/pack.mjs';

const die = (msg) => {
  console.error(`✗ ${msg}`);
  process.exit(1);
};

const args = { memberId: null, days: 7, from: null, to: null, json: false };
const positional = [];
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i += 1) {
  const a = argv[i];
  if (a === '--json') args.json = true;
  else if (a === '--days') args.days = Number(argv[++i]);
  else if (a === '--from') args.from = argv[++i];
  else if (a === '--to') args.to = argv[++i];
  else if (a === '--help' || a === '-h') {
    console.log(`用法：node tools/analyze.mjs <成员ID> [--days ${ALLOWED_DAYS.join('|')}] [--json]\n      node tools/analyze.mjs <成员ID> --from 2026-11-01 --to 2026-11-18`);
    process.exit(0);
  } else if (a.startsWith('--')) die(`未知参数 ${a}`);
  else positional.push(a);
}
args.memberId = positional[0];
if (!args.memberId) die('用法：node tools/analyze.mjs <成员ID> [--days 7|30|90] [--json]');

let pack;
try {
  pack = buildPack(args.memberId, { days: args.days, from: args.from, to: args.to });
} catch (err) {
  die(String(err.message ?? err));
}

if (args.json) {
  console.log(JSON.stringify(pack, null, 2));
  process.exit(0);
}
console.log(renderPackText(pack));
