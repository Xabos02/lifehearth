// Движок E2E-синхронизации: pull (получить чужие изменения, расшифровать,
// применить по принципу «новейший побеждает») + push (зашифровать свои свежие
// изменения и отправить). Содержимое шифруется на устройстве; на Worker уходит
// только шифротекст + служебные поля.
//
// Когда запускается: при старте, возврате в приложение, раз в минуту (запасной
// путь), через DEBOUNCE_MS после своей правки, перед уходом в фон и — главное
// — по сигналу сервера о чужой правке (lib/syncLive.ts): чужое появляется
// через секунды, а не на следующем опросе.

import type { IndexableType, Table } from 'dexie';
import { db } from '../db/db';
import type { SyncConfig } from '../db/types';
import {
  encryptJSON,
  decryptJSON,
  generateKey,
  exportKeyRaw,
  importKeyRaw,
  newAccountId,
  randomToken,
  encodePairing,
  decodePairing,
  encodeMeet,
  decodeMeet,
  generateBoxKeyPair,
  exportBoxPublic,
  exportBoxPrivate,
  importBoxPublic,
  importBoxPrivate,
  sealFor,
  openFrom,
  type PairingData,
} from './crypto';
import { t } from './i18n';
import { reconcileIncomingReminder } from './push';
import { getSyncConfig, patchSyncConfig, saveSyncConfig, clearSyncConfig } from './syncState';

// Адрес живёт в lib/workerUrl.ts — одна точка на всё приложение. Отсюда он
// ре-экспортируется, потому что на него уже ссылается клиент AI-прокси
// (lib/ai/aiClient.ts) и ломать его импорт незачем.
export { WORKER_URL } from './workerUrl';
import { WORKER_URL } from './workerUrl';
import { hasConsent } from './consent';
const PUSH_CHUNK = 200;
// Потолок пачки по объёму — по той же причине, что и на приёме: двести кусков
// вложений в одном теле запроса это сто мегабайт, которые не уйдут никогда.
const PUSH_MAX_BYTES = 3 * 1024 * 1024;
// Потолок ОДНОЙ записи. На сервере шифротекст ложится в колонку D1, а там
// значение не больше 2 МБ. Запись крупнее сервер не примет никогда: пачка
// падает целиком, клиент роняет цикл, курсор не двигается — и на следующем
// круге всё повторяется. Синхронизация встаёт насовсем, причём молча.
//
// Сейчас так может выйти у задачи: фотографии лежат прямо в её строке, и
// десяток снимков перерастает лимит. Пока снимки не переехали в отдельную
// таблицу чанками, такую запись просто не отправляем: она остаётся на
// устройстве, а обмен продолжает работать. Про пропуск честно сообщаем.
const RECORD_MAX_BYTES = 1_600_000;
// Потолок тела для fetch с keepalive: браузер даёт 64 КиБ на все такие
// запросы разом, больше — отказ ещё до отправки.
const KEEPALIVE_MAX_BYTES = 60_000;
/** Записи, применённые с сервера и ещё не вышедшие из окна отправки:
 *  «таблица:id» → updatedAt. См. push (эхо). В памяти: после перезагрузки
 *  одно лишнее эхо безвредно — сервер его отвергнет. */
const remoteApplied = new Map<string, string>();

// Таблицы, которые синхронизируются. settings (device-local) и sync (секреты)
// сюда НЕ входят намеренно. Включены legacy habits/metrics (пустые) — безвредно.
const SYNCED_TABLES = [
  'projects',
  'tasks',
  'goals',
  'habits',
  'habitLogs',
  'notes',
  'noteFiles',
  'noteFolders',
  'learningItems',
  'learningLogs',
  'learningParts',
  'expenseItems',
  'savingsGoals',
  'savingsDeposits',
  'energyItems',
  'energyLogs',
  'placeItems',
  'metrics',
  'metricLogs',
  'reminderSections',
  'reminderItems',
  'taskPhotos',
  'taskFiles',
  'workouts',
  'exerciseDefs',
  'workoutTemplates',
] as const;
type SyncedTable = (typeof SYNCED_TABLES)[number];
const isSynced = (t: string): t is SyncedTable => (SYNCED_TABLES as readonly string[]).includes(t);

interface RemoteRecord {
  table: string;
  id: string;
  updatedAt: string;
  deletedAt: string | null;
  ciphertext: string;
}

type Row = Record<string, unknown> & { id: string; updatedAt: string; deletedAt: string | null };

// Полезная нагрузка записи familyShare: семейное подключение, реплицируемое
// между устройствами ОДНОГО аккаунта. Ключ семьи — в сыром base64url виде,
// но только внутри шифротекста аккаунтного ключа.
interface FamilySharePayload {
  familyId: string;
  familyToken: string;
  keyRaw: string;
  familyName: string;
  selfMemberId: string;
  joinedAt: string;
  enabled: boolean;
  updatedAt: string;
  // Всё, что связано с исключением участников. Без этого второе устройство
  // после смены ключа группы читало бы старую переписку, но не новую, а с
  // потерей ownerSecret владелец перестал бы быть владельцем.
  keyEpoch?: number;
  keysRaw?: Record<string, string>;
  boxPub?: string;
  boxPriv?: string;
  ownerSecret?: string;
  ownerMemberId?: string;
}

/** Связка ключей из сырых значений синка. Общая для «группы ещё нет» и
 *  «группа есть, ключ сменился» — оба пути раскладывают её одинаково. */
async function keyRingFrom(p: FamilySharePayload, current: CryptoKey): Promise<Record<string, CryptoKey>> {
  const ring: Record<string, CryptoKey> = {};
  for (const [e, raw] of Object.entries(p.keysRaw ?? {})) ring[e] = await importKeyRaw(raw);
  ring[String(p.keyEpoch ?? 0)] = current;
  return ring;
}

/** Применять ли удалённую правку: если локальной нет или удалённая новее (LWW). */
export function shouldApply(localUpdatedAt: string | undefined, remoteUpdatedAt: string): boolean {
  return !localUpdatedAt || remoteUpdatedAt > localUpdatedAt;
}

export function authHeaders(c: SyncConfig): Record<string, string> {
  return {
    'X-Account': c.accountId,
    Authorization: `Bearer ${c.authToken}`,
    'Content-Type': 'application/json',
  };
}

