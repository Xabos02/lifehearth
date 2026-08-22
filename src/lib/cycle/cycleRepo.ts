// Единственная точка записи в таблицы раздела «Женские дни».
//
// Сознательно НЕ использует db/repo: тот на каждой записи дёргает
// scheduleSyncSoon(), а данные цикла по умолчанию не покидают устройство.
// Изоляция здесь архитектурная, а не в виде галочки в интерфейсе: таблицы
// раздела отсутствуют в SYNCED_TABLES (lib/sync.ts), запись идёт мимо общего
// репозитория, и чтобы данные цикла случайно уехали в облако, недостаточно
// забыть про условие — нужно осознанно добавить таблицу в allowlist.
// Тот же принцип для семьи: в семейный payload попадают только явно
// перечисленные таблицы, и cycle* среди них нет.
//
// Второе отличие от общего репозитория — отсутствие мягкого удаления.
// deletedAt нужен, чтобы удаление доехало до другого устройства; здесь
// синхронизации нет, а «удалённая, но лежащая в базе» запись о цикле — это
// ровно то, чего человек не ожидает, когда нажимает «удалить».

import { db } from '../../db/db';
import type {
  Cycle,
  CycleDayLog,
  CycleEpisode,
  CycleOverride,
  CycleSettings,
  LocalDate,
  SymptomDef,
  SymptomEntry,
} from '../../db/cycleTypes';
import { MENSTRUAL_LEVELS } from '../../db/cycleTypes';
import { todayKey } from '../dates';
import { deriveCycles } from './derive';
import { builtInSymptoms } from './symptoms';
import { planAutoTasks } from './autoTasks';
import { predictNextPeriod } from './predict';

const now = (): string => new Date().toISOString();

export const DEFAULT_CYCLE_SETTINGS: Omit<CycleSettings, 'updatedAt'> = {
  id: 'app',
  mode: 'tracking',
  predictionsEnabled: true,
  // Фертильность выключена: человек, пришедший считать дни до месячных, не
  // просил показывать ему окно зачатия.
  fertilityDisplay: 'off',
  dayStartHour: 0,
  lock: 'none',
  hideFromNavigation: false,
  showOnTodayScreen: false,
  neutralNotificationText: true,
  // Раздел ВХОДИТ в резервную копию по умолчанию. Синхронизация ему закрыта, и
  // без копии данные существовали бы ровно в одном экземпляре: потеря телефона
  // = потеря всей истории безвозвратно. Кто предпочтёт закрытость сохранности —
  // выключит в настройках раздела и будет знать, чем платит.
  includeInGeneralBackup: true,
  syncEnabled: false,
  integrations: {
    todayCard: false,
    calendarMarks: false,
    energyCorrelation: false,
    habitsCorrelation: false,
    autoTasks: false,
    planningHints: false,
  },
};

/** Заводит настройки раздела и справочник симптомов при первом открытии.
 *  Идемпотентна: повторный вызов ничего не перезаписывает. */
export async function ensureCycleSetup(): Promise<void> {
  const ts = now();
  const existing = await db.cycleSettings.get('app');
  if (!existing) await db.cycleSettings.put({ ...DEFAULT_CYCLE_SETTINGS, updatedAt: ts });

  const count = await db.cycleSymptoms.count();
  if (count === 0) await db.cycleSymptoms.bulkPut(builtInSymptoms(ts));
}

export async function updateCycleSettings(changes: Partial<CycleSettings>): Promise<void> {
  const current = await db.cycleSettings.get('app');
  const base: CycleSettings = current ?? { ...DEFAULT_CYCLE_SETTINGS, updatedAt: now() };
  await db.cycleSettings.put({
    ...base,
    ...changes,
    // integrations вложенный — поверхностный spread затёр бы соседние флаги.
    integrations: { ...base.integrations, ...(changes.integrations ?? {}) },
    id: 'app',
    updatedAt: now(),
  });
}

type DayPatch = Omit<
  CycleDayLog,
  'date' | 'createdAt' | 'updatedAt' | 'isBleedingDay' | 'source' | 'symptomKeys'
> & { symptoms?: SymptomEntry[] };

/** Запись дня. Единственное место, где считается isBleedingDay и
 *  синхронизируется денормализованный symptomKeys — держать это в вызывающем
 *  коде значило бы рано или поздно разъехаться. */
