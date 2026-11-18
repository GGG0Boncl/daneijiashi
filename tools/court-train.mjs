#!/usr/bin/env node
/**
 * 六部 Agent 训练场（教练闭环）
 *
 * 做法：起一个中枢（默认假模型，不花钱）→ 按用例逐条让该部上奏 → 按 5 条标准打分
 *      → 打印失分点与分数曲线 → 存进 court/gym/history.json
 *
 * 用法：
 *   node tools/court-train.mjs --dept libu                  # 假模型，0 成本
 *   node tools/court-train.mjs --dept hubu --rounds 3
 *   node tools/court-train.mjs --dept libu --url http://127.0.0.1:8787 --rounds 2   # 用正在跑的中枢（真模型，会花钱）
 *
 * 注意：这不是训练模型权重，是训练"这一部的人设与例库"。
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CASES, scoreMemorial, summarizeRound } from '../court/gym.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const HUB = path.join(ROOT, 'hub', 'hub.mjs');

const argv = process.argv.slice(2);
const flag = (name, fallback = null) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : fallback;
};
const dept = flag('--dept');
const rounds = Math.max(1, Number(flag('--rounds', 1)));
const externalUrl = flag('--url');
if (!dept) {
  console.error('用法：node tools/court-train.mjs --dept libu [--rounds 2] [--url http://127.0.0.1:8787]');
  process.exit(1);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const port = 8807;
const udpPort = 8808;
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'court-train-'));
let child = null;
const base = externalUrl || `http://127.0.0.1:${port}`;

async function waitHub() {
  for (let i = 0; i < 40; i += 1) {
    try {
      const r = await fetch(`${base}/api/health`);
      if (r.ok) return true;
    } catch {
      /* 等 */
    }
    await sleep(250);
  }
  return false;
}

async function post(p, body) {
  const r = await fetch(`${base}${p}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  });
  return { status: r.status, body: await r.json().catch(() => ({})) };
}

async function seed() {
  // 给假模型一点数据，让素材不至于全空
  await post('/api/court/ledger', { text: '买菜 35', memberId: '训练官' });
  await post('/api/court/item', { dept: 'gongbu', kind: 'chore', text: '周六大扫除', memberId: '训练官' });
  await post('/api/court/role', { memberId: '训练官', role: 'emperor' });
}

async function main() {
  if (!externalUrl) {
    child = spawn(process.execPath, [HUB], {
      env: {
        ...process.env,
        CHECKIN_DATA_DIR: dataDir,
        HUB_PORT: String(port),
        HUB_UDP_PORT: String(udpPort),
        HUB_DEEPSEEK_FAKE: '1',
      },
      stdio: 'ignore',
    });
    if (!(await waitHub())) throw new Error('中枢没起来');
    await seed();
  }

  const cases = CASES.filter((c) => c.dept === dept);
  if (!cases.length) throw new Error(`没有 ${dept} 的训练用例`);

  const historyFile = path.join(ROOT, 'court', 'gym', 'history.json');
  const history = fs.existsSync(historyFile) ? JSON.parse(fs.readFileSync(historyFile, 'utf8')) : {};
  const roundsData = [];

  for (let round = 1; round <= rounds; round += 1) {
    const results = [];
    for (const [idx, c] of cases.entries()) {
      const r = await post('/api/court/summon', {
        dept,
        memberId: '训练官',
        focus: c.focus,
        force: true,
      });
      if (r.status !== 200) {
        console.log(`  ✗ 用例 ${idx + 1} 上奏失败：${r.body.error}`);
        continue;
      }
      const score = scoreMemorial(r.body.memorial.body, { mustInclude: c.mustInclude });
      results.push({ focus: c.focus, title: r.body.memorial.title, score });
      console.log(`  用例 ${idx + 1}「${c.focus}」→ ${score.total} 分${score.total >= 80 ? ' ✅' : ''}`);
      for (const ck of score.checks.filter((x) => !x.pass)) console.log(`      · 失分：${ck.name}（${ck.note}）`);
    }
    const summary = summarizeRound(results);
    roundsData.push({ round, summary, results });
    console.log(`第 ${round} 轮：平均 ${summary.average} 分，弱项：${summary.weakPoints.map((w) => `${w.name}×${w.times}`).join('、') || '无'}`);
  }

  history[dept] = [...(history[dept] ?? []), { at: new Date().toISOString(), rounds: roundsData.map((r) => r.summary) }].slice(-20);
  fs.mkdirSync(path.dirname(historyFile), { recursive: true });
  fs.writeFileSync(historyFile, `${JSON.stringify(history, null, 2)}\n`, 'utf8');
  console.log(`\n已记录到 ${path.relative(ROOT, historyFile)}`);
}

main()
  .catch((err) => {
    console.error(`✗ ${err.message}`);
    process.exitCode = 1;
  })
  .finally(() => {
    if (child) {
      try {
        child.kill();
      } catch {
        /* ignore */
      }
    }
    try {
      fs.rmSync(dataDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });
