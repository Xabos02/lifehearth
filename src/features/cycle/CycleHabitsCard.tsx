import { useLiveQuery } from 'dexie-react-hooks';
import { db } from '../../db/db';
import type { Cycle } from '../../db/cycleTypes';
import { buildHabitsByCycle, type HabitsCycleWindow } from '../../lib/cycle/habitsByCycle';
import { t, tPlur } from '../../lib/i18n';

/** Ретроспектива «привычки по дням цикла» — только её числа с количеством
 *  наблюдений, никаких интерпретаций и советов. Компонент монтируется лишь
 *  при включённом тумблере в настройках раздела, поэтому у всех остальных
 *  запросов к привычкам отсюда не происходит вовсе. */

const WINDOW_LABEL: Record<HabitsCycleWindow, string> = {
  period: 'Дни менструации',
  preMenstrual: 'Перед менструацией',
  other: 'Остальные дни',
};

export function CycleHabitsCard({ cycles }: { cycles: Cycle[] }) {
  const habits = useLiveQuery(() => db.habits.toArray(), []);
  const logs = useLiveQuery(() => db.habitLogs.toArray(), []);

  // Пока Dexie не ответил — ничего: мигание «мало данных» → таблица хуже,
  // чем секунда пустоты.
  if (habits === undefined || logs === undefined) return null;

  const view = buildHabitsByCycle(habits, logs, cycles);

  return (
    <section>
      <h2 className="mb-1.5 px-1 lh-section">{t('Привычки по циклу')}</h2>
      {view === undefined ? (
        <div className="card p-4">
          <p className="text-sm leading-snug text-lh-text-secondary">
            {t(
              'Пока мало данных. Сравнение появится, когда наберутся два завершённых цикла и регулярные отметки привычек.',
            )}
          </p>
        </div>
      ) : (
        <>
          <div className="card divide-y divide-lh-border px-4">
            {view.rows.map((r) => (
              <div key={r.window} className="flex items-baseline justify-between gap-3 py-3">
                <span className="min-w-[6rem] flex-1 text-sm text-lh-text-secondary">
                  {t(WINDOW_LABEL[r.window])}
                </span>
                <span className="shrink-0 font-semibold tabular-nums">
                  {Math.round(r.share * 100)}%{' '}
                  <span className="font-normal text-lh-text-secondary">
                    ({t('{done} из {total}', { done: r.done, total: r.planned })})
                  </span>
                </span>
              </div>
            ))}
          </div>
          {/* Число циклов обязано стоять рядом с долями: 40% против 60% на двух
              циклах и на двенадцати — это разные по весу наблюдения, и решать,
              верить ли им, можно только зная n. */}
          <p className="mt-2 px-1 text-xs leading-snug text-lh-text-secondary">
            {t('Доля выполненных привычек за {n}. Это ваши отметки, а не вывод о работоспособности.', {
              n: tPlur(view.cyclesUsed, ['завершённый цикл', 'завершённых цикла', 'завершённых циклов']),
            })}
          </p>
        </>
      )}
    </section>
  );
}
