/**
 * 户部 · 一句话记账（兼容旧引用）
 *
 * 真正的实现已移到 shared/ledger.mjs，App 与中枢共用同一份解析与归类规则。
 * 这里保留转发，老代码（hub/hub.mjs、court/context.mjs、测试）不用改 import。
 */
export {
  CATEGORIES, categorize, parseLedgerText, parseLedgerLine, summarizeLedger,
} from '../shared/ledger.mjs';
