import { useMemo, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { useLoaded } from '../../hooks/useLoaded';
import { useDayRollover } from '../../hooks/useDayRollover';
import {
  GSearch as Search,
  GSun as Sun,
} from '../../components/ui/glyphs';
import { db } from '../../db/db';
import { alive } from '../../db/repo';
import type { Project, Task } from '../../db/types';
import { formatHeaderDate, todayKey } from '../../lib/dates';
import { taskOnDay } from '../../lib/taskDates';
import { Fab } from '../../components/layout/Fab';
import { Screen } from '../../components/layout/Screen';
import { EmptyState } from '../../components/ui/EmptyState';
import { QuickAddBar } from '../tasks/QuickAddBar';
import { CycleTodayLine } from '../cycle/CycleTodayLine';
import { TaskItem } from '../tasks/TaskItem';
import { TaskEditSheet } from '../tasks/TaskEditSheet';
import { DayBand } from './DayBand';
import { useDayOpenSnapshot } from './useDayOpenSnapshot';
import { RemindersBlock } from './RemindersBlock';
import { HabitsToday } from '../habits/HabitsToday';
import { EnergyTodayLine } from '../energy/EnergyTodayLine';
import { SportTodayLine } from '../health/SportTodayLine';
import { ProtectDataCard } from './ProtectDataCard';
import { IconButton } from '../../components/ui/IconButton';
import { t } from '../../lib/i18n';
import { useSettings } from '../../hooks/useSettings';

/** Приветствие по времени суток (макет «Сегодня»: крупно — приветствие,
 *  мелко над ним — дата). */
function greeting(now = new Date()): string {
  const h = now.getHours();
  if (h >= 5 && h < 12) return t('Доброе утро');
  if (h >= 12 && h < 18) return t('Добрый день');
  if (h >= 18 && h < 23) return t('Добрый вечер');
  return t('Доброй ночи');
}

/** Список задач в карточке — как в TasksPage. */
function TaskList({
  tasks,
  projectById,
  onEdit,
}: {
  tasks: Task[];
  projectById: Map<string, Project>;
  onEdit: (t: Task) => void;
}) {
  // Макет: все задачи дня — в ОДНОЙ карточке через разделители; просроченные
  // сверху (их выделяет красная полоса и подпись срока в самой строке),
  // выполненные — внизу, зачёркнутые.
  return (
    <div className="card divide-y divide-lh-border px-4">
      {tasks.map((t) => (
        <TaskItem
          key={t.id}
          task={t}
          project={t.projectId ? projectById.get(t.projectId) : null}
          onEdit={onEdit}
        />
      ))}
    </div>
  );
}

/** Главный экран — погода, напоминания (далее) и задачи на сегодня. */
export function TodayPage() {
  // Что было сделано на момент открытия экрана — по этому снимку сворачиваются
  // силы и привычки. Одно решение на полосу и на блоки: иначе они расходятся, и
  // значение показывается дважды.
  const day = useDayOpenSnapshot();
  // Раскрытие свёрнутых блоков по тапу на ячейку полосы дня. Живёт здесь, а не
  // внутри блоков: полоса и блок — разные поддеревья, общего родителя ближе нет.
  const [energyOpen, setEnergyOpen] = useState(false);
  const [habitsOpen, setHabitsOpen] = useState(false);
  const energyCollapsed = day.ready && day.energyMarked && !energyOpen;
  const habitsCollapsed = day.ready && day.habitsClosed && !habitsOpen;
  const [sheetOpen, setSheetOpen] = useState(false);
  const [editing, setEditing] = useState<Task | null>(null);
  // Открытая с вечера «Сегодня» утром перерисовывается сама: иначе совет
  // спорта оставался вчерашним, а быстрый ввод ставил задачу на вчера, и она
  // сразу была просрочена (аудит 1.64.0, H15, NEW-H-1).
  useDayRollover();
  const today = todayKey();
  // Срок новой задачи — на день, когда открыли форму: перерисовка в полночь
  // иначе меняла бы его под открытой формой, и закрытие без правок
  // спрашивало «Закрыть без сохранения?».
  const [sheetDate, setSheetDate] = useState(today);

  // Сырые значения держим отдельно: undefined значит «Dexie ещё не ответил»,
  // и это не то же самое, что «задач нет». Склей их — и на первом кадре
  // самого посещаемого экрана вспыхивает «На сегодня задач нет».
  const tasksRaw = useLiveQuery(() => db.tasks.toArray(), []);
  const projectsRaw = useLiveQuery(() => db.projects.toArray(), []);
  const loaded = useLoaded(tasksRaw, projectsRaw);
  const tasks = alive(tasksRaw ?? []);
  const projects = alive(projectsRaw ?? []);
  const projectById = useMemo(() => new Map(projects.map((p) => [p.id, p])), [projects]);

  const byPriorityThenOrder = (a: Task, b: Task) =>
    b.priority - a.priority || a.sortOrder - b.sortOrder;
  // Внутри сегодняшнего дня — по времени (утренние выше), затем приоритет.
  const byTimeThenPriority = (a: Task, b: Task) =>
    (a.dueTime ?? '99:99').localeCompare(b.dueTime ?? '99:99') || byPriorityThenOrder(a, b);

  const overdue = tasks
    .filter((t) => !t.completedAt && !t.frozenAt && t.dueDate !== null && t.dueDate < today)
    .sort((a, b) => (a.dueDate ?? '').localeCompare(b.dueDate ?? '') || byPriorityThenOrder(a, b));

  const todayOpen = tasks
    .filter((t) => !t.completedAt && !t.frozenAt && taskOnDay(t, today))
    .sort(byTimeThenPriority);
  const todayDone = tasks
    .filter((t) => Boolean(t.completedAt) && taskOnDay(t, today))
    .sort((a, b) => (b.completedAt ?? '').localeCompare(a.completedAt ?? ''));

  function openEdit(t: Task) {
    setEditing(t);
    setSheetDate(todayKey());
    setSheetOpen(true);
  }

  const settings = useSettings();
  const name = settings.profile?.name?.trim();
  const hello = name ? `${greeting()}, ${name}` : greeting();
  const totalToday = overdue.length + todayOpen.length + todayDone.length;

  const noTasks = overdue.length === 0 && todayOpen.length === 0 && todayDone.length === 0;

  return (
    <Screen
      title={hello}
      titleHiddenPrefix={t('Сегодня')}
      eyebrow={formatHeaderDate()}
      right={
        <IconButton icon={Search} label={t('Поиск')} to="/search" />
      }
    >
      {/* ПОРЯДОК ЭКРАНА: сначала день, потом всё про день.
          Замер до этой правки: лента 1773px при экране 668px, и блок «Задачи
          на сегодня» начинался на 1400-м пикселе — два экрана прокрутки от
          верха. Место занимало служебное: промо защиты данных 237px, пустой
          блок напоминаний 155px, подсказка быстрого ввода 243px. Экран, на
          который приложение открывается, показывал что угодно, кроме того,
          ради чего на него заходят.
          Погода осталась первой намеренно: это одна строка про сегодняшний
          день, а не служебная просьба, и с неё день и начинают смотреть. */}
      {/* Полоса дня вместо трёх отдельных блоков — но только для того, что уже
          сделано: отмеченные силы и закрытые привычки. Несделанное остаётся
          развёрнутым, потому что и то, и другое ставится одним тапом прямо
          отсюда. Подробности — в DayBand. */}
      <DayBand
        showEnergy={energyCollapsed}
        showHabits={habitsCollapsed}
        onToggleEnergy={() => setEnergyOpen((v) => !v)}
        onToggleHabits={() => setHabitsOpen((v) => !v)}
      />

      {noTasks ? (
        loaded && <EmptyState icon={Sun} title={t('На сегодня задач нет')} hint={t('Добавьте задачу кнопкой +')} />
      ) : (
        <section className="mb-3">
          <div className="mb-2.5 flex items-end justify-between gap-3 px-1">
            <h2 className="lh-section">{t('Задачи на сегодня')}</h2>
            <span className="text-xs tabular-nums text-lh-text-secondary">
              {t('{done} из {total} готово', { done: todayDone.length, total: totalToday })}
            </span>
          </div>
          <TaskList tasks={[...overdue, ...todayOpen, ...todayDone]} projectById={projectById} onEdit={openEdit} />
        </section>
      )}

      {/* Быстрый ввод стоит СРАЗУ ПОД задачами: он про них, и добавляют чаще
          всего после того, как посмотрели, что уже есть. */}
      <QuickAddBar defaultDueDate={today} />

      {/* Строка раздела «Женские дни». Сама решает, показываться ли: без
          включённого переключателя и без данных цикла ничего не рисует. */}
      <CycleTodayLine />

      {/* Выше привычек намеренно: отметка энергии — одна строка и один тап,
          а список привычек бывает длинным и утаскивает её под сгиб. */}
      <EnergyTodayLine collapsed={energyCollapsed} />

      {/* Строка спорта: что сегодня по ритму и отметка одним жестом. Сама
          решает, показываться ли: до первой тренировки и при скрытом
          разделе — ничего. */}
      <SportTodayLine />

      <HabitsToday collapsed={habitsCollapsed} />

      <RemindersBlock />

      {/* Служебная строка — последней: единственный блок экрана, который
          просит что-то у человека, а не показывает его день. */}
      <ProtectDataCard />

      <Fab
        onClick={() => {
          setEditing(null);
          setSheetDate(todayKey());
          setSheetOpen(true);
        }}
      />
      <TaskEditSheet
        open={sheetOpen}
        onClose={() => setSheetOpen(false)}
        task={editing}
        defaults={{ dueDate: sheetDate }}
      />
    </Screen>
  );
}
