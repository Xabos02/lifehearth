// Клиент Web Push: запрос разрешения, подписка, постановка/снятие напоминаний
// на Worker. Реальные пуши приходят только в установленном PWA на iOS 16.4+.

import { sealReminderText } from './reminderSeal';
import type { Task } from '../db/types';
// Алиас: в этом файле t — общепринятое имя задачи в параметрах.
import { getLang, t as tr } from './i18n';
import { plural } from './plural';

import { clearReminderRetry, pendingReminderRetries, queueReminderRetry } from './reminderQueue';

import { WORKER_URL } from './workerUrl';
import { askConsent, hasConsent } from './consent';
// Публичный VAPID-ключ (пара к секрету воркера). Безопасно держать в коде.
const VAPID_PUBLIC =
  'BCi0yalmrjjC4elVs1vwAzGASoESrlpDA5ImcuB-u6kOVQf00Zc-GIK79WIBe7sQp5Y3_IBD96l8JEpccCj9Ws8';
const SUB_KEY = 'life-hub-push-sub';

export type ReminderTask = Pick<Task, 'id' | 'title' | 'dueDate' | 'dueTime' | 'remindBefore'>;

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
  return pushSupported() && Notification.permission === 'granted' && !!storedSub();
}

/** Уведомления включали, но согласия на внешнее нет (задача 34): подписка
 *  цела, телефон просто ничего не ставит и не регистрирует. Уже лежащее на
 *  сервере приходит — так решил Влад 25.09: пуш приведёт к «Принимаю». */
export function pushPaused(): boolean {
  return (
    pushSupported() &&
    Notification.permission === 'granted' &&
    !!localStorage.getItem(SUB_KEY) &&
    !hasConsent()
  );
}

/** Подписка для запросов на сервер. Без согласия её нет — на этом стоят все
 *  двери: постановка и снятие напоминаний, «Фокус», повтор очереди, семейная
 *  регистрация пушей. */
function storedSub(): unknown | null {
  if (!hasConsent()) return null;
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
  // Без согласия — сначала окно. С согласием путь прежний, без лишнего await:
  // запрос разрешения iOS показывает только в жесте.
  if (!hasConsent() && !(await askConsent('push'))) return { ok: false, reason: 'consent' };
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
  if (!hasConsent() || !pushSupported() || Notification.permission !== 'granted') return;
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

/** Во сколько напоминать о задаче, у которой есть день, но нет времени.
 *
 *  Раньше такой задаче напоминание было недоступно вовсе: считать время
 *  срабатывания не от чего. А «на день» — самый частый способ поставить срок:
 *  «завтра сдать отчёт» пишется без часа. Утро — единственный ответ, который
 *  не надо спрашивать: напоминание приходит к началу дня, а не среди ночи и
 *  не когда день уже прошёл. */
export const ALLDAY_REMIND_TIME = '09:00';

/** Абсолютное время срабатывания (epoch ms) или null, если задача не годится.
 *
 *  Экспортируется ради юнитов: тут арифметика дат и подстановка утреннего часа
 *  — ровно то место, где ошибка не видна глазом и всплывает уведомлением не в
 *  тот день. */
export function reminderFireAt(t: ReminderTask): number | null {
  if (!t.dueDate || t.remindBefore == null) return null;
  // Локальный разбор: 'YYYY-MM-DDTHH:mm:00' трактуется как местное время.
  const start = new Date(`${t.dueDate}T${t.dueTime || ALLDAY_REMIND_TIME}:00`).getTime();
  if (Number.isNaN(start)) return null;
  return start - t.remindBefore * 60_000;
}

/** «Через сколько» словами. Минуты годятся до часа, часы — до суток, дальше
 *  дни: «Через 1440 мин» — это не текст уведомления, это отчёт машины. */
function leftText(min: number): string {
  const en = getLang() === 'en';
  if (min >= 1440) {
    const d = Math.round(min / 1440);
    return en ? `${d}\u00A0d` : `${d}\u00A0${plural(d, ['день', 'дня', 'дней'])}`;
  }
  if (min >= 60) {
    const h = Math.round(min / 60);
    return en ? `${h}\u00A0h` : `${h}\u00A0ч`;
  }
  return en ? `${min}\u00A0min` : `${min}\u00A0мин`;
}

/** Вторая строка уведомления: сколько осталось и к какому времени. У задачи
 *  без часа времени нет — и обещать его в тексте нельзя. */
function bodyFor(t: ReminderTask): string {
  const before = t.remindBefore ?? 0;
  if (before === 0) {
    return t.dueTime ? tr('Уже пора · {time}', { time: t.dueTime }) : tr('Сегодня');
  }
  const left = leftText(before);
  return t.dueTime
    ? tr('Через {left} · {time}', { left, time: t.dueTime })
    : tr('Через {left}', { left });
}

/** Единственная дверь в /schedule. Текст — только шифротекстом (reminderSeal.ts):
 *  сервер хранит его до срока и видеть не должен. Не вышло зашифровать — уходит
 *  пустым (уведомление придёт нейтральным «Напоминание», но не открытым), и
 *  sealed=false: напоминание задачи остаётся в очереди повтора. */
async function postSchedule(
  id: string,
  fireAt: number,
  title: string,
  body: string,
): Promise<{ res: Response; sealed: boolean }> {
  const text = await sealReminderText(title, body).catch(() => '');
  const res = await fetch(`${WORKER_URL}/schedule`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ taskId: id, fireAt, title: '', body: text, subscription: storedSub() }),
  });
  return { res, sealed: text !== '' };
}

