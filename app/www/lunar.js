// 农历与节日：1900–2100，纯函数，不依赖网络。
// 数据表是常见的 lunarInfo（每年一个 16 位整数，低 4 位为闰月月份）。
// 只用来在行事历上写“农历十月初十”“中秋”这种小字，不做算命。

const LUNAR_INFO = [
  0x04bd8, 0x04ae0, 0x0a570, 0x054d5, 0x0d260, 0x0d950, 0x16554, 0x056a0, 0x09ad0, 0x055d2, // 1900-1909
  0x04ae0, 0x0a5b6, 0x0a4d0, 0x0d250, 0x1d255, 0x0b540, 0x0d6a0, 0x0ada2, 0x095b0, 0x14977, // 1910-1919
  0x04970, 0x0a4b0, 0x0b4b5, 0x06a50, 0x06d40, 0x1ab54, 0x02b60, 0x09570, 0x052f2, 0x04970, // 1920-1929
  0x06566, 0x0d4a0, 0x0ea50, 0x06e95, 0x05ad0, 0x02b60, 0x186e3, 0x092e0, 0x1c8d7, 0x0c950, // 1930-1939
  0x0d4a0, 0x1d8a6, 0x0b550, 0x056a0, 0x1a5b4, 0x025d0, 0x092d0, 0x0d2b2, 0x0a950, 0x0b557, // 1940-1949
  0x06ca0, 0x0b550, 0x15355, 0x04da0, 0x0a5b0, 0x14573, 0x052b0, 0x0a9a8, 0x0e950, 0x06aa0, // 1950-1959
  0x0aea6, 0x0ab50, 0x04b60, 0x0aae4, 0x0a570, 0x05260, 0x0f263, 0x0d950, 0x05b57, 0x056a0, // 1960-1969
  0x096d0, 0x04dd5, 0x04ad0, 0x0a4d0, 0x0d4d4, 0x0d250, 0x0d558, 0x0b540, 0x0b6a0, 0x195a6, // 1970-1979
  0x095b0, 0x049b0, 0x0a974, 0x0a4b0, 0x0b27a, 0x06a50, 0x06d40, 0x0af46, 0x0ab60, 0x09570, // 1980-1989
  0x04af5, 0x04970, 0x064b0, 0x074a3, 0x0ea50, 0x06b58, 0x055c0, 0x0ab60, 0x096d5, 0x092e0, // 1990-1999
  0x0c960, 0x0d954, 0x0d4a0, 0x0da50, 0x07552, 0x056a0, 0x0abb7, 0x025d0, 0x092d0, 0x0cab5, // 2000-2009
  0x0a950, 0x0b4a0, 0x0baa4, 0x0ad50, 0x055d9, 0x04ba0, 0x0a5b0, 0x15176, 0x052b0, 0x0a930, // 2010-2019
  0x07954, 0x06aa0, 0x0ad50, 0x05b52, 0x04b60, 0x0a6e6, 0x0a4e0, 0x0d260, 0x0ea65, 0x0d530, // 2020-2029
  0x05aa0, 0x076a3, 0x096d0, 0x04afb, 0x04ad0, 0x0a4d0, 0x1d0b6, 0x0d250, 0x0d520, 0x0dd45, // 2030-2039
  0x0b5a0, 0x056d0, 0x055b2, 0x049b0, 0x0a577, 0x0a4b0, 0x0aa50, 0x1b255, 0x06d20, 0x0ada0, // 2040-2049
  0x14b63, 0x09370, 0x049f8, 0x04970, 0x064b0, 0x168a6, 0x0ea50, 0x06b20, 0x1a6c4, 0x0aae0, // 2050-2059
  0x092e0, 0x0d2e3, 0x0c960, 0x0d557, 0x0d4a0, 0x0da50, 0x05d55, 0x056a0, 0x0a6d0, 0x055d4, // 2060-2069
  0x052d0, 0x0a9b8, 0x0a950, 0x0b4a0, 0x0b6a6, 0x0ad50, 0x055a0, 0x0aba4, 0x0a5b0, 0x052b0, // 2070-2079
  0x0b273, 0x06930, 0x07337, 0x06aa0, 0x0ad50, 0x14b55, 0x04b60, 0x0a570, 0x054e4, 0x0d160, // 2080-2089
  0x0e968, 0x0d520, 0x0daa0, 0x16aa6, 0x056d0, 0x04ae0, 0x0a9d4, 0x0a2d0, 0x0d150, 0x0f252, // 2090-2099
  0x0d520, // 2100
];

const BASE = Date.UTC(1900, 0, 31); // 1900 年正月初一
const DAY_MS = 86400000;
const MONTH_NAMES = ['正月', '二月', '三月', '四月', '五月', '六月', '七月', '八月', '九月', '十月', '冬月', '腊月'];
const DIGITS = ['', '一', '二', '三', '四', '五', '六', '七', '八', '九', '十'];

/** 农历某年的第 m 个月有几天（m 从 1 开始，闰月另算） */
function monthDays(year, month) {
  const info = LUNAR_INFO[year - 1900];
  if (!info) return 29;
  return info & (0x10000 >> month) ? 30 : 29;
}

