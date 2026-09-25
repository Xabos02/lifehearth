// Напоминания, которые не удалось поставить: очередь и повтор.

import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Юниты идут без браузерного окружения, а очередь живёт в localStorage:
// она привязана к устройству, как и подписка на уведомления. Подставляем
// минимальную реализацию — проверяем свою логику, а не чужую.
const store = new Map<string, string>();
globalThis.localStorage = {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, String(v)),
  removeItem: (k: string) => void store.delete(k),
  clear: () => store.clear(),
  key: (i: number) => [...store.keys()][i] ?? null,
  get length() {
    return store.size;
  },
} as Storage;
import {
  clearReminderRetry,
  pendingReminderRetries,
  queueReminderRetry,
} from './reminderQueue';

describe('очередь повторов напоминаний', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('запоминает задачу без напоминания и отдаёт её обратно', () => {
    queueReminderRetry('t1');
    expect(pendingReminderRetries()).toEqual(['t1']);
  });

  it('не копит дубли: одна задача — одна запись', () => {
    queueReminderRetry('t1');
    queueReminderRetry('t1');
    expect(pendingReminderRetries()).toEqual(['t1']);
  });

  it('снимается с очереди, когда напоминание поставлено или снято', () => {
    queueReminderRetry('t1');
    queueReminderRetry('t2');
    clearReminderRetry('t1');
    expect(pendingReminderRetries()).toEqual(['t2']);
  });

  it('не растёт без предела при долгом офлайне', () => {
    for (let i = 0; i < 300; i++) queueReminderRetry(`t${i}`);
    const ids = pendingReminderRetries();
    expect(ids.length).toBeLessThanOrEqual(200);
    // Хранятся последние: они актуальнее.
    expect(ids).toContain('t299');
  });

  it('переживает мусор в хранилище, а не падает', () => {
    localStorage.setItem('life-hub-reminder-retry', 'не json');
    expect(pendingReminderRetries()).toEqual([]);
    queueReminderRetry('t1');
    expect(pendingReminderRetries()).toEqual(['t1']);
  });
});

describe('повтор постановки', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.resetModules();
  });

  it('ставит напоминание заново и снимает задачу с очереди', async () => {
    localStorage.setItem('life-hub-push-sub', JSON.stringify({ endpoint: 'https://push/x' }));
    const calls: string[] = [];
    globalThis.fetch = ((url: RequestInfo | URL) => {
      calls.push(String(url));
      return Promise.resolve(new Response('{"ok":true}', { status: 200 }));
    }) as typeof fetch;

    const { retryPendingReminders } = await import('./push');
    queueReminderRetry('t1');

    const done = await retryPendingReminders(async () => [
      {
        id: 't1',
        title: 'Позвонить в банк',
        dueDate: '2099-01-01',
        dueTime: '14:30',
        remindBefore: 15,
      },
    ]);

    expect(done).toBe(1);
    expect(calls.some((u) => u.includes('/schedule'))).toBe(true);
    expect(pendingReminderRetries()).toEqual([]);
  });

  it('задачу, которая напоминания больше не ждёт, снимает на сервере и из очереди', async () => {
    // Удалили или выполнили без сети — отмена могла не дойти. Работает и на
    // устройстве без своей подписки: напоминание ставил другой телефон.
    const calls: string[] = [];
    globalThis.fetch = ((url: RequestInfo | URL) => {
      calls.push(new URL(String(url)).pathname);
      return Promise.resolve(new Response('{"ok":true}', { status: 200 }));
    }) as typeof fetch;

    const { retryPendingReminders } = await import('./push');
    queueReminderRetry('исчезла');

    await retryPendingReminders(async () => []); // живой задачи с таким id нет

    expect(calls).toEqual(['/cancel']);
    expect(pendingReminderRetries()).toEqual([]);
  });

  it('отмена без сети встаёт в очередь, а не теряется', async () => {
    globalThis.fetch = (() => Promise.reject(new Error('офлайн'))) as typeof fetch;
    const { cancelReminder } = await import('./push');
    await cancelReminder('t1', true);
    expect(pendingReminderRetries()).toEqual(['t1']);
  });

  it('если сети всё ещё нет — задача остаётся в очереди', async () => {
    localStorage.setItem('life-hub-push-sub', JSON.stringify({ endpoint: 'https://push/x' }));
    globalThis.fetch = (() => Promise.reject(new Error('офлайн'))) as typeof fetch;

    const { retryPendingReminders } = await import('./push');
    queueReminderRetry('t1');

    const done = await retryPendingReminders(async () => [
      { id: 't1', title: 'Позвонить', dueDate: '2099-01-01', dueTime: '14:30', remindBefore: 15 },
    ]);

    expect(done).toBe(0);
    expect(pendingReminderRetries()).toEqual(['t1']);
  });
});

