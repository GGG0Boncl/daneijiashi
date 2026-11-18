/**
 * 导出格式一致性：手机端（core.exportRecordsAsText）和中枢（hub/pack.recordsAsText）
 * 必须是同一个格式，否则"复制出来的"和"下载的 TXT"长得不一样。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { exportRecordsAsText } from '../app/www/core.js';
import { recordsAsText } from '../hub/pack.mjs';

const rec = (date, goals) => ({ memberId: '妈妈', memberName: '妈妈', date, version: 1, goals });

const fixture = [
  rec('2026-11-18', [
    { id: 'g1', text: '背单词', status: 'done', updatedAt: '2026-11-18T21:00:00+08:00', deleted: false },
    { id: 'g2', text: '跑步 3 公里', status: 'failed', updatedAt: '2026-11-18T21:10:00+08:00', deleted: false },
  ]),
  rec('2026-11-17', []), // 空日 -> 不占行
  rec('2026-11-16', [
    { id: 'g1', text: '读书 20 页', status: 'pending', updatedAt: '2026-11-16T07:00:00+08:00', deleted: false },
    { id: 'g2', text: '已删除的目标', status: 'pending', updatedAt: '2026-11-16T07:00:00+08:00', deleted: true },
    { id: 'g3', text: '带；分号', status: 'pending', updatedAt: '2026-11-16T07:00:00+08:00', deleted: false },
  ]),
];

test('手机端与中枢导出完全一致，且格式符合用户要求', () => {
  const fromApp = exportRecordsAsText(fixture);
  const fromHub = recordsAsText(fixture);
  assert.equal(fromApp, fromHub, '两边格式必须一致，改一处要同步另一处');
  assert.equal(fromApp, [
    '2026年11月16日：读书 20 页；带，分号。',
    '2026年11月18日：背单词；跑步 3 公里。',
  ].join('\n'));
});

test('只有删除目标/空记录时导出为空', () => {
  const onlyDeleted = [rec('2026-11-18', [{ id: 'g1', text: 'x', status: 'pending', deleted: true }])];
  assert.equal(exportRecordsAsText(onlyDeleted), '');
  assert.equal(recordsAsText(onlyDeleted), '');
  assert.equal(exportRecordsAsText([]), '');
  assert.equal(recordsAsText([]), '');
});