/** 农历某年的闰月月份，0 表示没有闰月 */
function leapMonth(year) {
  const info = LUNAR_INFO[year - 1900];
  return info ? info & 0xf : 0;
}

/** 农历某年闰月的天数 */
function leapDays(year) {
  const info = LUNAR_INFO[year - 1900];
  if (!info || !leapMonth(year)) return 0;
  return info & 0x10000 ? 30 : 29;
}

function monthList(year) {
  const leap = leapMonth(year);
  const out = [];
  for (let m = 1; m <= 12; m += 1) {
    out.push({ month: m, leap: false, days: monthDays(year, m) });
    if (leap === m) out.push({ month: m, leap: true, days: leapDays(year) });
  }
  return out;
}

function yearDays(year) {
  return monthList(year).reduce((sum, m) => sum + m.days, 0);
}

function dayName(day) {
  if (day === 10) return '初十';
  if (day === 20) return '二十';
  if (day === 30) return '三十';
  if (day < 10) return `初${DIGITS[day]}`;
  if (day < 20) return `十${DIGITS[day - 10]}`;
  return `廿${DIGITS[day - 20]}`;
}

/** 'YYYY-MM-DD' → {year,month,day,isLeap,monthName,dayName,label,fullLabel} */
export function lunarDate(dateStr) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(dateStr));
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  if (y < 1900 || y > 2100) return null;
  let offset = Math.floor((Date.UTC(y, mo - 1, d) - BASE) / DAY_MS);
  if (offset < 0) return null;
  let year = 1900;
  while (year <= 2100) {
    const days = yearDays(year);
    if (offset < days) break;
    offset -= days;
    year += 1;
  }
  if (year > 2100) return null;
  let hit = null;
  for (const item of monthList(year)) {
    if (offset < item.days) {
      hit = item;
      break;
    }
    offset -= item.days;
  }
  if (!hit) return null;
  const day = offset + 1;
  const monthName = `${hit.leap ? '闰' : ''}${MONTH_NAMES[hit.month - 1]}`;
  const dayLabel = dayName(day);
  return {
    year,
    month: hit.month,
    day,
    isLeap: hit.leap,
    monthName,
    dayName: dayLabel,
    label: day === 1 ? monthName : dayLabel,
    fullLabel: `农历${monthName}${dayLabel}`,
  };
}

const SOLAR_FESTIVALS = {
  '01-01': '元旦',
  '03-08': '妇女节',
  '03-12': '植树节',
  '05-01': '劳动节',
  '05-04': '青年节',
  '06-01': '儿童节',
  '07-01': '建党节',
  '08-01': '建军节',
  '09-10': '教师节',
  '10-01': '国庆节',
};

const LUNAR_FESTIVALS = {
  '1-1': '春节',
  '1-15': '元宵节',
  '2-2': '龙抬头',
  '5-5': '端午节',
  '7-7': '七夕',
  '7-15': '中元节',
  '8-15': '中秋节',
  '9-9': '重阳节',
  '12-8': '腊八节',
  '12-23': '小年',
};

// 24 节气（秒数偏移），只用到清明、冬至
const TERM_INFO = [
  0, 21208, 42467, 63836, 85337, 107014, 128867, 150921, 173149, 195551, 218072, 240693,
  263343, 285989, 308563, 331033, 353350, 375494, 397447, 419210, 440795, 462224, 483532, 504758,
];

/** 某年第 n 个节气（0=小寒）落在几号 */
function solarTermDay(year, n) {
  const ms = 31556925974.7 * (year - 1900) + TERM_INFO[n] * 60000 + Date.UTC(1900, 0, 6, 2, 5);
  return new Date(ms).getUTCDate();
}

function solarTermName(dateStr) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(dateStr));
  if (!m) return '';
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  if (mo === 4 && d === solarTermDay(y, 6)) return '清明';
  if (mo === 12 && d === solarTermDay(y, 23)) return '冬至';
  return '';
}

/** 当天节日：优先公历节日，再农历节日，再清明/冬至；没有就空串 */
export function festivalOf(dateStr) {
  const solar = SOLAR_FESTIVALS[String(dateStr).slice(5)];
  if (solar) return solar;
  const l = lunarDate(dateStr);
  if (!l) return solarTermName(dateStr);
  if (!l.isLeap) {
    const f = LUNAR_FESTIVALS[`${l.month}-${l.day}`];
    if (f) return f;
    // 除夕：腊月最后一天（大小月都算）
    if (l.month === 12 && l.day === monthDays(l.year, 12)) return '除夕';
  }
  return solarTermName(dateStr);
}

/** 行事历格子上的小字：节日 > 初一显示月名 > 其余显示日名 */
export function lunarLabel(dateStr) {
  const festival = festivalOf(dateStr);
  if (festival) return festival;
  const l = lunarDate(dateStr);
  return l ? l.label : '';
}

/** 头部用：农历十月初十 · 节日 */
export function fullLabel(dateStr) {
  const l = lunarDate(dateStr);
  if (!l) return '';
  const festival = festivalOf(dateStr);
  return festival && festival !== l.label ? `${l.fullLabel} · ${festival}` : l.fullLabel;
}

export { LUNAR_INFO, monthDays, leapMonth, yearDays };
