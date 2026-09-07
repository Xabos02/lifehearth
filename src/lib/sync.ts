// Движок E2E-синхронизации: pull (получить чужие изменения, расшифровать,
// применить по принципу «новейший побеждает») + push (зашифровать свои свежие
// изменения и отправить). Содержимое шифруется на устройстве; на Worker уходит
// только шифротекст + служебные поля.

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
import { getSyncConfig, patchSyncConfig, saveSyncConfig, clearSyncConfig } from './syncState';

// Экспорт: адрес воркера переиспользует клиент AI-прокси (lib/ai/aiClient.ts).
export const WORKER_URL = 'https://life-hub-push.xabos161rus.workers.dev';
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

function authHeaders(c: SyncConfig): Record<string, string> {
  return {
    'X-Account': c.accountId,
    Authorization: `Bearer ${c.authToken}`,
    'Content-Type': 'application/json',
  };
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
 * его дальше и курсор lastPullAt не двигается. Синхронизация встаёт НАВСЕГДА и
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
  since: string,
): Promise<{ applied: number; skipped: number; nextSince: string; hasMore: boolean }> {
  const res = await fetch(`${WORKER_URL}/sync/pull?since=${encodeURIComponent(since)}`, {
    headers: authHeaders(c),
  });
  if (!res.ok) throw new Error(`pull ${res.status}`);
  const data = (await res.json()) as { records: RemoteRecord[]; hasMore: boolean; nextSince: string };
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
    // должен ронять весь цикл: иначе курсор lastPullAt не сдвинется и синк
    // встанет навсегда — перестанут приходить и задачи, и заметки, и семья.
    try {
      decoded.push({ r, obj: await decryptJSON<Row>(c.key, r.ciphertext) });
    } catch (e) {
      if (!isPoisonRecord(e)) throw e;
      skipped++;
      console.warn(`sync: пропущена запись ${r.table}/${r.id}`, e);
    }
  }

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
        applied++;
      }
    });
  }

  return { applied, skipped, nextSince: data.nextSince, hasMore: data.hasMore };
}

/** Курсор pull двигается по времени, а сервер отдаёт только updated_at > since.
 *  Значит запись, пропущенную как «незнакомая таблица», уже не переспросить:
 *  курсор ушёл вперёд вместе со всей страницей.
 *
 *  Так и терялись данные при обновлении. Второй телефон на старом бандле
 *  получал папки заметок и цели-копилок, не знал таких таблиц, пропускал их
 *  через continue — но lastPullAt всё равно сдвигал. После обновления
 *  приложения эти записи не приходили уже никогда, и причина ниоткуда не
 *  видна: на сервере всё цело, на одном устройстве есть, на другом нет.
 *
 *  Поэтому запоминаем набор таблиц, который знала двигавшая курсор версия.
 *  Появились новые — один раз переспрашиваем всё с начала. Полный ре-pull
 *  безопасен: запись применяется только если она свежее локальной. */
async function rewindIfTablesGrew(c: SyncConfig): Promise<string> {
  const known = c.knownTables;
  const now = [...SYNCED_TABLES];
  if (known && now.every((t) => known.includes(t))) return c.lastPullAt;
  // Поля ещё нет — значит курсор двигала версия ДО этой защиты, и что она
  // умела, мы не знаем. Раз не знаем — считаем, что могли пропустить, и
  // перечитываем. Пропустить этот случай было бы бессмысленно: именно этот
  // релиз и добавляет таблицы, из-за которых всё затевалось.
  //
  // Цена — один полный pull истории аккаунта, единожды. Для личных объёмов
  // это секунды, и он безопасен: запись применяется, только если свежее
  // локальной.
  await patchSyncConfig({ knownTables: now, lastPullAt: '' });
  return '';
}

