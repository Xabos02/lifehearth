import { useLiveQuery } from 'dexie-react-hooks';
import { Circle, CircleCheck, CircleDot } from 'lucide-react';
import { db } from '../../db/db';
import type { LearningPart } from '../../db/types';
import { formatNum } from '../../lib/finance';
import { t } from '../../lib/i18n';
import { unitLabel, type ProgressUnit } from '../../lib/learningPace';
import { ICON, STROKE_STRONG } from '../../components/ui/icons';
import { Haptic } from '../../components/ui/Haptic';
import { togglePart } from './plan';

/** План материала: части, сгруппированные по разделам.
 *
 *  Раздел — просто подпись над группой, а не сущность: у книги их не бывает
 *  вовсе, а у курса они приходят вместе со списком тем и меняются вместе с ним. */
export function PlanList({ parts, unit }: { parts: LearningPart[]; unit: ProgressUnit }) {
  const item = useLiveQuery(
    () => (parts[0] ? db.learningItems.get(parts[0].itemId) : undefined),
    [parts[0]?.itemId],
  );

  // Текущая часть — первая незакрытая: её значок отличается от будущих.
  const currentId = parts.find((p) => !p.doneAt)?.id;
  const groups: { section: string; rows: LearningPart[] }[] = [];
  for (const part of parts) {
    const last = groups[groups.length - 1];
    if (last && last.section === part.section) last.rows.push(part);
    else groups.push({ section: part.section, rows: [part] });
  }

  return (
    <div className="card divide-y divide-lh-border">
      {groups.map((g) => (
        <div key={g.section || '—'}>
          {g.section && (
            <p className="px-4 pb-1 pt-3 text-2xs font-semibold uppercase tracking-wider text-lh-text-secondary">{g.section}</p>
          )}
          {g.rows.map((part) => (
            <button
              key={part.id}
              type="button"
              disabled={!item}
              onClick={() => item && void togglePart(part, item)}
              className="flex min-h-11 w-full items-center gap-3 px-4 py-3 text-left active:opacity-70"
            >
              {part.doneAt ? (
                <CircleCheck size={ICON.base} strokeWidth={STROKE_STRONG} className="shrink-0 text-lh-accent" aria-hidden />
              ) : part.id === currentId ? (
                <CircleDot size={ICON.base} className="shrink-0 text-lh-accent" aria-hidden />
              ) : (
                <Circle size={ICON.base} className="shrink-0 text-lh-text-secondary" aria-hidden />
              )}
              <span
                className={`flex-1 truncate text-sm ${
                  part.doneAt ? 'text-lh-text-secondary' : 'text-lh-text-primary'
                }`}
              >
                {part.title}
              </span>
              {part.estimate > 0 && (
                <span className="shrink-0 text-xs tabular-nums text-lh-text-secondary">
                  {formatNum(part.estimate)}
                  {/* У процентов оценка — только вес части (planProgress),
                      «3 %» соврало бы: часть весом 3 из 8 — это 38%. */}
                  {unit !== 'percent' && `\u00A0${unitLabel(unit, part.estimate)}`}
                </span>
              )}
              {/* Отметка части щёлкает — и постановка, и снятие (PROTOCOL §6.4). */}
              {item && <Haptic />}
            </button>
          ))}
        </div>
      ))}
      {parts.length === 0 && <p className="p-4 text-sm text-lh-text-secondary">{t('План пуст')}</p>}
    </div>
  );
}
