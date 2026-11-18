/**
 * 本地存储：IndexedDB（数据量极小，每天几条，够用且不用 SQLite 插件）
 *  - records: 以日期为主键，存当天目标与打卡
 *  - meta:   身份（memberId/名字/设备ID/中枢地址/上次同步时间/已排提醒）
 */

const DB_NAME = 'family-checkin';
const DB_VERSION = 1;
const S_RECORDS = 'records';
const S_META = 'meta';

let dbPromise = null;

function open() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(S_RECORDS)) db.createObjectStore(S_RECORDS, { keyPath: 'date' });
      if (!db.objectStoreNames.contains(S_META)) db.createObjectStore(S_META, { keyPath: 'key' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('IndexedDB 打开失败'));
  });
  return dbPromise;
}

function run(store, mode, fn) {
  return open().then(
    (db) =>
      new Promise((resolve, reject) => {
        const tx = db.transaction(store, mode);
        const os = tx.objectStore(store);
        let result;
        try {
          result = fn(os);
        } catch (err) {
          reject(err);
          return;
        }
        tx.oncomplete = () => resolve(result && result.__req ? result.__req.result : result);
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error ?? new Error('事务被中止'));
      }),
  );
}

const wrap = (req) => ({ __req: req });

export const store = {
  async getMeta(key, fallback = null) {
    const row = await run(S_META, 'readonly', (os) => wrap(os.get(key)));
    return row ? row.value : fallback;
  },
  setMeta(key, value) {
    return run(S_META, 'readwrite', (os) => wrap(os.put({ key, value, at: new Date().toISOString() })));
  },
  async allMeta() {
    const rows = await run(S_META, 'readonly', (os) => wrap(os.getAll()));
    return Object.fromEntries((rows ?? []).map((r) => [r.key, r.value]));
  },
  async getRecord(date) {
    return (await run(S_RECORDS, 'readonly', (os) => wrap(os.get(date)))) ?? null;
  },
  putRecord(rec) {
    return run(S_RECORDS, 'readwrite', (os) => wrap(os.put(rec)));
  },
  putRecords(recs) {
    return run(S_RECORDS, 'readwrite', (os) => {
      for (const r of recs ?? []) os.put(r);
      return wrap(null);
    });
  },
  async allRecords() {
    const rows = await run(S_RECORDS, 'readonly', (os) => wrap(os.getAll()));
    return (rows ?? []).sort((a, b) => a.date.localeCompare(b.date));
  },
  deleteRecord(date) {
    return run(S_RECORDS, 'readwrite', (os) => wrap(os.delete(date)));
  },
  async clearAll() {
    await run(S_RECORDS, 'readwrite', (os) => wrap(os.clear()));
    await run(S_META, 'readwrite', (os) => wrap(os.clear()));
  },
};
