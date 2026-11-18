/**
 * 成员ID规则单测 + 复制文件一致性
 *
 * 背景：家人真的会起「瑞瑞🥚」这样的名字，旧规则只放中英文数字，
 * 结果 hub 报"非法成员ID"、同步直接失败。这里守住新的规则：
 *   · emoji / 中文 / 空格 / 连字符 都行
 *   · 只拦会弄坏文件系统的字符、Windows 保留名、结尾点空格、超长
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  memberIdProblem, normalizeMemberId, isValidMemberId, MEMBER_ID_MAX,
} from '../shared/id.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');

test('emoji 与常见中文称呼都合法（就是这次 bug 的场景）', () => {
  for (const id of ['瑞瑞🥚', '妈妈', '大龙龙', '小 A', 'AI-01', '囡囡 🐱', 'Ñoño']) {
    assert.equal(memberIdProblem(id), null, `${id} 应该合法`);
    assert.ok(isValidMemberId(id));
  }
});

test('真会弄坏文件系统的字符必须拦住', () => {
  for (const id of ['a/b', 'a\\b', 'a:b', 'a*b', 'a?b', 'a"b', 'a<b', 'a>b', 'a|b', 'a\u0000b', 'a\u001fb']) {
    assert.ok(memberIdProblem(id), `${JSON.stringify(id)} 不该合法`);
  }
});

test('Windows 保留名、结尾点、空值都要拦（结尾空格会被裁掉）', () => {
  for (const id of ['con', 'CON', 'prn', 'aux', 'nul', 'com1', 'lpt9', 'con.txt']) {
    assert.match(memberIdProblem(id) ?? '', /保留名/);
  }
  assert.match(memberIdProblem('名字.') ?? '', /结尾/);
  assert.match(memberIdProblem('名字..') ?? '', /结尾/);
  // 首尾空白是"收口"的一部分：裁掉后就是「名字」，应当合法
  assert.equal(memberIdProblem('名字 '), null);
  assert.match(memberIdProblem('') ?? '', /不能为空/);
  assert.equal(memberIdProblem('  '), '称呼不能为空');
  assert.match(memberIdProblem('.') ?? '', /不能是/);
  assert.match(memberIdProblem('..') ?? '', /不能是/);
});

test('长度按码点算：emoji 算 1 个，超长要提示', () => {
  const ok = '瑞'.repeat(MEMBER_ID_MAX - 1) + '🥚';
  assert.equal(Array.from(ok).length, MEMBER_ID_MAX);
  assert.equal(memberIdProblem(ok), null);

  const tooLong = '瑞'.repeat(MEMBER_ID_MAX + 1);
  assert.match(memberIdProblem(tooLong) ?? '', /最多/);

  // emoji 是代理对，用 .length 会算成 2 —— 我们按码点算，所以 32 个 emoji 应该刚好合法
  assert.equal(memberIdProblem('🥚'.repeat(MEMBER_ID_MAX)), null);
});

test('归一化：去首尾空白、压掉中间连续空白', () => {
  assert.equal(normalizeMemberId('  妈妈  '), '妈妈');
  assert.equal(normalizeMemberId('小   满'), '小 满');
  assert.equal(normalizeMemberId('瑞瑞🥚\n'), '瑞瑞🥚');
  assert.equal(normalizeMemberId(null), '');
  assert.equal(normalizeMemberId(undefined), '');
});

test('App 里的副本必须和 shared/id.mjs 一致（防止改了一边忘另一边）', () => {
  const src = fs.readFileSync(path.join(ROOT, 'shared', 'id.mjs'), 'utf8');
  const copy = fs.readFileSync(path.join(ROOT, 'app', 'www', 'member-id.js'), 'utf8');
  assert.ok(copy.startsWith('// 由 tools/sync-assets.mjs'), '副本应该带"别直接改"的提示');
  assert.equal(copy.slice(copy.indexOf('export')), src.slice(src.indexOf('export')), '副本内容必须与源一致，跑 node tools/sync-assets.mjs 重新生成');

  const mergeSrc = fs.readFileSync(path.join(ROOT, 'hub', 'merge.mjs'), 'utf8');
  const mergeCopy = fs.readFileSync(path.join(ROOT, 'app', 'www', 'merge.js'), 'utf8');
  assert.equal(mergeCopy.slice(mergeCopy.indexOf('export')), mergeSrc.slice(mergeSrc.indexOf('export')), 'merge 副本也要同步');
});
