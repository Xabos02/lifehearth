import { useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { PiggyBank } from 'lucide-react';
import {
  GPlus as Plus,
} from '../../components/ui/glyphs';
import { db } from '../../db/db';
import { alive, now, update } from '../../db/repo';
import type { SavingsDeposit, SavingsGoal } from '../../db/types';
import { wrapRub } from '../../lib/finance';
import { goalSaved, isReached, monthlyNeeded, progressPct, remaining } from '../../lib/savings';
import { todayKey } from '../../lib/dates';
import { SavingsGoalSheet } from './SavingsGoalSheet';
import { getLang, t } from '../../lib/i18n';
import { DepositSheet } from './DepositSheet';
import { ICON } from '../../components/ui/icons';
import { confirmAction } from '../../components/ui/confirmStore';

function GoalCard({
  goal,
  deposits,
  onEdit,
  onDeposit,
  onClaim,
}: {
  goal: SavingsGoal;
  deposits: SavingsDeposit[];
  onEdit: () => void;
  onDeposit: () => void;
  onClaim: () => void;
}) {
  const saved = goalSaved(goal.id, deposits);
  const pct = progressPct(saved, goal.targetAmount);
  const rem = remaining(saved, goal.targetAmount);
  const reached = isReached(saved, goal.targetAmount);
  const monthly = monthlyNeeded(rem, goal.targetDate, todayKey());

  return (
    <div
      role="button"
      tabIndex={0}
      aria-label={t('Изменить цель накоплений')}
      onClick={onEdit}
      onKeyDown={(e) => {
        // Enter на «Пополнить» или «Забрать» всплывает сюда, и preventDefault
        // погасил бы их собственный клик.
        if (e.target !== e.currentTarget) return;
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onEdit();
        }
      }}
      className="px-4 py-4 active:opacity-90"
    >
      <div className="flex items-baseline justify-between gap-3">
        <span className="min-w-0 flex-1 truncate">
          {goal.emoji && <span className="mr-1.5" aria-hidden>{goal.emoji}</span>}
          {goal.title}
        </span>
        {/* Процент — цветом текста, не цели: пастельные цвета палитры не
            держали 4.5. Цвет несёт полоса, числу он не нужен. */}
        <span className="shrink-0 text-xs tabular-nums text-lh-text-secondary">{Math.round(pct)}%</span>
      </div>

      <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-lh-surface-2">
        <div
          className={`h-full rounded-full transition-[width] duration-300 ${reached ? 'bg-success' : 'bg-lh-accent'}`}
          style={{ width: `${pct}%` }}
        />
      </div>

      {/* Одна переносимая строка: «X из Y ₽ · по N/мес». wrapRub даёт точки
          переноса — на 320px сумма с NBSP была монолитом, и хвост («₽»)
          молча срезался .card{overflow:hidden}. */}
      <p className="mt-2 min-w-0 text-xs tabular-nums text-lh-text-secondary">
        {reached ? (
          <span className="font-semibold text-success">{t('Цель достигнута')} · {wrapRub(saved)}</span>
        ) : (
          <>
            {t('{done} из {total}', {
              done: wrapRub(saved).replace(/\s?₽$/, ''),
              total: wrapRub(goal.targetAmount),
            })}
            {monthly
              ? ` · ${t('по {sum}/мес', { sum: wrapRub(monthly) })}`
              : ` · ${getLang() === 'en' ? `${wrapRub(rem)} left` : `осталось ${wrapRub(rem)}`}`}
          </>
        )}
      </p>

      <div className="mt-3 flex flex-wrap gap-2">
        {!reached && (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onDeposit();
            }}
            className="h-11 rounded-xl bg-lh-surface-2 px-4 text-sm text-lh-accent active:opacity-70"
          >
            {t('Пополнить')}
          </button>
        )}
        {(reached || saved > 0) && (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onClaim();
            }}
            className={`h-11 rounded-xl px-4 text-sm active:opacity-70 ${
              reached ? 'bg-lh-surface-2 font-semibold text-lh-text-primary' : 'text-lh-text-secondary'
            }`}
          >
            {t('Забрать')}
          </button>
        )}
      </div>
    </div>
  );
}

