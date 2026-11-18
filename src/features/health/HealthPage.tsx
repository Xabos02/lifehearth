import { useMemo, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { db } from '../../db/db';
import { Screen } from '../../components/layout/Screen';
import { Fab } from '../../components/layout/Fab';
import { SegmentedControl } from '../../components/ui/SegmentedControl';
import { t } from '../../lib/i18n';
import { todayKey } from '../../lib/dates';
import { useLoaded } from '../../hooks/useLoaded';
import { useDayRollover } from '../../hooks/useDayRollover';
import type { Workout, WorkoutTemplate } from '../../db/types';
import { SportTab } from './SportTab';
import type { Scale } from './WorkoutCalendar';
import { MeasuresTab } from './MeasuresTab';
import { WorkoutSheet } from './WorkoutSheet';
import { TemplatesSheet } from './TemplatesSheet';
import { shownWorkouts } from './workoutRepo';
import { lastWorkout } from './workoutStats';

type Tab = 'sport' | 'health';

/** Раздел «Здоровье»: спорт (календарь тренировок, ритм, сводки) и замеры.
 *  Задача 14 набора 10.09.2026; канва «Здоровье и спорт», design/health/. */
export function HealthPage() {
  const [tab, setTab] = useState<Tab>('sport');
  // Выбранный день; null — «сегодня», какое оно сейчас. Иначе день, открытый
  // вечером, переживал полночь, и «Отметить тренировку» молча записывала
  // тренировку на вчера. Выбор сегодняшнего дня тоже идёт за сутками.
  useDayRollover();
  const [picked, setPicked] = useState<string | null>(null);
  const selected = picked ?? todayKey();
  const setSelected = (key: string) => setPicked(key === todayKey() ? null : key);
  // Дата для формы — на нажатии, а не из рендера: до минуты после полуночи
  // экран ещё прежний, а запись уже должна уйти на новые сутки.
  const selectedNow = () => picked ?? todayKey();
  const [scale, setScale] = useState<Scale>('week');
  const [sheet, setSheet] = useState<{ open: boolean; workout: Workout | null; date: string; template: WorkoutTemplate | null }>({
    open: false,
    workout: null,
    date: todayKey(),
    template: null,
  });
  const [templatesOpen, setTemplatesOpen] = useState(false);
  // Сырое значение и «загружено ли» — раздельно: иначе на первом кадре у
  // человека с сотней тренировок мелькало «Первая тренировка сегодня?».
  // По времени записи, а не по id (случайный uuid): виды одного занятия идут
  // в порядке ввода и в точках дня, и в списках (addWorkoutSession).
  const rows = useLiveQuery(async () => (await db.workouts.toArray()).sort((a, b) => a.createdAt.localeCompare(b.createdAt)), []);
  const loaded = useLoaded(rows);
  // Один и тот же список между кадрами: сводки вкладки считаются по нему.
  const workouts = useMemo(() => shownWorkouts(rows ?? []), [rows]);

  const openNew = (date: string) => setSheet({ open: true, workout: null, date, template: null });
  const openEdit = (w: Workout) => setSheet({ open: true, workout: w, date: w.date, template: null });
  // По шаблону — на выбранный день: чип в карточке дня и выбор в списке.
  const openTemplate = (tpl: WorkoutTemplate) => {
    setTemplatesOpen(false);
    setSheet({ open: true, workout: null, date: selectedNow(), template: tpl });
  };
  const close = () => setSheet((s) => ({ ...s, open: false }));

  return (
    <Screen
      title={t('Здоровье')}
      backTo="/home"
      // Вход в шаблоны — в шапке вкладки «Спорт» (канва design/template-entry,
      // вариант А): «Шаблоны ›» внизу карточки дня на 375 px стоял ниже
      // первого экрана, и новичок не находил, где завести шаблон. Шапка
      // липкая — вход виден и при прокрутке. Чипы остаются в карточке дня.
      right={
        tab === 'sport' ? (
          <button
            type="button"
            onClick={() => setTemplatesOpen(true)}
            className="min-h-11 shrink-0 rounded-lg px-2 py-2.5 text-base font-medium text-lh-accent active:opacity-60"
          >
            {t('Шаблоны')}
          </button>
        ) : undefined
      }
    >
      <div className="mb-4">
        <SegmentedControl<Tab>
          options={[
            { value: 'sport', label: t('Спорт') },
            { value: 'health', label: t('Замеры') },
          ]}
          value={tab}
          onChange={setTab}
        />
      </div>
      {tab === 'sport' ? (
        loaded && (
          <SportTab
            workouts={workouts}
            selected={selected}
            onSelect={setSelected}
            onEdit={openEdit}
            // Дата — на нажатии, как у плавающей кнопки: до минуты после
            // полуночи карточка дня ещё вчерашняя.
            onAddFor={() => openNew(selectedNow())}
            onTemplate={openTemplate}
            onTemplates={() => setTemplatesOpen(true)}
            scale={scale}
            onScale={setScale}
          />
        )
      ) : (
        <MeasuresTab />
      )}
      {tab === 'sport' && loaded && <Fab onClick={() => openNew(selectedNow())} label={t('Отметить тренировку')} />}
      <WorkoutSheet
        open={sheet.open}
        onClose={close}
        workout={sheet.workout}
        date={sheet.date}
        template={sheet.template}
        last={lastWorkout(workouts, todayKey())}
      />
      <TemplatesSheet open={templatesOpen} onClose={() => setTemplatesOpen(false)} onPick={openTemplate} />
    </Screen>
  );
}
