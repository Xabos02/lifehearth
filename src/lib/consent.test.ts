// Одно согласие на всё, что уходит с телефона (задача 34).
//
// Две проверки, которые по отдельности ничего не гарантируют:
//  1. в исходниках нет адреса, которого нет в перечне EGRESS_HOSTS — иначе
//     новый внешний канал появится мимо окна согласия и его текста;
//  2. двери каналов без согласия в сеть не ходят, а после «Принимаю» — ходят.
// Браузерная сторона (раннеры, окно, реальные запросы) — e2e/consent.spec.ts.

import 'fake-indexeddb/auto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const SRC = new URL('..', import.meta.url).pathname;
const ROOT = new URL('../..', import.meta.url).pathname;

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(tsx?|js)$/.test(name) && !/\.test\.tsx?$/.test(name)) out.push(p);
  }
  return out;
}

/** Хосты из адресов в коде. Комментарии пропускаем: там ссылки на документацию
 *  (прайс Polza.ai, пример «vk.com/kafe»), а не запросы. */
function hostsIn(code: string): string[] {
  const out: string[] = [];
  for (const line of code.split('\n')) {
    const s = line.trim();
    if (s.startsWith('//') || s.startsWith('*') || s.startsWith('/*')) continue;
    for (const m of s.matchAll(/\b(?:https?|wss?):\/\/([a-z0-9.-]+\.[a-z]{2,})/gi)) out.push(m[1].toLowerCase());
    for (const m of s.matchAll(/\b(?:stuns?|turns?):([a-z0-9.-]+\.[a-z]{2,})/gi)) out.push(m[1].toLowerCase());
  }
  return out;
}

describe('перечень внешних адресов', () => {
  it('каждый адрес в коде приложения есть в EGRESS_HOSTS или ON_TAP_HOSTS', async () => {
    const { EGRESS_HOSTS, ON_TAP_HOSTS } = await import('./consent');
    const known = new Set<string>([
      ...Object.values(EGRESS_HOSTS).flat(),
      ...ON_TAP_HOSTS,
      // Боевой адрес воркера: в тестах WORKER_URL — локальный из .env.
      'life-hub-push.xabos161rus.workers.dev',
      // Пространство имён SVG, а не запрос.
      'www.w3.org',
    ]);
    const files = [...walk(SRC), join(ROOT, 'public', 'push-sw.js'), join(ROOT, 'index.html')];
    const unknown: string[] = [];
    for (const f of files) {
      for (const h of hostsIn(readFileSync(f, 'utf8'))) {
        if (!known.has(h)) unknown.push(`${f.slice(ROOT.length)}: ${h}`);
      }
    }
    expect(unknown, 'новый внешний адрес — впишите канал в lib/consent.ts и строку в окно').toEqual([]);
  });

  it('сторож видит адреса, а не молчит на пустом множестве', () => {
    // Мутация: подложенный адрес обязан найтись — и в строке, и в шаблоне.
    expect(hostsIn("fetch('https://evil.example.com/x')")).toEqual(['evil.example.com']);
    expect(hostsIn('const u = `wss://a.b.io/ws`; // коммент')).toEqual(['a.b.io']);
    expect(hostsIn("  // https://polza.ai/api — документация")).toEqual([]);
    const weather = readFileSync(join(SRC, 'lib', 'consent.ts'), 'utf8');
    expect(hostsIn(weather)).toContain('api.open-meteo.com');
  });
});

