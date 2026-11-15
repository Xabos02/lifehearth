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
import { addDaysKey, formatRu, todayKey, toKey, WEEKDAY_LABELS } from '../../lib/dates';
import { taskOnDay } from '../../lib/taskDates';
import { cycleAllowed } from '../../lib/sections';
import { TaskItem } from '../tasks/TaskItem';
import { TaskEditSheet } from '../tasks/TaskEditSheet';
import { t, tPlur } from '../../lib/i18n';
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

  const monthName = format(grid.monthDate, 'LLLL', { locale: dateLocale() });
  const monthTitle = monthName.charAt(0).toUpperCase() + monthName.slice(1);
  const monthPrefix = monthKey.slice(0, 7);
  const monthCount = tasks.filter((x) => !x.completedAt && x.dueDate?.startsWith(monthPrefix)).length;
  // «Дальше на неделе» — что ждёт после выбранного дня, чтобы не листать дни по одному.
  const weekAhead = useMemo(() => {
    const end = addDaysKey(selectedDate, 7);
    return tasks
      .filter((x) => !x.completedAt && x.dueDate && x.dueDate > selectedDate && x.dueDate <= end)
      .sort((a, b) => a.dueDate!.localeCompare(b.dueDate!) || (a.dueTime ?? '99:99').localeCompare(b.dueTime ?? '99:99'))
      .slice(0, 6);
  }, [tasks, selectedDate]);
  const selectedWeekday = format(new Date(`${selectedDate}T00:00:00`), 'EEEE', { locale: dateLocale() });

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
      subtitle={t('Задачи по дням. Точка — на день что-то запланировано.')}
      backTo="/home"
      // «Сегодня» переехала сюда из строки месяца. Втроём с двумя стрелками она
      // забирала 170px из 252px, доступных внутри карточки на 320px, и на
      // заголовок оставалось 71px — обрезались все 12 месяцев, «Сентябрь 2026»
      // показывался как «Сент…», год не был виден ни в одном. Без неё стрелки
      // занимают 86.75px, месяцу достаётся 165px — хватает и худшему.
      right={
        <button
          type="button"
          onClick={goToday}
          className="min-h-11 shrink-0 rounded-lg px-2 py-2.5 text-sm text-lh-accent active:opacity-60"
        >
          {t('Сегодня')}
        </button>
      }
    >
      <div className="card p-3 pb-4">
        <div className="mb-2 flex items-center justify-between px-1">
          <button
            type="button"
            aria-label={t('Предыдущий месяц')}
            onClick={() => shiftMonth(-1)}
            className="flex size-11 shrink-0 items-center justify-center rounded-lg text-lh-text-secondary active:opacity-60"
          >
            <ChevronLeft size={ICON.action} />
          </button>
          <div className="min-w-0 text-center">
            <h2 className="truncate font-semibold">{monthTitle}</h2>
            <p className="text-2xs text-lh-text-secondary tabular-nums">
              {monthPrefix.slice(0, 4)}
              {monthCount > 0 && ` · ${tPlur(monthCount, ['задача', 'задачи', 'задач'])}`}
            </p>
          </div>
          <button
            type="button"
            aria-label={t('Следующий месяц')}
            onClick={() => shiftMonth(1)}
            className="flex size-11 shrink-0 items-center justify-center rounded-lg text-lh-text-secondary active:opacity-60"
          >
            <ChevronRight size={ICON.action} />
          </button>
        </div>

        <div className="grid grid-cols-7">
          {WEEKDAY_LABELS.map((label) => (
            <div key={label} className="pb-1.5 text-center text-2xs tracking-[0.06em] text-lh-text-secondary uppercase">
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
                className={`relative flex aspect-square flex-col items-center justify-center rounded-xl text-sm tabular-nums transition-colors ${
                  isSelected
                    ? 'bg-lh-accent font-semibold text-lh-bg'
                    : day.inMonth
                      ? 'text-lh-text-primary active:bg-lh-surface-2'
                      : // Дни соседних месяцев. Были text-lh-text-secondary/40 — контраст 1.76:1,
                        // то есть число видно только если знать, что оно там.
                        // Они кликабельны (переводят календарь на тот месяц),
                        // значит это управляющий элемент, а не декорация.
                        'text-lh-text-secondary'
                } ${isToday && !isSelected ? 'ring-1 ring-lh-accent' : ''}`}
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
                          : 'bg-lh-accent'
                    }`}
                  />
                )}
              </button>
            );
          })}
        </div>
        <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 border-t border-lh-border px-2 pt-3 text-2xs text-lh-text-secondary">
          <span className="flex items-center gap-1.5"><span aria-hidden className="size-1.5 rounded-full bg-lh-accent" />{t('Задачи')}</span>
          <span className="flex items-center gap-1.5"><span aria-hidden className="size-1.5 rounded-full bg-danger" />{t('Просрочено')}</span>
          <span className="flex items-center gap-1.5"><span aria-hidden className="size-3.5 rounded-[5px] ring-1 ring-lh-accent" />{t('Сегодня')}</span>
        </div>
      </div>

      <section className="mt-6">
        <div className="mb-2.5 flex items-baseline justify-between gap-2 px-1">
          <h2 className="lh-section">{t('Задачи на {date}', { date: formatRu(selectedDate) })}</h2>
          <span className="shrink-0 text-xs text-lh-text-secondary tabular-nums">
            {selectedWeekday}
            {dayTasks.length > 0 && ` · ${dayTasks.length}`}
          </span>
        </div>
        {dayTasks.length > 0 ? (
          <div className="card divide-y divide-lh-border px-4">
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
          <p className="px-1 py-3 text-sm text-lh-text-secondary">{t('На этот день задач нет')}</p>
        )}
        <button
          type="button"
          onClick={() => openTask(null)}
          className="mt-3 flex min-h-12 w-full items-center justify-center gap-2 rounded-xl border border-dashed border-lh-accent-border text-sm text-lh-accent active:opacity-60"
        >
          <Plus size={ICON.inline} /> {t('Задача на этот день')}
        </button>
      </section>

      {weekAhead.length > 0 && (
        <section className="mt-6">
          <h2 className="mb-2.5 px-1 lh-section">{t('Дальше на неделе')}</h2>
          <div className="card divide-y divide-lh-border">
            {weekAhead.map((task) => {
              const d = new Date(`${task.dueDate}T00:00:00`);
              return (
                <button
                  key={task.id}
                  type="button"
                  onClick={() => openTask(task)}
                  className="flex min-h-14 w-full items-center gap-3 px-4 py-2.5 text-left active:bg-lh-surface-2"
                >
                  <span className="w-10 shrink-0 text-center">
                    <span className="block text-2xs text-lh-text-secondary uppercase">{format(d, 'EEEEEE', { locale: dateLocale() })}</span>
                    <span className="block tabular-nums">{format(d, 'd')}</span>
                  </span>
                  <span className="min-w-0 flex-1 break-words text-sm">{task.title}</span>
                  {task.dueTime && <span className="shrink-0 text-xs text-lh-text-secondary tabular-nums">{task.dueTime}</span>}
                </button>
              );
            })}
          </div>
        </section>
      )}

      <TaskEditSheet
        open={sheetOpen}
        onClose={() => setSheetOpen(false)}
        task={editing}
        defaults={{ dueDate: selectedDate }}
      />
    </Screen>
  );
}
