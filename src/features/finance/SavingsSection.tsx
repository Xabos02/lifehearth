import { useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { PiggyBank } from 'lucide-react';
import {
  GCheck as Check,
  GPlus as Plus,
} from '../../components/ui/glyphs';
import { db } from '../../db/db';
import { alive, now, update } from '../../db/repo';
import type { SavingsDeposit, SavingsGoal } from '../../db/types';
import { formatRub, wrapRub } from '../../lib/finance';
import { goalSaved, isReached, monthlyNeeded, progressPct, remaining } from '../../lib/savings';
import { todayKey } from '../../lib/dates';
import { SavingsGoalSheet } from './SavingsGoalSheet';
import { getLang, t } from '../../lib/i18n';
import { DepositSheet } from './DepositSheet';
import { ICON } from '../../components/ui/icons';

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
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onEdit();
        }
      }}
      className="card p-4 active:opacity-90"
    >
      <div className="mb-3.5 flex items-center gap-2.5">
        <span
          className="flex size-10 shrink-0 items-center justify-center rounded-xl text-lg leading-none"
          style={{ background: `color-mix(in oklch, ${goal.color} 16%, transparent)` }}
        >
          {goal.emoji}
        </span>
        <span className="min-w-0 flex-1 truncate font-semibold">{goal.title}</span>
        {/* Процент — цветом текста, не цели: пастельные цвета палитры на
            светлой карточке давали 1,5–2,8 против нормы 4,5. Цвет несёт кольцо
            и полоса, числу он не нужен. */}
        <span className="shrink-0 font-semibold tracking-tight">{Math.round(pct)}%</span>
      </div>

      <div className="h-2.5 overflow-hidden rounded-full bg-surface-2">
        <div
          className="h-full rounded-full transition-[width] duration-300"
          style={{
            width: `${pct}%`,
            background: reached
              ? 'var(--app-success)'
              : goal.color,
          }}
        />
      </div>

      {/* До 380px значение и цель стоят в столбик: в строку они физически не
          влезают — на 320px внутри карточки 250px против 135 + 8 + 132 = 275,
          и хвост правого блока молча срезался .card{overflow:hidden}. Обрезался
          именно знак валюты («цель 3 500 00» вместо «цель 3 500 000 ₽») — это
          уже другое сообщение, а не косметика.
          min-w-0 + wrapRub — страховка для широкой раскладки: без min-w-0
          flex-элемент не сожмётся ниже min-content своей суммы, а без обычных
          пробелов сумма остаётся монолитом и переносить её некуда. С ними
          длинные суммы переносятся по разрядам вместо тихой обрезки. */}
      <div className="mt-3 flex flex-col gap-0.5 min-[380px]:flex-row min-[380px]:items-baseline min-[380px]:justify-between min-[380px]:gap-2">
        <span className="min-w-0 text-lg font-semibold tabular-nums tracking-tight">
          {wrapRub(saved)}
        </span>
        <span className="min-w-0 text-sm text-muted tabular-nums">
          {t('цель')} {wrapRub(goal.targetAmount)}
        </span>
      </div>

      <div className="mt-2.5 flex items-center justify-between gap-3">
        {reached ? (
          <span className="flex items-center gap-1.5 text-sm font-semibold text-success">
            <Check size={ICON.action} /> {t('Цель достигнута')}
          </span>
        ) : (
          // Та же болезнь в узком боксе: рядом стоит shrink-0-кнопка, строке
          // остаётся ~131px на 320px, а «1 041 667 ₽/мес» с неразрывными
          // пробелами — неразбиваемый кусок под 120px. Обычные пробелы дают
          // строке точки переноса, иначе хвост уходит под overflow:hidden.
          <span className="min-w-0 text-sm text-muted">
            {/* Порядок слов различается («осталось X» / «X left») — ветка, не словарь. */}
            {getLang() === 'en' ? (
              <>
                <b className="text-text tabular-nums">{wrapRub(rem)}</b> left
              </>
            ) : (
              <>
                осталось <b className="text-text tabular-nums">{wrapRub(rem)}</b>
              </>
            )}
            {monthly ? ` · ${t('по {sum}/мес', { sum: wrapRub(monthly) })}` : ''}
          </span>
        )}
        {reached ? (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onClaim();
            }}
            className="shrink-0 rounded-xl bg-surface-2 px-4 py-2.5 text-sm font-semibold active:opacity-70"
          >
            {t('Забрать')}
          </button>
        ) : (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onDeposit();
            }}
            // Тон цели подложкой, а не заливкой под белый текст: белое ни на
            // одном из восьми цветов палитры не читалось (1,5–2,8). Высота
            // py-2.5 — 44px касания.
            className="shrink-0 rounded-xl px-4 py-2.5 text-sm font-bold text-text active:opacity-80"
            style={{ background: `color-mix(in oklab, ${goal.color} 26%, transparent)` }}
          >
            {t('Пополнить')}
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
  const claim = (g: SavingsGoal) => {
    // Необратимо с экрана: архивную цель ни один экран пока не показывает.
    if (!window.confirm(t('Забрать накопленное и убрать цель из списка? История пополнений останется в базе.'))) return;
    void update(db.savingsGoals, g.id, { archivedAt: now() });
  };

  return (
    <section>
      <div className="mb-2 flex items-end justify-between gap-2 px-1">
        <h2 className="flex items-center gap-1.5 px-1 text-sm font-semibold text-muted">
          <PiggyBank size={ICON.inline} className="shrink-0" />
          {t('Накопления')}
        </h2>
        {goals.length > 0 && (
          <div className="text-right">
            <p className="text-2xs font-medium text-muted">{t('Всего накоплено')}</p>
            <p className="font-bold tabular-nums tracking-tight">{formatRub(total)}</p>
          </div>
        )}
      </div>

      <div className="space-y-3">
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

        <button
          type="button"
          onClick={openNew}
          className="flex w-full items-center justify-center gap-2 rounded-2xl border border-dashed border-border py-3.5 text-sm font-semibold text-muted active:opacity-70"
        >
          <Plus size={ICON.action} /> {goals.length === 0 ? t('Цель накопления') : t('Новая цель')}
        </button>
      </div>

      <SavingsGoalSheet open={goalSheet} onClose={() => setGoalSheet(false)} goal={editingGoal} />
      <DepositSheet
        open={depositGoal !== null}
        onClose={() => setDepositGoal(null)}
        goal={depositGoal}
      />
    </section>
  );
}