describe('постановка напоминания при сбое', () => {
  const task = {
    id: 't1',
    title: 'Позвонить в банк',
    dueDate: '2099-01-01',
    dueTime: '14:30',
    remindBefore: 15,
  };

  beforeEach(() => {
    store.clear();
    vi.resetModules();
    localStorage.setItem('life-hub-push-sub', JSON.stringify({ endpoint: 'https://push/x' }));
  });

  it('нет сети — задача попадает в очередь повторов', async () => {
    globalThis.fetch = (() => Promise.reject(new Error('офлайн'))) as typeof fetch;
    const { scheduleReminder } = await import('./push');

    await scheduleReminder(task);

    expect(pendingReminderRetries()).toEqual(['t1']);
  });

  it('сервер ответил отказом — тоже в очередь: напоминания нет', async () => {
    // Без проверки ответа отказ выглядел бы как успех: исключения нет, значит
    // «поставили». А напоминания при этом не существует.
    globalThis.fetch = (() => Promise.resolve(new Response('', { status: 500 }))) as typeof fetch;
    const { scheduleReminder } = await import('./push');

    await scheduleReminder(task);

    expect(pendingReminderRetries()).toEqual(['t1']);
  });

  it('удачная постановка снимает задачу с очереди', async () => {
    queueReminderRetry('t1');
    globalThis.fetch = (() =>
      Promise.resolve(new Response('{"ok":true}', { status: 200 }))) as typeof fetch;
    const { scheduleReminder } = await import('./push');

    await scheduleReminder(task);

    expect(pendingReminderRetries()).toEqual([]);
  });

  it('ушло без текста (база ключа не открылась) — задача остаётся в очереди', async () => {
    // Сервер принял, но текст не запечатан: придёт нейтральное «Напоминание».
    // Повтор запечатает название, когда база ключа оживёт.
    const idb = globalThis.indexedDB;
    globalThis.indexedDB = { open: () => { throw new Error('IDB down'); } } as unknown as IDBFactory;
    const sent: { body: string }[] = [];
    globalThis.fetch = ((_u: string, init: RequestInit) => {
      sent.push(JSON.parse(String(init.body)));
      return Promise.resolve(new Response('{"ok":true}', { status: 200 }));
    }) as typeof fetch;
    try {
      const { scheduleReminder } = await import('./push');
      await scheduleReminder(task);
    } finally {
      globalThis.indexedDB = idb;
    }
    expect(sent).toHaveLength(1);
    expect(sent[0].body).toBe('');
    expect(pendingReminderRetries()).toEqual(['t1']);
  });
});

describe('снятие напоминания общей задачи', () => {
  beforeEach(() => {
    store.clear(); // подписки на этом телефоне нет: уведомления не включали
    vi.resetModules();
  });

  it('уходит на сервер и без своей подписки, а личное — нет', async () => {
    // Напоминание семейной задачи ставил телефон другого участника. Раньше
    // отметка «выполнена» с телефона без уведомлений до сервера не доходила,
    // и автор получал напоминание о сделанном деле.
    const calls: string[] = [];
    globalThis.fetch = ((url: RequestInfo | URL) => {
      calls.push(String(url));
      return Promise.resolve(new Response('{"ok":true}', { status: 200 }));
    }) as typeof fetch;
    const { cancelReminder } = await import('./push');

    await cancelReminder('t1');
    expect(calls).toEqual([]);
    await cancelReminder('t1', true);
    expect(calls.map((u) => new URL(u).pathname)).toEqual(['/cancel']);
  });
});

describe('задача пришла синхронизацией с другого устройства', () => {
  const base = { id: 't1', title: 'Позвонить в банк', dueDate: '2099-01-01', dueTime: '14:30', remindBefore: 15 };
  let calls: string[];
  beforeEach(() => {
    store.clear();
    vi.resetModules();
    calls = [];
    globalThis.fetch = ((url: RequestInfo | URL) => {
      calls.push(new URL(String(url)).pathname);
      return Promise.resolve(new Response('{"ok":true}', { status: 200 }));
    }) as typeof fetch;
  });
  const withSub = () => localStorage.setItem('life-hub-push-sub', JSON.stringify({ endpoint: 'https://push/x' }));

  it('выполнили на маке без уведомлений — телефон снимает напоминание', async () => {
    withSub();
    const { reconcileIncomingReminder } = await import('./push');
    await reconcileIncomingReminder(base, { ...base, completedAt: '2026-09-25T10:00:00.000Z' });
    expect(calls).toEqual(['/cancel']);
  });

  it('перенесли время — телефон ставит напоминание заново, на новое время', async () => {
    withSub();
    const { reconcileIncomingReminder } = await import('./push');
    await reconcileIncomingReminder(base, { ...base, dueTime: '16:00' });
    expect(calls).toEqual(['/schedule']);
  });

  it('правка без отношения к напоминанию (заметки) — на сервер не ходит', async () => {
    withSub();
    const { reconcileIncomingReminder } = await import('./push');
    await reconcileIncomingReminder(base, { ...base });
    expect(calls).toEqual([]);
  });

  it('задача без напоминания — на сервер не ходит', async () => {
    withSub();
    const { reconcileIncomingReminder } = await import('./push');
    const plain = { ...base, remindBefore: null };
    await reconcileIncomingReminder(plain, { ...plain, completedAt: '2026-09-25T10:00:00.000Z' });
    expect(calls).toEqual([]);
  });

  it('устройство без уведомлений ничего не сводит', async () => {
    const { reconcileIncomingReminder } = await import('./push');
    await reconcileIncomingReminder(base, { ...base, completedAt: '2026-09-25T10:00:00.000Z' });
    expect(calls).toEqual([]);
  });
});
