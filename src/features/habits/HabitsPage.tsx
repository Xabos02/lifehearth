import { useMemo, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { useLoaded } from '../../hooks/useLoaded';
import { Fab } from '../../components/layout/Fab';
import { Screen } from '../../components/layout/Screen';
import { EmptyState } from '../../components/ui/EmptyState';
import { TaskCheck } from '../../components/ui/Checkbox';
import { ProgressRing } from '../../components/ui/ProgressRing';
import { SegmentedControl } from '../../components/ui/SegmentedControl';
import { db } from '../../db/db';
import { alive } from '../../db/repo';
import type { Habit, HabitLog } from '../../db/types';
import { formatRu, todayKey } from '../../lib/dates';
import { doneDates, habitStats, isFrozenNow, scheduleLabel } from '../../lib/habits';
import { t, tPlur } from '../../lib/i18n';
import { toggleHabitDone } from './habitRepo';
import { HabitSheet } from './HabitSheet';
import { HabitLogSheet } from './HabitLogSheet';
import {
  GHabits as CalendarCheck,
} from '../../components/ui/glyphs';

type Filter = 'active' | 'archived';

export function HabitsPage() {
  const [sheetOpen, setSheetOpen] = useState(false);
  const [editing, setEditing] = useState<Habit | null>(null);
  const [logHabit, setLogHabit] = useState<Habit | null>(null);
  const [filter, setFilter] = useState<Filter>('active');
  const today = todayKey();

  const habitsRaw = useLiveQuery(() => db.habits.toArray(), []);
  const logsRaw = useLiveQuery(() => db.habitLogs.toArray(), []);
  const loaded = useLoaded(habitsRaw, logsRaw);
  const habits = alive(habitsRaw ?? []);
  const logs = alive(logsRaw ?? []);

  // habitId → его логи (нужны и даты, и значения для количественных).
  const logsByHabit = useMemo(() => {
    const m = new Map<string, HabitLog[]>();
    for (const l of logs) {
      const arr = m.get(l.habitId);
      if (arr) arr.push(l);
      else m.set(l.habitId, [l]);
    }
    return m;
  }, [logs]);

  const activeHabits = habits.filter((h) => !h.archivedAt);
  const archivedHabits = habits.filter((h) => h.archivedAt);
  // Если архив опустел, а фильтр стоял на «Архив» — не застреваем на пустом
  // экране без переключателя: показываем активные.
  const effFilter: Filter =
    filter === 'archived' && archivedHabits.length === 0 ? 'active' : filter;
  const list = (effFilter === 'active' ? activeHabits : archivedHabits)
    .slice()
    .sort((a, b) => a.sortOrder - b.sortOrder);

  const rows = list.map((habit) => {
    const hlogs = logsByHabit.get(habit.id) ?? [];
    const stats = habitStats(habit, doneDates(habit, hlogs), today);
    const todayValue = hlogs.find((l) => l.date === today)?.value ?? 0;
    return { habit, ...stats, todayValue };
  });

  const openCreate = () => {
    setEditing(null);
    setSheetOpen(true);
  };
  const openEdit = (h: Habit) => {
    setEditing(h);
    setSheetOpen(true);
  };

  const logValue = logHabit
    ? (logsByHabit.get(logHabit.id)?.find((l) => l.date === today)?.value ?? 0)
    : 0;

  return (
    <Screen title={t('Привычки')} backTo="/home">
      <div className="space-y-3">
        <div className="card p-4">
          <p className="text-sm leading-relaxed text-lh-text-secondary">
            {t(
              'Отмечайте выполнение каждый день — серия 🔥 растёт, пока не пропустите запланированный день.',
            )}
          </p>
        </div>

        {archivedHabits.length > 0 && (
          <SegmentedControl<Filter>
            options={[
              { value: 'active', label: t('Активные ({n})', { n: activeHabits.length }) },
              { value: 'archived', label: t('Архив ({n})', { n: archivedHabits.length }) },
            ]}
            value={effFilter}
            onChange={setFilter}
          />
        )}

        {rows.length === 0 ? (
          loaded && <EmptyState
            icon={CalendarCheck}
            title={effFilter === 'archived' ? t('Архив пуст') : t('Пока нет привычек')}
            hint={
              effFilter === 'archived'
                ? t('Сюда попадают привычки, убранные в архив.')
                : t('Нажмите +, чтобы добавить привычку и вести серию.')
            }
          />
        ) : (
          rows.map(({ habit, current, best, doneToday, plannedToday, todayValue, frozenInCurrent }) => {
            const counted = habit.target != null;
            const target = habit.target ?? 0;
            const pct = counted && target > 0 ? Math.min(100, (todayValue / target) * 100) : 0;
            // Заморожена «сейчас» (открытый интервал) — приглушаем карточку тем
            // же opacity, что и выключенные разделы в настройках, и прячем
            // статистику серии за честной строкой «Заморожена с …»: отметка
            // выполненности на замороженный день недоступна.
            const frozen = isFrozenNow(habit);
            const frozenSince = frozen
              ? habit.frozenRanges!.find((r) => r.to === undefined)!.from
              : null;
            return (
              <div
                key={habit.id}
                onClick={() => openEdit(habit)}
                className={`card flex items-center gap-3 p-4 active:opacity-90 ${
                  habit.archivedAt || frozen ? 'opacity-45' : ''
                }`}
              >
                <span className="text-2xl leading-none" aria-hidden>
                  {habit.emoji}
                </span>
                <div className="min-w-0 flex-1">
                  <p className="truncate font-semibold">{habit.name}</p>
                  {frozen ? (
                    <p className="mt-0.5 text-xs text-lh-text-secondary">
                      {t('Заморожена с {date}', { date: formatRu(frozenSince!) })}
                    </p>
                  ) : (
                    <>
                      <p className="mt-0.5 text-xs text-lh-text-secondary">
                        {scheduleLabel(habit.schedule)}
                        {counted && ` · ${target}${habit.unit ? ' ' + habit.unit : ''}`}
                        {current > 0 && ` · 🔥 ${current}`}
                        {best > 1 && ` · ${t('рекорд {n}', { n: best })}`}
                      </p>
                      {frozenInCurrent > 0 && (
                        <p className="text-xs text-lh-text-secondary">
                          {t('в серии заморозка')}{' '}
                          {tPlur(frozenInCurrent, ['день', 'дня', 'дней'])}
                        </p>
                      )}
                    </>
                  )}
                </div>
                {habit.archivedAt || frozen ? null : !plannedToday ? (
                  <span className="shrink-0 text-2xs text-lh-text-secondary">{t('не сегодня')}</span>
                ) : counted ? (
                  <button
                    type="button"
                    aria-label={t('Ввести значение')}
                    onClick={(e) => {
                      e.stopPropagation();
                      setLogHabit(habit);
                    }}
                  >
                    <ProgressRing
                      value={pct}
                      size={44}
                      strokeWidth={4}
                      color={habit.color}
                      label={doneToday ? '✓' : `${todayValue}`}
                    />
                  </button>
                ) : (
                  <TaskCheck
                    checked={doneToday}
                    color={habit.color}
                    onChange={() => void toggleHabitDone(habit.id, today, !doneToday)}
                  />
                )}
              </div>
            );
          })
        )}
      </div>
      <Fab onClick={openCreate} />
      <HabitSheet open={sheetOpen} onClose={() => setSheetOpen(false)} item={editing} />
      <HabitLogSheet
        open={logHabit != null}
        onClose={() => setLogHabit(null)}
        habit={logHabit}
        date={today}
        currentValue={logValue}
      />
    </Screen>
  );
}
