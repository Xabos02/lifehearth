import type { Route } from '@playwright/test';

// Подставной сервер обмена — общий для тестов, которым нужен целый круг
// «правка → отправка → приём → экран». Настоящий сервер трогать нельзя: там
// живые данные семьи, и однажды тесты уже выжгли ему дневной лимит.
//
// Протокол повторён по воркеру: курсор — порядковый номер прихода записи на
// сервер (seq, migrations/0007), а не время правки; устройство называет себя
// в строке запроса (pull) и в теле (push) и свои записи обратно не получает,
// но курсор мимо них двигается; last-write-wins по
// updatedAt; /account/check отвечает про существование аккаунта и НЕ
// регистрирует незнакомый. Живой сигнал (/sync/ticket, сокет) тут не
// поднимается: тесты зовут runSync сами, а тикет получает 404 — как от сервера
// без этой возможности, клиент это переживает молча.

interface Rec {
  table: string;
  id: string;
  updatedAt: string;
  deletedAt: string | null;
  ciphertext: string;
}

/** Общий на оба устройства «сервер»: хранит шифротексты и отдаёт дельту. */
export function makeServer(opts: { accountExists?: boolean } = {}) {
  const rows = new Map<string, Rec & { seq: number; device: string }>();
  const keyOf = (r: Rec) => `${r.table}:${r.id}`;
  let seq = 0;
  let pushes = 0;
  let pulls = 0;

  const handle = async (route: Route) => {
    const req = route.request();
    const url = new URL(req.url());

    if (url.pathname === '/sync/push') {
      pushes++;
      const body = JSON.parse(req.postData() ?? '{}') as { records?: Rec[]; device?: string };
      const device = body.device ?? '';
      for (const r of body.records ?? []) {
        const prev = rows.get(keyOf(r));
        // Тот же ON CONFLICT, что у воркера: побеждает более свежая правка, и
        // она получает следующий номер — по нему её и прочитают остальные.
        if (!prev || r.updatedAt > prev.updatedAt) rows.set(keyOf(r), { ...r, seq: ++seq, device });
      }
      return route.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' });
    }

    if (url.pathname === '/sync/pull') {
      pulls++;
      const after = Number(url.searchParams.get('after') ?? '0') || 0;
      const device = url.searchParams.get('device') ?? '';
      const scanned = [...rows.values()].filter((r) => r.seq > after).sort((a, b) => a.seq - b.seq);
      const out = scanned.filter((r) => !device || r.device !== device);
      const last = scanned[scanned.length - 1];
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          records: out.map((r) => ({
            table: r.table,
            id: r.id,
            updatedAt: r.updatedAt,
            deletedAt: r.deletedAt,
            ciphertext: r.ciphertext,
          })),
          hasMore: false,
          nextAfter: last ? last.seq : after,
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
