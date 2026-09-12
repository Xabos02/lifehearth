import { useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { db } from '../../db/db';
import { alive } from '../../db/repo';
import { Screen } from '../../components/layout/Screen';
import { Fab } from '../../components/layout/Fab';
import { SegmentedControl } from '../../components/ui/SegmentedControl';
import { t } from '../../lib/i18n';
import { todayKey } from '../../lib/dates';
import { useLoaded } from '../../hooks/useLoaded';
import type { Workout } from '../../db/types';
import { SportTab } from './SportTab';
import { MeasuresTab } from './MeasuresTab';
import { WorkoutSheet } from './WorkoutSheet';

type Tab = 'sport' | 'health';

/** Раздел «Здоровье»: спорт (календарь тренировок, ритм, сводки) и замеры.
 *  Задача 14 набора 10.09.2026; канва «Здоровье и спорт», design/health/. */
export function HealthPage() {
  const [tab, setTab] = useState<Tab>('sport');
  const [selected, setSelected] = useState(todayKey());
  const [sheet, setSheet] = useState<{ open: boolean; workout: Workout | null; date: string }>({
    open: false,
    workout: null,
    date: todayKey(),
  });
  // Сырое значение и «загружено ли» — раздельно: иначе на первом кадре у
  // человека с сотней тренировок мелькало «Первая тренировка сегодня?».
  const rows = useLiveQuery(() => db.workouts.toArray(), []);
  const loaded = useLoaded(rows);
  const workouts = alive(rows ?? []);

  const openNew = (date: string) => setSheet({ open: true, workout: null, date });
  const openEdit = (w: Workout) => setSheet({ open: true, workout: w, date: w.date });
  const close = () => setSheet((s) => ({ ...s, open: false }));

  return (
    <Screen title={t('Здоровье')} backTo="/home">
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
          <SportTab workouts={workouts} selected={selected} onSelect={setSelected} onEdit={openEdit} onAddFor={openNew} />
        )
      ) : (
        <MeasuresTab />
      )}
      {tab === 'sport' && loaded && <Fab onClick={() => openNew(selected)} label={t('Отметить тренировку')} />}
      <WorkoutSheet open={sheet.open} onClose={close} workout={sheet.workout} date={sheet.date} />
    </Screen>
  );
}
