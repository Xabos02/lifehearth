// Облачная резервная копия аккаунта (E2E). Полный снапшот всех данных
// (шире дельта-синка: включает семейный чат/задачи) шифруется аккаунтным
// ключом НА устройстве и кладётся на Worker. Сервер видит только шифротекст.
// Модель latest-only: одна копия на аккаунт, при необходимости — чанками.

import { exportBackup, validateBackup, type BackupFile } from '../db/backup';
import { encryptJSON, decryptJSON } from './crypto';
import { getSyncConfig } from './syncState';
import type { SyncConfig } from '../db/types';

import { WORKER_URL } from './workerUrl';

// Порог чанка по plaintext-байтам. D1: значение одной колонки ≤ 2 МБ, а
// base64url-шифротекст раздувает объём ~на треть — держим консервативно.
const CHUNK_BYTES = 1_000_000;

function authHeaders(c: SyncConfig): Record<string, string> {
  return {
    'X-Account': c.accountId,
    Authorization: `Bearer ${c.authToken}`,
    'Content-Type': 'application/json',
  };
}

/** Режем строку на куски ≤ maxBytes в UTF-8, не разрывая code point. */
function chunkByBytes(s: string, maxBytes: number): string[] {
  const bytes = new TextEncoder().encode(s);
  const dec = new TextDecoder();
  const out: string[] = [];
  let start = 0;
  while (start < bytes.length) {
    let end = Math.min(bytes.length, start + maxBytes);
    // 0x80–0xBF — continuation-байт: отступаем к началу code point.
    while (end < bytes.length && (bytes[end] & 0xc0) === 0x80) end--;
    out.push(dec.decode(bytes.subarray(start, end)));
    start = end;
  }
  return out;
}

/** Таблицы, которых НЕТ в дельта-синке (SYNCED_TABLES в lib/sync.ts): история
 *  цикла и семейный чат. Они существуют ровно в одном экземпляре — на том
 *  устройстве, где их вводили, — и облачная копия для них единственный способ
 *  пережить потерю телефона. Именно их и нельзя потерять при перезаписи. */
const UNSYNCED_TABLES = [
  'cycleDays',
  'cycleOverrides',
  'cycleEpisodes',
  'cycleSettings',
  'cycleSymptoms',
  'cyclePredictions',
  'familyMessages',
  'familyTasks',
  'familyMembers',
] as const;

/** Копия в облаке содержит то, чего нет на этом устройстве. */
export class BackupWouldLoseDataError extends Error {
  readonly losing: { table: string; had: number; now: number }[];
  readonly remoteDate: string | null;
  constructor(losing: { table: string; had: number; now: number }[], remoteDate: string | null) {
    super('Копия в облаке полнее, чем данные на этом устройстве');
    this.name = 'BackupWouldLoseDataError';
    this.losing = losing;
    this.remoteDate = remoteDate;
  }
}

function counts(f: BackupFile): Record<string, number> {
  const out: Record<string, number> = {};
  for (const t of UNSYNCED_TABLES) out[t] = f.data[t]?.length ?? 0;
  return out;
}

/** Загрузить зашифрованный снапшот аккаунта в облако. Возвращает число чанков
 *  (0 — если синхронизация не включена: без аккаунтного ключа копии нет).
 *
 *  ПОЧЕМУ СНАЧАЛА ЧИТАЕМ. Хранение latest-only: /backup/put стирает прежнюю
 *  копию и кладёт новую. А отметка «копия создана» лежит в settings, которые
 *  между устройствами НЕ синхронизируются, — значит на втором телефоне в
 *  настройках всегда горит «копию ещё не делали», даже когда она есть.
 *  Человек жмёт «Сохранить сейчас» (или включает автокопию), и полная копия с
 *  основного устройства заменяется снапшотом без истории цикла и без старой
 *  переписки. Восстановить неоткуда: дельта-синк эти таблицы не возит, а
 *  сервер чата чистит сообщения старше полугода.
 *
 *  Поэтому перед записью скачиваем существующую копию и сверяем по таблицам,
 *  которых нет в синке. Стало меньше — не пишем, а рассказываем. force —
 *  осознанное «да, всё равно заменить». */
