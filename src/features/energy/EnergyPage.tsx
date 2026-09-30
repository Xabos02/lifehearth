import { useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { useLoaded } from '../../hooks/useLoaded';
import { Fab } from '../../components/layout/Fab';
import { Screen } from '../../components/layout/Screen';
import { EmptyState } from '../../components/ui/EmptyState';
import { SegmentedControl } from '../../components/ui/SegmentedControl';
import { db } from '../../db/db';
import { alive } from '../../db/repo';
import { levelByDate } from '../../lib/energy';
import type { EnergyEffort, EnergyItem } from '../../db/types';
import { EnergyJournal } from './EnergyJournal';
import { EnergySheet } from './EnergySheet';
import { t } from '../../lib/i18n';
import {
  GEnergy as BatteryCharging,
} from '../../components/ui/glyphs';

type Filter = 'all' | EnergyEffort;

const EFFORT_LABEL: Record<EnergyEffort, string> = {
  low: 'Мало сил',
  medium: 'Средне',
  high: 'Много сил',
};

const EFFORT_CLASS: Record<EnergyEffort, string> = {
  low: 'text-success',
  medium: 'text-warning',
  high: 'text-lh-text-secondary',
};

function EffectivenessDots({ value }: { value: number }) {
  return (
    <div className="flex items-center gap-1" aria-label={t('Помогает на {n} из 5', { n: value })}>
      {[1, 2, 3, 4, 5].map((n) => (
        <span
          key={n}
          className={`size-1.5 rounded-full ${n <= value ? 'bg-lh-accent' : 'bg-lh-text-tertiary/30'}`}
        />
      ))}
    </div>
  );
}

function EnergyCard({ item, onOpen }: { item: EnergyItem; onOpen: () => void }) {
  return (
    <div
      onClick={onOpen}
      className="card p-4 active:opacity-90"
    >
      <div className="flex items-start justify-between gap-3">
        <p className="min-w-0 flex-1 truncate font-semibold">{item.title}</p>
        <span className={`shrink-0 text-xs font-medium ${EFFORT_CLASS[item.effort]}`}>
          {t(EFFORT_LABEL[item.effort])}
        </span>
      </div>
      {item.description && (
        <p className="mt-1 line-clamp-2 text-sm text-lh-text-secondary">{item.description}</p>
      )}
      <div className="mt-3 flex items-center justify-between gap-3">
        {item.category ? (
          <span className="shrink-0 rounded-full bg-lh-surface-2 px-2.5 py-0.5 text-2xs text-lh-text-secondary">
            {t(item.category)}
          </span>
        ) : (
          <span />
        )}
        <EffectivenessDots value={item.effectiveness} />
      </div>
    </div>
  );
}

export function EnergyPage() {
  const [filter, setFilter] = useState<Filter>('all');
  const [sheetOpen, setSheetOpen] = useState(false);
  const [editing, setEditing] = useState<EnergyItem | null>(null);

  const rows = useLiveQuery(() => db.energyItems.toArray(), []);
  const loaded = useLoaded(rows);
  const logs = useLiveQuery(() => db.energyLogs.toArray(), []);
  const byDate = levelByDate(alive(logs ?? []));
  const items = alive(rows ?? [])
    .filter((i) => filter === 'all' || i.effort === filter)
    .sort((a, b) => b.effectiveness - a.effectiveness);

  const openCreate = () => {
    setEditing(null);
    setSheetOpen(true);
  };

  const openEdit = (item: EnergyItem) => {
    setEditing(item);
    setSheetOpen(true);
  };

  return (
    <Screen title={t('Энергия')} backTo="/home">
      <div className="mb-5">
        <EnergyJournal byDate={byDate} />
      </div>

      <div className="space-y-3">
        <h2 className="lh-section px-1">{t('Что восстанавливает')}</h2>
        <div className="card p-4">
          <p className="text-sm leading-relaxed text-lh-text-secondary">
            {t('Когда ничего не хочется — выберите способ под свои силы.')}
          </p>
        </div>
        <SegmentedControl<Filter>
          options={[
            { value: 'all', label: t('Все') },
            { value: 'low', label: t('Мало сил') },
            { value: 'medium', label: t('Средне') },
            { value: 'high', label: t('Много') },
          ]}
          value={filter}
          onChange={setFilter}
        />
        {items.length === 0 ? (
          loaded && (
            <EmptyState
              icon={BatteryCharging}
              title={t('Пока нет способов')}
              hint={t('Нажмите +, чтобы добавить то, что возвращает вам силы.')}
            />
          )
        ) : (
          items.map((item) => (
            <EnergyCard key={item.id} item={item} onOpen={() => openEdit(item)} />
          ))
        )}
      </div>
      <Fab onClick={openCreate} />
      <EnergySheet open={sheetOpen} onClose={() => setSheetOpen(false)} item={editing} />
    </Screen>
  );
}
