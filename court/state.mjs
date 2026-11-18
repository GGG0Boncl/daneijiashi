/**
 * 国事状态同步（中枢侧）
 *
 * 手机 offline 也照记；连上后把整份国事（国家大事 / 六部差事 / 户部流水）推上来，
 * 这里按 updatedAt 合并、按身份把关，再把合并后的结果原样还给手机。
 *
 * 磁盘仍是原来的位置：annual.json、tasks/<部>.json、ledger/entries.jsonl，
 * 看板与老接口都不用改。墓碑（谁删了哪条）单独放 tombstones.json。
 */
import fs from 'node:fs';
import path from 'node:path';
import { listAnnual, saveAnnualItems, ANNUAL_ADJUST_LIMIT } from './annual.mjs';
import { listTasks, saveTaskItems } from './tasks.mjs';
import { appendLedger, listLedger } from './store.mjs';
import {
  DEPT_IDS, emptyCourtState, normalizeCourtState, mergeAnnualSections, mergeTaskSections,
  mergeLedgerSections, asTime,
} from '../shared/court-state.mjs';

const tombstonesFile = (dataDir) => path.join(dataDir, 'court', 'tombstones.json');

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
  } catch {
    return fallback;
  }
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  fs.renameSync(tmp, file);
}

function readTombstones(dataDir) {
  const raw = readJson(tombstonesFile(dataDir), {});
  return {
    annual: raw?.annual && typeof raw.annual === 'object' ? raw.annual : {},
    tasks: raw?.tasks && typeof raw.tasks === 'object' ? raw.tasks : {},
  };
}

/** 磁盘 → 一份完整国事状态（不含 serverTime） */
export function readCourtState(dataDir) {
  const tombstones = readTombstones(dataDir);
  const tasks = {};
  for (const dept of DEPT_IDS) {
    tasks[dept] = { items: listTasks(dataDir, dept), deleted: tombstones.tasks[dept] ?? {} };
  }
  return normalizeCourtState({
    annual: { items: listAnnual(dataDir), deleted: tombstones.annual },
    tasks,
    ledger: { entries: listLedger(dataDir) },
  });
}

function sectionKey(section) {
  const items = (section?.items ?? []).map((i) => `${i.id}@${i.updatedAt}`).sort();
  const deleted = Object.entries(section?.deleted ?? {}).map(([id, at]) => `${id}@${at}`).sort();
  return JSON.stringify({ items, deleted });
}

/**
 * 合并手机推来的状态。
 * canEdit=false（家人身份）时不接受对国家大事 / 六部差事的改动，但仍收流水。
 */
export function mergeForHub(serverRaw, incomingRaw, { canEdit = false } = {}) {
  const server = normalizeCourtState(serverRaw);
  const incoming = normalizeCourtState(incomingRaw);
  const rejected = { annual: false, annualIds: [], tasks: false };

  let annual;
  if (canEdit) {
    const yearNow = new Date().getFullYear();
    const filtered = {
      deleted: incoming.annual.deleted,
      items: incoming.annual.items.map((item) => {
        const old = server.annual.items.find((s) => s.id === item.id);
        if (!old) return item;
        const structural = old.text !== item.text || old.period !== item.period || (old.budget ?? null) !== (item.budget ?? null);
        const used = old.adjustmentsYear === yearNow ? (old.adjustments ?? 0) : 0;
        if (structural && used >= ANNUAL_ADJUST_LIMIT) {
          rejected.annualIds.push(item.id);
          return old;
        }
        return item;
      }),
    };
    annual = mergeAnnualSections(filtered, server.annual);
  } else {
    annual = server.annual;
    rejected.annual = sectionKey(incoming.annual) !== sectionKey(server.annual);
  }

  const tasks = {};
  let tasksRejected = false;
  for (const dept of DEPT_IDS) {
    const inc = incoming.tasks[dept] ?? { items: [], deleted: {} };
    const srv = server.tasks[dept] ?? { items: [], deleted: {} };
    if (canEdit) {
      tasks[dept] = mergeTaskSections(dept, inc, srv);
    } else {
      tasks[dept] = srv;
      if (sectionKey(inc) !== sectionKey(srv)) tasksRejected = true;
    }
  }
  rejected.tasks = tasksRejected;

  const ledger = mergeLedgerSections(incoming.ledger, server.ledger);
  return { state: { annual, tasks, ledger }, rejected };
}

/** 合并结果落盘；流水只追加不复写 */
export function writeCourtState(dataDir, state) {
  const clean = normalizeCourtState(state);
  saveAnnualItems(dataDir, clean.annual.items);
  for (const dept of DEPT_IDS) saveTaskItems(dataDir, dept, clean.tasks[dept]?.items ?? []);

  const existing = listLedger(dataDir);
  const have = new Set(existing.map((e) => e.id));
  const extra = clean.ledger.entries
    .filter((e) => !have.has(e.id))
    .sort((a, b) => asTime(a.at) - asTime(b.at));
  for (const entry of extra) appendLedger(dataDir, entry);

  const tasksTomb = {};
  for (const dept of DEPT_IDS) tasksTomb[dept] = clean.tasks[dept]?.deleted ?? {};
  writeJson(tombstonesFile(dataDir), { annual: clean.annual.deleted, tasks: tasksTomb });
  return clean;
}

export { emptyCourtState, DEPT_IDS };
