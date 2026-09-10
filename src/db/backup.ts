import { db, SCHEMA_VERSION } from './db';
import { now } from './repo';
import { t } from '../lib/i18n';

const TABLES = [
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
  // Семейный контент (расшифрован локально): без него потеря устройства =
  // потеря всей истории чата. Конфиги семей (таблица family) НЕ включаем —
  // там ключ шифрования и токен, бэкап-файлу им не место.
  'familyMembers',
  'familyTasks',
  'familyMessages',
  // Раздел «Женские дни». Эти таблицы не синхронизируются между устройствами
  // (см. SYNCED_TABLES в lib/sync.ts), но в резервную копию входят: иначе
  // потеря телефона означала бы потерю всей истории цикла безвозвратно, а
  // восстановить её неоткуда — данные существуют в одном экземпляре.
  // Облачная копия шифруется аккаунтным ключом на устройстве, сервер видит
  // только шифротекст. Файловая копия НЕ шифрована — об этом человека
  // предупреждает экран экспорта.
  // Таблицу cycles (кэш циклов) не включаем сознательно: она выводится из
  // cycleDays и пересчитывается после импорта. Класть в файл производные
  // данные — значит однажды получить файл, где кэш противоречит источнику.
  'cycleDays',
  'cycleOverrides',
  'cycleEpisodes',
  'cycleSettings',
  'cycleSymptoms',
  'cyclePredictions',
  // Настройки приложения: тема, начало недели, раскладка разделов, пройденный
  // онбординг, скрытые подсказки. Без них восстановление возвращает данные, но
  // не возвращает приложение в привычный вид. Секреты сюда не попадают: ключи
  // синхронизации живут в отдельной таблице sync, её в копии нет.
  'settings',
  'taskPhotos',
] as const;

type TableName = (typeof TABLES)[number];

export interface BackupFile {
  app: 'life-hub';
  schemaVersion: number;
  exportedAt: string;
  data: Record<TableName, unknown[]>;
}

/** ДАННЫЕ раздела «Женские дни» — записи о днях. Выделены отдельно, потому что
 *  их попадание в копию — единственное, чем человек управляет сам. Выключил и
 *  восстановился — раздел очищается, это и есть смысл настройки. */
const CYCLE_TABLES: readonly TableName[] = [
  'cycleDays',
  'cycleOverrides',
  'cycleEpisodes',
  'cyclePredictions',
];

/** НАСТРОЙКИ раздела и справочник симптомов. Сюда же по ошибке попадали
 *  cycleSettings и cycleSymptoms, и это давало самоотменяющуюся приватность:
 *  человек ставил код доступа и выключал раздел из копий, а любое
 *  восстановление стирало строку настроек. Дальше ensureCycleSetup молча
 *  заводил её заново с умолчаниями — lock:'none', hideFromNavigation:false,
 *  includeInGeneralBackup:true. То есть раздел, спрятанный и запароленный
 *  ровно против чужих глаз, снова появлялся в меню без кода, и следующая
 *  копия опять уносила его в облако.
 *
 *  Настройки — не данные раздела. Их не кладём в копию вовсе и при
 *  восстановлении не трогаем: importBackup пропускает отсутствующий ключ. */
const CYCLE_CONFIG_TABLES: readonly TableName[] = ['cycleSettings', 'cycleSymptoms'];

export async function exportBackup(): Promise<BackupFile> {
  // Настройка раздела решает, попадёт ли он в копию. По умолчанию попадает:
  // синхронизация ему закрыта, и без копии история существует в одном
  // экземпляре. Кто выключил — получает файл без раздела, и это его выбор,
  // а не молчаливое решение приложения.
  const cycleSettings = await db.cycleSettings.get('app');
  const includeCycle = cycleSettings?.includeInGeneralBackup !== false;

  const data = {} as Record<TableName, unknown[]>;
  for (const name of TABLES) {
    if (!includeCycle && CYCLE_CONFIG_TABLES.includes(name)) {
      // Ключа нет вовсе — importBackup такую таблицу не тронет, и код доступа
      // с настройкой приватности переживут восстановление.
      continue;
    }
    if (!includeCycle && CYCLE_TABLES.includes(name)) {
      // Пустой массив, а не пропуск ключа: importBackup отсутствующую таблицу
      // не трогает вовсе, и старые данные пережили бы восстановление — то
      // есть «выключил и восстановился» не очистило бы раздел, как ожидалось.
      // Пустой массив честно означает «в этой копии раздела нет».
      data[name] = [];
      continue;
    }
    // включая soft-deleted — бэкап должен быть полным
    data[name] = await db.table(name).toArray();
  }
  return { app: 'life-hub', schemaVersion: SCHEMA_VERSION, exportedAt: now(), data };
}

export function backupFilename(): string {
  return `life-hub-backup-${new Date().toISOString().slice(0, 10)}.json`;
}

export interface ImportPreview {
  counts: Record<TableName, number>;
  exportedAt: string;
}

