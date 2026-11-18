/**
 * 成员ID规则（唯一真源，checkin.mjs / hub / App 共用）
 *
 * 为什么不再限制成"中英文+数字"：家人会起「瑞瑞🥚」这样的名字，
 * emoji 在 NTFS 文件名里完全合法，拦掉它只会让人同步失败。
 *
 * 真正要拦的是"会把文件系统搞坏"的字符：
 *   / \ : * ? " < > |、控制字符、结尾的点或空格、Windows 保留名。
 */

export const MEMBER_ID_MAX = 32;

const FORBIDDEN = /[\\/:*?"<>|\u0000-\u001f\u007f]/;
const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;
const len = (s) => Array.from(String(s ?? '')).length;

/** 收口格式：去首尾空白，中间连续空白压成一个空格 */
export function normalizeMemberId(input) {
  return String(input ?? '').replace(/\s+/g, ' ').trim();
}

/** 返回 null 表示合法；否则返回一句能直接给用户看的原因 */
export function memberIdProblem(input) {
  const id = normalizeMemberId(input);
  if (!id) return '称呼不能为空';
  if (len(id) > MEMBER_ID_MAX) return `称呼最多 ${MEMBER_ID_MAX} 个字（emoji 算 1 个）`;
  if (FORBIDDEN.test(id)) return '称呼里不能有 / \\ : * ? " < > | 这些符号（emoji 可以放心用）';
  if (id === '.' || id === '..') return '称呼不能是「.」或「..」';
  if (/[. ]$/.test(id)) return '称呼结尾不能是点或空格';
  if (RESERVED.test(id)) return `「${id}」是 Windows 的保留名，换一个吧`;
  return null;
}

export const isValidMemberId = (input) => memberIdProblem(input) === null;
