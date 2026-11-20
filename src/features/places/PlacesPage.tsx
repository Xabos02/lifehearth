import { useEffect, useMemo, useState } from 'react';
import { useLocation } from 'react-router';
import { useLiveQuery } from 'dexie-react-hooks';
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
import { APPLE_MAPS_URL } from '../../lib/consent';
import {
  GFaArrowUpRightFromSquare,
  GFaBox,
  GFaLightbulb,
  GFaLocationDot,
  GFaPlane,
  GFaUtensils,
} from '../../components/ui/glyphs';
import { SECTION_BY_ID } from '../../lib/sections';

const PlacesIcon = SECTION_BY_ID.get('places')!.icon;

const KIND_ICONS: Record<PlaceKind, LucideIcon> = {
  place: GFaLocationDot,
  thing: GFaBox,
  tip: GFaLightbulb,
  food: GFaUtensils,
  travel: GFaPlane,
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

/** Кнопка-действие в карточке: «На карте», «Открыть ссылку». 44px по высоте —
 *  палец, а не курсор; клик не всплывает к карточке, иначе открывался бы шит. */
const ACTION =
  'inline-flex h-11 items-center gap-1.5 rounded-[10px] bg-lh-surface-2 px-3 text-xs font-medium text-lh-accent active:opacity-70';

function PlaceActions({ item }: { item: PlaceItem }) {
  if (!item.location && !item.link) return null;
  return (
    <div className="flex flex-wrap gap-2">
      {item.location && (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            openMaps(item.location);
          }}
          className={ACTION}
        >
          <GFaLocationDot size={ICON.inline} />
          {t('На карте')}
        </button>
      )}
      {item.link && (
        <a
          href={/^[a-z][a-z0-9+.-]*:/i.test(item.link) ? item.link : `https://${item.link}`}
          target="_blank"
          rel="noopener noreferrer"
          onClick={(e) => e.stopPropagation()}
          className={ACTION}
        >
          <GFaArrowUpRightFromSquare size={ICON.inline} />
          {t('Открыть ссылку')}
        </a>
      )}
    </div>
  );
}

function StatusBadge({ status }: { status: PlaceStatus }) {
  return (
    <span
      className={`shrink-0 rounded-full bg-lh-surface-2 px-2 py-0.5 text-2xs ${
        status === 'done' ? 'text-success' : 'text-lh-text-secondary'
      }`}
    >
      {t(STATUS_LABELS[status])}
    </span>
  );
}

function Tags({ tags }: { tags: string[] }) {
  if (tags.length === 0) return null;
  return (
    <div className="flex flex-wrap gap-1.5">
      {tags.map((tag) => (
        <span key={tag} className="rounded-full bg-lh-surface-2 px-2 py-0.5 text-2xs text-lh-text-secondary">
          {tag}
        </span>
      ))}
    </div>
  );
}

/** Карточка места. С фото — обложка с плашкой вида поверх и текст под ней;
 *  без фото — плитка с иконкой вида слева, как в макете. */
function PlaceCard({ item, onOpen }: { item: PlaceItem; onOpen: () => void }) {
  const Icon = KIND_ICONS[item.kind];
  const kind = t(KIND_LABELS[item.kind]);
  const from = item.source ? `${t('от')} ${item.source}` : '';

  if (item.photo) {
    return (
      <article id={`place-${item.id}`} onClick={onOpen} className="card overflow-hidden active:opacity-90">
        <div className="relative">
          <img src={item.photo} alt="" className="h-40 w-full object-cover" />
          <span className="absolute bottom-3 left-3 flex h-7 items-center gap-1.5 rounded-[8px] bg-[color-mix(in_oklab,var(--lh-bg)_75%,transparent)] px-2.5 text-xs text-lh-text-primary backdrop-blur-sm">
            <Icon size={ICON.inline} className="text-lh-accent" />
            {kind}
          </span>
        </div>
        <div className="flex flex-col gap-3 p-4">
          <div>
            <div className="flex items-start gap-2">
              <h2 className="min-w-0 flex-1 text-base font-semibold leading-snug">{item.title}</h2>
              <StatusBadge status={item.status} />
            </div>
            {item.description && (
              <p className="mt-1 line-clamp-2 text-sm text-lh-text-secondary">{item.description}</p>
            )}
            {item.location && <p className="mt-1 truncate text-xs text-lh-text-secondary">{item.location}</p>}
          </div>
          <Tags tags={item.tags} />
          {(from || item.location || item.link) && (
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="min-w-0 text-xs text-lh-text-secondary">{from}</span>
              <PlaceActions item={item} />
            </div>
          )}
        </div>
      </article>
    );
  }

  return (
    <article id={`place-${item.id}`} onClick={onOpen} className="card flex flex-col gap-3 p-4 active:opacity-90">
      <div className="flex gap-3.5">
        <span className="flex size-[72px] shrink-0 items-center justify-center rounded-[12px] bg-lh-surface-2 text-lh-accent">
          <Icon size={ICON.accent} />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-start gap-2">
            <p className="min-w-0 flex-1 truncate text-xs text-lh-text-secondary">
              {item.location ? `${kind} · ${item.location}` : kind}
            </p>
            <StatusBadge status={item.status} />
          </div>
          <h2 className="mt-0.5 text-base font-semibold leading-snug">{item.title}</h2>
          {item.description && (
            <p className="mt-1 line-clamp-2 text-xs text-lh-text-secondary">{item.description}</p>
          )}
          {/* «От кого» — своей строкой, как на карточке с фото: в одном абзаце
              с описанием line-clamp уносил его за многоточие. */}
          {from && <p className="mt-1 break-words text-xs text-lh-text-secondary">{from}</p>}
        </div>
      </div>
      {/* Метки и действия — на всю ширину карточки: в колонке справа от плитки
          две кнопки не помещались в строку и вставали столбиком. */}
      <Tags tags={item.tags} />
      <PlaceActions item={item} />
    </article>
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
    <Screen
      title={t('Места')}
      subtitle={t('Места, вещи и советы, которые не хочется забыть')}
      backTo="/home"
    >
      <div className="space-y-3">
        <SearchField value={query} onChange={setQuery} placeholder={t('Название, город или от кого')} />

        <ChipRow>
          <Chip active={kindFilter === 'all'} hapticOff={kindFilter === 'all'} onClick={() => setKindFilter('all')}>
            {all.length > 0 ? t('Все · {n}', { n: all.length }) : t('Все')}
          </Chip>
          {KIND_ORDER.map((k) => (
            <Chip key={k} active={kindFilter === k} hapticOff={kindFilter === k} onClick={() => setKindFilter(k)}>
              {t(KIND_LABELS[k])}
            </Chip>
          ))}
        </ChipRow>

        {items.length === 0 ? (
          <EmptyState
            icon={PlacesIcon}
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
