import Dexie, { type Table } from 'dexie';
import type {
  Project,
  Task,
  Goal,
  Habit,
  HabitLog,
  Note,
  NoteFile,
  TaskPhoto,
  TaskFile,
  NoteFolder,
  LearningItem,
  LearningLog,
  LearningPart,
  ExpenseItem,
  SavingsGoal,
  SavingsDeposit,
  EnergyItem,
  EnergyLog,
  PlaceItem,
  Metric,
  MetricLog,
  Workout,
  Settings,
  SyncConfig,
  FamilyConfig,
  FamilyMember,
  FamilyTask,
  FamilyMessage,
  ReminderSection,
  ReminderItem,
  LlmChat,
  LlmMessage,
} from './types';
import type {
  Cycle,
  CycleDayLog,
  CycleEpisode,
  CycleOverride,
  CyclePrediction,
  CycleSettings,
  SymptomDef,
} from './cycleTypes';

export const SCHEMA_VERSION = 21;

export class LifeHearthDB extends Dexie {
  projects!: Table<Project, string>;
  tasks!: Table<Task, string>;
  goals!: Table<Goal, string>;
  habits!: Table<Habit, string>;
  habitLogs!: Table<HabitLog, string>;
  notes!: Table<Note, string>;
  noteFiles!: Table<NoteFile, string>;
  noteFolders!: Table<NoteFolder, string>;
  learningItems!: Table<LearningItem, string>;
  learningLogs!: Table<LearningLog, string>;
  learningParts!: Table<LearningPart, string>;
  expenseItems!: Table<ExpenseItem, string>;
  savingsGoals!: Table<SavingsGoal, string>;
  savingsDeposits!: Table<SavingsDeposit, string>;
  energyItems!: Table<EnergyItem, string>;
  energyLogs!: Table<EnergyLog, string>;
  taskPhotos!: Table<TaskPhoto, string>;
  taskFiles!: Table<TaskFile, string>;
  placeItems!: Table<PlaceItem, string>;
  metrics!: Table<Metric, string>;
  metricLogs!: Table<MetricLog, string>;
  workouts!: Table<Workout, string>;
  settings!: Table<Settings, string>;
  sync!: Table<SyncConfig, string>;
  family!: Table<FamilyConfig, string>;
  familyMembers!: Table<FamilyMember, string>;
  familyTasks!: Table<FamilyTask, string>;
  familyMessages!: Table<FamilyMessage, string>;
  reminderSections!: Table<ReminderSection, string>;
  reminderItems!: Table<ReminderItem, string>;
  // Раздел «Женские дни». Ключ дневной записи и цикла — строка даты, а не uuid:
  // на календарный день приходится ровно одна запись, суррогатный id позволил
  // бы завести вторую. Эти таблицы НЕ входят в SYNCED_TABLES (lib/sync.ts) и
  // пишутся мимо db/repo — см. lib/cycle/cycleRepo.ts.
  cycleDays!: Table<CycleDayLog, string>;
  cycles!: Table<Cycle, string>;
  cycleOverrides!: Table<CycleOverride, string>;
  cycleEpisodes!: Table<CycleEpisode, string>;
  cycleSettings!: Table<CycleSettings, string>;
  cycleSymptoms!: Table<SymptomDef, string>;
  cyclePredictions!: Table<CyclePrediction, string>;
  // Раздел «ИИ». НЕ входят в SYNCED_TABLES и в бэкап: pullPage старых сборок
  // молча пропускает записи незнакомых таблиц, а курсор двигается — устройство
  // на прошлой версии потеряло бы часть переписки навсегда (план, §4.7).
  llmChats!: Table<LlmChat, string>;
  llmMessages!: Table<LlmMessage, string>;

