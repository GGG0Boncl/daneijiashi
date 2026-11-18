/**
 * 六部 Agent 运行时
 *
 * summon：收集该部数据 → 生成奏疏（带缓存指纹，数据没变不重复花钱）
 * dispose：御书房批阅（圣旨/懿旨存档、驳回原因记进该部记忆）
 * meeting：家庭常朝，六部依次简短汇报（不走模型，省钱）
 */
import { createHash } from 'node:crypto';
import { deptById, systemPrompt, userPrompt, extractTitle } from './personas.mjs';
import { digestFor } from './context.mjs';
import {
  saveMemorial, listMemorials, readMemorial, disposeMemorial, addReply, ensureCourtDirs, canDispose,
} from './store.mjs';

const MAX_TEXT = 4000;

export const fingerprintOf = (parts) => createHash('sha1').update(JSON.stringify(parts)).digest('hex').slice(0, 16);

/**
 * 让某部上一次奏疏。
 * callModel(system, user) 由中枢注入（复用现有 DeepSeek 配置与假模型开关）。
 */
export async function summon(dataDir, {
  deptId, role = 'member', focus = '', force = false, now = new Date(), callModel, model = 'deepseek-chat',
}) {
  const dept = deptById(deptId);
  if (!dept) {
    const err = new Error(`没有这个部：${deptId}`);
    err.statusCode = 400;
    throw err;
  }
  ensureCourtDirs(dataDir);
  const digest = digestFor(deptId, { dataDir, now });
  const fingerprint = fingerprintOf([deptId, digest.basis, String(focus ?? '').trim()]);

  if (!force) {
    const cached = listMemorials(dataDir, { dept: deptId, limit: 50 }).find(
      (m) => m.fingerprint === fingerprint && m.status !== 'rejected',
    );
    if (cached) return { ...cached, cached: true };
  }

  const system = systemPrompt(dept);
  const user = userPrompt(dept, { digest: digest.text, memory: digest.memory, focus });
  const started = Date.now();
  const { content, usage } = await callModel(system, user);
  const body = String(content ?? '').slice(0, MAX_TEXT).trim();
  if (!body) {
    const err = new Error('模型没有返回奏疏内容');
    err.statusCode = 502;
    throw err;
  }

  const memorial = {
    id: null,
    dept: dept.id,
    deptName: dept.name,
    office: dept.office,
    title: extractTitle(body, dept, now.toISOString().slice(0, 10)),
    body,
    status: 'pending',
    fingerprint,
    focus: String(focus ?? '').trim(),
    digest: digest.text,
    facts: digest.facts,
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
    actor: role,
    model,
    ms: Date.now() - started,
    usage,
    dispositions: [],
    replies: [],
  };
  memorial.id = `${Date.now()}-${dept.id}`;
  saveMemorial(dataDir, memorial);
  return { ...memorial, cached: false };
}

/** 御书房批阅 */
export function dispose(dataDir, { id, action, comment = '', role, by, now = new Date() }) {
  ensureCourtDirs(dataDir);
  return disposeMemorial(dataDir, { id, action, comment, role, by, at: now.toISOString() });
}

/** 六部回奏 */
export function reply(dataDir, { id, text, by, now = new Date() }) {
  return addReply(dataDir, { id, text, by, at: now.toISOString() });
}

/**
 * 家庭常朝：六部依次汇报（用各部台账 + 最新奏疏状态拼简报，不调模型）。
 * 返回 { at, items: [{deptId, name, office, summary, latest}] , pendingTotal, brief }
 */
export function meeting(dataDir, { now = new Date() } = {}) {
  const order = ['libu', 'hubu', 'libu2', 'bingbu', 'xingbu', 'gongbu'];
  const items = order.map((id) => {
    const dept = deptById(id);
    const digest = digestFor(id, { dataDir, now });
    const latest = listMemorials(dataDir, { dept: id, limit: 1 })[0] ?? null;
    const firstLine = digest.text.split('\n').filter(Boolean).slice(0, 2).join('；');
    return {
      deptId: id,
      name: dept.name,
      office: dept.office,
      icon: dept.icon,
      summary: firstLine || '本日无新事可奏',
      latest: latest ? { id: latest.id, title: latest.title, status: latest.status, at: latest.createdAt } : null,
    };
  });
  const pending = listMemorials(dataDir, { status: 'pending', limit: 100 });
  const pendingTotal = pending.length;
  const brief = [
    `本日朝会（${now.toISOString().slice(0, 10)}）：`,
    ...items.map((i) => `${i.icon} ${i.name}：${i.summary}`),
    pendingTotal ? `御书房待批 ${pendingTotal} 份，请帝后过目。` : '御书房暂无需批阅的奏疏。',
  ].join('\n');
  return { at: now.toISOString(), items, pendingTotal, brief };
}

export { readMemorial, listMemorials, canDispose };
