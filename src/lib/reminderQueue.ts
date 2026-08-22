// Задачи, чьи напоминания не удалось поставить.
//
// Напоминание живёт на сервере: приложение отправляет ему «разбуди в 14:15».
// Если в этот момент нет сети — а задачу как раз и заводят на ходу, в метро
// или на смене, — запрос падает. Раньше на этом всё и заканчивалось: интерфейс
// показывал напоминание как поставленное, но его не существовало, и повторить
// попытку было некому. Напоминание, заведённое офлайн, не срабатывало никогда.
//
// Очередь привязана к устройству, поэтому localStorage, а не база: подписка на
// уведомления своя у каждого устройства, и переносить эти записи на второе
// незачем.

const KEY = 'life-hub-reminder-retry';

function read(): string[] {
  try {
    const raw = localStorage.getItem(KEY);
    const list = raw ? (JSON.parse(raw) as unknown) : [];
    return Array.isArray(list) ? list.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

function write(ids: string[]) {
  try {
    if (ids.length) localStorage.setItem(KEY, JSON.stringify(ids));
    else localStorage.removeItem(KEY);
  } catch {
    /* приватный режим: очередь — не та вещь, ради которой стоит падать */
  }
}

/** Запомнить задачу, которой не досталось напоминания. */
export function queueReminderRetry(taskId: string): void {
  const ids = read();
  if (ids.includes(taskId)) return;
  // Потолок на случай долгого офлайна: очередь не должна расти без предела.
  write([...ids, taskId].slice(-200));
}

/** Задача больше не ждёт повтора: напоминание поставлено или снято. */
export function clearReminderRetry(taskId: string): void {
  const ids = read();
  if (!ids.includes(taskId)) return;
  write(ids.filter((id) => id !== taskId));
}

export function pendingReminderRetries(): string[] {
  return read();
}