export function validateBackup(parsed: unknown): BackupFile {
  const b = parsed as BackupFile;
  if (!b || typeof b !== 'object' || b.app !== 'life-hub') {
    throw new Error(t('Это не файл резервной копии LifeHearth'));
  }
  if (typeof b.schemaVersion !== 'number' || b.schemaVersion > SCHEMA_VERSION) {
    throw new Error(t('Резервная копия создана более новой версией приложения'));
  }
  if (!b.data || typeof b.data !== 'object') {
    throw new Error(t('Файл резервной копии повреждён: нет данных'));
  }
  for (const name of TABLES) {
    if (b.data[name] !== undefined && !Array.isArray(b.data[name])) {
      throw new Error(t('Файл резервной копии повреждён: неверная структура данных'));
    }
  }
  return b;
}

export function previewBackup(b: BackupFile): ImportPreview {
  const counts = {} as Record<TableName, number>;
  for (const name of TABLES) counts[name] = b.data[name]?.length ?? 0;
  return { counts, exportedAt: b.exportedAt };
}

/** Нормализует строку из старого бэкапа: проставляет поля, добавленные после
 *  той версии схемы. bulkPut пишет объекты вербатим и НЕ запускает Dexie
 *  upgrade-хуки (db.ts version(3).upgrade), поэтому бэкфилл нужен здесь —
 *  иначе у задач из бэкапа v3/v4 (schemaVersion 1/2) tags === undefined, и
 *  первый же рендер падает на task.tags (TaskItem, TasksPage). */
function normalizeRow(name: TableName, row: unknown): unknown {
  if (name === 'tasks') {
    const t = row as {
      tags?: unknown;
      checklist?: unknown;
      duration?: unknown;
      remindBefore?: unknown;
    };
    if (!Array.isArray(t.tags)) t.tags = [];
    if (!Array.isArray(t.checklist)) t.checklist = [];
    if (t.duration === undefined) t.duration = null;
    if (t.remindBefore === undefined) t.remindBefore = null;
  }
  return row;
}

/** Таблицы кусков: их содержимое приезжает синком отдельно от «своих» записей,
 *  поэтому пустой список в копии значит «ещё не доехало», а не «пусто». */
const CHUNK_TABLES = new Set(['taskPhotos', 'noteFiles']);

/** Замена данных содержимым бэкапа, в одной транзакции. */
export async function importBackup(b: BackupFile): Promise<void> {
  const tables = TABLES.map((name) => db.table(name));
  await db.transaction('rw', tables, async () => {
    for (const name of TABLES) {
      const rows = b.data[name];
      // Таблицу, отсутствующую в файле, НЕ трогаем — иначе частичный или
      // старый бэкап молча затёр бы её текущие данные без возможности отката.
      if (rows === undefined) continue;
      // Пустой список кусков вложений — тоже «нет данных», а не «сотри всё».
      //
      // Куски приезжают синком отдельно от своих записей и могут ещё быть в
      // пути. Копия, снятая устройством, до которого они не доехали, содержит
      // пустой список — и очистка по нему стёрла бы на этом устройстве
      // фотографии и вложения, которые здесь есть. Данные при этом целы на
      // сервере, но локально исчезают, а человек об этом не узнает.
      if (rows.length === 0 && CHUNK_TABLES.has(name)) continue;
      const table = db.table(name);
      await table.clear();
      // bulkPut идемпотентен по первичному ключу id — переносит дубли id
      // из файла, не роняя всю транзакцию (в отличие от bulkAdd).
      if (rows.length) await table.bulkPut(rows.map((r) => normalizeRow(name, r)));
    }
  });

  // Синхронизация должна перечитать всё заново.
  //
  // Восстановление стирает таблицы и кладёт строки из снапшота с их
  // ИСХОДНЫМИ updatedAt. Курсоры при этом остаются на «сейчас», а сервер
  // отдаёт только то, что новее курсора, — значит всё, что появилось после
  // снятия копии, на это устройство уже не вернётся никогда, хотя на сервере
  // и на втором устройстве оно цело. В обратную сторону так же: восстановленные
  // строки старше lastPushAt и никуда не уедут, то есть второе устройство не
  // узнает о восстановлении.
  //
  // Сброс безопасен по той же причине, что и в rewindIfTablesGrew: запись
  // применяется, только если она свежее локальной. Цена — один полный обмен.
  try {
    const { patchSyncConfig } = await import('../lib/syncState');
    await patchSyncConfig({ lastPullAt: '', lastPushAt: '' });
  } catch {
    /* синхронизация не настроена — сбрасывать нечего */
  }

  // Кэш циклов в файле не лежит — восстанавливаем его из дневных записей.
  // Отдельной транзакцией, после основной: db.cycles в её область не входит.
  // Ошибку глушим: не пересчитались циклы — данные всё равно на месте, и
  // следующая правка любого дня всё исправит.
  if (b.data.cycleDays !== undefined) {
    try {
      const { rebuildCycles } = await import('../lib/cycle/cycleRepo');
      await rebuildCycles();
    } catch {
      /* пересчитается при следующей правке */
    }
  }
}