// Имя устройства для сервера: по нему сервер не отдаёт устройству его же
// записи и не будит его же сокет. Едет в строке запроса и в теле, а НЕ
// заголовком: новый заголовок — новый preflight, и приложение, обновившееся
// раньше сервера, ломалось бы целиком вместо того, чтобы работать по-старому.
//
// Выдаётся один раз и живёт с конфигом. Первый обмен после обновления зовёт
// это сразу из двух мест (круг обмена и живое соединение) — выдача общая,
// иначе у устройства оказалось бы два имени.
let deviceIdInFlight: Promise<string> | null = null;
let knownDeviceId = '';

export async function ensureDeviceId(c: SyncConfig): Promise<SyncConfig> {
  if (c.deviceId) {
    knownDeviceId = c.deviceId;
    return c;
  }
  deviceIdInFlight ??= (async () => {
    const fresh = await getSyncConfig();
    if (fresh?.deviceId) return fresh.deviceId;
    const deviceId = randomToken(12);
    await patchSyncConfig({ deviceId });
    return deviceId;
  })();
  try {
    const deviceId = await deviceIdInFlight;
    knownDeviceId = deviceId;
    return { ...c, deviceId };
  } finally {
    deviceIdInFlight = null;
  }
}

/** Имя этого устройства, каким его знает сервер, — для фильтра сигналов о
 *  своих же правках. Пусто до первого обмена. */
export function currentDeviceId(): string {
  return knownDeviceId;
}

// === PULL ===

/**
 * Сбой ОТНОСИТСЯ К САМОЙ ЗАПИСИ (её можно пропустить и идти дальше), а не к
 * хранилищу? Битый шифротекст, не-JSON внутри, испорченный base64 — запись
 * «ядовитая», следующие к ней отношения не имеют. А вот QuotaExceededError,
 * DatabaseClosedError и прочие сбои IndexedDB означают, что не применится
 * НИЧЕГО: их надо пробросить, чтобы цикл упал и курсор не уехал вперёд по
 * записям, которые на самом деле не записаны.
 */
function isPoisonRecord(e: unknown): boolean {
  const name = (e as { name?: string } | null)?.name ?? '';
  return name === 'OperationError' || name === 'SyntaxError' || name === 'InvalidCharacterError' || name === 'DataError';
}

/**
 * Конфликты по уникальным индексам.
 *
 * У части таблиц есть уникальные индексы: &[habitId+date] у отметок привычек,
 * &date у отметок энергии — они держат правило «одна отметка в день» на уровне
 * базы. При этом id генерируются случайно на каждом устройстве. Отметил
 * привычку (или уровень энергии) за один день на маке и на телефоне до
 * обмена — получаются две строки с разными id и одинаковым ключом, и put
 * входящей падает с ConstraintError.
 *
 * А ConstraintError не считается «ядовитой записью», значит pullPage бросает
 * его дальше и курсор lastPullSeq не двигается. Синхронизация встаёт НАВСЕГДА и
 * молча — вместе с задачами, заметками, целями и финансами. Именно так и было
 * с energyLogs: разрешение конфликта написали под habitLogs поимённо, а вторую
 * таблицу с уникальным индексом просто забыли.
 *
 * Поэтому идём не по списку таблиц, а по схеме: спрашиваем у Dexie, какие
 * индексы объявлены уникальными, и разрешаем каждый по LWW — как везде в
 * синке. Новая таблица с уникальным индексом попадает сюда сама, без правок.
 *
 * Возвращает false, если побеждает локальная запись и писать не нужно.
 */
async function resolveUniqueConflicts(table: Table<Row>, obj: Row): Promise<boolean> {
  for (const idx of table.schema.indexes) {
    if (!idx.unique) continue;
    const keys = Array.isArray(idx.keyPath) ? idx.keyPath : [idx.keyPath as string];
    const values = keys.map((k) => obj[k]);
    // Пустое значение в ключе индекса не индексируется — конфликтовать нечему.
    if (values.some((v) => v === undefined || v === null || v === '')) continue;
    const dup = await table
      .where(idx.name)
      .equals(idx.compound ? (values as IndexableType) : (values[0] as IndexableType))
      .first();
    if (!dup || dup.id === obj.id) continue;
    if (obj.updatedAt > (dup.updatedAt ?? '')) {
      await table.delete(dup.id); // входящая свежее — снимаем локальный дубль
      continue;
    }
    return false; // локальная запись свежее — входящую игнорируем
  }
  return true;
}

/** Применить одну входящую запись. true — если что-то записано локально. */
async function applyRecord(c: SyncConfig, r: RemoteRecord): Promise<boolean> {
  // Семейное подключение с другого МОЕГО устройства: восстанавливаем конфиг
  // (ключ/токен зашифрованы аккаунтным ключом). Курсоры чтения — свои,
  // с нуля: бэкфилл комнаты доберёт историю. FamilyRunner увидит новую
  // группу через liveQuery и сам поднимет соединение.
  if (r.table === 'familyShare') {
    const p = await decryptJSON<FamilySharePayload>(c.key, r.ciphertext);
    const local = await db.family.get(p.familyId);
    const key = await importKeyRaw(p.keyRaw);
    if (!local) {
      await db.family.put({
        id: p.familyId,
        familyId: p.familyId,
        familyToken: p.familyToken,
        familyKey: key,
        familyName: p.familyName,
        selfMemberId: p.selfMemberId,
        lastSeq: 0,
        lastReadSeq: 0,
        enabled: p.enabled,
        joinedAt: p.joinedAt,
        updatedAt: p.updatedAt,
        keyEpoch: p.keyEpoch ?? 0,
        keyRing: await keyRingFrom(p, key),
        boxPub: p.boxPub,
        boxPriv: p.boxPriv,
        ownerSecret: p.ownerSecret,
        ownerMemberId: p.ownerMemberId,
      });
      return true;
    }
    if (shouldApply(local.updatedAt, p.updatedAt)) {
      await db.family.update(p.familyId, {
        familyToken: p.familyToken,
        familyName: p.familyName,
        enabled: p.enabled,
        updatedAt: p.updatedAt,
        // Ключ забираем, только если пришла эпоха новее: два устройства
        // одного человека могут разойтись, и откат на прежний ключ сделал бы
        // свежую переписку нечитаемой.
        ...((p.keyEpoch ?? 0) > (local.keyEpoch ?? 0)
          ? { familyKey: key, keyEpoch: p.keyEpoch ?? 0, keyRing: { ...(local.keyRing ?? {}), ...(await keyRingFrom(p, key)) } }
          : {}),
        ...(local.ownerSecret ? {} : { ownerSecret: p.ownerSecret }),
        ...(local.ownerMemberId ? {} : { ownerMemberId: p.ownerMemberId }),
      });
      return true;
    }
    return false;
  }
  if (!isSynced(r.table)) return false; // незнакомая таблица — пропускаем
  const table = db.table<Row>(r.table);
  const local = await table.get(r.id);
  if (!shouldApply(local?.updatedAt, r.updatedAt)) return false;
  const obj = await decryptJSON<Row>(c.key, r.ciphertext);
  if (!(await resolveUniqueConflicts(table, obj))) return false;
  // Пишем НАПРЯМУЮ (минуя repo) — сохраняем серверный updatedAt, иначе синк
  // зациклится (repo проставил бы новый updatedAt → бесконечный пинг-понг).
  await table.put(obj);
  return true;
}