async function pull(c: SyncConfig): Promise<{ applied: number; skipped: number }> {
  let applied = 0;
  let skipped = 0;
  let since = await rewindIfTablesGrew(c);
  for (;;) {
    const page = await pullPage(c, since);
    applied += page.applied;
    skipped += page.skipped;
    since = page.nextSince;
    // Курсор двигаем ПОСТРАНИЧНО, а не после всего цикла. Иначе обрыв на
    // середине (закрыли вкладку, пропала сеть) стирает весь прогресс, и
    // следующий заход начинает с начала. На полном перечитывании истории —
    // а оно случается после каждого релиза, добавившего таблицу в обмен, —
    // телефон может не досидеть до конца НИКОГДА и качать одно и то же.
    //
    // Безопасно по той же причине, что и сам ре-pull: запись применяется,
    // только если свежее локальной, так что повтор ничего не портит.
    await patchSyncConfig({ lastPullAt: since });
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
      .between(c.lastPushAt, cutoff, true, false)
      .toArray();
    for (const row of rows) fresh.push({ name, row });
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
    (f) => typeof f.updatedAt === 'string' && f.updatedAt >= c.lastPushAt && f.updatedAt < cutoff,
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
    const res = await fetch(`${WORKER_URL}/sync/push`, {
      method: 'POST',
      headers: authHeaders(c),
      body: JSON.stringify({ records: batch }),
    });
    if (!res.ok) throw new Error(`push ${res.status}`);
  }
  await patchSyncConfig({ lastPushAt: cutoff });
  return { pushed: sendable.length, oversized };
}

// === Оркестрация ===
let running = false;
let lastError: string | null = null;

/** Один цикл: pull → push. Возвращает null, если синк выключен или уже идёт. */
export async function runSync(): Promise<{
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
  // курсоры lastPullAt/lastPushAt наперегонки — последний завершившийся молча
  // перезаписывает более ранний.
  if (running) return null;
  running = true;
  lastError = null;
  try {
    const c = await getSyncConfig();
    if (!c || !c.enabled) return null;
    const { applied: pulled, skipped } = await pull(c);
    const fresh = await getSyncConfig(); // курсор pull обновился
    const sent = fresh ? await push(fresh) : { pushed: 0, oversized: 0 };
    await patchSyncConfig({ lastSyncedAt: new Date().toISOString() });
    // Прошлая неудача больше не актуальна — снимаем отметку.
    await clearSyncFailure();
    return { pulled, pushed: sent.pushed, skipped, oversized: sent.oversized };
  } catch (e) {
    lastError = String(e);
    // Фоновый цикл запускается сам и ошибку никому не показывает: раньше она
    // жила только в переменной модуля и пропадала при перезагрузке. Оставляем
    // след в настройках, чтобы экран синхронизации мог сказать честно.
    await noteSyncFailure(humanReason(e));
    throw e;
  } finally {
    running = false;
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
const DEBOUNCE_MS = 1500;
let debounceTimer: ReturnType<typeof setTimeout> | null = null;

export function scheduleSyncSoon(): void {
  if (debounceTimer) clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => {
    debounceTimer = null;
    void runSync().catch(() => {});
  }, DEBOUNCE_MS);
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
    lastPullAt: '',
    lastPushAt: '',
    lastSyncedAt: '',
  });
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
export async function connectSync(code: string): Promise<void> {
  // Код встречи (v:3) — не секрет: отвечаем своим одноразовым ключом и ждём
  // конверт с секретами. Старый пакет (v:1) остаётся рабочим: это резервная
  // копия доступа, сохранённая файлом, и восстановление по ней ломать нельзя.
  const meet = decodeMeet(code);
  const p = meet ? await claimPairing(meet) : decodePairing(code);
  const key = await importKeyRaw(p.key);
  await saveSyncConfig({
    id: 'config',
    accountId: p.accountId,
    authToken: p.authToken,
    key,
    enabled: true,
    lastPullAt: '',
    lastPushAt: '',
    lastSyncedAt: '',
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