  constructor() {
    // Имя базы в IndexedDB — 'life-hub', и менять его нельзя НИКОГДА, даже
    // теперь, когда приложение называется LifeHearth. Браузер ищет базу по
    // имени: под новым он откроет пустую, а всё, что человек накопил,
    // останется лежать под старым именем — невидимым для приложения. Это
    // ровно то, что выглядит как «данные пропали». Имя внутреннее, человек
    // его нигде не видит.
    super('life-hub');
    this.version(1).stores({
      projects: 'id, sortOrder',
      tasks: 'id, projectId, goalId, dueDate, completedAt',
      goals: 'id, status',
      habits: 'id, goalId',
      habitLogs: 'id, habitId, date, &[habitId+date]',
      notes: 'id, *tags, pinned',
      learningItems: 'id, status, goalId',
      learningLogs: 'id, itemId, date',
      settings: 'id',
    });
    // v2 — новые разделы жизни (финансы, энергия, места, метрики).
    // Существующие таблицы не меняются, поэтому upgrade-функция не нужна.
    this.version(2).stores({
      expenseItems: 'id, category, kind',
      energyItems: 'id, category',
      placeItems: 'id, kind, status',
      metrics: 'id',
      metricLogs: 'id, metricId, date',
    });
    // v3 — теги у задач (multiEntry-индекс *tags для фильтра).
    this.version(3)
      .stores({ tasks: 'id, projectId, goalId, dueDate, completedAt, *tags' })
      .upgrade((tx) =>
        tx
          .table('tasks')
          .toCollection()
          .modify((t) => {
            if (!Array.isArray(t.tags)) t.tags = [];
          }),
      );
    // v4 — конфиг E2E-синхронизации (одна строка id='config'). Новая таблица,
    // существующие не меняются → upgrade-функция не нужна.
    this.version(4).stores({ sync: 'id' });
    // v5 — семейный раздел (общие задачи + чат). Только новые таблицы,
    // существующие не трогаются → upgrade-функция не нужна.
    this.version(5).stores({
      family: 'id',
      familyMembers: 'id, seq',
      familyTasks: 'id, seq, assigneeId, completedAt',
      familyMessages: 'clientMsgId, seq, createdAt',
    });
    // v6 — несколько семейных групп одновременно. Конфиг теперь по ключу
    // familyId (много строк вместо одной 'config'), а семейные данные
    // размечаются полем familyId (+ индекс для выборки по группе).
    this.version(6)
      .stores({
        family: 'id',
        familyMembers: 'id, familyId, seq',
        familyTasks: 'id, familyId, seq, assigneeId, completedAt',
        familyMessages: 'clientMsgId, familyId, seq, createdAt',
      })
      .upgrade(async (tx) => {
        // Перекладываем единственную старую группу на новую модель: строку
        // конфига id='config' перекеиваем в id=familyId, а все её данные
        // (они принадлежали ровно этой группе) штампуем тем же familyId.
        const cfg = await tx.table('family').get('config');
        if (!cfg) return;
        const fid: string = cfg.familyId;
        await tx.table('family').delete('config');
        await tx.table('family').put({ ...cfg, id: fid, lastReadSeq: cfg.lastReadSeq ?? 0 });
        for (const t of ['familyMembers', 'familyTasks', 'familyMessages']) {
          await tx
            .table(t)
            .toCollection()
            .modify((row: { familyId?: string }) => {
              if (!row.familyId) row.familyId = fid;
            });
        }
      });
    // v7 — напоминания: разделы по темам + закреплённые подсказки. Только новые
    // таблицы, существующие не трогаются → upgrade-функция не нужна.
    this.version(7).stores({
      reminderSections: 'id, sortOrder',
      reminderItems: 'id, sectionId, sortOrder',
    });
    // v8 — подпроекты: parentId у проекта (+ индекс для выборки детей).
    // Существующие проекты нормализуются в parentId=null (верхний уровень).
    this.version(8)
      .stores({ projects: 'id, sortOrder, parentId' })
      .upgrade((tx) =>
        tx
          .table('projects')
          .toCollection()
          .modify((p) => {
            if (p.parentId === undefined) p.parentId = null;
          }),
      );
    // v9 — количественные привычки: target/unit у привычки и value у отметки.
    // Индексы не меняются; существующие записи нормализуем (простые галочки).
    this.version(9)
      .stores({
        habits: 'id, goalId',
        habitLogs: 'id, habitId, date, &[habitId+date]',
      })
      .upgrade(async (tx) => {
        await tx
          .table('habits')
          .toCollection()
          .modify((h) => {
            if (h.target === undefined) h.target = null;
            if (h.unit === undefined) h.unit = '';
          });
        await tx
          .table('habitLogs')
          .toCollection()
          .modify((l) => {
            if (l.value === undefined) l.value = null;
          });
      });
    // v10 — накопления: цели-копилки и пополнения. Только новые таблицы,
    // существующие не трогаются → upgrade-функция не нужна.
    this.version(10).stores({
      savingsGoals: 'id, sortOrder, archivedAt',
      savingsDeposits: 'id, goalId, date',
    });
    // v11 — раздел «Женские дни». Только новые таблицы, существующие не
    // трогаются → upgrade-функция не нужна.
    //
    // cycleDays.date первичным ключом даёт уникальность записи на день без
    // отдельного индекса и корректный between('2026-01-01','2026-07-25'):
    // лексикографический порядок ISO-дат совпадает с хронологическим.
    // isBleedingDay — 0|1, потому что boolean в индекс IndexedDB не попадает
    // вообще. *symptomKeys — multi-entry: «все дни, когда болела голова» одним
    // проходом вместо скана истории.
    // [excluded+startDate] — основной запрос статистики: последние N
    // неисключённых циклов. Без составного индекса это скан всех циклов с
    // фильтром в JS; на трёх годах терпимо, на импорте за десять лет уже нет.
    this.version(11).stores({
      cycleDays: 'date, isBleedingDay, *symptomKeys',
      cycles: 'startDate, endDate, [excluded+startDate]',
      cycleOverrides: 'startDate',
      cycleEpisodes: 'id, kind, startDate',
      cycleSettings: 'id',
      // enabled в индекс НЕ идёт: это boolean, а IndexedDB индексирует только
      // числа, строки, даты и массивы. Симптомов пара десятков — фильтруем в JS.
      cycleSymptoms: 'key, group',
      cyclePredictions: 'forCycleStart',
    });
    // v12 — происхождение задачи. Индекс по origin нужен, чтобы раздел находил
    // свои автозадачи одним запросом, а не сканом всего списка; и чтобы
    // проверка «не утекло ли что-то из закрытого раздела» была дешёвой.
    // Существующие задачи не трогаем: undefined означает «человек сам создал».
    this.version(12).stores({
      tasks: 'id, projectId, goalId, dueDate, completedAt, *tags, origin',
    });

    // Папки заметок. Один уровень вложенности намеренно: папка в папке в папке
    // — самый быстрый способ добиться того, что человек перестанет
    // раскладывать вообще и свалит всё в корень.
    // У существующих заметок folderId остаётся undefined — это и есть корень,
    // переносить ничего не нужно.
    this.version(13)
      .stores({
        noteFolders: 'id, sortOrder',
        notes: 'id, *tags, pinned, folderId',
      })
      .upgrade(async (tx) => {
        // Помечаем уже существующую строку настроек как «старого» пользователя.
        //
        // Экраны онбординга появились только в этом релизе, поля onboardingDone
        // в прежних настройках нет вовсе, а ensureSettings пишет строку лишь
        // когда её нет целиком. Без этой строчки человек, у которого приложение
        // стоит давно и полно данных, после тихого обновления получил бы
        // вводный тур для новичка поверх собственных задач — и, что хуже,
        // окно «Новое имя и значок» не показалось бы уже никогда: оно ждёт
        // пройденного онбординга.
        //
        // Дата — не «сейчас», а заведомо прошлая: онбординг человек не проходил,
        // и притворяться, что прошёл сегодня, значит соврать в собственных
        // данных. Важен только факт «не новичок».
        await tx
          .table('settings')
          .toCollection()
          .modify((row: { onboardingDone?: string }) => {
            if (row.onboardingDone === undefined) row.onboardingDone = '2000-01-01T00:00:00.000Z';
          });
      });

    // v14 — файлы-вложения заметок (чанками, см. NoteFile в types.ts). Только
    // новая таблица, существующие не трогаются → upgrade-функция не нужна.
    // fileId в индексе: удаление одного вложения и подсчёт его чанков идут
    // выборкой по fileId, а не сканом всех файлов заметки.
    this.version(14).stores({
      noteFiles: 'id, noteId, fileId',
    });

    // v15 — вложенные папки заметок: parentId у папки (+ индекс для выборки
    // детей), как parentId у проектов в v8. Существующие папки нормализуются
    // в parentId=null (корень).
    this.version(15)
      .stores({ noteFolders: 'id, sortOrder, parentId' })
      .upgrade((tx) =>
        tx
          .table('noteFolders')
          .toCollection()
          .modify((f) => {
            if (f.parentId === undefined) f.parentId = null;
          }),
      );

    // v16 — дневник уровня энергии. Уникальный индекс &date держит правило
    // «одна отметка в день» на уровне БД, как &[habitId+date] у привычек:
    // повторная отметка правит существующую строку, а не плодит вторую.
    // Только новая таблица, существующие не трогаются → upgrade не нужен.
    this.version(16).stores({
      energyLogs: 'id, &date',
    });

    // v17 — раздел ИИ: чаты с языковой моделью. Только новые таблицы,
    // существующие не трогаются → upgrade-функция не нужна.
    // Индексы минимальные: чаты сортируем по lastMessageAt, сообщения читаем
    // выборкой по chatId. Составной [chatId+createdAt] не добавляем — его не
    // использовал бы ни один запрос, а каждый лишний индекс это запись на
    // каждое сообщение.
    this.version(17).stores({
      llmChats: 'id, lastMessageAt',
      llmMessages: 'id, chatId',
    });

    // v18 — составной индекс для хвоста семейной переписки.
    //
    // Лента читала таблицу сообщений целиком: вместе со строками приезжали
    // фотографии, голосовые и куски файлов, лежащие в тех же записях, — и так
    // на каждое входящее сообщение. По этому индексу берутся только последние
    // сообщения группы, а история остаётся на диске, пока за ней не поднимутся.
    this.version(18).stores({
      familyMessages: 'clientMsgId, familyId, seq, createdAt, [familyId+seq]',
    });

    // v19 — индекс updatedAt всем синхронизируемым таблицам.
    //
    // Отправка изменений читала КАЖДУЮ из двадцати таблиц целиком и отбирала
    // свежие строки уже в памяти. Среди них noteFiles — куски вложений по
    // 400 КиБ, и tasks с фотографиями прямо в строке. А запускается это через
    // полторы секунды после каждой правки: печатаешь заметку — и на каждую
    // паузу в наборе поднимается вся база.
    //
    // С индексом берётся ровно окно [lastPushAt, cutoff) — обычно одна-две
    // строки. Индексы перечислены полностью: Dexie удаляет те, что не назвали.
    this.version(19).stores({
      projects: 'id, sortOrder, parentId, updatedAt',
      tasks: 'id, projectId, goalId, dueDate, completedAt, *tags, origin, updatedAt',
      goals: 'id, status, updatedAt',
      habits: 'id, goalId, updatedAt',
      habitLogs: 'id, habitId, date, &[habitId+date], updatedAt',
      notes: 'id, *tags, pinned, folderId, updatedAt',
      noteFiles: 'id, noteId, fileId, updatedAt',
      noteFolders: 'id, sortOrder, parentId, updatedAt',
      learningItems: 'id, status, goalId, updatedAt',
      learningLogs: 'id, itemId, date, updatedAt',
      expenseItems: 'id, category, kind, updatedAt',
      savingsGoals: 'id, sortOrder, archivedAt, updatedAt',
      savingsDeposits: 'id, goalId, date, updatedAt',
      energyItems: 'id, category, updatedAt',
      energyLogs: 'id, &date, updatedAt',
      placeItems: 'id, kind, status, updatedAt',
      metrics: 'id, updatedAt',
      metricLogs: 'id, metricId, date, updatedAt',
      reminderSections: 'id, sortOrder, updatedAt',
      reminderItems: 'id, sectionId, sortOrder, updatedAt',
    });

    // v20 — фотографии задач переезжают из строки задачи в свою таблицу.
    //
    // Раньше снимки лежали полем `photos` прямо в задаче. Списки задач читают
    // таблицу целиком на десятке экранов живыми подписками — и поднимали в
    // память все фотографии ради заголовков и дат. А синхронизация шифрует
    // строку задачи одним куском: десяток снимков перерастал лимит колонки на
    // сервере, и такая задача не уезжала на второе устройство никогда.
    //
    // Индексы: taskId — выбрать снимки одной задачи; photoId — собрать один
    // снимок из кусков; updatedAt — обязателен, по нему синхронизация ищет
    // свежие записи (без него push падает с ошибкой схемы).
    this.version(20).stores({
      taskPhotos: 'id, taskId, photoId, updatedAt',
    });

    // v21 — у материала обучения появляется план: список частей своей таблицей.
    //
    // Не массивом внутри материала, хотя так было бы на четыре строки короче.
    // Синхронизация разрешает конфликты по `updatedAt` ЦЕЛОЙ строки и кладёт
    // её через put целиком: план из шестидесяти частей уезжал бы к тому
    // устройству, что сохранило последним, вместе со всеми чужими галочками.
    // Отдельные строки расходятся по одной — теряется отметка, а не план.
    //
    // Индексы: itemId — собрать план одного материала; updatedAt — обязателен,
    // по нему push ищет свежие записи (без него падает весь обмен).
    this.version(21).stores({
      learningParts: 'id, itemId, updatedAt',
    });

    // v22 — файлы любого формата у задач, чанками (см. TaskFile в types.ts).
    // Индексы: taskId — собрать вложения одной задачи; fileId — все куски
    // одного файла; updatedAt — по нему push ищет свежие записи.
    this.version(22).stores({
      taskFiles: 'id, taskId, fileId, updatedAt',
    });

    // v23 — тренировки (раздел «Здоровье»). date — календарь и сводки по
    // периодам; updatedAt — для push синхронизации.
    this.version(23).stores({
      workouts: 'id, date, updatedAt',
    });
  }
}

export const db = new LifeHearthDB();

export const DEFAULT_SETTINGS: Settings = {
  id: 'app',
  theme: 'dark',
  weekStart: 1,
  lastBackupAt: null,
  schemaVersion: SCHEMA_VERSION,
  updatedAt: new Date().toISOString(),
};

/** Создаёт строку настроек при первом запуске. Вызывается из main.tsx. */
export async function ensureSettings(): Promise<void> {
  const existing = await db.settings.get('app');
  if (!existing) await db.settings.put(DEFAULT_SETTINGS);
}