export async function putDay(date: LocalDate, patch: DayPatch): Promise<void> {
  const ts = now();
  const prev = await db.cycleDays.get(date);
  const merged: CycleDayLog = {
    ...prev,
    ...patch,
    date,
    isBleedingDay:
      patch.bleeding !== undefined && MENSTRUAL_LEVELS.includes(patch.bleeding) ? 1 : 0,
    symptomKeys: (patch.symptoms ?? prev?.symptoms ?? []).map((s) => s.key),
    createdAt: prev?.createdAt ?? ts,
    updatedAt: ts,
    // Запись «не сегодняшним» днём помечается: заполняемость, проставленная
    // задним числом пачкой, не значит того же, что ежедневные отметки.
    backdated: date !== todayKey() ? true : (prev?.backdated ?? false),
    source: prev?.source ?? 'user',
  };
  await db.cycleDays.put(merged);
  await rebuildCycles();
}

/** Полное удаление записи дня — без мягкого удаления, см. шапку файла. */
export async function deleteDay(date: LocalDate): Promise<void> {
  await db.cycleDays.delete(date);
  await rebuildCycles();
}

export async function putEpisode(
  episode: Omit<CycleEpisode, 'id' | 'createdAt' | 'updatedAt'> & { id?: string },
): Promise<string> {
  const ts = now();
  const id = episode.id ?? crypto.randomUUID();
  const prev = id ? await db.cycleEpisodes.get(id) : undefined;
  await db.cycleEpisodes.put({
    ...episode,
    id,
    createdAt: prev?.createdAt ?? ts,
    updatedAt: ts,
  });
  await rebuildCycles();
  return id;
}

export async function deleteEpisode(id: string): Promise<void> {
  await db.cycleEpisodes.delete(id);
  await rebuildCycles();
}

/** Пользовательская правка цикла: исключить из статистики, подтвердить дату
 *  начала. Живёт отдельной таблицей именно потому, что cycles пересчитывается
 *  с нуля и стёр бы решение человека. */
export async function putOverride(
  startDate: LocalDate,
  changes: Partial<Omit<CycleOverride, 'startDate' | 'createdAt' | 'updatedAt'>>,
): Promise<void> {
  const ts = now();
  const prev = await db.cycleOverrides.get(startDate);
  await db.cycleOverrides.put({
    ...prev,
    ...changes,
    startDate,
    createdAt: prev?.createdAt ?? ts,
    updatedAt: ts,
  });
  await rebuildCycles();
}

/** Пересчёт кэша циклов.
 *
 *  Таблица переписывается целиком, а не правится точечно: правка одного дня в
 *  середине истории меняет границы двух соседних циклов, а иногда и всех
 *  последующих. Точечное обновление здесь — прямой путь к рассинхрону кэша с
 *  источником истины.
 *  Транзакция на три таблицы: между чтением дней и записью циклов не должно
 *  быть окна, в котором таблица циклов пуста, — в него попадёт useLiveQuery и
 *  моргнёт пустым экраном. */
export async function rebuildCycles(): Promise<Cycle[]> {
  const cycles = await rebuildCyclesOnly();
  // Автозадачи двигаем ПОСЛЕ транзакции, а не внутри: db.tasks в её область не
  // входит, и обращение к ней изнутри Dexie просто запретит. Ошибку здесь
  // глушим: не сумели подвинуть задачу — это не повод потерять пересчёт цикла.
  try {
    await syncAutoTasks();
  } catch {
    /* автозадачи подождут следующего пересчёта */
  }
  return cycles;
}

async function rebuildCyclesOnly(): Promise<Cycle[]> {
  return db.transaction(
    'rw',
    [db.cycleDays, db.cycles, db.cycleOverrides, db.cycleEpisodes],
    async () => {
      const [days, overrides, episodes] = await Promise.all([
        db.cycleDays.toArray(),
        db.cycleOverrides.toArray(),
        db.cycleEpisodes.toArray(),
      ]);
      const cycles = deriveCycles({ days, overrides, episodes, today: todayKey(), now: now() });
      await db.cycles.clear();
      if (cycles.length > 0) await db.cycles.bulkPut(cycles);
      return cycles;
    },
  );
}

