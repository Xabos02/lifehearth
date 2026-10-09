import { useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import {
  GTrash as Trash2,
} from '../../components/ui/glyphs';
import { Sheet } from '../../components/ui/Sheet';
import { Button } from '../../components/ui/Button';
import { Field, Textarea } from '../../components/ui/Input';
import { db } from '../../db/db';
import type { BleedingLevel, Severity, SymptomEntry } from '../../db/cycleTypes';
import { deleteDay, putDay } from '../../lib/cycle/cycleRepo';
import { SYMPTOM_GROUP_LABELS } from '../../lib/cycle/symptoms';
import { formatRu } from '../../lib/dates';
import { t } from '../../lib/i18n';
import { ICON } from '../../components/ui/icons';

/** Шкала кровотечения. Пять значений вместо принятого у Apple и Google
 *  разделения на «поток» и «межменструальное кровотечение»: человеку проще
 *  выбрать одно из пяти, чем понять, в какое из двух полей писать. Семантика
 *  восстанавливается расчётом. */
const LEVELS: { value: BleedingLevel; label: string; dots: number }[] = [
  { value: 'none', label: 'Не было', dots: 0 },
  { value: 'spotting', label: 'Мазня', dots: 0 },
  { value: 'light', label: 'Скудно', dots: 1 },
  { value: 'medium', label: 'Умеренно', dots: 2 },
  { value: 'heavy', label: 'Обильно', dots: 3 },
];

const SEVERITY_LABELS: Record<Severity, string> = { 1: 'слабо', 2: 'средне', 3: 'сильно' };

/** Заголовок + набор кнопок. Не Field: тот оборачивает содержимое в <label>,
 *  и скринридер читает всю группу как одну кнопку с подписью из всех вариантов
 *  подряд. role="group" с aria-labelledby даёт правильную структуру. */
function Group({ label, children }: { label: string; children: React.ReactNode }) {
  const id = 'grp-' + label.replace(/\s+/g, '-').toLowerCase();
  return (
    <div role="group" aria-labelledby={id}>
      <span id={id} className="mb-1.5 block text-sm font-medium text-lh-text-secondary">
        {label}
      </span>
      {children}
    </div>
  );
}

interface Props {
  open: boolean;
  date: string | null;
  onClose: () => void;
}

export function DayLogSheet({ open, date, onClose }: Props) {
  // Форма монтируется заново на каждое открытие: состояние инициализируется
  // из props, поэтому сброс через эффект не нужен.
  if (!open || date === null) return null;
  return <DayLogForm key={date} date={date} onClose={onClose} />;
}

function DayLogForm({ date, onClose }: { date: string; onClose: () => void }) {
  const existing = useLiveQuery(() => db.cycleDays.get(date), [date]);
  const symptomDefs = useLiveQuery(() => db.cycleSymptoms.toArray(), []);

  const [bleeding, setBleeding] = useState<BleedingLevel | undefined>(undefined);
  const [symptoms, setSymptoms] = useState<SymptomEntry[] | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  // Пока Dexie не ответил, показываем то, что уже есть в форме; после ответа —
  // сохранённое, если человек ещё ничего не менял. undefined у bleeding значит
  // «не трогали», а не «не было»: эти состояния в модели различаются.
  const currentBleeding = bleeding ?? existing?.bleeding;
  const currentSymptoms = symptoms ?? existing?.symptoms ?? [];
  const currentNote = note ?? existing?.note ?? '';

  const enabled = (symptomDefs ?? []).filter((s) => s.enabled).sort((a, b) => a.order - b.order);
  const groups = [...new Set(enabled.map((s) => s.group))];

  const entryFor = (key: string): SymptomEntry | undefined =>
    currentSymptoms.find((s) => s.key === key);

  function toggleSymptom(key: string, scale: 'presence' | 'severity') {
    const next = [...currentSymptoms];
    const i = next.findIndex((s) => s.key === key);
    if (i >= 0) {
      const cur = next[i];
      // Для шкалы со степенью повторный тап повышает её, а с третьего — снимает:
      // так один и тот же жест и ставит, и уточняет, и убирает.
      if (scale === 'severity' && (cur.severity ?? 1) < 3) {
        next[i] = { ...cur, severity: ((cur.severity ?? 1) + 1) as Severity };
      } else {
        next.splice(i, 1);
      }
    } else {
      next.push(scale === 'severity' ? { key, severity: 1 } : { key });
    }
    setSymptoms(next);
  }

  async function save() {
    if (saving) return;
    setSaving(true);
    try {
      await putDay(date, {
        ...(currentBleeding !== undefined ? { bleeding: currentBleeding } : {}),
        symptoms: currentSymptoms,
        note: currentNote.trim() || undefined,
      });
      onClose();
    } finally {
      setSaving(false);
    }
  }

  async function clear() {
    if (!window.confirm(t('Удалить все отметки за {date}?', { date: formatRu(date) }))) return;
    await deleteDay(date);
    onClose();
  }

  return (
    <Sheet open onClose={onClose} title={formatRu(date, 'd MMMM')}>
      <div className="flex flex-col gap-5 pb-2">
        <Group label={t('Кровотечение')}>
          {/* Число колонок растёт с шириной. На 320px даже три колонки режут
              подпись: под текст остаётся 79px, а «Умеренно» требует 88.
              Две колонки дают 139px — с запасом. Пять в ряд — только от 420px,
              где на кнопку приходится больше 44px тач-таргета. */}
          <div className="grid grid-cols-2 gap-2 min-[360px]:grid-cols-3 min-[420px]:grid-cols-5">
            {LEVELS.map((l) => {
              const active = currentBleeding === l.value;
              return (
                <button
                  key={l.value}
                  type="button"
                  onClick={() => setBleeding(l.value)}
                  aria-pressed={active}
                  className={`flex min-h-11 min-w-0 flex-col items-center justify-center gap-1 rounded-xl border px-1 py-2 text-2xs transition-colors ${
                    active
                      ? 'border-danger bg-danger/15 font-semibold text-danger'
                      : 'border-lh-border bg-lh-surface-2 text-lh-text-secondary'
                  }`}
                >
                  <span aria-hidden className="flex h-1.5 items-center gap-0.5">
                    {l.value === 'spotting' ? (
                      <span className="size-1.5 rounded-full border border-current" />
                    ) : (
                      Array.from({ length: l.dots }, (_, k) => (
                        <span key={k} className="size-1.5 rounded-full bg-current" />
                      ))
                    )}
                  </span>
                  <span className="max-w-full truncate">{t(l.label)}</span>
                </button>
              );
            })}
          </div>
        </Group>

        {groups.map((g) => (
          <Group key={g} label={t(SYMPTOM_GROUP_LABELS[g])}>
            <div className="flex flex-wrap gap-2">
              {enabled
                .filter((s) => s.group === g)
                .map((s) => {
                  const e = entryFor(s.key);
                  return (
                    <button
                      key={s.key}
                      type="button"
                      onClick={() => toggleSymptom(s.key, s.scale)}
                      aria-pressed={Boolean(e)}
                      className={`min-h-11 rounded-xl border px-3 py-2 text-sm transition-colors ${
                        e
                          ? 'border-lh-accent bg-lh-accent-dim font-medium text-lh-accent'
                          : 'border-lh-border bg-lh-surface-2 text-lh-text-secondary'
                      }`}
                    >
                      {t(s.label)}
                      {e?.severity !== undefined && (
                        <span className="ml-1.5 text-xs opacity-80">
                          {t(SEVERITY_LABELS[e.severity])}
                        </span>
                      )}
                    </button>
                  );
                })}
            </div>
          </Group>
        ))}

        <Field label={t('Заметка')}>
          <Textarea
            value={currentNote}
            onChange={(e) => setNote(e.target.value)}
            placeholder={t('Что стоит запомнить об этом дне')}
            className="min-h-20"
          />
        </Field>

        <div className="flex flex-col gap-2 min-[400px]:flex-row">
          <Button onClick={() => void save()} disabled={saving} className="min-[400px]:flex-1">
            {t('Сохранить')}
          </Button>
          {existing && (
            <Button variant="ghost" onClick={() => void clear()} className="text-danger!">
              <Trash2 size={ICON.action} /> {t('Очистить день')}
            </Button>
          )}
        </div>
      </div>
    </Sheet>
  );
}
