/**
 * 复盘取数链路的回归测试（dsh 分析靠它吃饭）
 *
 * 流程：造演示数据 → 跑 analyze.mjs（JSON 模式 + 人话模式）→ 校验结构与关键信号。
 * 注意：这里用 stdio 指向文件描述符（沙箱不允许管道）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'checkin-analyze-'));
const env = { ...process.env, CHECKIN_DATA_DIR: dataDir };

function run(script, args, outFile) {
  const fd = fs.openSync(outFile, 'w');
  try {
    const res = spawnSync(process.execPath, [path.join(ROOT, script), ...args], {
      env,
      stdio: ['ignore', fd, 'ignore'],
      encoding: 'utf8',
      timeout: 120000,
    });
    return res;
  } finally {
    fs.closeSync(fd);
  }
}

test('复盘取数链路', async (t) => {
  t.after(() => {
    try {
      fs.rmSync(dataDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  await t.test('造演示数据', () => {
    const log = path.join(dataDir, 'seed.log');
    const res = run('tools/seed-demo.mjs', ['--days', '21', '--name', '测试娃'], log);
    assert.equal(res.status, 0, `seed 失败：${fs.readFileSync(log, 'utf8')}`);
    assert.ok(fs.existsSync(path.join(dataDir, 'records', '测试娃')), '记录目录应该建出来');
    const files = fs.readdirSync(path.join(dataDir, 'records', '测试娃'));
    assert.ok(files.length >= 15, `应该有足够多天的数据，实际 ${files.length}`);
  });

  await t.test('JSON 素材包结构完整', () => {
    const out = path.join(dataDir, 'pack.json');
    const res = run('tools/analyze.mjs', ['测试娃', '--days', '7', '--json'], out);
    assert.equal(res.status, 0, 'analyze --json 应该成功');
    const pack = JSON.parse(fs.readFileSync(out, 'utf8'));
    for (const key of ['member', 'range', 'stats', 'stuck', 'notes', 'details', 'generatedAt']) {
      assert.ok(key in pack, `素材包缺少 ${key}`);
    }
    assert.equal(pack.member.id, '测试娃');
    assert.equal(pack.range.days, 7);
    assert.equal(pack.details.length, 7);
    assert.ok(Array.isArray(pack.stuck));
    assert.ok(pack.details.every((d) => typeof d.submitted === 'boolean'));
  });

  await t.test('人话版素材包含三段引导与逐日明细', () => {
    const out = path.join(dataDir, 'pack.txt');
    const res = run('tools/analyze.mjs', ['测试娃', '--days', '7'], out);
    assert.equal(res.status, 0);
    const text = fs.readFileSync(out, 'utf8');
    assert.match(text, /复盘素材 · 测试娃/);
    assert.match(text, /一、提交与完成/);
    assert.match(text, /三、反复卡住的目标/);
    assert.match(text, /四、逐日明细/);
    assert.match(text, /六、写分析时的自我提醒/);
    assert.match(text, /只分析这一个人/, '必须带上"单人独立分析"的自我约束');
  });

  await t.test('中长期区间会给出前后半程对比', () => {
    const out = path.join(dataDir, 'pack30.json');
    const res = run('tools/analyze.mjs', ['测试娃', '--days', '21', '--json'], out);
    assert.equal(res.status, 0);
    const pack = JSON.parse(fs.readFileSync(out, 'utf8'));
    assert.ok(pack.contrast, '≥14 天应该给 contrast');
    assert.ok(pack.contrast.early.from < pack.contrast.late.from);
    assert.equal(
      pack.contrast.early.days + pack.contrast.late.days,
      21,
      '前后半程天数应等于区间长度',
    );
  });

  await t.test('不存在的成员会报错而不是瞎编', () => {
    const out = path.join(dataDir, 'missing.txt');
    const res = run('tools/analyze.mjs', ['查无此人', '--days', '7'], out);
    assert.notEqual(res.status, 0, '应该非零退出');
  });
});