async function pullPage(
  c: SyncConfig,
  after: number,
): Promise<{ applied: number; skipped: number; nextAfter: number; hasMore: boolean }> {
  const device = c.deviceId ? `&device=${encodeURIComponent(c.deviceId)}` : '';
  // Прежний курсор по времени едет рядом с новым — для сервера, который ещё
  // не обновился (или откатился): он читает только since. Без него такой
  // сервер отдавал бы всю историю на каждом опросе, пока не выкатится.
  const since = `&since=${encodeURIComponent(c.lastPullAt ?? '')}`;
  const res = await fetch(`${WORKER_URL}/sync/pull?after=${after}${device}${since}`, {
    headers: authHeaders(c),
  });
  if (!res.ok) throw new Error(`pull ${res.status}`);
  const data = (await res.json()) as {
    records: RemoteRecord[];
    hasMore: boolean;
    nextAfter?: number;
    nextSince?: string;
  };
  let applied = 0;
  let skipped = 0;

  // Расшифровка — ВНЕ транзакции, запись — в ОДНОЙ.
  //
  // Раньше каждая запись применялась сама по себе, и каждая будила подписки
  // экранов. Страница — это до пятисот записей: после релиза, добавившего
  // таблицу в обмен, приложение перечитывает всю историю и получает сотни
  // перерисовок подряд. На телефоне это выглядит как зависший экран.
  //
  // Транзакция Dexie не переживает ожидания не-Dexie операций, а расшифровка
  // как раз такая. Поэтому сначала разбираем всю страницу, потом пишем пачкой —
  // тот же приём, что в семейном чате (family/familyChat.ts, applyBatch).
  const decoded: { r: RemoteRecord; obj: Row }[] = [];
  for (const r of data.records) {
    // Записи семейных подключений применяются особо (импорт ключей — тоже
    // ожидание не-Dexie), поэтому идут прежним путём, по одной.
    if (r.table === 'familyShare') {
      try {
        if (await applyRecord(c, r)) applied++;
      } catch (e) {
        if (!isPoisonRecord(e)) throw e;
        skipped++;
        console.warn(`sync: пропущена запись ${r.table}/${r.id}`, e);
      }
      continue;
    }
    if (!isSynced(r.table)) continue; // незнакомая таблица — пропускаем
    // Сбой на ОДНОЙ «ядовитой» записи (битый шифротекст, не-JSON внутри) не
    // должен ронять весь цикл: иначе курсор lastPullSeq не сдвинется и синк
    // встанет навсегда — перестанут приходить и задачи, и заметки, и семья.
    try {
      decoded.push({ r, obj: await decryptJSON<Row>(c.key, r.ciphertext) });
    } catch (e) {
      if (!isPoisonRecord(e)) throw e;
      skipped++;
      console.warn(`sync: пропущена запись ${r.table}/${r.id}`, e);
    }
  }

  // Задачи, пришедшие с другого устройства, — их напоминание сводится после
  // транзакции: внутри неё сетевой запрос оборвал бы транзакцию Dexie.
  const taskChanges: { before: Row | undefined; after: Row }[] = [];
  if (decoded.length) {
    const tables = [...new Set(decoded.map((d) => d.r.table))].map((name) => db.table(name));
    // Сбой ХРАНИЛИЩА пропускать нельзя: там не применится ничего, и сдвинутый
    // курсор увёл бы за собой записи, которые не записаны. Поэтому ошибка
    // транзакции летит наружу, как и раньше.
    await db.transaction('rw', tables, async () => {
      for (const { r, obj } of decoded) {
        const table = db.table<Row>(r.table);
        const local = await table.get(r.id);
        if (!shouldApply(local?.updatedAt, r.updatedAt)) continue;
        if (!(await resolveUniqueConflicts(table, obj))) continue;
        // Пишем НАПРЯМУЮ (минуя repo) — сохраняем серверный updatedAt, иначе
        // синк зациклится (repo проставил бы новый updatedAt).
        await table.put(obj);
        remoteApplied.set(`${r.table}:${r.id}`, r.updatedAt);
        applied++;
        if (r.table === 'tasks') taskChanges.push({ before: local, after: obj });
      }
    });
  }
  for (const { before, after } of taskChanges) {
    void reconcileIncomingReminder(before as never, after as never).catch(() => {});
  }

  // Сервер без нового курсора (ещё не обновился) nextAfter не отдаёт — тогда
  // по seq стоим на месте, а двигаем прежний курсор по времени: он ответил
  // по-старому, и ходить к нему надо по-старому, пока не обновится.
  const legacy = typeof data.nextAfter !== 'number' || !Number.isFinite(data.nextAfter);
  if (legacy && typeof data.nextSince === 'string') {
    await patchSyncConfig({ lastPullAt: data.nextSince }, c.accountId);
    c.lastPullAt = data.nextSince;
    return { applied, skipped, nextAfter: after, hasMore: Boolean(data.hasMore) };
  }
  const nextAfter = legacy ? after : (data.nextAfter as number);
  return { applied, skipped, nextAfter, hasMore: data.hasMore && nextAfter > after };
}

