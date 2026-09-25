// Сервис-воркер пушей (public/push-sw.js) — обычный файл без сборки, поэтому
// гоняем его как есть в подменённом окружении SW: registration со scope,
// clients, события push и notificationclick.
//
// Зачем: 07.09 приложение переехало с /life-hub/ на /lifehearth/, а адреса в
// этом файле остались старыми — тап по уведомлению открывал страницу о
// переезде. Тест держит, что адрес берётся из области действия SW.

import 'fake-indexeddb/auto';
import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';

const CODE = readFileSync(new URL('../../public/push-sw.js', import.meta.url), 'utf8');

function bootSw(scope: string, openClients: { postMessage: (m: unknown) => void; focus: () => void }[] = []) {
  const handlers: Record<string, (e: unknown) => void> = {};
  const shown: { title: string; opts: { icon: string; data: { url: string } } }[] = [];
  const openWindow = vi.fn(async () => {});
  const self = {
    registration: {
      scope,
      showNotification: async (title: string, opts: never) => void shown.push({ title, opts }),
    },
    clients: { matchAll: async () => openClients, openWindow },
    addEventListener: (type: string, fn: (e: unknown) => void) => (handlers[type] = fn),
  };
  new Function('self', CODE)(self);
  const fire = async (type: string, e: Record<string, unknown>) => {
    let wait: Promise<unknown> = Promise.resolve();
    handlers[type]({ ...e, waitUntil: (p: Promise<unknown>) => (wait = p) });
    await wait;
  };
  return { shown, openWindow, fire };
}

const pushOf = (data: unknown) => ({ data: { json: () => data } });
const clickOf = (url: string) => ({ notification: { close: () => {}, data: { url } } });

describe('push-sw: адреса из области действия SW', () => {
  it('напоминание о задаче ведёт в приложение по нынешнему адресу', async () => {
    const sw = bootSw('https://xabos02.github.io/lifehearth/');
    await sw.fire('push', pushOf({ title: 'Оплатить интернет', taskId: 't1' }));
    expect(sw.shown[0].opts.data.url).toBe('/lifehearth/');
    expect(sw.shown[0].opts.icon).toBe('/lifehearth/icons/icon-192.png');
  });

  it('пуш семьи ведёт в чат своей группы', async () => {
    const sw = bootSw('https://xabos02.github.io/lifehearth/');
    await sw.fire('push', pushOf({ title: 'Отец', family: true, familyId: 'g1' }));
    expect(sw.shown[0].opts.data.url).toBe('/lifehearth/more/family?g=g1');
  });

  it('тап при закрытом приложении открывает его, а не старый адрес', async () => {
    const sw = bootSw('https://xabos02.github.io/lifehearth/');
    await sw.fire('notificationclick', clickOf('/lifehearth/more/family?g=g1'));
    expect(sw.openWindow).toHaveBeenCalledWith('/lifehearth/more/family?g=g1');
  });

  it('уведомление, пришедшее до правки, со старым адресом тоже ведёт в приложение', async () => {
    const sw = bootSw('https://xabos02.github.io/lifehearth/');
    await sw.fire('notificationclick', clickOf('/life-hub/more/family?g=g1'));
    expect(sw.openWindow).toHaveBeenCalledWith('/lifehearth/more/family?g=g1');
  });

  it('при открытом приложении шлёт ему адрес и наводит фокус', async () => {
    const posted: unknown[] = [];
    const focus = vi.fn();
    const sw = bootSw('https://xabos02.github.io/lifehearth/', [{ postMessage: (m) => posted.push(m), focus }]);
    await sw.fire('notificationclick', clickOf('/life-hub/'));
    expect(posted).toEqual([{ type: 'open-url', url: '/lifehearth/' }]);
    expect(focus).toHaveBeenCalled();
    expect(sw.openWindow).not.toHaveBeenCalled();
  });
});

