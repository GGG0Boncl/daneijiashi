import test from 'node:test';
import assert from 'node:assert/strict';
import * as lunar from '../www/lunar.js';

test('农历：2026 春节落在正月初一', () => {
  const l = lunar.lunarDate('2026-02-17');
  assert.equal(l.year, 2026);
  assert.equal(l.month, 1);
  assert.equal(l.day, 1);
  assert.equal(l.monthName, '正月');
  assert.equal(l.dayName, '初一');
  assert.equal(lunar.festivalOf('2026-02-17'), '春节');
});

test('农历：除夕是腊月最后一天', () => {
  assert.equal(lunar.festivalOf('2026-02-16'), '除夕');
  assert.equal(lunar.lunarDate('2026-02-16').monthName, '腊月');
});

test('农历：闰月能正确标出', () => {
  const leap = lunar.lunarDate('2023-03-22');
  assert.equal(leap.isLeap, true);
  assert.equal(leap.month, 2);
  assert.equal(leap.monthName, '闰二月');
  assert.equal(lunar.lunarDate('2023-04-20').monthName, '三月');
});

test('节日：公历、农历、清明冬至都有', () => {
  assert.equal(lunar.festivalOf('2026-10-01'), '国庆节');
  assert.equal(lunar.festivalOf('2026-09-25'), '中秋节');
  assert.equal(lunar.festivalOf('2026-04-05'), '清明');
  assert.equal(lunar.festivalOf('2026-12-22'), '冬至');
});

test('格子小字：节日优先，初一写月名，其余写日名', () => {
  assert.equal(lunar.lunarLabel('2026-10-01'), '国庆节');
  assert.equal(lunar.lunarLabel('2026-02-17'), '春节');
  assert.equal(lunar.lunarLabel('2026-06-15'), '五月');
  assert.equal(lunar.lunarLabel('2026-06-16'), '初二');
});

test('超出 1900–2100 或格式不对返回 null', () => {
  assert.equal(lunar.lunarDate('1899-12-31'), null);
  assert.equal(lunar.lunarDate('2101-01-01'), null);
  assert.equal(lunar.lunarDate('2026/02/17'), null);
});

test('每个月的天数只能是 29 或 30', () => {
  for (let y = 1900; y <= 2100; y += 1) {
    for (let m = 1; m <= 12; m += 1) {
      const d = lunar.monthDays(y, m);
      assert.ok(d === 29 || d === 30, `${y}-${m} 天数异常：${d}`);
    }
  }
});