export function SavingsSection() {
  const [goalSheet, setGoalSheet] = useState(false);
  const [editingGoal, setEditingGoal] = useState<SavingsGoal | null>(null);
  const [depositGoal, setDepositGoal] = useState<SavingsGoal | null>(null);

  const goalRows = useLiveQuery(() => db.savingsGoals.toArray(), []);
  const depRows = useLiveQuery(() => db.savingsDeposits.toArray(), []);
  const goals = alive(goalRows ?? [])
    .filter((g) => !g.archivedAt)
    .sort((a, b) => a.sortOrder - b.sortOrder);
  const deposits = alive(depRows ?? []);

  const activeIds = new Set(goals.map((g) => g.id));
  const total = deposits.reduce((s, d) => (activeIds.has(d.goalId) ? s + d.amount : s), 0);

  const openNew = () => {
    setEditingGoal(null);
    setGoalSheet(true);
  };
  const openEdit = (g: SavingsGoal) => {
    setEditingGoal(g);
    setGoalSheet(true);
  };
  // Без подтверждения: цель уходит в АРХИВ, а не удаляется, и вернуть её
  // оттуда можно. Спрашивать на обратимом действии — приучать жать «Да» не
  // читая, и тогда вопрос перестаёт работать там, где он правда нужен.
  const claim = async (g: SavingsGoal) => {
    // Необратимо с экрана: архивную цель ни один экран пока не показывает.
    if (
      !(await confirmAction({
        title: t('Забрать накопленное и убрать цель из списка? История пополнений останется в базе.'),
        confirmLabel: t('Забрать'),
        danger: false,
      }))
    )
      return;
    void update(db.savingsGoals, g.id, { archivedAt: now() });
  };

  return (
    <section>
      <div className="mb-2.5 flex items-center justify-between gap-3 px-1">
        <h2 className="lh-section">{t('Накопления')}</h2>
        <button
          type="button"
          onClick={openNew}
          className="-my-3 inline-flex min-h-11 items-center gap-1 text-xs text-lh-accent active:opacity-70"
        >
          <Plus size={ICON.inline} />
          {goals.length === 0 ? t('Цель накопления') : t('Новая цель')}
        </button>
      </div>

      {goals.length > 0 ? (
        <div className="card divide-y divide-lh-border">
          <div className="px-4 py-4">
            <p className="text-xs text-lh-text-secondary">{t('Всего накоплено')}</p>
            <p className="mt-0.5 text-2xl font-light tabular-nums tracking-tight">{wrapRub(total)}</p>
          </div>
          {goals.map((g) => (
            <GoalCard
              key={g.id}
              goal={g}
              deposits={deposits}
              onEdit={() => openEdit(g)}
              onDeposit={() => setDepositGoal(g)}
              onClaim={() => claim(g)}
            />
          ))}
        </div>
      ) : (
        <button
          type="button"
          onClick={openNew}
          className="card flex w-full items-center gap-3 px-4 py-3.5 text-left active:opacity-80"
        >
          <span className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-lh-surface-2 text-lh-accent">
            <PiggyBank size={ICON.base} />
          </span>
          <span className="min-w-0 flex-1 text-sm text-lh-text-secondary">
            {t('Отложите на подушку, отпуск или крупную покупку — прогресс будет виден здесь.')}
          </span>
        </button>
      )}

      <SavingsGoalSheet open={goalSheet} onClose={() => setGoalSheet(false)} goal={editingGoal} />
      <DepositSheet
        open={depositGoal !== null}
        onClose={() => setDepositGoal(null)}
        goal={depositGoal}
      />
    </section>
  );
}
