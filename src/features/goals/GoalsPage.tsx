import { useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import {
  GChevronDown as ChevronDown,
  GChevronRight as ChevronRight,
  GTarget as Target,
} from '../../components/ui/glyphs';
import { db } from '../../db/db';
import { alive } from '../../db/repo';
import type { Goal } from '../../db/types';
import { Screen } from '../../components/layout/Screen';
import { Fab } from '../../components/layout/Fab';
import { EmptyState } from '../../components/ui/EmptyState';
import { GoalCard } from './GoalCard';
import { GoalEditSheet } from './GoalEditSheet';
import { t } from '../../lib/i18n';
import { ICON } from '../../components/ui/icons';

function bySortOrder(a: Goal, b: Goal): number {
  return a.sortOrder - b.sortOrder;
}

/** Сворачиваемая секция неактивных целей («На паузе», «Завершённые»). */
function CollapsibleSection({ title, goals }: { title: string; goals: Goal[] }) {
  const [expanded, setExpanded] = useState(false);
  if (goals.length === 0) return null;
  const Icon = expanded ? ChevronDown : ChevronRight;
  return (
    <section className="mt-5">
      <button
        type="button"
        aria-expanded={expanded}
        onClick={() => setExpanded((v) => !v)}
        className="flex w-full items-center gap-1 py-1 text-sm font-semibold text-lh-text-secondary"
      >
        <Icon size={ICON.action} />
        {title}
        <span className="font-normal">· {goals.length}</span>
      </button>
      {expanded && (
        <div className="mt-2 flex flex-col gap-3">
          {goals.map((g) => (
            <GoalCard key={g.id} goal={g} />
          ))}
        </div>
      )}
    </section>
  );
}

/** Экран «Цели»: активные сверху, паузы/завершённые — в сворачиваемых секциях. */
export function GoalsPage() {
  const goals = useLiveQuery(() => db.goals.toArray().then(alive), []);
  const [createOpen, setCreateOpen] = useState(false);

  const active = (goals ?? []).filter((g) => g.status === 'active').sort(bySortOrder);
  const paused = (goals ?? []).filter((g) => g.status === 'paused').sort(bySortOrder);
  const finished = (goals ?? [])
    .filter((g) => g.status === 'completed' || g.status === 'archived')
    .sort(bySortOrder);

  return (
    <Screen title={t('Цели')}>
      {goals !== undefined &&
        (goals.length === 0 ? (
          <EmptyState
            icon={Target}
            title={t('Пока нет целей')}
            hint={t('Создайте цель и привяжите к ней задачи и привычки — прогресс будет считаться сам')}
          />
        ) : (
          <>
            <div className="flex flex-col gap-3">
              {active.map((g) => (
                <GoalCard key={g.id} goal={g} />
              ))}
            </div>
            <CollapsibleSection title={t('На паузе')} goals={paused} />
            <CollapsibleSection title={t('Завершённые')} goals={finished} />
          </>
        ))}
      <Fab onClick={() => setCreateOpen(true)} label={t('Новая цель')} />
      <GoalEditSheet open={createOpen} onClose={() => setCreateOpen(false)} goal={null} />
    </Screen>
  );
}
