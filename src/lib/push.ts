// Клиент Web Push: запрос разрешения, подписка, постановка/снятие напоминаний
// на Worker. Реальные пуши приходят только в установленном PWA на iOS 16.4+.

import type { Task } from '../db/types';
// Алиас: в этом файле t — общепринятое имя задачи в параметрах.
import { t as tr } from './i18n';

import { clearReminderRetry, pendingReminderRetries, queueReminderRetry } from './reminderQueue';

const WORKER_URL = 'https://life-hub-push.xabos161rus.workers.dev';
// Публичный VAPID-ключ (пара к секрету воркера). Безопасно держать в коде.
const VAPID_PUBLIC =
  'BCi0yalmrjjC4elVs1vwAzGASoESrlpDA5ImcuB-u6kOVQf00Zc-GIK79WIBe7sQp5Y3_IBD96l8JEpccCj9Ws8';
const SUB_KEY = 'life-hub-push-sub';

type ReminderTask = Pick<Task, 'id' | 'title' | 'dueDate' | 'dueTime' | 'remindBefore'>;

function urlBase64ToUint8Array(base64String: string): Uint8Array {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(base64);
  const arr = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) arr[i] = raw.charCodeAt(i);
  return arr;
}

export function pushSupported(): boolean {
  return (
    'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window
  );
}

/** true — стоит в режиме приложения (иначе на iOS пуши не работают). */
export function isStandalone(): boolean {
  return (
    window.matchMedia('(display-mode: standalone)').matches ||
    (navigator as unknown as { standalone?: boolean }).standalone === true
  );
}

/** iOS/iPadOS — только там web push требует установки на «Домой». На десктопе
 *  (Mac/Windows) и Android пуши работают и в обычной вкладке. iPadOS 13+
 *  маскируется под Mac — отличаем его по числу тач-точек. */
export function isIOS(): boolean {
  const ua = navigator.userAgent;
  return (
    /iPad|iPhone|iPod/.test(ua) ||
    (navigator.maxTouchPoints > 1 && /Macintosh/.test(ua))
  );
}

export function pushEnabled(): boolean {
  return (
    pushSupported() && Notification.permission === 'granted' && !!localStorage.getItem(SUB_KEY)
  );
}

function storedSub(): unknown | null {
  const raw = localStorage.getItem(SUB_KEY);
  return raw ? (JSON.parse(raw) as unknown) : null;
}

/** Текущая push-подписка (для регистрации в семейном DO). */
export function getPushSubscription(): unknown | null {
  return storedSub();
}

/** Запрос разрешения + подписка. Возвращает причину отказа для UI. */
export async function enablePush(): Promise<{ ok: boolean; reason?: string }> {
  if (!pushSupported()) return { ok: false, reason: 'unsupported' };
  const perm = await Notification.requestPermission();
  if (perm !== 'granted') return { ok: false, reason: 'denied' };
  try {
    const reg = await navigator.serviceWorker.ready;
    let sub = await reg.pushManager.getSubscription();
    if (!sub) {
      sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(VAPID_PUBLIC) as BufferSource,
      });
    }
    localStorage.setItem(SUB_KEY, JSON.stringify(sub));
    void registerGlobalPush(sub); // в глобальный список — для рассылки об обновлении
    return { ok: true };
  } catch (e) {
    return { ok: false, reason: String(e) };
  }
}

/** Само-восстановление подписки. Если уведомления уже разрешены и push-подписка
 *  существует — тихо до-регистрируем её в глобальном списке (для пуша «вышло
 *  обновление») и обновляем localStorage. Вызывается при старте приложения,
 *  чтобы НЕ зависеть от ручного «перевключить уведомления» после деплоя: тот,
 *  кто хоть раз включил уведомления, остаётся в списке рассылки сам собой. */
export async function ensurePushRegistered(): Promise<void> {
  if (!pushSupported() || Notification.permission !== 'granted') return;
  try {
    const reg = await navigator.serviceWorker.ready;
    const sub = await reg.pushManager.getSubscription();
    if (!sub) return;
    localStorage.setItem(SUB_KEY, JSON.stringify(sub));
    await registerGlobalPush(sub);
  } catch {
    /* SW ещё не готов / офлайн — попробуется при следующем запуске */
  }
}