export async function pushAccountSnapshot(force = false): Promise<number> {
  const c = await getSyncConfig();
  if (!c?.enabled) return 0;
  const snapshot = await exportBackup();

  const nowCounts = counts(snapshot);

  if (!force) {
    // Сверяемся с МАНИФЕСТОМ — несколькими числами о содержимом копии, — а не
    // скачиваем её целиком.
    //
    // Раньше для этой проверки качалась вся копия, и ошибка скачивания
    // означала «пиши так»: чем больше копия, тем вероятнее было, что
    // скачивание упадёт по памяти или таймауту, и тем вероятнее защита
    // отключалась ровно тогда, когда была нужна. Манифест маленький, его
    // получение не зависит от объёма данных.
    //
    // Копия, снятая прежней версией, манифеста не имеет — для неё остаётся
    // старый путь со скачиванием.
    const meta = await fetchMeta(c).catch(() => null);
    const remoteCounts = meta?.manifest
      ? await decryptJSON<Record<string, number>>(c.key, meta.manifest).catch(() => null)
      : null;

    if (remoteCounts) {
      const losing = UNSYNCED_TABLES.filter((t) => (remoteCounts[t] ?? 0) > nowCounts[t]).map((t) => ({
        table: t,
        had: remoteCounts[t] ?? 0,
        now: nowCounts[t],
      }));
      if (losing.length) throw new BackupWouldLoseDataError(losing, meta?.updatedAt ?? null);
    } else if (meta?.total) {
      // Манифеста нет, но копия есть: старый путь — скачать и сверить.
      const got = await fetchRemote(c).catch(() => null);
      const remote = got?.file ?? null;
      if (remote) {
        const was = counts(remote);
        const losing = UNSYNCED_TABLES.filter((t) => was[t] > nowCounts[t]).map((t) => ({
          table: t,
          had: was[t],
          now: nowCounts[t],
        }));
        if (losing.length) throw new BackupWouldLoseDataError(losing, got?.updatedAt ?? null);
      }
    }
  }

  const parts = chunkByBytes(JSON.stringify(snapshot), CHUNK_BYTES);
  const chunks = await Promise.all(
    parts.map(async (p, i) => ({ chunk: i, ciphertext: await encryptJSON(c.key, p) })),
  );
  const res = await fetch(`${WORKER_URL}/backup/put`, {
    method: 'POST',
    headers: authHeaders(c),
    body: JSON.stringify({
      chunks,
      total: chunks.length,
      // Манифест шифруется тем же ключом: серверу видны только числа под
      // шифром, как и всё остальное.
      manifest: await encryptJSON(c.key, nowCounts),
    }),
  });
  if (!res.ok) throw new Error(`backup put ${res.status}`);
  return chunks.length;
}

/** Сведения о копии без её скачивания: дата, число кусков и манифест. */
async function fetchMeta(
  c: SyncConfig,
): Promise<{ updatedAt: string | null; total: number; manifest: string | null }> {
  const res = await fetch(`${WORKER_URL}/backup/meta`, { headers: authHeaders(c) });
  if (!res.ok) throw new Error(`backup meta ${res.status}`);
  return (await res.json()) as { updatedAt: string | null; total: number; manifest: string | null };
}

/** Скачать, склеить и расшифровать копию. Дата — та, что помнит сервер, а не
 *  устройство: локальная отметка о копии не синхронизируется и на втором
 *  телефоне всегда пуста. */
async function fetchRemote(c: SyncConfig): Promise<{ file: BackupFile | null; updatedAt: string | null }> {
  const res = await fetch(`${WORKER_URL}/backup/get`, { headers: authHeaders(c) });
  if (!res.ok) throw new Error(`backup get ${res.status}`);
  const data = (await res.json()) as {
    chunks: { chunk: number; ciphertext: string }[];
    updatedAt: string | null;
  };
  if (!data.chunks?.length) return { file: null, updatedAt: null };
  const ordered = [...data.chunks].sort((a, b) => a.chunk - b.chunk);
  let s = '';
  for (const ch of ordered) s += await decryptJSON<string>(c.key, ch.ciphertext);
  return { file: validateBackup(JSON.parse(s)), updatedAt: data.updatedAt };
}

/** Скачать и расшифровать облачную копию. null — копии нет / синк выключен. */
export async function pullAccountSnapshot(): Promise<BackupFile | null> {
  const c = await getSyncConfig();
  if (!c?.enabled) return null;
  return (await fetchRemote(c)).file;
}

/** Когда копия в облаке обновлялась в последний раз. null — копии нет.
 *
 *  Нужно экрану настроек: отметка в settings device-local, и на втором
 *  устройстве в этом месте всегда горело «копию ещё не делали» — ровно тот
 *  текст, который толкает человека нажать «Сохранить сейчас» и затереть
 *  единственную полную копию снапшотом пустого телефона. */
export async function cloudBackupDate(): Promise<string | null> {
  const c = await getSyncConfig();
  if (!c?.enabled) return null;
  try {
    const res = await fetch(`${WORKER_URL}/backup/get`, { headers: authHeaders(c) });
    if (!res.ok) return null;
    const data = (await res.json()) as { updatedAt: string | null; chunks?: unknown[] };
    return data.chunks?.length ? data.updatedAt : null;
  } catch {
    return null;
  }
}
