import { useLiveQuery } from 'dexie-react-hooks';
import { Check } from 'lucide-react';
import { db } from '../../db/db';
import type { LearningPart } from '../../db/types';
import { formatNum } from '../../lib/finance';
import { t } from '../../lib/i18n';
import { ICON } from '../../components/ui/icons';
import { togglePart } from './plan';

/** План материала: части, сгруппированные по разделам.
 *
 *  Раздел — просто подпись над группой, а не сущность: у книги их не бывает
 *  вовсе, а у курса они приходят вместе со списком тем и меняются вместе с ним. */
export function PlanList({ parts, unit }: { parts: LearningPart[]; unit: string }) {
  const item = useLiveQuery(
    () => (parts[0] ? db.learningItems.get(parts[0].itemId) : undefined),
    [parts[0]?.itemId],
  );

  const groups: { section: string; rows: LearningPart[] }[] = [];
  for (const part of parts) {
    const last = groups[groups.length - 1];
    if (last && last.section === part.section) last.rows.push(part);
    else groups.push({ section: part.section, rows: [part] });
  }

  return (
    <div className="card divide-y divide-hairline">
      {groups.map((g) => (
        <div key={g.section || '—'}>
          {g.section && (
            <p className="px-4 pb-1 pt-3 text-xs font-semibold text-muted">{g.section}</p>
          )}
          {g.rows.map((part) => (
            <button
              key={part.id}
              type="button"
              disabled={!item}
              onClick={() => item && void togglePart(part, item)}
              className="flex min-h-11 w-full items-center gap-3 px-4 py-2.5 text-left active:opacity-70"
            >
              <span
                className={`flex size-[22px] shrink-0 items-center justify-center rounded-lg border-2 ${
                  part.doneAt
                    ? 'border-success bg-success text-bg'
                    : 'border-muted text-transparent'
                }`}
              >
                <Check size={ICON.inline} strokeWidth={2.4} />
              </span>
              <span
                className={`flex-1 truncate text-sm ${
                  part.doneAt ? 'text-muted line-through' : 'text-text'
                }`}
              >
                {part.title}
              </span>
              {part.estimate > 0 && (
                <span className="shrink-0 text-xs tabular-nums text-muted">
                  {formatNum(part.estimate)} {unit}
                </span>
              )}
            </button>
          ))}
        </div>
      ))}
      {parts.length === 0 && <p className="p-4 text-sm text-muted">{t('План пуст')}</p>}
    </div>
  );
}