/** Курсор pull двигается вперёд, а сервер отдаёт только то, что за ним.
 *  Значит запись, пропущенную как «незнакомая таблица», уже не переспросить:
 *  курсор ушёл вперёд вместе со всей страницей.
 *
 *  Так и терялись данные при обновлении. Второй телефон на старом бандле
 *  получал папки заметок и цели-копилок, не знал таких таблиц, пропускал их
 *  через continue — но курсор всё равно сдвигал. После обновления
 *  приложения эти записи не приходили уже никогда, и причина ниоткуда не
 *  видна: на сервере всё цело, на одном устройстве есть, на другом нет.
 *
 *  Поэтому запоминаем набор таблиц, который знала двигавшая курсор версия.
 *  Появились новые — один раз переспрашиваем всё с начала. Полный ре-pull
 *  безопасен: запись применяется только если она свежее локальной. */
async function rewindIfTablesGrew(c: SyncConfig): Promise<number> {
  const known = c.knownTables;
  const now = [...SYNCED_TABLES];
  if (known && now.every((t) => known.includes(t))) return c.lastPullSeq ?? 0;
  // Поля ещё нет — значит курсор двигала версия ДО этой защиты, и что она
  // умела, мы не знаем. Раз не знаем — считаем, что могли пропустить, и
  // перечитываем. Пропустить этот случай было бы бессмысленно: именно этот
  // релиз и добавляет таблицы, из-за которых всё затевалось.
  //
  // Цена — один полный pull истории аккаунта, единожды. Для личных объёмов
  // это секунды, и он безопасен: запись применяется, только если свежее
  // локальной.
  await patchSyncConfig({ knownTables: now, lastPullSeq: 0 }, c.accountId);
  return 0;
}

/** Сколько курсору позволено обгонять часы устройства, прежде чем считать его
 *  сломанным. Секунды набегают законно — расхождение часов между телефоном и
 *  ноутбуком, задержка сети. Сутки — уже не расхождение. */
const CURSOR_FUTURE_TOLERANCE_MS = 24 * 60 * 60 * 1000;

/** Курсор отправки, уехавший в будущее, чинится сам.
 *
 *  Часы устройства отъехали назад — и новые правки получают штамп МЕНЬШЕ
 *  курсора, то есть не попадают в окно отправки никогда. Молча: ошибки нет,
 *  обмен «успешен», данные просто не уезжают.
 *
 *  Лечение: сбросить курсор и переотправить с начала. Это безопасно — сервер
 *  принимает запись, только если она свежее его копии. Цена — один полный
 *  круг, единожды.
 *
 *  Курсор приёма той же болезнью болел зеркально — пока был меткой времени
 *  с чужих часов. Теперь это порядковый номер, который ставит сервер, и
 *  чинить там нечего. */
export function cursorFromFuture(cursor: string, now: number): boolean {
  if (!cursor) return false;
  // Прежний курсор приёма был составным «updatedAt|id» — разбираем и такой.
  const at = Date.parse(cursor.split('|')[0]);
  return Number.isFinite(at) && at > now + CURSOR_FUTURE_TOLERANCE_MS;
}

/** Курсор приёма — порядковый номер прихода записи на сервер.
 *
 *  Раньше это была метка времени правки, а её ставит устройство-автор по
 *  своим часам. Стоило записи прийти на сервер позже, чем другая, более
 *  свежая по метке, — телефон создал задачу без сети и отправил через час,
 *  часы двух устройств разошлись на секунды, — и для всех, кто ту свежую уже
 *  получил, эта запись становилась невидимой навсегда: сервер честно отвечал
 *  «новее ничего нет». На сервере цела, на одном устройстве есть, на другом
 *  нет. Так задачи, заведённые ночью на телефоне, не доезжали до мака.
 *
 *  Номер ставит сервер в момент прихода: что пришло позже, то и читается
 *  позже, часы устройств ни при чём. */
async function pull(c: SyncConfig): Promise<{ applied: number; skipped: number }> {
  let applied = 0;
  let skipped = 0;
  let after = await rewindIfTablesGrew(c);
  for (;;) {
    const page = await pullPage(c, after);
    applied += page.applied;
    skipped += page.skipped;
    after = page.nextAfter;
    // Курсор двигаем ПОСТРАНИЧНО, а не после всего цикла. Иначе обрыв на
    // середине (закрыли вкладку, пропала сеть) стирает весь прогресс, и
    // следующий заход начинает с начала. На полном перечитывании истории —
    // а оно случается после каждого релиза, добавившего таблицу в обмен, —
    // телефон может не досидеть до конца НИКОГДА и качать одно и то же.
    //
    // Безопасно по той же причине, что и сам ре-pull: запись применяется,
    // только если свежее локальной, так что повтор ничего не портит.
    await patchSyncConfig({ lastPullSeq: after }, c.accountId);
    if (!page.hasMore) break;
  }
  return { applied, skipped };
}

