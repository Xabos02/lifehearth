import { useEffect, useMemo, useState } from 'react';
import { useLocation } from 'react-router';
import { useLiveQuery } from 'dexie-react-hooks';
import {
  Lightbulb,
  Package,
  Plane,
  UtensilsCrossed,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { Fab } from '../../components/layout/Fab';
import { Screen } from '../../components/layout/Screen';
import { Chip, ChipRow } from '../../components/ui/Chip';
import { EmptyState } from '../../components/ui/EmptyState';
import { SearchField } from '../../components/ui/Input';
import { db } from '../../db/db';
import { alive } from '../../db/repo';
import type { PlaceItem, PlaceKind, PlaceStatus } from '../../db/types';
import { PlaceSheet } from './PlaceSheet';
import { t } from '../../lib/i18n';
import { ICON } from '../../components/ui/icons';
import { HIT_SLOP_44 } from '../../components/ui/hitSlop';
import { APPLE_MAPS_URL } from '../../lib/consent';
import {
  GPlaces as MapPin,
  GExternalLink as ExternalLink,
} from '../../components/ui/glyphs';

const KIND_ICONS: Record<PlaceKind, LucideIcon> = {
  place: MapPin,
  thing: Package,
  tip: Lightbulb,
  food: UtensilsCrossed,
  travel: Plane,
};

const KIND_LABELS: Record<PlaceKind, string> = {
  place: 'Места',
  thing: 'Вещи',
  tip: 'Советы',
  food: 'Еда',
  travel: 'Путешествия',
};

const STATUS_LABELS: Record<PlaceStatus, string> = {
  idea: 'Идея',
  want: 'Хочу',
  done: 'Был',
};

const KIND_ORDER: PlaceKind[] = ['place', 'thing', 'tip', 'food', 'travel'];

/** Открывает адрес в Картах (на iPhone/Mac — приложение Apple Карты).
 *  Только по нажатию и без согласия: в окне «Что уходит с телефона» это
 *  раскрыто строкой «И без согласия». noreferrer — картам достаётся адрес
 *  места, но не адрес приложения. */
function openMaps(location: string) {
  window.open(`${APPLE_MAPS_URL}?q=${encodeURIComponent(location)}`, '_blank', 'noopener,noreferrer');
}

type KindFilter = 'all' | PlaceKind;

function PlaceCard({ item, onOpen }: { item: PlaceItem; onOpen: () => void }) {
  const Icon = KIND_ICONS[item.kind];
  return (
    <div
      id={`place-${item.id}`}
      onClick={onOpen}
      className="card active:opacity-90"
    >
      {item.photo && <img src={item.photo} alt="" className="h-40 w-full object-cover" />}
      <div className="flex items-start gap-3 p-4">
        {item.location ? (
          <button
            type="button"
            aria-label={t('Открыть на карте')}
            onClick={(e) => {
              e.stopPropagation();
              openMaps(item.location);
            }}
            className={`flex size-10 shrink-0 items-center justify-center rounded-xl tile-accent text-accent active:opacity-70 ${HIT_SLOP_44}`}
          >
            <MapPin size={ICON.header} />
          </button>
        ) : (
          <div className="flex size-10 shrink-0 items-center justify-center rounded-xl tile-accent text-accent">
            <Icon size={ICON.header} />
          </div>
        )}
        <div className="min-w-0 flex-1">
          <div className="flex items-start gap-2">
            <p className="min-w-0 flex-1 font-semibold">{item.title}</p>
            <span
              className={`shrink-0 rounded-full bg-surface-2 px-2 py-0.5 text-2xs ${
                item.status === 'done' ? 'text-success' : 'text-muted'
              }`}
            >
              {t(STATUS_LABELS[item.status])}
            </span>
          </div>
          {item.description && (
            <p className="mt-0.5 line-clamp-2 text-sm text-muted">{item.description}</p>
          )}
          {item.source && (
            <p className="mt-1 text-xs text-muted">{t('от')} {item.source}</p>
          )}
          {item.location && (
            <p className="mt-1 flex items-center gap-1 text-xs text-muted">
              <MapPin size={ICON.inline} className="shrink-0" />
              <span className="truncate">{item.location}</span>
            </p>
          )}
          {item.tags.length > 0 && (
            <div className="mt-2 flex flex-wrap gap-1.5">
              {item.tags.map((tag) => (
                <span
                  key={tag}
                  className="rounded-full bg-surface-2 px-2 py-0.5 text-2xs text-muted"
                >
                  {tag}
                </span>
              ))}
            </div>
          )}
          {item.link && (
            <a
              href={/^[a-z][a-z0-9+.-]*:/i.test(item.link) ? item.link : `https://${item.link}`}
              target="_blank"
              rel="noopener noreferrer"
              onClick={(e) => e.stopPropagation()}
              className={`mt-2 inline-flex items-center gap-1 text-sm font-medium text-accent active:opacity-60 ${HIT_SLOP_44}`}
            >
              <ExternalLink size={ICON.inline} />
              {t('Открыть ссылку')}
            </a>
          )}
        </div>
      </div>
    </div>
  );
}

export function PlacesPage() {
  const [kindFilter, setKindFilter] = useState<KindFilter>('all');
  const [query, setQuery] = useState('');
  const [sheetOpen, setSheetOpen] = useState(false);
  const [editing, setEditing] = useState<PlaceItem | null>(null);

  const rows = useLiveQuery<PlaceItem[]>(() => db.placeItems.toArray(), []);
  const all = useMemo(() => alive(rows ?? []), [rows]);

  // Из поиска приходим с #id: докручиваем к найденной карточке, иначе список
  // открывался сверху и найденное место оставалось за экраном.
  const { hash } = useLocation();
  useEffect(() => {
    const id = hash.slice(1);
    if (!id || !rows) return;
    const el = document.getElementById(`place-${id}`);
    const sc = document.getElementById('app-scroll');
    if (!el || !sc) return;
    const r = el.getBoundingClientRect();
    const cr = sc.getBoundingClientRect();
    sc.scrollTop += r.top - cr.top - 12;
  }, [hash, rows]);

  const q = query.trim().toLowerCase();
  const items = useMemo(
    () =>
      all
        .filter((i) => (kindFilter === 'all' ? true : i.kind === kindFilter))
        .filter((i) =>
          !q
            ? true
            : `${i.title}\n${i.description}\n${i.source}\n${i.location}\n${i.tags.join(' ')}`
                .toLowerCase()
                .replace(/ё/g, 'е')
                .includes(q.replace(/ё/g, 'е')),
        )
        .sort((a, b) => b.sortOrder - a.sortOrder),
    [all, kindFilter, q],
  );

  const openCreate = () => {
    setEditing(null);
    setSheetOpen(true);
  };

  const openEdit = (item: PlaceItem) => {
    setEditing(item);
    setSheetOpen(true);
  };

  return (
    <Screen title={t('Места')} backTo="/home">
      <div className="space-y-3">
        <ChipRow>
          <Chip active={kindFilter === 'all'} onClick={() => setKindFilter('all')}>
            {t('Все')}
          </Chip>
          {KIND_ORDER.map((k) => (
            <Chip key={k} active={kindFilter === k} onClick={() => setKindFilter(k)}>
              {t(KIND_LABELS[k])}
            </Chip>
          ))}
        </ChipRow>

        <SearchField value={query} onChange={setQuery} />

        {items.length === 0 ? (
          <EmptyState
            icon={MapPin}
            title={t('Пока ничего нет')}
            hint={
              all.length === 0
                ? t('Сохраняйте места, вещи и советы, чтобы не забыть.')
                : t('Ничего не найдено. Попробуйте другой запрос или фильтр.')
            }
          />
        ) : (
          items.map((item) => (
            <PlaceCard key={item.id} item={item} onOpen={() => openEdit(item)} />
          ))
        )}
      </div>

      <Fab onClick={openCreate} />
      <PlaceSheet open={sheetOpen} onClose={() => setSheetOpen(false)} item={editing} />
    </Screen>
  );
}
