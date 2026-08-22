// Напоминания, которые не удалось поставить: очередь и повтор.

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

  it('исчезнувшую задачу снимает с очереди, а не хранит вечно', async () => {
    localStorage.setItem('life-hub-push-sub', JSON.stringify({ endpoint: 'https://push/x' }));
    globalThis.fetch = (() =>
      Promise.resolve(new Response('{"ok":true}', { status: 200 }))) as typeof fetch;

    const { retryPendingReminders } = await import('./push');
    queueReminderRetry('исчезла');

    await retryPendingReminders(async () => []); // задачи с таким id больше нет

    expect(pendingReminderRetries()).toEqual([]);
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
});