// === PUSH ===
// Выборка по индексу updatedAt в окне [lastPushAt, cutoff).
//
// Раньше здесь был полный скан каждой из двадцати таблиц с фильтром в памяти.
// Среди них noteFiles — куски вложений по 400 КиБ — и tasks с фотографиями
// прямо в строке, а запускается отправка через полторы секунды после каждой
// правки: пока пишешь заметку, на каждую паузу поднималась вся база. Индекс
// добавлен в v19.
async function push(c: SyncConfig): Promise<{ pushed: number; oversized: number }> {
  // Курсор снимаем ДО скана и двигаем ровно на него — а НЕ на максимум
  // updatedAt среди найденных строк. Иначе правка, сделанная во время скана в
  // уже прочитанную таблицу, получает штамп МЕНЬШЕ нового курсора и не уедет
  // в облако никогда (фильтр следующего цикла её отбросит). Верхняя граница
  // окна отсекает всё, что записано после снятия курсора, — оно уедет
  // следующим циклом.
  const cutoff = new Date().toISOString();
  // Курсор отправки из будущего — часы устройства отъехали назад. Всё, что
  // человек написал после этого, оказывается «старее» курсора и не уезжает
  // никогда. Отправляем с начала: сервер разберётся по времени правки.
  const from = cursorFromFuture(c.lastPushAt, Date.now()) ? '' : c.lastPushAt;
  if (from !== c.lastPushAt) {
    console.warn(`sync: курсор отправки из будущего (${c.lastPushAt}) — отправляем с начала`);
  }
  // Окно ПОЛУОТКРЫТОЕ: [lastPushAt, cutoff). Верхняя граница строгая, иначе
  // запись, созданная в ту же миллисекунду, что и cutoff, но уже после его
  // снятия, не попадёт ни в это окно (её ещё нет в базе), ни в следующее
  // (фильтр там строго больше cutoff). Нижняя граница включающая — она лишь
  // переотправит одну пограничную запись, что безвредно: на сервере стоит
  // ON CONFLICT ... WHERE excluded.updated_at > records.updated_at.
  const fresh: { name: string; row: Row }[] = [];
  for (const name of SYNCED_TABLES) {
    // between(lower, upper, includeLower, includeUpper) — то же полуоткрытое
    // окно, что и раньше, только границы теперь считает база.
    const rows = await db
      .table<Row>(name)
      .where('updatedAt')
      .between(from, cutoff, true, false)
      .toArray();
    for (const row of rows) {
      // Эхо: запись, только что ПРИНЯТАЯ с сервера, по метке времени попадает
      // в окно отправки (её updatedAt — время чужой правки, а оно позже
      // нашего прошлого круга) и уезжала бы обратно целиком — с фотографиями
      // по сотням килобайт, — чтобы сервер её отверг как не более свежую.
      // Та же строка с той же меткой = та, что пришла; правленная получает
      // новую метку и едет как положено.
      if (remoteApplied.get(`${name}:${row.id}`) === row.updatedAt) continue;
      fresh.push({ name, row });
    }
  }
  // Шифруем параллельно (Promise.all), а не последовательно await в цикле —
  // не блокирует main-thread при правке задачи с большим набором изменений.
  const out: RemoteRecord[] = await Promise.all(
    fresh.map(async ({ name, row }) => ({
      table: name,
      id: row.id,
      updatedAt: row.updatedAt,
      deletedAt: row.deletedAt ?? null,
      ciphertext: await encryptJSON(c.key, row),
    })),
  );
  // Семейные подключения — на другие МОИ устройства (ключ семьи внутри
  // шифротекста аккаунтного ключа; серверу, как и всё остальное, не виден).
  //
  // Здесь окно считается в памяти, а не запросом по индексу, как у таблиц выше:
  // у `family` индекса по updatedAt нет, а строк в ней столько же, сколько у
  // человека семейных групп — одна-две. Индекс ради этого не нужен, а вот
  // отбор нужен: без него отправлялись бы все подключения при каждом пуше.
  const famFresh = (await db.family.toArray()).filter(
    (f) => typeof f.updatedAt === 'string' && f.updatedAt >= from && f.updatedAt < cutoff,
  );
  for (const f of famFresh) {
    const keysRaw: Record<string, string> = {};
    for (const [e, k] of Object.entries(f.keyRing ?? {})) keysRaw[e] = await exportKeyRaw(k);
    const payload: FamilySharePayload = {
      familyId: f.familyId,
      familyToken: f.familyToken,
      keyRaw: await exportKeyRaw(f.familyKey),
      familyName: f.familyName,
      selfMemberId: f.selfMemberId,
      joinedAt: f.joinedAt,
      enabled: f.enabled,
      updatedAt: f.updatedAt!,
      keyEpoch: f.keyEpoch ?? 0,
      keysRaw,
      boxPub: f.boxPub,
      boxPriv: f.boxPriv,
      ownerSecret: f.ownerSecret,
      ownerMemberId: f.ownerMemberId,
    };
    out.push({
      table: 'familyShare',
      id: f.familyId,
      updatedAt: f.updatedAt!,
      deletedAt: null,
      ciphertext: await encryptJSON(c.key, payload),
    });
  }
  // Отсев неподъёмных. Считаем по шифротексту — именно он ложится в колонку.
  const sendable = out.filter((r) => r.ciphertext.length <= RECORD_MAX_BYTES);
  const oversized = out.length - sendable.length;
  if (oversized > 0) {
    await noteOversized(oversized);
    console.warn(`sync: пропущено записей, слишком больших для сервера: ${oversized}`);
  } else {
    await noteOversized(0);
  }

  for (const batch of batchByBytes(sendable)) {
    const body = JSON.stringify({ records: batch, ...(c.deviceId ? { device: c.deviceId } : {}) });
    const res = await fetch(`${WORKER_URL}/sync/push`, {
      method: 'POST',
      headers: authHeaders(c),
      body,
      // Отправка перед сворачиванием (см. flushSyncNow): keepalive доносит
      // запрос, даже если страница уже ушла в фон. Браузер держит для таких
      // запросов 64 КиБ на всё — пачку крупнее шлём обычным путём.
      keepalive: body.length < KEEPALIVE_MAX_BYTES,
    });
    if (!res.ok) throw new Error(`push ${res.status}`);
  }
  await patchSyncConfig({ lastPushAt: cutoff }, c.accountId);
  // Принятое до этой отсечки в окно отправки больше не попадёт — забываем.
  for (const [key, at] of remoteApplied) if (at < cutoff) remoteApplied.delete(key);
  return { pushed: sendable.length, oversized };
}


// === Оркестрация ===
let running = false;
let lastError: string | null = null;
// Просьба прогнать ещё круг, пришедшая ПОКА круг шёл. Раньше такой вызов
// просто выходил по флагу, и правка, сделанная во время обмена (или чужая,
// о которой сообщил сокет), ждала следующего повода — до минуты. Теперь
// текущий круг дорабатывает и сразу идёт на второй.
let rerunRequested = false;
/** Сколько кругов подряд позволено одному вызову — защита от бесконечного
 *  «пока шёл, попросили ещё». Три хватает: правка → круг → чужой сигнал.
 *  Просьба, оставшаяся после третьего (или пришедшая в самом хвосте, когда
 *  круги уже кончились), не теряется — её подхватывает новый вызов. */
const MAX_ROUNDS = 3;
// Полное перечитывание попросили, пока круг шёл: сброшенные курсоры он
// перезаписал бы своими, поэтому сброс повторяется в начале его следующего
// круга (см. requestFullResync).
let resetPending = false;

/** Курсоры сброшены, имя устройства новое — сервер отдаст всё как чужое. */
const FULL_RESET = (): Partial<SyncConfig> => ({
  lastPullSeq: 0,
  lastPullAt: '',
  lastPushAt: '',
  deviceId: randomToken(12),
});

