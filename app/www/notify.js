/**
 * 本地通知（07:30 / 21:30）
 *
 * 走 @capacitor/local-notifications（底层是的 Android AlarmManager），
 * 不依赖任何服务器，电脑没开也照响。
 *
 * 排期规则在 core.js 的 planReminders() 里，这里只负责"把计划落到系统"。
 * 每次数据变化 / App 回到前台都会重排一次，所以：
 *   - 今天 07:30 之前且还没提交目标 → 今天有 07:30
 *   - 今天已经提交 → 今天不排 07:30
 *   - 未来 6 天都排 07:30
 *   - 今天 21:30 前且还有未打卡 → 排 21:30，否则取消
 */
import { planReminders } from './core.js';
import { nativePlugin } from './sync.js';
import { store } from './db.js';

const SCHEDULED_KEY = 'scheduledIds';

const plugin = () => nativePlugin('LocalNotifications');

export function notificationsAvailable() {
  return Boolean(plugin()?.schedule);
}

export async function ensurePermission() {
  const ln = plugin();
  if (!ln) return { granted: false, reason: '当前环境不是 App（浏览器预览不支持本地通知）' };
  try {
    const status = await ln.checkPermissions();
    if (status.display === 'granted') return { granted: true };
    const req = await ln.requestPermissions();
    return { granted: req.display === 'granted', reason: req.display };
  } catch (err) {
    return { granted: false, reason: String(err?.message ?? err) };
  }
}

/** 把计划同步到系统，返回本次实际排上的条数 */
export async function applyPlan(records, now = new Date()) {
  const ln = plugin();
  if (!ln?.schedule) return { applied: 0, reason: 'no-plugin' };

  const plan = planReminders(records, now);
  const ids = plan.map((p) => p.id);
  const prev = (await store.getMeta(SCHEDULED_KEY, [])) ?? [];
  const toCancel = prev.filter((id) => !ids.includes(id));

  try {
    if (toCancel.length) {
      await ln.cancel({ notifications: toCancel.map((id) => ({ id })) });
    }
    if (plan.length) {
      await ln.schedule({
        notifications: plan.map((p) => ({
          id: p.id,
          title: p.title,
          body: p.body,
          largeBody: p.body,
          summaryText: p.kind === '0730' ? '设个今天的小目标吧' : '别忘了打卡',
          schedule: { at: new Date(p.at), allowWhileIdle: true },
          channelId: 'checkin',
          autoCancel: true,
        })),
      });
    }
    await store.setMeta(SCHEDULED_KEY, ids);
    return { applied: plan.length, cancelled: toCancel.length };
  } catch (err) {
    console.warn('排提醒失败', err);
    return { applied: 0, reason: String(err?.message ?? err) };
  }
}

/** 首次启动建一个通知渠道（Android 8+ 需要），失败不影响主流程 */
export async function ensureChannel() {
  const ln = plugin();
  if (!ln?.createChannel) return;
  try {
    await ln.createChannel({
      id: 'checkin',
      name: '打卡提醒',
      description: '每天 07:30 设目标提醒、21:30 打卡提醒',
      importance: 4,
      visibility: 1,
      vibration: true,
    });
  } catch (err) {
    console.warn('创建通知渠道失败', err);
  }
}

/** 调试用：马上发一条通知，验证权限与渠道是否正常 */
export async function sendTestNotification() {
  const ln = plugin();
  if (!ln?.schedule) return false;
  await ln.schedule({
    notifications: [
      {
        id: 9000,
        title: '测试通知',
        body: '能看到这条，说明提醒通道是通的 🐱',
        schedule: { at: new Date(Date.now() + 3000) },
        channelId: 'checkin',
      },
    ],
  });
  return true;
}
