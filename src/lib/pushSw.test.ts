// Сервис-воркер пушей (public/push-sw.js) — обычный файл без сборки, поэтому
// гоняем его как есть в подменённом окружении SW: registration со scope,
// clients, события push и notificationclick.
//
// Зачем: 07.09 приложение переехало с /life-hub/ на /lifehearth/, а адреса в
// этом файле остались старыми — тап по уведомлению открывал страницу о
// переезде. Тест держит, что адрес берётся из области действия SW.

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