describe('без согласия внешнее в сеть не ходит', () => {
  const store = new Map<string, string>();
  let calls: string[] = [];

  beforeEach(() => {
    store.clear();
    calls = [];
    vi.stubGlobal('localStorage', {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, String(v)),
      removeItem: (k: string) => void store.delete(k),
      clear: () => store.clear(),
    });
    vi.stubGlobal('fetch', async (u: string) => {
      calls.push(String(u));
      return new Response(JSON.stringify({ records: [], hasMore: false, nextAfter: 0, ok: true }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    });
  });

  afterEach(async () => {
    (await import('./consent')).setConsentFlag(true);
    vi.unstubAllGlobals();
  });

  it('ассистент: и живая модель, и эхо — ошибка без запроса', async () => {
    const { setConsentFlag } = await import('./consent');
    const { requestChat, aiErrorText } = await import('./ai/aiClient');
    setConsentFlag(false);
    const err = await requestChat({ messages: [{ role: 'user', content: 'привет' }], model: 'echo' }).catch((e) => e);
    expect(err?.code).toBe('no_consent');
    expect(aiErrorText(err)).toContain('Что уходит с телефона');
    expect(calls).toEqual([]);
  });

  it('погода: ни координат, ни Open-Meteo', async () => {
    const { setConsentFlag } = await import('./consent');
    const { getWeather } = await import('./weather');
    setConsentFlag(false);
    expect(await getWeather()).toBeNull();
    expect(calls).toEqual([]);
  });

  it('синхронизация: включённый обмен на паузе, конфиг цел', async () => {
    const { db } = await import('../db/db');
    const { generateKey } = await import('./crypto');
    const { setConsentFlag } = await import('./consent');
    const { runSync } = await import('./sync');
    const { pushAccountSnapshot, cloudBackupDate } = await import('./cloudBackup');
    await db.open();
    await db.sync.put({
      id: 'config',
      accountId: 'acc-1',
      authToken: 'tok-1',
      key: await generateKey(),
      enabled: true,
      lastPullAt: '',
      lastPushAt: '',
      lastSyncedAt: '',
    } as never);
    setConsentFlag(false);
    expect(await runSync()).toBeNull();
    expect(await pushAccountSnapshot()).toBe(0);
    // Не «копии нет» — это толкало бы затереть настоящую копию.
    expect(await cloudBackupDate()).toEqual({ state: 'unknown' });
    expect(calls).toEqual([]);
    expect((await db.sync.get('config'))?.enabled).toBe(true);

    setConsentFlag(true);
    await runSync().catch(() => {});
    expect(calls.some((u) => u.includes('/sync/pull'))).toBe(true);
    await db.sync.clear();
  });

  it('напоминания: не ставятся и не снимаются, а копятся до «Принимаю»', async () => {
    const { setConsentFlag } = await import('./consent');
    const push = await import('./push');
    const { pendingReminderRetries } = await import('./reminderQueue');
    store.set('life-hub-push-sub', JSON.stringify({ endpoint: 'https://push.example/x' }));
    setConsentFlag(false);
    const task = { id: 'r1', title: 'Позвонить', dueDate: '2099-01-01', dueTime: '10:00', remindBefore: 10 };
    await push.scheduleReminder(task);
    await push.cancelReminder('fam-1', true); // общая задача — и без подписки не уходит
    await push.ensurePushRegistered();
    expect(calls).toEqual([]);
    // Снятие тоже не теряется: после «Принимаю» напоминание выполненной на
    // паузе задачи уйдёт с сервера, а не придёт через неделю.
    expect(pendingReminderRetries()).toEqual(['r1', 'fam-1']);
    expect(push.pushEnabled()).toBe(false);

    setConsentFlag(true);
    await push.retryPendingReminders(async () => [task]);
    expect(calls.some((u) => u.endsWith('/schedule'))).toBe(true);
    expect(calls.some((u) => u.endsWith('/cancel'))).toBe(true);
    expect(pendingReminderRetries()).toEqual([]);
  });
});

describe('окно по просьбе', () => {
  it('вторая просьба при открытом окне не копится: «Принимаю» не повторит действие дважды', async () => {
    vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => {}, removeItem: () => {} });
    const c = await import('./consent');
    c.setConsentFlag(false);
    const first = c.askConsent('ai');
    expect(await c.askConsent('ai')).toBe(false); // второй Enter под окном
    await c.answerConsent(true).catch(() => {}); // запись в базу здесь не важна
    expect(await first).toBe(true);
    expect(c.hasConsent()).toBe(true);
    expect(await c.askConsent('sync')).toBe(true); // дальше — без окна
    vi.unstubAllGlobals();
  });
});

describe('согласие даёт человек на этом телефоне', () => {
  beforeEach(async () => {
    const { db } = await import('../db/db');
    await db.open();
    await Promise.all(db.tables.map((t) => t.clear()));
  });

  it('копия его не уносит', async () => {
    const { db } = await import('../db/db');
    const { exportBackup } = await import('../db/backup');
    await db.settings.put({ id: 'app', consentAt: '2026-09-25T10:00:00.000Z', consentAskedAt: '2026-09-25T10:00:00.000Z' } as never);
    const b = await exportBackup();
    expect(b.data.settings[0]).not.toHaveProperty('consentAt');
    expect(b.data.settings[0]).not.toHaveProperty('consentAskedAt');
  });

  it('восстановление не приносит чужое и не стирает своё', async () => {
    const { db } = await import('../db/db');
    const { importBackup, exportBackup } = await import('../db/backup');
    // Копия со старого телефона — с его согласием; здесь согласия нет.
    await db.settings.put({ id: 'app', theme: 'light', consentAt: '2026-01-01T00:00:00.000Z' } as never);
    const foreign = await exportBackup();
    foreign.data.settings = [{ ...(foreign.data.settings[0] as object), consentAt: '2026-01-01T00:00:00.000Z' }];
    await db.settings.put({ id: 'app', theme: 'dark' } as never);
    await importBackup(foreign);
    expect((await db.settings.get('app'))?.consentAt).toBeUndefined();
    expect((await db.settings.get('app'))?.theme).toBe('light');

    // И обратно: здесь согласие дано, в копии (снята до 1.39.0) его нет.
    await db.settings.update('app', { consentAt: '2026-09-25T10:00:00.000Z' });
    const old = await exportBackup();
    await importBackup(old);
    expect((await db.settings.get('app'))?.consentAt).toBe('2026-09-25T10:00:00.000Z');
  });
});
