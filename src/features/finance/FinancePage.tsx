import { useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { useLoaded } from '../../hooks/useLoaded';
import {
  Car,
  CircleEllipsis,
  Gamepad2,
  Repeat,
  Shirt,
  ShoppingBasket,
  Smartphone,
  Stethoscope,
  TrendingUp,
  type LucideIcon,
} from 'lucide-react';
import { Fab } from '../../components/layout/Fab';
import { Screen } from '../../components/layout/Screen';
import { EmptyState } from '../../components/ui/EmptyState';
import { SegmentedControl } from '../../components/ui/SegmentedControl';
import { db } from '../../db/db';
import { alive } from '../../db/repo';
import type { ExpenseItem, ExpenseRecurrence } from '../../db/types';
import { financeSummary, formatRub, upcomingExpenses, wrapRub } from '../../lib/finance';
import { formatRu, todayKey } from '../../lib/dates';
import { ExpenseSheet } from './ExpenseSheet';
import { SavingsSection } from './SavingsSection';
import { t, tPlur } from '../../lib/i18n';
import { ICON } from '../../components/ui/icons';
import {
  GFinance as Wallet,
  GHome,
} from '../../components/ui/glyphs';

const RECURRENCE_LABEL: Record<ExpenseRecurrence, string> = {
  monthly: 'Ежемесячно',
  weekly: 'Еженедельно',
  yearly: 'Ежегодно',
  oneoff: 'Разово',
};

/** Значок категории в плитке строки. Категория — свободный текст, поэтому
 *  незнакомая получает нейтральный «прочее», а доход — свой знак. */
const CATEGORY_ICON: Record<string, LucideIcon> = {
  Жильё: GHome as LucideIcon,
  Еда: ShoppingBasket,
  Транспорт: Car,
  Подписки: Repeat,
  Здоровье: Stethoscope,
  Связь: Smartphone,
  Развлечения: Gamepad2,
  Одежда: Shirt,
};

/** Оттенки золота для полосы категорий: от яркого к приглушённому. Полоса и
 *  точки легенды — декор, текста на них нет, поэтому порог 4.5 к ним не
 *  относится; подписи рядом — обычным цветом текста. */
const SHADES = ['bg-lh-accent', 'bg-lh-accent/70', 'bg-lh-accent/45', 'bg-lh-text-secondary/40'];
const MAX_SEGMENTS = 4;

function SummaryCard({ items }: { items: ExpenseItem[] }) {
  // Месяц/Год: одна карточка, суммы (включая категории) пересчитываются —
  // категории за год видны без второго списка, ничего не дублируем.
  const [period, setPeriod] = useState<'month' | 'year'>('month');
  const summary = financeSummary(items);
  const mul = period === 'year' ? 12 : 1;
  const balancePositive = summary.balance >= 0;

  // Больше четырёх отрезков полоса не различает: хвост сворачивается в «Прочее».
  const cats = summary.byCategory;
  const segments =
    cats.length <= MAX_SEGMENTS
      ? cats
      : [
          ...cats.slice(0, MAX_SEGMENTS - 1),
          {
            category: t('Прочее'),
            amount: cats.slice(MAX_SEGMENTS - 1).reduce((s, c) => s + c.amount, 0),
          },
        ];

  return (
    <section className="card p-5">
      <div className="flex items-center justify-between gap-3">
        <p className="text-xs text-lh-text-secondary">
          {period === 'month' ? t('Расходы в месяц') : t('Расходы в год')}
        </p>
        <div className="w-32 shrink-0">
          <SegmentedControl
            options={[
              { value: 'month', label: t('Месяц') },
              { value: 'year', label: t('Год') },
            ]}
            value={period}
            onChange={setPeriod}
          />
        </div>
      </div>
      <p className="mt-1 text-3xl font-light leading-tight tracking-tight tabular-nums">
        {wrapRub(summary.expense * mul)}
      </p>
      <p className="mt-1 text-xs text-lh-text-secondary">
        ≈ {period === 'month'
          ? t('{amount} в год', { amount: formatRub(summary.expense * 12) })
          : t('{amount} в месяц', { amount: formatRub(summary.expense) })}
      </p>

      {segments.length > 0 && summary.expense > 0 && (
        <>
          <div className="mt-5 flex h-2 gap-[2px] overflow-hidden rounded-full" aria-hidden>
            {segments.map((c, i) => (
              <span
                key={c.category}
                className={`h-full ${SHADES[i]}`}
                style={{ width: `${(100 * c.amount) / summary.expense}%` }}
              />
            ))}
          </div>
          {/* Легенда в две колонки. min-w-0 + truncate у названия и
              переносимая сумма: на 320px колонка ~115px, «Развлечения 12 000»
              туда целиком не встаёт, и раньше хвост срезался краем карточки. */}
          <ul className="mt-3 grid grid-cols-2 gap-x-4 gap-y-2 text-xs">
            {segments.map((c, i) => (
              <li key={c.category} className="flex min-w-0 items-center gap-2">
                <span className={`size-2 shrink-0 rounded-sm ${SHADES[i]}`} aria-hidden />
                <span className="min-w-0 flex-1 truncate">{t(c.category)}</span>
                <span className="text-right tabular-nums text-lh-text-secondary">
                  {wrapRub(c.amount * mul).replace(/\s?₽$/, '')}
                </span>
              </li>
            ))}
          </ul>
        </>
      )}

      {/* min-w-0 на обеих колонках обязательно: без него блок не сжимается
          ниже min-content своей суммы, пара распирает карточку, и хвост
          уезжает под .card{overflow:hidden}. Суммы ещё и переносимые (wrapRub). */}
      {(summary.income > 0 || summary.balance !== 0) && (
        <div className="mt-5 grid grid-cols-2 border-t border-lh-border pt-4">
          <div className="min-w-0 pr-4">
            <p className="text-xs text-lh-text-secondary">{t('Доход')}</p>
            <p className="mt-0.5 text-lg font-light tabular-nums">{wrapRub(summary.income * mul)}</p>
          </div>
          <div className="min-w-0 border-l border-lh-border pl-4">
            <p className="text-xs text-lh-text-secondary">{t('Баланс')}</p>
            <p
              className={`mt-0.5 text-lg font-light tabular-nums ${balancePositive ? 'text-success' : 'text-danger'}`}
            >
              {balancePositive && summary.balance > 0 ? '+' : ''}
              {wrapRub(summary.balance * mul)}
            </p>
          </div>
        </div>
      )}
    </section>
  );
}

function ExpenseRow({ item, onOpen }: { item: ExpenseItem; onOpen: () => void }) {
  const isIncome = item.kind === 'income';
  const Icon = isIncome ? TrendingUp : (CATEGORY_ICON[item.category ?? ''] ?? CircleEllipsis);
  const meta = [
    !isIncome && item.category ? t(item.category) : null,
    RECURRENCE_LABEL[item.recurrence] ? t(RECURRENCE_LABEL[item.recurrence]).toLowerCase() : null,
    item.active ? null : t('не учитывается'),
  ]
    .filter(Boolean)
    .join(' · ');
  // Строка — div с onClick, не кнопка: e2e «кнопка +» требует, чтобы на
  // нулевой прокрутке краем ленты не резалось управление, а строки длинного
  // списка на сгибе — норма прокрутки. Так было и до редизайна.
  return (
    <div onClick={onOpen} className="flex items-center gap-3 px-4 py-3 active:opacity-80">
      <span className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-lh-surface-2 text-lh-accent">
        <Icon size={ICON.action} />
      </span>
      {/* Пол ширины вместо min-w-0: название — главное в строке, и оно не
          должно проигрывать сумме, иначе truncate ужимает его до буквы. */}
      <div className="min-w-[6rem] flex-1">
        <p className="truncate">{item.title}</p>
        <p className="mt-0.5 text-xs text-lh-text-secondary">{meta}</p>
      </div>
      {/* Без shrink-0: когда названию некуда сжиматься, сумма переносится —
          обрезать её нельзя, обрезанное число врёт. */}
      <span
        className={`text-right tabular-nums ${
          !item.active ? 'text-lh-text-secondary' : isIncome ? 'text-success' : ''
        }`}
      >
        {isIncome ? '+' : ''}
        {wrapRub(item.amount)}
      </span>
    </div>
  );
}

const LIST_LIMIT = 5;

export function FinancePage() {
  const [sheetOpen, setSheetOpen] = useState(false);
  const [editing, setEditing] = useState<ExpenseItem | null>(null);
  const [kind, setKind] = useState<'expense' | 'income'>('expense');
  const [showAll, setShowAll] = useState(false);

  const rows = useLiveQuery(() => db.expenseItems.toArray(), []);
  const loaded = useLoaded(rows);
  const items = alive(rows ?? []).sort((a, b) => a.sortOrder - b.sortOrder);

  const expenses = items.filter((i) => i.kind === 'expense');
  const incomes = items.filter((i) => i.kind === 'income');
  const upcoming = upcomingExpenses(items, todayKey(), 14);

  // Список показывает одну сторону; если её нет — другую, чтобы пустая
  // секция не прятала записи за ссылкой.
  const side = kind === 'income' ? (incomes.length ? 'income' : 'expense') : expenses.length ? 'expense' : 'income';
  const list = side === 'income' ? incomes : expenses;
  const other = side === 'income' ? expenses : incomes;
  const visible = showAll ? list : list.slice(0, LIST_LIMIT);

  const openCreate = () => {
    setEditing(null);
    setSheetOpen(true);
  };
  const openEdit = (item: ExpenseItem) => {
    setEditing(item);
    setSheetOpen(true);
  };

  return (
    <Screen title={t('Финансы')} backTo="/home">
      <div className="space-y-6">
        {items.length === 0 ? (
          loaded && (
            <EmptyState
              icon={Wallet}
              title={t('Пока нет трат и доходов')}
              hint={t('Добавьте ежемесячные траты — аренду, подписки, еду — и увидите, сколько уходит в месяц и в год.')}
            />
          )
        ) : (
          <>
            <SummaryCard items={items} />

            {upcoming.length > 0 && (
              <section>
                <h2 className="mb-2.5 px-1 lh-section">{t('Ближайшие списания')}</h2>
                {/* Карточки в ряд; больше трёх — горизонтальная прокрутка внутри
                    ряда, страница вширь не растёт. */}
                <div className="-mx-4 flex gap-2.5 overflow-x-auto px-4 pb-1">
                  {upcoming.map(({ item, date, daysLeft }) => {
                    const soon = daysLeft <= 1;
                    return (
                      <button
                        key={item.id}
                        type="button"
                        onClick={() => openEdit(item)}
                        title={formatRu(date)}
                        className="card min-w-[7.5rem] flex-1 basis-0 p-3.5 text-left active:opacity-80"
                      >
                        <span className={`block text-2xs ${soon ? 'text-warning' : 'text-lh-text-secondary'}`}>
                          {daysLeft === 0
                            ? t('сегодня')
                            : daysLeft === 1
                              ? t('завтра')
                              : t('через {n}', { n: tPlur(daysLeft, ['день', 'дня', 'дней']) })}
                        </span>
                        <span className="mt-1 block truncate text-sm">{item.title}</span>
                        <span className="block text-sm tabular-nums text-lh-text-secondary">
                          {wrapRub(item.amount)}
                        </span>
                      </button>
                    );
                  })}
                </div>
              </section>
            )}

            <section>
              <div className="mb-2.5 flex items-center justify-between gap-3 px-1">
                <h2 className="lh-section">
                  {side === 'income' ? t('Доходы') : t('Расходы')} · {list.length}
                </h2>
                {other.length > 0 && (
                  <button
                    type="button"
                    onClick={() => {
                      setKind(side === 'income' ? 'expense' : 'income');
                      setShowAll(false);
                    }}
                    className="-my-3 min-h-11 text-xs text-lh-accent active:opacity-70"
                  >
                    {side === 'income' ? t('Расходы') : t('Доходы')} · {other.length}
                  </button>
                )}
              </div>
              <div className="card divide-y divide-lh-border">
                {visible.map((item) => (
                  <ExpenseRow key={item.id} item={item} onOpen={() => openEdit(item)} />
                ))}
                {list.length > LIST_LIMIT && (
                  <button
                    type="button"
                    onClick={() => setShowAll((v) => !v)}
                    className="flex h-12 w-full items-center justify-center text-sm text-lh-accent active:opacity-70"
                  >
                    {showAll
                      ? t('Свернуть')
                      : side === 'income'
                        ? t('Показать все доходы')
                        : t('Показать все расходы')}
                  </button>
                )}
              </div>
            </section>
          </>
        )}

        <SavingsSection />
      </div>

      <Fab onClick={openCreate} />
      <ExpenseSheet open={sheetOpen} onClose={() => setSheetOpen(false)} item={editing} />
    </Screen>
  );
}