/** Ставит/обновляет напоминание задачи на Worker (или снимает, если не годится). */
export async function scheduleReminder(t: ReminderTask): Promise<void> {
  if (!storedSub()) {
    // На паузе без согласия — в очередь повтора: после «Принимаю» SyncRunner
    // поставит то, что человек успел завести или передвинуть.
    if (!hasConsent() && localStorage.getItem(SUB_KEY)) queueReminderRetry(t.id);
    return; // пуши не включены — нечего ставить
  }
  const fireAt = reminderFireAt(t);
  if (fireAt == null || fireAt < Date.now()) {
    await cancelReminder(t.id);
    return;
  }
  // Тон уведомлений: без эмодзи, коротко и по делу (title — название задачи).
  const body = bodyFor(t);
  try {
    const { res, sealed } = await postSchedule(t.id, fireAt, t.title, body);
    // Проверяем ответ, а не только отсутствие исключения: сервер мог ответить
    // отказом, и тогда напоминания тоже нет.
    if (!res.ok) throw new Error(`schedule ${res.status}`);
    // Ушло без текста (сбой базы ключа) — стоит, но нейтральное; повтор
    // запечатает название, когда база оживёт.
    if (!sealed) throw new Error('schedule: not sealed');
    clearReminderRetry(t.id);
  } catch {
    // Раньше здесь стояло молчание с обещанием «переедет при следующем
    // сохранении» — но переезжать было некому: повтор случался, только если
    // человек снова откроет эту же задачу и сохранит её. Напоминание,
    // заведённое в метро, не срабатывало никогда.
    queueReminderRetry(t.id);
  }
}

/** elsewhere — напоминание могло поставить ДРУГОЕ устройство: у задачи оно
 *  было (remindBefore), а ставит его тот телефон, что тронул задачу последним,
 *  или телефон другого участника семьи. Тогда снимать надо и с устройства без
 *  своей подписки: раньше мак без уведомлений закрывал задачу, а напоминание
 *  айфона о сделанном деле приходило. Задача без напоминания на сервер не
 *  ходит: иначе сервер узнавал бы время каждой отметки.
 *
 *  Не дошло (нет сети) — в очередь повтора: retryPendingReminders снимет,
 *  когда связь вернётся, раз задача уже не ждёт напоминания. */
export async function cancelReminder(taskId: string, elsewhere = false): Promise<void> {
  clearReminderRetry(taskId);
  // Без согласия снятие не уходит (цена паузы, названная Владу: напомнит о
  // сделанном на паузе), но и не теряется: id — в очередь, и после
  // «Принимаю» повтор снимет напоминание задачи, которой больше нет. Иначе
  // выполненная на паузе задача напомнила бы о себе и через неделю.
  if (!hasConsent()) {
    if (elsewhere || localStorage.getItem(SUB_KEY)) queueReminderRetry(taskId);
    return;
  }
  if (!elsewhere && !storedSub()) return;
  try {
    const res = await fetch(`${WORKER_URL}/cancel`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ taskId }),
    });
    if (!res.ok) throw new Error(`cancel ${res.status}`);
  } catch {
    queueReminderRetry(taskId);
  }
}

type SyncedTask = ReminderTask & Partial<Pick<Task, 'completedAt' | 'deletedAt' | 'frozenAt'>>;

/** Задача пришла синхронизацией с другого устройства — свести её напоминание.
 *
 *  Напоминание на сервере одно на задачу и стоит на подписке того телефона,
 *  который его поставил. Правку с устройства без уведомлений (мак) сервер
 *  раньше не видел: задачу закрыли — напоминание о сделанном приходило;
 *  перенесли — приходило в старое время. Телефон с уведомлениями, получив
 *  правку, сам снимает напоминание или ставит заново — на себя. Без своей
 *  подписки здесь делать нечего. */
export async function reconcileIncomingReminder(before: SyncedTask | undefined, after: SyncedTask): Promise<void> {
  if (!storedSub()) return;
  const wants = (x: SyncedTask | undefined) =>
    !!x && x.remindBefore != null && !!x.dueDate && !x.completedAt && !x.deletedAt && !x.frozenAt;
  if (!wants(after)) {
    if (wants(before)) await cancelReminder(after.id, true);
    return;
  }
  const same =
    wants(before) &&
    before!.title === after.title &&
    before!.dueDate === after.dueDate &&
    (before!.dueTime ?? null) === (after.dueTime ?? null) &&
    before!.remindBefore === after.remindBefore;
  if (!same) await scheduleReminder(after);
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
    await postSchedule(id, fireAt, title, body);
  } catch {
    /* офлайн */
  }
}

/** Снять пуш по произвольному id. Без согласия — ничего и без очереди:
 *  «Фокус» сам переставит свой пуш после «Принимаю» (PomodoroProvider), а
 *  отложенное снятие спорило бы с этой постановкой. */
export async function cancelPush(id: string): Promise<void> {
  if (!hasConsent()) return;
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
  // Пока нет согласия, очередь ждёт «Принимаю» целиком: ни снятий, ни
  // постановок (storedSub без согласия пуст — иначе живые задачи ушли бы из
  // очереди как «без подписки»).
  if (!ids.length || !hasConsent()) return 0;
  const tasks = await load(ids);
  const known = new Set(tasks.map((t) => t.id));
  // Задачи, которые напоминания больше не ждут (удалили, выполнили, пока не
  // было сети), — снять и на сервере: отмена могла не дойти. Удалось — сама
  // уходит из очереди; нет — останется до следующего раза.
  for (const id of ids) if (!known.has(id)) await cancelReminder(id, true);
  // Без своей подписки ставить нечего — живые задачи из очереди убираем.
  if (!storedSub()) {
    for (const t of tasks) clearReminderRetry(t.id);
    return 0;
  }
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