/** Перечитать и переотправить всё с начала: восстановление из копии, кнопка
 *  «Перечитать всё заново».
 *
 *  Одних курсоров мало. Сервер не отдаёт устройству его же записи (они у
 *  него есть) — но после восстановления старой копии их как раз нет: всё,
 *  что устройство само создало и удалило после снятия копии, на сервере
 *  помечено его именем и не вернулось бы никогда. Поэтому вместе с курсорами
 *  меняется имя: прежние «свои» записи становятся чужими и приходят, а LWW
 *  защищает от отката того, что свежее.
 *
 *  Идущий круг обмена перезаписал бы сброс своими курсорами — тогда сброс
 *  повторится в начале его следующего круга. */
export async function requestFullResync(): Promise<void> {
  if (running) {
    // Сброс — в начале следующего круга, а не сейчас: сейчас идущий круг
    // подхватил бы пустой курсор отправки и отправил бы всю базу, а
    // следующий круг — ещё раз.
    resetPending = true;
    rerunRequested = true;
    return;
  }
  await patchSyncConfig(FULL_RESET());
  knownDeviceId = (await getSyncConfig())?.deviceId ?? '';
}

export interface RunSyncOptions {
  /** Сначала отправить, потом получить. Для ухода в фон: на iPhone страница
   *  замирает через секунды, и приём, стоящий перед отправкой, мог бы её
   *  не дождаться. */
  pushFirst?: boolean;
}

/** Один цикл: pull → push. Возвращает null, если синк выключен или уже идёт
 *  (тогда идущий цикл, закончив, прогонит ещё один). */
export async function runSync(opts: RunSyncOptions = {}): Promise<{
  pulled: number;
  pushed: number;
  skipped: number;
  /** Записи, которые сервер не примет никогда: больше лимита колонки. */
  oversized: number;
} | null> {
  // Флаг — СРАЗУ после синхронной проверки, до первого await: если между
  // проверкой и установкой оказывается await-разрыв (раньше здесь стоял
  // getSyncConfig), второй конкурентный вызов (visibilitychange + интервал,
  // дебаунс + ручной запуск) успевает пройти проверку, и два цикла гоняют
  // курсоры lastPullSeq/lastPushAt наперегонки — последний завершившийся молча
  // перезаписывает более ранний.
  if (running) {
    rerunRequested = true;
    return null;
  }
  running = true;
  // Сбрасываем ЗДЕСЬ, до первого await, а не в начале круга: просьба может
  // прийти между этой строкой и стартом круга — и её нельзя стереть.
  rerunRequested = false;
  lastError = null;
  try {
    const first = await getSyncConfig();
    // Без согласия на внешнее — пауза (задача 34). Конфиг не трогаем: снять
    // enabled значило бы показать «Включить синхронизацию», и новый аккаунт
    // встал бы рядом со старым, ключ которого у человека сохранён. Эта строка
    // закрывает все пути обмена: раннер, дебаунс после правок, уход в фон,
    // сигнал сокета, кнопки настроек.
    if (!first || !first.enabled || !hasConsent()) return null;
    const total = { pulled: 0, pushed: 0, skipped: 0, oversized: 0 };
    let c: SyncConfig | undefined = await ensureDeviceId(first);
    for (let round = 0; round < MAX_ROUNDS && c; round++) {
      if (resetPending) {
        resetPending = false;
        await patchSyncConfig(FULL_RESET());
        c = await getSyncConfig();
        if (!c?.enabled) break;
        knownDeviceId = c.deviceId ?? '';
      }
      if (opts.pushFirst && round === 0) {
        const sent = await push(c);
        total.pushed += sent.pushed;
        total.oversized = sent.oversized;
        const after = await getSyncConfig(); // курсор push обновился
        const { applied: pulled, skipped } = after ? await pull(after) : { applied: 0, skipped: 0 };
        total.pulled += pulled;
        total.skipped += skipped;
      } else {
        const { applied: pulled, skipped } = await pull(c);
        const fresh = await getSyncConfig(); // курсор pull обновился
        const sent = fresh ? await push(fresh) : { pushed: 0, oversized: 0 };
        total.pulled += pulled;
        total.skipped += skipped;
        total.pushed += sent.pushed;
        total.oversized = sent.oversized;
      }
      if (!rerunRequested) break;
      rerunRequested = false;
      c = await getSyncConfig();
      if (!c?.enabled) break;
    }
    await patchSyncConfig({ lastSyncedAt: new Date().toISOString() });
    // Прошлая неудача больше не актуальна — снимаем отметку.
    await clearSyncFailure();
    return total;
  } catch (e) {
    lastError = String(e);
    // Фоновый цикл запускается сам и ошибку никому не показывает: раньше она
    // жила только в переменной модуля и пропадала при перезагрузке. Оставляем
    // след в настройках, чтобы экран синхронизации мог сказать честно.
    await noteSyncFailure(humanReason(e));
    throw e;
  } finally {
    running = false;
    // Просьба, пришедшая в хвосте (между последним кругом и этой строкой) или
    // оставшаяся после MAX_ROUNDS, — новым вызовом, уже вне этого. Раньше
    // флаг здесь просто стирался, и сигнал сокета откатывался к минутному
    // опросу.
    if (rerunRequested) {
      rerunRequested = false;
      setTimeout(() => void runSync().catch(() => {}), 0);
    }
  }
}

/** Сколько записей не влезает в сервер. Ноль стирает прежнюю отметку: чинить
 *  такую запись человек может только сам (убрать часть фотографий), и держать
 *  предупреждение после того, как он это сделал, было бы враньём. */
async function noteOversized(count: number): Promise<void> {
  try {
    const s = await db.settings.get('app');
    if (!s) return;
    if ((s.syncOversized ?? 0) === count) return;
    await db.settings.put({ ...s, syncOversized: count });
  } catch {
    /* негде отметить — не беда */
  }
}

/** Причина отказа человеческим языком.
 *
 *  Код ошибки сам по себе ничего не говорит тому, кто открыл экран
 *  синхронизации. А чинится всё по-разному: 401/403 — устройство отвязали или
 *  токен протух, лечится переподключением; отказ сети — ждать связи; 5xx —
 *  сервер, ждать. Раньше всё это выглядело одинаково: «последняя попытка не
 *  удалась». */
