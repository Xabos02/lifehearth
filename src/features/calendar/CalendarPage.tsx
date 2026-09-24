import { useMemo, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import {
  GChevronLeft as ChevronLeft,
  GChevronRight as ChevronRight,
  GPlus as Plus,
} from '../../components/ui/glyphs';
import {
  addMonths,
  eachDayOfInterval,
  endOfMonth,
  endOfWeek,
  format,
  isSameMonth,
  startOfMonth,
  startOfWeek,
} from 'date-fns';
import { dateLocale } from '../../lib/dates';
import { db } from '../../db/db';
import { alive } from '../../db/repo';
import type { Task } from '../../db/types';
import { Screen } from '../../components/layout/Screen';
import { HIT_SLOP_44 } from '../../components/ui/Checkbox';
import { addDaysKey, formatRu, todayKey, toKey, WEEKDAY_LABELS } from '../../lib/dates';
import { taskOnDay } from '../../lib/taskDates';
import { cycleAllowed } from '../../lib/sections';
import { TaskItem } from '../tasks/TaskItem';
import { TaskEditSheet } from '../tasks/TaskEditSheet';
import { t } from '../../lib/i18n';
import { ICON } from '../../components/ui/icons';

/** Дни менструации из раздела «Женские дни» — но только если человек включил
 *  отметки в настройках раздела. Отдельный хук, чтобы запрос к таблицам цикла
 *  вообще не выполнялся у тех, кто раздел не включал. */
function useCycleMarks(): Set<string> {
  const appSettings = useLiveQuery(() => db.settings.get('app'), []);
  const settings = useLiveQuery(() => db.cycleSettings.get('app'), []);
  // Пол сильнее тумблера: включённые в женском профиле отметки не должны
  // пережить смену пола на мужской.
  const on = cycleAllowed(appSettings?.gender) && Boolean(settings?.integrations.calendarMarks);
  const days = useLiveQuery(
    async () => (on ? await db.cycleDays.where('isBleedingDay').equals(1).toArray() : []),
    [on],
  );
  return useMemo(() => new Set((days ?? []).map((d) => d.date)), [days]);
}

export function CalendarPage() {
  const tasksRaw = useLiveQuery(() => db.tasks.toArray(), []);
  const projectsRaw = useLiveQuery(() => db.projects.toArray(), []);

  const tasks = alive(tasksRaw ?? []);
  const projects = alive(projectsRaw ?? []).filter((p) => !p.archivedAt);
  const projectById = useMemo(() => new Map(projects.map((p) => [p.id, p])), [projects]);

  // Месяц, отображаемый в сетке (ключ 'YYYY-MM-DD' любого дня этого месяца).
  const [monthKey, setMonthKey] = useState(() => todayKey());
  const [selectedDate, setSelectedDate] = useState(() => todayKey());

  const [editing, setEditing] = useState<Task | null>(null);
  const [sheetOpen, setSheetOpen] = useState(false);

  const today = useMemo(() => todayKey(), []);

  // Сетка месяца с понедельника: от начала первой недели до конца последней.
  const grid = useMemo(() => {
    const monthDate = startOfMonth(new Date(`${monthKey.slice(0, 7)}-01T00:00:00`));
    const from = startOfWeek(monthDate, { weekStartsOn: 1 });
    const to = endOfWeek(endOfMonth(monthDate), { weekStartsOn: 1 });
    return {
      monthDate,
      monthLabel: format(monthDate, 'LLLL yyyy', { locale: dateLocale() }),
      days: eachDayOfInterval({ start: from, end: to }).map((d) => ({
        date: d,
        key: toKey(d),
        inMonth: isSameMonth(d, monthDate),
      })),
    };
  }, [monthKey]);

  // Счётчик живых невыполненных задач по дню + флаг просрочки относительно сегодня.
  const dayStats = useMemo(() => {
    const map = new Map<string, { count: number; overdue: boolean }>();
    for (const t of tasks) {
      if (t.completedAt || !t.dueDate) continue;
      const overdue = t.dueDate < today;
      // Срок-период занимает каждый день окна, точечный — один. Потолок в
      // год — защита от кривых данных, а не рабочий предел.
      let day = t.startDate && t.startDate <= t.dueDate ? t.startDate : t.dueDate;
      for (let i = 0; i < 366 && day <= t.dueDate; i++, day = addDaysKey(day, 1)) {
        const prev = map.get(day);
        if (prev) {
          prev.count += 1;
          prev.overdue = prev.overdue || overdue;
        } else {
          map.set(day, { count: 1, overdue });
        }
      }
    }
    return map;
  }, [tasks, today]);

  const dayTasks = useMemo(
    () =>
      tasks
        .filter((t) => taskOnDay(t, selectedDate))
        .sort(
          (a, b) =>
            Number(Boolean(a.completedAt)) - Number(Boolean(b.completedAt)) ||
            (a.dueTime ?? '99:99').localeCompare(b.dueTime ?? '99:99') ||
            b.priority - a.priority ||
            a.sortOrder - b.sortOrder,
        ),
    [tasks, selectedDate],
  );

  const monthLabel = grid.monthLabel.charAt(0).toUpperCase() + grid.monthLabel.slice(1);

  function shiftMonth(delta: number) {
    setMonthKey((cur) => toKey(addMonths(new Date(`${cur.slice(0, 7)}-01T00:00:00`), delta)));
  }

  function goToday() {
    const today = todayKey();
    setMonthKey(today);
    setSelectedDate(today);
  }

  function openTask(task: Task | null) {
    setEditing(task);
    setSheetOpen(true);
  }

  const cycleMarks = useCycleMarks();

  return (
    <Screen
      title={t('Календарь')}
      backTo="/tasks"
      // «Сегодня» переехала сюда из строки месяца. Втроём с двумя стрелками она
      // забирала 170px из 252px, доступных внутри карточки на 320px, и на
      // заголовок оставалось 71px — обрезались все 12 месяцев, «Сентябрь 2026»
      // показывался как «Сент…», год не был виден ни в одном. Без неё стрелки
      // занимают 86.75px, месяцу достаётся 165px — хватает и худшему.
      right={
        <button
          type="button"
          onClick={goToday}
          className="shrink-0 rounded-lg px-2 py-2.5 text-sm font-medium text-accent active:opacity-60"
        >
          {t('Сегодня')}
        </button>
      }
    >
      <div className="card p-4">
        <div className="mb-3 flex items-center justify-between gap-2">
          {/* Название месяца не переносим: иначе шапка растёт на две строки.
              Кегль ужимается только на узких экранах: «Сентябрь 2026» при 19px
              требует 162px, при 17px — 145px, и запас до стрелок вырастает с
              3px до 20px. От 400px и шире держим исходные 19px.
              truncate (overflow:hidden) заодно снимает min-width:auto — без него
              флекс-элемент не ужимается и распирает строку. */}
          <h2 className="min-w-0 truncate text-lg font-semibold">
            {monthLabel}
          </h2>
          <div className="flex shrink-0 items-center gap-2">
            {/* Сами стрелки 32.75px (иконка 20 + p-1.5 при root 17px) — меньше 44px
                минимума. Увеличивать их нельзя: шапка распухнет и месяц срежется
                сильнее, поэтому добираем невидимой хит-зоной. */}
            <button
              type="button"
              aria-label={t('Предыдущий месяц')}
              onClick={() => shiftMonth(-1)}
              className={`shrink-0 rounded-lg p-1.5 text-muted active:opacity-60 ${HIT_SLOP_44}`}
            >
              <ChevronLeft size={ICON.header} />
            </button>
            {/* ml-1 поверх gap-2: зона 44px вылезает за кнопку на (44-32.75)/2 = 5.625px
                с каждой стороны, значит между стрелками нужно ≥11.25px, иначе тап у
                края уйдёт соседней стрелке — месяц перелистнётся не в ту сторону.
                8.5 + 4.25 = 12.75px, запас 1.5px. */}
            <button
              type="button"
              aria-label={t('Следующий месяц')}
              onClick={() => shiftMonth(1)}
              className={`ml-1 shrink-0 rounded-lg p-1.5 text-muted active:opacity-60 ${HIT_SLOP_44}`}
            >
              <ChevronRight size={ICON.header} />
            </button>
          </div>
        </div>

        <div className="grid grid-cols-7">
          {WEEKDAY_LABELS.map((label) => (
            <div key={label} className="pb-1 text-center text-xs font-medium text-muted">
              {t(label)}
            </div>
          ))}
          {grid.days.map((day) => {
            const isToday = day.key === today;
            const isSelected = day.key === selectedDate;
            const stat = dayStats.get(day.key);
            return (
              <button
                key={day.key}
                type="button"
                aria-label={`${format(day.date, 'd MMMM yyyy', { locale: dateLocale() })}${
                  isSelected ? t(', выбрано') : ''
                }${stat ? `${t(', задач: {n}', { n: stat.count })}${stat.overdue ? t(', есть просроченные') : ''}` : ''}${
                  cycleMarks.has(day.key) ? t(', менструация') : ''
                }`}
                aria-pressed={isSelected}
                onClick={() => {
                  setSelectedDate(day.key);
                  // Серый день соседнего месяца листает сетку на свой месяц:
                  // иначе выбранный день висел на краю чужого месяца.
                  if (!day.inMonth) setMonthKey(day.key);
                }}
                className={`relative flex aspect-square flex-col items-center justify-center rounded-xl text-sm transition-colors ${
                  isSelected
                    ? 'bg-accent-fill font-semibold text-white'
                    : day.inMonth
                      ? 'text-text active:bg-surface-2'
                      : // Дни соседних месяцев. Были text-muted/40 — контраст 1.76:1,
                        // то есть число видно только если знать, что оно там.
                        // Они кликабельны (переводят календарь на тот месяц),
                        // значит это управляющий элемент, а не декорация.
                        'text-muted'
                } ${isToday && !isSelected ? 'ring-1 ring-accent' : ''}`}
              >
                {/* Отметка цикла — полоса сверху, а не точка: точка снизу уже
                    занята задачами, и две точки в одной ячейке различить
                    невозможно. Форма, а не только цвет: цвет как единственный
                    носитель не работает у дальтоников и в скринридере (там
                    отметка попадает в aria-label словом). */}
                {cycleMarks.has(day.key) && (
                  <span
                    aria-hidden
                    className={`absolute inset-x-2 top-1 h-0.5 rounded-full ${
                      isSelected ? 'bg-white/80' : 'bg-danger'
                    }`}
                  />
                )}
                <span>{format(day.date, 'd')}</span>
                {stat && (
                  <span
                    className={`absolute bottom-1.5 size-1.5 rounded-full ${
                      isSelected
                        ? 'bg-white'
                        : stat.overdue
                          ? 'bg-danger'
                          : 'bg-accent'
                    }`}
                  />
                )}
              </button>
            );
          })}
        </div>
      </div>

      <section className="mt-5">
        <h2 className="mb-2 px-1 text-sm font-semibold">
          {t('Задачи на {date}', { date: formatRu(selectedDate) })}
        </h2>
        {dayTasks.length > 0 ? (
          <div className="card divide-y divide-hairline px-4">
            {dayTasks.map((t) => (
              <TaskItem
                key={t.id}
                task={t}
                project={t.projectId ? (projectById.get(t.projectId) ?? null) : null}
                onEdit={openTask}
              />
            ))}
          </div>
        ) : (
          <p className="px-1 py-3 text-sm text-muted">{t('На этот день задач нет')}</p>
        )}
        <button
          type="button"
          onClick={() => openTask(null)}
          className="mt-2 flex min-h-11 items-center gap-1.5 px-1 py-1.5 text-sm font-medium text-accent active:opacity-60"
        >
          <Plus size={ICON.inline} /> {t('Задача на этот день')}
        </button>
      </section>

      <TaskEditSheet
        open={sheetOpen}
        onClose={() => setSheetOpen(false)}
        task={editing}
        defaults={{ dueDate: selectedDate }}
      />
    </Screen>
  );
}
