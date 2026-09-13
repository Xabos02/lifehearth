import { Sheet } from "../../components/ui/Sheet";
import { GCheck as Check } from "../../components/ui/glyphs";
import { ICON } from "../../components/ui/icons";
import { t } from "../../lib/i18n";
import { FOCUS_VARS } from "./focusVars";

export interface SoundItem<K extends string> {
  value: K;
  label: string;
  /** Подпись под названием: длительность мелодии («0:02») или ничего. */
  hint?: string;
}

interface Props<K extends string> {
  open: boolean;
  onClose: () => void;
  title: string;
  items: SoundItem<K>[];
  value: K;
  /** Выбор — и он же проигрывает: слушать — единственный способ выбрать. */
  onPick: (value: K) => void;
  volume: number;
  onVolume: (v: number) => void;
  volumeLabel: string;
  note?: string;
}

/** Список мелодий или шумов с громкостью сверху — как «Мелодия томата» в
 *  Focus To-Do: одна колонка, галочка у выбранного, тап проигрывает. */
export function SoundPickerSheet<K extends string>({
  open,
  onClose,
  title,
  items,
  value,
  onPick,
  volume,
  onVolume,
  volumeLabel,
  note,
}: Props<K>) {
  return (
    <Sheet open={open} onClose={onClose} title={title}>
      {/* Шит рисуется порталом, вне обёртки экрана — тёплый акцент «Фокуса»
          сюда сам не доходит, ставим явно. */}
      <div style={FOCUS_VARS}>
        <label className="mb-2 flex items-center gap-3 px-1">
          <span className="shrink-0 text-sm font-medium text-muted">
            {t("Громкость")}
          </span>
          <input
            type="range"
            min={0}
            max={100}
            step={5}
            value={Math.round(volume * 100)}
            aria-label={volumeLabel}
            onChange={(e) => onVolume(Number(e.target.value) / 100)}
            className="h-11 min-w-0 flex-1 accent-[var(--app-accent)]"
          />
        </label>
        <div className="flex flex-col" role="radiogroup" aria-label={title}>
          {items.map((it) => {
            const active = it.value === value;
            return (
              <button
                key={it.value}
                type="button"
                role="radio"
                aria-checked={active}
                onClick={() => onPick(it.value)}
                className="flex min-h-11 items-center justify-between gap-3 border-b border-hairline py-2.5 text-left last:border-b-0 active:opacity-70"
              >
                <span className="min-w-0">
                  <span
                    className={`block ${active ? "font-semibold text-accent" : ""}`}
                  >
                    {t(it.label)}
                  </span>
                  {it.hint && (
                    <span className="block text-xs text-muted">{it.hint}</span>
                  )}
                </span>
                {active && (
                  <Check size={ICON.base} className="shrink-0 text-accent" />
                )}
              </button>
            );
          })}
        </div>
        {note && (
          <p className="mt-3 px-1 pb-1 text-xs leading-snug text-muted">
            {note}
          </p>
        )}
      </div>
    </Sheet>
  );
}