function humanReason(e: unknown): string {
  const s = String(e);
  const code = /\b(pull|push)\s+(\d{3})/.exec(s);
  if (code) {
    const status = Number(code[2]);
    if (status === 401 || status === 403)
      return t('сервер не признал это устройство — подключите его заново');
    if (status === 413) return t('запись не поместилась на сервере');
    if (status >= 500) return t('сервер отвечает ошибкой — попробуйте позже');
    return t('сервер ответил отказом ({status})', { status });
  }
  if (/Failed to fetch|NetworkError|network/i.test(s)) return t('нет связи с сервером');
  return s.replace(/^Error:\s*/, '');
}

/** Отметить неудачу обмена. Ошибки записи настроек глотаем: если уж и она не
 *  прошла, то показывать всё равно негде, а ронять цикл из-за пометки нельзя. */
async function noteSyncFailure(reason: string): Promise<void> {
  try {
    const s = await db.settings.get('app');
    if (s)
      await db.settings.put({
        ...s,
        syncFailedAt: new Date().toISOString(),
        syncFailedReason: reason,
      });
  } catch {
    /* негде отметить — не беда */
  }
}

async function clearSyncFailure(): Promise<void> {
  try {
    const s = await db.settings.get('app');
    if (s?.syncFailedAt)
      await db.settings.put({ ...s, syncFailedAt: null, syncFailedReason: null });
  } catch {
    /* негде отметить — не беда */
  }
}

/** Разбить записи на пачки: не длиннее PUSH_CHUNK и не тяжелее
 *  PUSH_MAX_BYTES. Одна запись, которая сама больше потолка, едет в
 *  собственной пачке — иначе она заблокировала бы обмен навсегда. */
export function batchByBytes(rows: RemoteRecord[]): RemoteRecord[][] {
  const out: RemoteRecord[][] = [];
  let cur: RemoteRecord[] = [];
  let bytes = 0;
  for (const r of rows) {
    const size = r.ciphertext.length;
    if (cur.length && (cur.length >= PUSH_CHUNK || bytes + size > PUSH_MAX_BYTES)) {
      out.push(cur);
      cur = [];
      bytes = 0;
    }
    cur.push(r);
    bytes += size;
  }
  if (cur.length) out.push(cur);
  return out;
}

export function syncRunning(): boolean {
  return running;
}

export function lastSyncError(): string | null {
  return lastError;
}

// Debounce-синк после правок: любая локальная запись через repo дёргает это,
// пачка изменений за DEBOUNCE_MS уходит одним синком. runSync сам выходит,
// если синк выключен, поэтому накладных для не-настроенных пользователей нет.
//
// Пауза короткая: она нужна лишь для того, чтобы серия правок подряд (набор
// текста, перестановка нескольких задач) уехала одной пачкой, а не по одной.
// Дальше сервер сам будит остальные устройства (lib/syncLive.ts), так что
// эта пауза — почти вся задержка между правкой здесь и её появлением там.
const DEBOUNCE_MS = 800;
let debounceTimer: ReturnType<typeof setTimeout> | null = null;

export function scheduleSyncSoon(): void {
  if (debounceTimer) clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => {
    debounceTimer = null;
    void runSync().catch(() => {});
  }, DEBOUNCE_MS);
}

/** Отправить накопленное сейчас, не дожидаясь паузы. Зовётся, когда
 *  приложение уходит в фон: на iPhone таймеры свёрнутого приложения не
 *  срабатывают, и правка, сделанная за секунду до блокировки экрана,
 *  оставалась на телефоне до следующего открытия — а другое устройство тем
 *  временем спрашивало, где она. */
export function flushSyncNow(): void {
  if (!debounceTimer) return;
  clearTimeout(debounceTimer);
  debounceTimer = null;
  void runSync({ pushFirst: true }).catch(() => {});
}

// === Жизненный цикл сопряжения ===

/** Создать новый аккаунт синхронизации на этом устройстве (первое устройство). */
export async function createSyncAccount(): Promise<void> {
  const key = await generateKey();
  await saveSyncConfig({
    id: 'config',
    accountId: newAccountId(),
    authToken: randomToken(),
    key,
    enabled: true,
    lastPullSeq: 0,
    lastPullAt: '',
    deviceId: randomToken(12),
    lastPushAt: '',
    lastSyncedAt: '',
  });
  await enableCloudBackup();
}

/**
 * Принимающая сторона встречи: ответить своим одноразовым ключом и забрать
 * конверт с секретами аккаунта.
 *
 * Первый ответ побеждает — сервер второго не примет. Это и есть защита от
 * того, кто подсмотрел QR: чтобы влезть, ему нужно успеть ответить раньше
 * настоящего второго устройства, стоя рядом в те же минуты, а не когда-нибудь
 * потом со скриншотом.
 */
