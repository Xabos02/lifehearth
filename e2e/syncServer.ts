import type { Route } from '@playwright/test';

// Подставной сервер обмена — общий для тестов, которым нужен целый круг
// «правка → отправка → приём → экран». Настоящий сервер трогать нельзя: там
// живые данные семьи, и однажды тесты уже выжгли ему дневной лимит.
//
// Протокол повторён по воркеру: составной курсор «updatedAt|id»,
// last-write-wins по updatedAt, /account/check отвечает про существование
// аккаунта и НЕ регистрирует незнакомый.

interface Rec {
  table: string;
  id: string;
  updatedAt: string;
  deletedAt: string | null;
  ciphertext: string;
}

/** Общий на оба устройства «сервер»: хранит шифротексты и отдаёт дельту. */
export function makeServer(opts: { accountExists?: boolean } = {}) {
  const rows = new Map<string, Rec>();
  const keyOf = (r: Rec) => `${r.table}:${r.id}`;
  let pushes = 0;
  let pulls = 0;

  const handle = async (route: Route) => {
    const req = route.request();
    const url = new URL(req.url());

    if (url.pathname === '/sync/push') {
      pushes++;
      const body = JSON.parse(req.postData() ?? '{}') as { records?: Rec[] };
      for (const r of body.records ?? []) {
        const prev = rows.get(keyOf(r));
        // Тот же ON CONFLICT, что у воркера: побеждает более свежая правка.
        if (!prev || r.updatedAt > prev.updatedAt) rows.set(keyOf(r), r);
      }
      return route.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' });
    }

    if (url.pathname === '/sync/pull') {
      pulls++;
      const since = url.searchParams.get('since') ?? '';
      const sep = since.indexOf('|');
      const su = sep >= 0 ? since.slice(0, sep) : since;
      const sid = sep >= 0 ? since.slice(sep + 1) : '';
      const out = [...rows.values()]
        .filter((r) => r.updatedAt > su || (r.updatedAt === su && r.id > sid))
        .sort((a, b) =>
          a.updatedAt === b.updatedAt ? a.id.localeCompare(b.id) : a.updatedAt.localeCompare(b.updatedAt),
        );
      const last = out[out.length - 1];
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          records: out,
          hasMore: false,
          nextSince: last ? `${last.updatedAt}|${last.id}` : since,
        }),
      });
    }

    // Восстановление по ключу спрашивает, есть ли такой аккаунт: сервер
    // регистрирует незнакомый молча, и без этого вопроса верный ключ от
    // несуществующего аккаунта выглядел как успешное подключение к пустоте.
    if (url.pathname === '/account/check') {
      const exists = opts.accountExists ?? true;
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(exists ? { exists: true, records: rows.size } : { exists: false }),
      });
    }

    // Всё прочее к воркеру (пуши, семья) тесту не нужно.
    return route.fulfill({ status: 404, contentType: 'application/json', body: '{}' });
  };

  return {
    handle,
    rows,
    stats: () => ({ pushes, pulls }),
  };
}

/** 32 случайных байта в base64url — сырой ключ аккаунта, общий у устройств. */
export function randomRawKey(): string {
  const bytes = new Uint8Array(32);
  for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
  return Buffer.from(bytes).toString('base64url');
}