/** Приводит автозадачи в соответствие с прогнозом.
 *
 *  Живёт здесь, а не в компоненте: вызывается после каждого пересчёта циклов,
 *  и вызывающему коду не нужно помнить, что после правки дня надо ещё и задачи
 *  подвинуть. Пишет в db.tasks НАПРЯМУЮ, минуя db/repo: тот дёргает
 *  планировщик синхронизации, а автозадача — производная от данных цикла и
 *  уезжать с устройства не должна, пока это не решено явно.
 *
 *  Возвращает число изменений — удобно в тестах и логах. */
export async function syncAutoTasks(): Promise<number> {
  const [settings, cycles, episodes] = await Promise.all([
    db.cycleSettings.get('app'),
    db.cycles.orderBy('startDate').toArray(),
    db.cycleEpisodes.toArray(),
  ]);
  if (!settings) return 0;

  const existing = await db.tasks.where('origin').equals('cycle').toArray();
  const plan = planAutoTasks({
    settings,
    prediction: predictNextPeriod({ cycles, episodes, today: todayKey() }),
    existing,
    today: todayKey(),
  });

  const ts = now();
  let changed = 0;

  for (const c of plan.create) {
    await db.tasks.put({
      id: crypto.randomUUID(),
      title: c.title,
      notes: '',
      projectId: null,
      goalId: null,
      priority: 0,
      dueDate: c.dueDate,
      dueTime: null,
      duration: null,
      remindBefore: null,
      completedAt: null,
      checklist: [],
      recurrence: null,
      tags: [],
      sortOrder: Date.now(),
      origin: 'cycle',
      originKey: c.originKey,
      createdAt: ts,
      updatedAt: ts,
      deletedAt: null,
    });
    changed += 1;
  }
  for (const r of plan.reschedule) {
    await db.tasks.update(r.id, { dueDate: r.dueDate, updatedAt: ts });
    changed += 1;
  }
  for (const id of plan.remove) {
    // Мягкое удаление, а не полное.
    //
    // Полное выглядело логично («задачу человек не заводил»), но давало две
    // беды. Задача уходила мимо корзины — вместе с заметками и чек-листом,
    // которые человек мог к ней дописать, и вернуть их было нечем. И оно не
    // доезжало до второго устройства: синхронизация возит пометку об удалении,
    // а не отсутствие записи, — телефон присылал задачу обратно, и она
    // воскресала.
    // Пишем напрямую, а не через общий репозиторий: тот дёргает планировщик
    // синхронизации на каждой записи, а этому файлу трогать его нельзя —
    // инвариант приватности раздела (см. cycle/privacy.test.ts). Пометки
    // достаточно: обмен подхватит задачу по времени правки на ближайшем круге.
    await db.tasks.update(id, { deletedAt: ts, updatedAt: ts });
    changed += 1;
  }
  return changed;
}

export async function addCustomSymptom(
  label: string,
  scale: SymptomDef['scale'] = 'severity',
): Promise<void> {
  const ts = now();
  const key = 'custom_' + crypto.randomUUID().slice(0, 8);
  const maxOrder = (await db.cycleSymptoms.toArray()).reduce((m, s) => Math.max(m, s.order), 0);
  await db.cycleSymptoms.put({
    key,
    group: 'custom',
    scale,
    label: label.trim(),
    builtIn: false,
    enabled: true,
    order: maxOrder + 10,
    createdAt: ts,
    updatedAt: ts,
  });
}

export async function setSymptomEnabled(key: string, enabled: boolean): Promise<void> {
  await db.cycleSymptoms.update(key, { enabled, updatedAt: now() });
}

/** Полное стирание раздела. Нужно и как кнопка в настройках, и как реакция на
 *  «удалить всё» — данные о цикле относятся к специальной категории, и
 *  возможность бесследно их убрать должна быть явной. */
export async function wipeCycleData(): Promise<void> {
  await db.transaction(
    'rw',
    [
      db.cycleDays,
      db.cycles,
      db.cycleOverrides,
      db.cycleEpisodes,
      db.cyclePredictions,
      db.cycleSettings,
      db.cycleSymptoms,
    ],
    async () => {
      await Promise.all([
        db.cycleDays.clear(),
        db.cycles.clear(),
        db.cycleOverrides.clear(),
        db.cycleEpisodes.clear(),
        db.cyclePredictions.clear(),
        db.cycleSettings.clear(),
        db.cycleSymptoms.clear(),
      ]);
    },
  );
}
