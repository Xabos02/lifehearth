import { useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { useLoaded } from '../../hooks/useLoaded';
import {
  CalendarClock,
} from 'lucide-react';
import { Fab } from '../../components/layout/Fab';
import { Screen } from '../../components/layout/Screen';
import { EmptyState } from '../../components/ui/EmptyState';
import { ProgressBar } from '../../components/ui/ProgressBar';
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
} from '../../components/ui/glyphs';

const RECURRENCE_LABEL: Record<ExpenseRecurrence, string> = {
  monthly: 'Ежемесячно',
  weekly: 'Еженедельно',
  yearly: 'Ежегодно',
  oneoff: 'Разово',
};

function SummaryCard({ items }: { items: ExpenseItem[] }) {
  // Месяц/Год: одна карточка, суммы (включая категории) пересчитываются —
  // категории за год видны без второго списка, ничего не дублируем.
  const [period, setPeriod] = useState<'month' | 'year'>('month');
  const summary = financeSummary(items);
  const mul = period === 'year' ? 12 : 1;
  const balancePositive = summary.balance >= 0;
  return (
    <div className="card p-4">
      <div className="flex items-center justify-between gap-3">
        <p className="text-sm font-medium text-lh-text-secondary">
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
      <p className="mt-1 text-3xl font-extralight tracking-tight tabular-nums">
        {wrapRub(summary.expense * mul)}
      </p>
      <p className="mt-1 text-sm text-lh-text-secondary">
        ≈ {period === 'month'
          ? t('{amount} в год', { amount: formatRub(summary.expense * 12) })
          : t('{amount} в месяц', { amount: formatRub(summary.expense) })}
      </p>

      {/* min-w-0 на обеих колонках обязательно: без него flex-элемент не сжимается
          ниже min-content своей суммы, пара блоков распирает карточку, и хвост
          уезжает под .card{overflow:hidden}. Само по себе min-w-0 лишь переносит
          обрезку внутрь блока — поэтому суммы ещё и переносимые (wrapRub). */}
      {(summary.income > 0 || summary.balance !== 0) && (
        <div className="mt-3 flex gap-2">
          {summary.income > 0 && (
            <div className="min-w-0 flex-1 rounded-xl bg-lh-surface-2 px-3 py-2">
              <p className="text-xs text-lh-text-secondary">{t('Доход')}</p>
              <p className="font-semibold tabular-nums text-success">
                {wrapRub(summary.income * mul)}
              </p>
            </div>
          )}
          <div className="min-w-0 flex-1 rounded-xl bg-lh-surface-2 px-3 py-2">
            <p className="text-xs text-lh-text-secondary">{t('Баланс')}</p>
            <p
              className={`font-semibold tabular-nums ${balancePositive ? 'text-success' : 'text-danger'}`}
            >
              {wrapRub(summary.balance * mul)}
            </p>
          </div>
        </div>
      )}

      {summary.byCategory.length > 0 && (
        <div className="mt-4 space-y-2.5">
          {summary.byCategory.map((c) => (
            <div key={c.category}>
              <div className="flex items-baseline justify-between gap-2 text-sm">
                {/* truncate сам даёт min-width:0, поэтому без явного пола название
                    ужимается до одной буквы, когда сумма за год становится длинной. */}
                <span className="min-w-[5rem] truncate text-lh-text-primary">{t(c.category)}</span>
                <span className="shrink-0 tabular-nums text-lh-text-secondary">{formatRub(c.amount * mul)}</span>
              </div>
              <div className="mt-1">
                <ProgressBar
                  value={summary.expense > 0 ? (100 * c.amount) / summary.expense : 0}
                />
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function ExpenseRow({ item, onOpen }: { item: ExpenseItem; onOpen: () => void }) {
  const isIncome = item.kind === 'income';
  const sign = isIncome ? '+' : '−';
  return (
    <div
      onClick={onOpen}
      className={`flex items-start gap-3 py-3 active:opacity-80 ${item.active ? '' : 'opacity-50'}`}
    >
      {/* Пол ширины вместо min-w-0: название — главное в строке, и оно не должно
          проигрывать сумме. Без пола truncate ужимает его до одной буквы, потому
          что вся недостача ширины достаётся ему одному. */}
      <div className="min-w-[6rem] flex-1">
        <p className="truncate font-semibold">{item.title}</p>
        <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1">
          {!isIncome && item.category && (
            <span className="truncate rounded-full border border-lh-border-strong bg-lh-surface px-2.5 py-0.5 text-xs text-lh-text-secondary">
              {t(item.category)}
            </span>
          )}
          <span className="text-xs text-lh-text-secondary">{t(RECURRENCE_LABEL[item.recurrence])}</span>
          {/* Бейдж переехал из строки заголовка сюда: там он был shrink-0 и съедал
              всю ширину названия. В переносимой мета-строке он с ним не конкурирует,
              а «выключенность» и так читается по opacity-50 всей строки. */}
          {!item.active && (
            <span className="shrink-0 rounded-full bg-lh-surface-2 px-2 py-0.5 text-2xs text-lh-text-secondary">
              {t('не учитывается')}
            </span>
          )}
        </div>
      </div>
      {/* Расходы — нейтральным серым (красный оставлен настоящим алертам),
          доходы — зелёным: список не сливается в сплошное красное полотно.
          Без shrink-0: когда названию уже некуда сжиматься, сумма переносится
          на вторую строку — обрезать её нельзя, обрезанное число врёт. */}
      <span
        className={`text-right font-semibold tabular-nums ${isIncome ? 'text-success' : 'text-lh-text-secondary'}`}
      >
        {sign}&nbsp;{wrapRub(item.amount)}
      </span>
    </div>
  );
}

export function FinancePage() {
  const [sheetOpen, setSheetOpen] = useState(false);
  const [editing, setEditing] = useState<ExpenseItem | null>(null);

  const rows = useLiveQuery(() => db.expenseItems.toArray(), []);
  const loaded = useLoaded(rows);
  const items = alive(rows ?? []).sort((a, b) => a.sortOrder - b.sortOrder);

  const expenses = items.filter((i) => i.kind === 'expense');
  const incomes = items.filter((i) => i.kind === 'income');
  const upcoming = upcomingExpenses(items, todayKey(), 14);

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
      <div className="space-y-5">
        <SavingsSection />

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
              <h2 className="mb-1.5 flex items-center gap-1.5 px-1 lh-section">
                <CalendarClock size={ICON.inline} className="shrink-0" />
                {t('Ближайшие списания')}
              </h2>
              <div className="card divide-y divide-lh-border px-4">
                {upcoming.map(({ item, date, daysLeft }) => (
                  <div key={item.id} className="flex items-baseline justify-between gap-3 py-3">
                    {/* Пол ширины названию + снятый shrink-0 у правого блока: сначала
                        обрезается название (до читаемого минимума), потом сумма с датой
                        переносятся на две строки. Раньше название схлопывалось до буквы. */}
                    <p className="min-w-[6rem] truncate font-medium">{item.title}</p>
                    <div className="text-right">
                      <p className="font-semibold tabular-nums text-lh-text-secondary">
                        {wrapRub(item.amount)}
                      </p>
                      <p className="text-xs text-lh-text-secondary">
                        {daysLeft === 0
                          ? t('сегодня')
                          : daysLeft === 1
                            ? t('завтра')
                            : t('через {n}', { n: tPlur(daysLeft, ['день', 'дня', 'дней']) })}{' '}
                        ({formatRu(date)})
                      </p>
                    </div>
                  </div>
                ))}
              </div>
            </section>
          )}

          {expenses.length > 0 && (
            <section>
              <h2 className="mb-1.5 px-1 lh-section">{t('Расходы')}</h2>
              <div className="card divide-y divide-lh-border px-4">
                {expenses.map((item) => (
                  <ExpenseRow key={item.id} item={item} onOpen={() => openEdit(item)} />
                ))}
              </div>
            </section>
          )}

          {incomes.length > 0 && (
            <section>
              <h2 className="mb-1.5 px-1 lh-section">{t('Доходы')}</h2>
              <div className="card divide-y divide-lh-border px-4">
                {incomes.map((item) => (
                  <ExpenseRow key={item.id} item={item} onOpen={() => openEdit(item)} />
                ))}
              </div>
            </section>
          )}
          </>
        )}
      </div>

      <Fab onClick={openCreate} />
      <ExpenseSheet open={sheetOpen} onClose={() => setSheetOpen(false)} item={editing} />
    </Screen>
  );
}