// Текст напоминания на сервере — только шифротекстом (reminderSeal.ts), а
// расшифровывает его этот же файл SW ключом из базы устройства. Сторож на всю
// цепочку: что уходит в /schedule и что человек видит на экране.
describe('push-sw: текст напоминания сервер не видит', () => {
  const SCOPE = 'https://xabos02.github.io/lifehearth/';

  it('в /schedule уходит шифротекст, а не название задачи', async () => {
    const sent: { title: string; body: string }[] = [];
    const store = new Map([['life-hub-push-sub', JSON.stringify({ endpoint: 'https://push.example/1' })]]);
    vi.stubGlobal('localStorage', { getItem: (k: string) => store.get(k) ?? null, setItem: () => {}, removeItem: () => {} });
    vi.stubGlobal('fetch', async (_u: string, init: RequestInit) => {
      sent.push(JSON.parse(String(init.body)));
      return new Response('{}', { status: 200 });
    });
    const { schedulePush } = await import('./push');
    await schedulePush('t1', Date.now() + 60_000, 'Забрать анализы у Иванова', 'Через 30 мин · 09:00');
    vi.unstubAllGlobals();
    expect(sent).toHaveLength(1);
    expect(sent[0].title).toBe('');
    expect(sent[0].body.startsWith('e2e1:')).toBe(true);
    expect(JSON.stringify(sent[0])).not.toContain('Иванова');
  });

  it('свой телефон показывает настоящий текст', async () => {
    const { sealReminderText } = await import('./reminderSeal');
    const sealed = await sealReminderText('Оплатить интернет', 'Через 30 мин · 09:00');
    const sw = bootSw(SCOPE);
    await sw.fire('push', pushOf({ title: 'Напоминание', body: sealed, taskId: 't1' }));
    expect(sw.shown[0].title).toBe('Оплатить интернет');
    expect((sw.shown[0].opts as unknown as { body: string }).body).toBe('Через 30 мин · 09:00');
  });

  it('без своего ключа — нейтральное уведомление, открытым текст не бывает', async () => {
    const { sealReminderText, forgetReminderKeyForTests } = await import('./reminderSeal');
    const sealed = await sealReminderText('Оплатить интернет', 'Через 30 мин · 09:00');
    // Переустановка или другой телефон: ключа, которым запечатано, больше нет.
    forgetReminderKeyForTests();
    await new Promise<void>((resolve) => {
      const r = indexedDB.deleteDatabase('lifehearth-push-key');
      r.onsuccess = r.onerror = () => resolve();
    });
    const sw = bootSw(SCOPE);
    await sw.fire('push', pushOf({ title: 'Напоминание', body: sealed, taskId: 't1' }));
    expect(sw.shown[0].title).toBe('Напоминание');
    const body = (sw.shown[0].opts as unknown as { body: string }).body;
    expect(body).not.toContain('e2e1:');
    expect(body).not.toContain('интернет');
  });
});

describe('ключ напоминаний: первый запуск в двух вкладках', () => {
  it('обе вкладки запечатывают ключом, который лежит в базе', async () => {
    // Две вкладки (или вкладка и PWA на Android) поднимаются после
    // обновления одновременно: раньше каждая заводила свой ключ, побеждал
    // последний, и напоминания проигравшей не расшифровывались.
    await new Promise<void>((resolve) => {
      const r = indexedDB.deleteDatabase('lifehearth-push-key');
      r.onsuccess = r.onerror = () => resolve();
    });
    vi.resetModules();
    const tabA = await import('./reminderSeal');
    vi.resetModules();
    const tabB = await import('./reminderSeal');
    const [a, b] = await Promise.all([
      tabA.sealReminderText('Задача вкладки А', ''),
      tabB.sealReminderText('Задача вкладки Б', ''),
    ]);
    const sw = bootSw('https://xabos02.github.io/lifehearth/');
    await sw.fire('push', pushOf({ title: 'Напоминание', body: a, taskId: 'a' }));
    await sw.fire('push', pushOf({ title: 'Напоминание', body: b, taskId: 'b' }));
    expect(sw.shown.map((n) => n.title)).toEqual(['Задача вкладки А', 'Задача вкладки Б']);
  });
});
