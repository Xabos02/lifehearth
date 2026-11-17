import { useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { useLoaded } from '../../hooks/useLoaded';
import { Fab } from '../../components/layout/Fab';
import { Screen } from '../../components/layout/Screen';
import { EmptyState } from '../../components/ui/EmptyState';
import { Chip, ChipRow } from '../../components/ui/Chip';
import { ICON } from '../../components/ui/icons';
import type { LucideIcon } from 'lucide-react';
import { Coffee, Dumbbell, Moon, Music, Palette, Trees, Users, Utensils } from 'lucide-react';
import { db } from '../../db/db';
import { alive } from '../../db/repo';
import { levelByDate } from '../../lib/energy';
import type { EnergyEffort, EnergyItem } from '../../db/types';
import { EnergyJournal } from './EnergyJournal';
import { EnergySheet } from './EnergySheet';
import { EnergySummary } from './EnergySummary';
import { t } from '../../lib/i18n';
import {
  GEnergy as BatteryCharging,
} from '../../components/ui/glyphs';

type Filter = 'all' | EnergyEffort;

const FILTERS: { value: Filter; label: string }[] = [
  { value: 'all', label: 'Все' },
  { value: 'low', label: 'Мало сил' },
  { value: 'medium', label: 'Средне' },
  { value: 'high', label: 'Много' },
];

const EFFORT_LABEL: Record<EnergyEffort, string> = {
  low: 'Мало сил',
  medium: 'Средне',
  high: 'Много сил',
};

const CATEGORY_ICON: Record<string, LucideIcon> = {
  Тело: Dumbbell,
  Отдых: Coffee,
  Сон: Moon,
  Общение: Users,
  Природа: Trees,
  Творчество: Palette,
  Музыка: Music,
  Еда: Utensils,
};

function EffectivenessDots({ value }: { value: number }) {
  return (
    <span className="flex items-center gap-1" aria-hidden>
      {[1, 2, 3, 4, 5].map((n) => (
        <span
          key={n}
          className={`size-1.5 rounded-full ${n <= value ? 'bg-lh-accent' : 'bg-lh-surface-2'}`}
        />
      ))}
    </span>
  );
}

function EnergyRow({ item, onOpen }: { item: EnergyItem; onOpen: () => void }) {
  const Icon = CATEGORY_ICON[item.category] ?? BatteryCharging;
  return (
    <button
      type="button"
      onClick={onOpen}
      className="flex w-full items-start gap-3 px-4 py-3.5 text-left active:bg-lh-surface-2"
    >
      <span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-lh-surface-2 text-lh-accent">
        <Icon size={ICON.base} aria-hidden />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate">{item.title}</span>
        {/* Категория — текстом: иконка есть только у предложенных, своя
            категория получает общую батарейку, а читалке иконка не видна. */}
        {item.category && (
          <span className="block truncate text-xs text-lh-text-secondary">{t(item.category)}</span>
        )}
        {item.description && (
          <span className="mt-0.5 line-clamp-2 block text-xs text-lh-text-secondary">
            {item.description}
          </span>
        )}
        <span className="mt-2 flex items-center gap-3 text-2xs text-lh-text-secondary">
          <EffectivenessDots value={item.effectiveness} />
          {t('Помогает на {n} из 5', { n: item.effectiveness })}
        </span>
      </span>
      <span className="shrink-0 text-2xs text-lh-text-secondary">
        {t(EFFORT_LABEL[item.effort]).toLowerCase()}
      </span>
    </button>
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
      <div className="space-y-6">
        <EnergySummary byDate={byDate} />
        <EnergyJournal byDate={byDate} />

        <section>
          <h2 className="lh-section mb-1 px-1">{t('Что восстанавливает')}</h2>
          <p className="mb-3 px-1 text-xs text-lh-text-secondary">
            {t('Когда ничего не хочется — выберите способ под свои силы.')}
          </p>
          <ChipRow>
            {FILTERS.map((f) => (
              <Chip
                key={f.value}
                active={filter === f.value}
                hapticOff={filter === f.value}
                onClick={() => setFilter(f.value)}
              >
                {t(f.label)}
              </Chip>
            ))}
          </ChipRow>
          <div className="mt-3">
            {items.length === 0 ? (
              loaded && (
                <EmptyState
                  icon={BatteryCharging}
                  title={t('Пока нет способов')}
                  hint={t('Нажмите +, чтобы добавить то, что возвращает вам силы.')}
                />
              )
            ) : (
              <div className="card divide-y divide-lh-border">
                {items.map((item) => (
                  <EnergyRow key={item.id} item={item} onOpen={() => openEdit(item)} />
                ))}
              </div>
            )}
          </div>
        </section>
      </div>
      <Fab onClick={openCreate} />
      <EnergySheet open={sheetOpen} onClose={() => setSheetOpen(false)} item={editing} />
    </Screen>
  );
}
