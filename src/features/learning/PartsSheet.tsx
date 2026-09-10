import { useRef, useState, type ChangeEvent } from 'react';
import { Button } from '../../components/ui/Button';
import { AutoGrowTextarea, Field } from '../../components/ui/Input';
import { Sheet } from '../../components/ui/Sheet';
import { db } from '../../db/db';
import { create, remove, update } from '../../db/repo';
import type { LearningItem, LearningPart } from '../../db/types';
import { t } from '../../lib/i18n';
import { parsePlan, planToText } from './plan';

interface Props {
  open: boolean;
  onClose: () => void;
  item: LearningItem;
  parts: LearningPart[];
}

export function PartsSheet({ open, onClose, item, parts }: Props) {
  return (
    <Sheet open={open} onClose={onClose} title={t('План материала')}>
      <PlanForm key={parts.length} item={item} parts={parts} onClose={onClose} />
    </Sheet>
  );
}

function PlanForm({
  item,
  parts,
  onClose,
}: {
  item: LearningItem;
  parts: LearningPart[];
  onClose: () => void;
}) {
  const [text, setText] = useState(() => planToText(parts));
  const savingRef = useRef(false);
  const parsed = parsePlan(text);
  const totalEstimate = parsed.reduce((s, p) => s + p.estimate, 0);

  const handleSave = async () => {
    if (savingRef.current) return;
    savingRef.current = true;
    try {
      // Совпавшие по порядку части обновляем на месте, а не пересоздаём:
      // иначе отметки «сделано» слетали бы при каждой правке плана.
      for (let i = 0; i < Math.max(parsed.length, parts.length); i += 1) {
        const next = parsed[i];
        const prev = parts[i];
        if (next && prev) {
          await update(db.learningParts, prev.id, {
            title: next.title,
            section: next.section,
            estimate: next.estimate,
            sortOrder: i,
          });
        } else if (next) {
          await create(db.learningParts, {
            itemId: item.id,
            title: next.title,
            section: next.section,
            estimate: next.estimate,
            doneAt: null,
            sortOrder: i,
          });
        } else if (prev) {
          await remove(db.learningParts, prev.id);
        }
      }
      // Цель материала — сумма частей, когда план непустой: иначе проценты
      // считались бы от числа, которое человек когда-то ввёл руками.
      if (parsed.length > 0 && totalEstimate > 0) {
        await update(db.learningItems, item.id, { progressTarget: totalEstimate });
      }
      onClose();
    } finally {
      savingRef.current = false;
    }
  };

  return (
    <div className="space-y-4 pb-2">
      <Field label={t('Одна строка — одна часть')}>
        <AutoGrowTextarea
          value={text}
          onChange={(e: ChangeEvent<HTMLTextAreaElement>) => setText(e.target.value)}
          placeholder={'# Модуль 1\nВведение — 3\nПрактический кейс — 2'}
          className="min-h-[9rem] font-mono text-sm"
        />
      </Field>
      <p className="px-1 text-xs leading-relaxed text-muted">
        {t(
          'Строка с # — раздел плана. Число после тире — сколько это займёт; можно не ставить.',
        )}
      </p>
      {parsed.length > 0 && (
        <p className="px-1 text-xs text-muted">
          {t('Получится частей: {n}', { n: parsed.length })}
          {totalEstimate > 0 && t(', всего {n}', { n: totalEstimate })}
        </p>
      )}
      <Button className="w-full" onClick={() => void handleSave()}>
        {t('Сохранить план')}
      </Button>
    </div>
  );
}