async function claimPairing(meet: { pairId: string; pub: string }): Promise<PairingData> {
  const pair = await generateBoxKeyPair();
  const res = await fetch(`${WORKER_URL}/pair/answer`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ pairId: meet.pairId, pubB: await exportBoxPublic(pair.publicKey) }),
  });
  if (res.status === 409) throw new Error(t('Этот код уже использован. Покажите новый на первом устройстве.'));
  if (res.status === 404) throw new Error(t('Код устарел. Покажите новый на первом устройстве.'));
  if (!res.ok) throw new Error(t('Не удалось подключиться. Проверьте связь и попробуйте снова.'));

  // Ждём, пока первое устройство положит конверт: ему нужно заметить ответ.
  const theirPub = await importBoxPublic(meet.pub);
  for (let i = 0; i < 60; i++) {
    const cl = await fetch(`${WORKER_URL}/pair/claim?pairId=${encodeURIComponent(meet.pairId)}`).catch(() => null);
    if (cl?.ok) {
      const { sealed } = (await cl.json()) as { sealed: string | null };
      if (sealed) return openFrom<PairingData>(theirPub, pair.privateKey, sealed);
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(t('Первое устройство не ответило. Попробуйте ещё раз.'));
}

/** Подключить это устройство к существующему аккаунту: по коду встречи или по
 *  сохранённой резервной копии доступа. */
export async function connectSync(code: string): Promise<{ records: number | null }> {
  // Код встречи (v:3) — не секрет: отвечаем своим одноразовым ключом и ждём
  // конверт с секретами. Старый пакет (v:1) остаётся рабочим: это резервная
  // копия доступа, сохранённая файлом, и восстановление по ней ломать нельзя.
  const meet = decodeMeet(code);
  const p = meet ? await claimPairing(meet) : decodePairing(code);
  // Восстановление по сохранённому ключу — единственный путь, где аккаунта
  // может не оказаться вовсе: у встречи он заведомо есть, её только что открыло
  // живое устройство. Сервер регистрирует незнакомый аккаунт молча, поэтому
  // спрашиваем отдельно и до сохранения конфига: иначе человек с верным ключом
  // от несуществующего аккаунта получал бодрое «Устройство подключено» и пустое
  // приложение — и не мог отличить успех от полной потери.
  let records: number | null = null;
  if (!meet) {
    const check = await fetch(`${WORKER_URL}/account/check`, {
      headers: { 'X-Account': p.accountId, Authorization: `Bearer ${p.authToken}` },
    }).catch(() => null);
    if (!check) throw new Error(t('Нет связи с сервером. Проверьте интернет и попробуйте снова.'));
    if (check.status === 401)
      throw new Error(t('Ключ не подошёл: сервер не признал доступ. Проверьте, что вставлен весь ключ целиком.'));
    // 404 — сервер старой версии, этого маршрута он ещё не знает. Тогда идём
    // прежним путём: проверка появится сама, когда сервер обновится. Ломать
    // восстановление из-за порядка выкатки нельзя — человек с ключом в руках
    // не должен зависеть от того, что и когда уехало на сервер.
    if (check.status !== 404) {
      if (!check.ok) throw new Error(t('Сервер не отвечает. Попробуйте позже — данные никуда не денутся.'));
      const body = (await check.json()) as { exists: boolean; records?: number };
      if (!body.exists)
        throw new Error(t('Аккаунта с этим ключом на сервере нет. Ключ верный по виду, но данных под ним не найдено.'));
      records = body.records ?? null;
    }
  }
  const key = await importKeyRaw(p.key);
  await saveSyncConfig({
    id: 'config',
    accountId: p.accountId,
    authToken: p.authToken,
    key,
    enabled: true,
    lastPullSeq: 0,
    lastPullAt: '',
    deviceId: randomToken(12),
    lastPushAt: '',
    lastSyncedAt: '',
  });
  await enableCloudBackup();
  return { records };
}

/** Включить облачную копию вместе с обменом.
 *
 *  Обмен возит задачи, заметки, цели и финансы, но НЕ возит дневник цикла и
 *  семейную переписку — они живут только в копии. Онбординг при этом обещает,
 *  что «зашифрованная копия переживёт даже потерю телефона», а копия была
 *  выключена по умолчанию и сама не включалась ничем: человек читал обещание,
 *  включал синхронизацию и оставался без единой копии. Раз в неделю — это один
 *  запрос к серверу в неделю, на лимиты это не влияет. */
async function enableCloudBackup(): Promise<void> {
  const s = await db.settings.get('app');
  if (s?.autoBackup === 'cloud') return;
  await db.settings.update('app', {
    autoBackup: 'cloud',
    autoBackupEvery: s?.autoBackupEvery ?? 'weekly',
    updatedAt: new Date().toISOString(),
  });
}

/** Пакет доступа целиком — РЕЗЕРВНАЯ КОПИЯ, которую человек сохраняет файлом
 *  на случай потери телефона. Секретен так же, как сам ключ, и не истекает. */
export async function getBackupCode(): Promise<string | null> {
  const c = await getSyncConfig();
  if (!c) return null;
  return encodePairing({ v: 1, accountId: c.accountId, authToken: c.authToken, key: await exportKeyRaw(c.key) });
}

/**
 * Открыть встречу для соседнего устройства и вернуть код для QR.
 *
 * В коде НЕТ секретов: номер встречи и одноразовый публичный ключ. Раньше на
 * этом месте показывался пакет доступа целиком — то есть ключ шифрования всех
 * данных, живущий вечно: скриншот QR в галерее или код, отправленный себе в
 * мессенджер, открывали аккаунт кому угодно и когда угодно. Теперь
 * подсмотренный код бесполезен: секреты уедут отдельно, зашифрованные общим
 * секретом встречи, а сама встреча гаснет через пятнадцать минут и после
 * первого же получения.
 *
 * Для человека порядок действий тот же: показать QR, отсканировать на втором
 * устройстве. Ждать и нажимать ничего не нужно.
 */
export async function startPairing(): Promise<{ code: string; pairId: string; priv: string } | null> {
  const c = await getSyncConfig();
  if (!c) return null;
  const pair = await generateBoxKeyPair();
  const pub = await exportBoxPublic(pair.publicKey);
  const priv = await exportBoxPrivate(pair.privateKey);
  const pairId = randomToken(12);
  const res = await fetch(`${WORKER_URL}/pair/offer`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ pairId, pubA: pub }),
  });
  if (!res.ok) return null;
  return { code: encodeMeet({ v: 3, pairId, pub }), pairId, priv };
}

/**
 * Показывающая сторона: дождаться ответа второго устройства и передать ему
 * секреты, зашифрованные общим секретом встречи. Возвращает true, когда
 * конверт положен (то есть сопряжение состоялось).
 *
 * Опрос, а не сокет: встреча длится минуты, соединение ради неё держать
 * незачем, а лишний путь в вебсокетах — лишний источник поломок.
 */
export async function awaitPairing(
  pairId: string,
  priv: string,
  signal?: { aborted: boolean },
): Promise<boolean> {
  const c = await getSyncConfig();
  if (!c) return false;
  for (let i = 0; i < 150 && !signal?.aborted; i++) {
    const res = await fetch(`${WORKER_URL}/pair/state?pairId=${encodeURIComponent(pairId)}`).catch(() => null);
    if (!res) {
      await new Promise((r) => setTimeout(r, 2000));
      continue;
    }
    if (res.status === 404) return false; // встреча истекла
    const { pubB } = (await res.json()) as { pubB: string | null };
    if (pubB) {
      const sealed = await sealFor(await importBoxPublic(pubB), await importBoxPrivate(priv), {
        v: 1,
        accountId: c.accountId,
        authToken: c.authToken,
        key: await exportKeyRaw(c.key),
      });
      const put = await fetch(`${WORKER_URL}/pair/seal`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pairId, sealed }),
      });
      return put.ok;
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
  return false;
}

/** Полностью отключить синхронизацию на этом устройстве (локальные данные целы). */
export async function disableSync(): Promise<void> {
  await clearSyncConfig();
}