/** Регистрирует подписку в глобальный список на Worker (для пуша «вышло обновление»). */
async function registerGlobalPush(sub: unknown): Promise<void> {
  try {
    await fetch(`${WORKER_URL}/push-register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ subscription: sub }),
    });
  } catch {
    /* офлайн — зарегистрируется при следующем включении */
  }
}

/** Абсолютное время срабатывания (epoch ms) или null, если задача не годится. */
function fireAtFor(t: ReminderTask): number | null {
  if (!t.dueDate || !t.dueTime || t.remindBefore == null) return null;
  // Локальный разбор: 'YYYY-MM-DDTHH:mm:00' трактуется как местное время.
  const start = new Date(`${t.dueDate}T${t.dueTime}:00`).getTime();
  if (Number.isNaN(start)) return null;
  return start - t.remindBefore * 60_000;
}

/** Ставит/обновляет напоминание задачи на Worker (или снимает, если не годится). */
export async function scheduleReminder(t: ReminderTask): Promise<void> {
  if (!storedSub()) return; // пуши не включены — нечего ставить
  const fireAt = fireAtFor(t);
  if (fireAt == null || fireAt < Date.now()) {
    await cancelReminder(t.id);
    return;
  }
  // Тон уведомлений: без эмодзи, коротко и по делу (title — название задачи).
  const body =
    t.remindBefore && t.remindBefore > 0
      ? tr('Через {n}\u00A0мин · {time}', { n: t.remindBefore, time: t.dueTime ?? '' })
      : tr('Уже пора · {time}', { time: t.dueTime ?? '' });
  try {
    const res = await fetch(`${WORKER_URL}/schedule`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ taskId: t.id, fireAt, title: t.title, body, subscription: storedSub() }),
    });
    // Проверяем ответ, а не только отсутствие исключения: сервер мог ответить
    // отказом, и тогда напоминания тоже нет.
    if (!res.ok) throw new Error(`schedule ${res.status}`);
    clearReminderRetry(t.id);
  } catch {
    // Раньше здесь стояло молчание с обещанием «переедет при следующем
    // сохранении» — но переезжать было некому: повтор случался, только если
    // человек снова откроет эту же задачу и сохранит её. Напоминание,
    // заведённое в метро, не срабатывало никогда.
    queueReminderRetry(t.id);
  }
}

export async function cancelReminder(taskId: string): Promise<void> {
  clearReminderRetry(taskId);
  if (!storedSub()) return;
  try {
    await fetch(`${WORKER_URL}/cancel`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ taskId }),
    });
  } catch {
    /* офлайн */
  }
}

/** Поставить пуш по произвольному id на абсолютное время (не задача — напр. помодоро). */
export async function schedulePush(
  id: string,
  fireAt: number,
  title: string,
  body: string,
): Promise<void> {
  if (!storedSub() || fireAt <= Date.now()) return;
  try {
    await fetch(`${WORKER_URL}/schedule`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ taskId: id, fireAt, title, body, subscription: storedSub() }),
    });
  } catch {
    /* офлайн */
  }
}

/** Снять пуш по произвольному id. */
export async function cancelPush(id: string): Promise<void> {
  return cancelReminder(id);
}

/** Повторить постановку напоминаний, которые не удалось поставить раньше.
 *
 *  Вызывается при возвращении в приложение и при появлении сети. Задачи
 *  читаются из базы заново: пока напоминание ждало повтора, срок могли
 *  передвинуть или задачу выполнить, и ставить нужно то, что есть сейчас, а не
 *  то, что было в момент неудачи. */
export async function retryPendingReminders(
  load: (ids: string[]) => Promise<ReminderTask[]>,
): Promise<number> {
  const ids = pendingReminderRetries();
  if (!ids.length || !storedSub()) return 0;
  const tasks = await load(ids);
  const known = new Set(tasks.map((t) => t.id));
  // Задачи, которых больше нет (удалили, пока ждали сети), снимаем с очереди —
  // иначе она копилась бы вечно.
  for (const id of ids) if (!known.has(id)) clearReminderRetry(id);
  let done = 0;
  for (const t of tasks) {
    await scheduleReminder(t);
    if (!pendingReminderRetries().includes(t.id)) done++;
  }
  return done;
}

/** После включения пушей — переставить напоминания всех будущих задач. */
export async function rescheduleAll(tasks: ReminderTask[]): Promise<void> {
  for (const t of tasks) {
    if (t.remindBefore != null) await scheduleReminder(t);
  }
}
