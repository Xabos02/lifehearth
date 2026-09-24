import { useEffect, useRef, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { db } from '../../db/db';
import { now } from '../../db/repo';
import { updateSettings } from '../../hooks/useSettings';
import { computeNavLayout } from '../../lib/navLayout';
import { ANCHOR_ID, DEFAULT_BOTTOM, HOME_VISIBLE_STEP, MAX_BOTTOM, SECTION_BY_ID, sectionsFor } from '../../lib/sections';
import { t } from '../../lib/i18n';
import { ICON } from '../../components/ui/icons';
import { HIT_SLOP_44 } from '../../components/ui/hitSlop';
import { GChevronDown as ChevronDown, GSparkle as Sparkles } from '../../components/ui/glyphs';

const LAYOUT_OPTS = { maxBottom: MAX_BOTTOM, defaultBottom: DEFAULT_BOTTOM, anchorId: ANCHOR_ID };

interface State {
  bottom: string[]; // панель — переносится как есть, здесь не меняется
  items: string[]; // список «Главной», по приоритету сверху вниз
  hidden: string[];
}

/**
 * Обязательный шаг сразу после вводного тура: человек расставляет приоритет
 * разделов «Главной» — что видно сразу, что скрыто, что не нужно вовсе.
 * Пропустить нельзя (кнопки «Пропустить» нет намеренно, как в GenderGate) —
 * человек, вложивший минуту в настройку под себя, продолжает пользоваться
 * охотнее, чем тот, кто получил чужой список по умолчанию.
 *
 * Показывается один раз (settings.sectionsPriorityDone), включая тех, кто
 * пользовался приложением до появления этого экрана, — как раньше было с
 * GenderGate. Пересмотреть порядок и после этого можно в «Настроить разделы»
 * или через «Показать заново» в Настройках.
 */
export function SectionsPriorityGate() {
  const settings = useLiveQuery(() => db.settings.get('app'), []);
  const [state, setState] = useState<State | null>(null);
  const inited = useRef(false);

  useEffect(() => {
    if (inited.current || !settings || !settings.onboardingDone || settings.sectionsPriorityDone) return;
    inited.current = true;
    const l = computeNavLayout(sectionsFor(settings.gender, settings.aiEnabled), settings.navConfig, LAYOUT_OPTS);
    // «Настройки» показываются на «Главной» отдельной карточкой внизу экрана
    // (см. HomePage) — расставлять им приоритет здесь нечего, они и так видны
    // всегда.
    setState({
      bottom: l.bottom.filter((id) => id !== ANCHOR_ID),
      items: l.more.filter((id) => id !== 'settings'),
      hidden: l.hidden,
    });
  }, [settings]);

  if (!settings || !settings.onboardingDone || settings.sectionsPriorityDone || !state) return null;

  const move = (id: string, dir: -1 | 1) => {
    setState((prev) => {
      if (!prev) return prev;
      const i = prev.items.indexOf(id);
      const j = i + dir;
      if (i < 0 || j < 0 || j >= prev.items.length) return prev;
      const items = [...prev.items];
      [items[i], items[j]] = [items[j], items[i]];
      return { ...prev, items };
    });
  };

  const toggle = (id: string) => {
    setState((prev) => {
      if (!prev) return prev;
      if (SECTION_BY_ID.get(id)?.nonHideable) return prev;
      if (prev.hidden.includes(id)) {
        return { ...prev, items: [...prev.items, id], hidden: prev.hidden.filter((x) => x !== id) };
      }
      return { ...prev, items: prev.items.filter((x) => x !== id), hidden: [...prev.hidden, id] };
    });
  };

  const finish = () => {
    void updateSettings({
      navConfig: { bottom: state.bottom, more: state.items, hidden: state.hidden },
      sectionsPriorityDone: now(),
    });
  };

  return (
    <div className="fixed inset-0 z-[82] flex flex-col bg-bg">
      <div aria-hidden className="aurora pointer-events-none absolute inset-0" />
      <div className="relative flex min-h-0 flex-1 flex-col overflow-y-auto px-5 pt-[calc(env(safe-area-inset-top)+24px)]">
        <div className="mb-5 flex flex-col items-center gap-3 text-center">
          <div className="flex size-14 items-center justify-center rounded-2xl tile-accent text-accent">
            <Sparkles size={ICON.header} />
          </div>
          <h2 className="text-xl font-bold tracking-tight">{t('Что для вас важнее всего?')}</h2>
          <p className="max-w-sm text-sm leading-relaxed text-muted">
            {t('Расставьте разделы по важности — верхние {n} сразу видны на «Главной», остальные откроются по кнопке «Показать ещё». Стрелками меняете порядок, переключателем — скрываете ненужное.', { n: HOME_VISIBLE_STEP })}
          </p>
        </div>

        <div className="space-y-2 pb-4">
          {state.items.map((id, i) => {
            const sec = SECTION_BY_ID.get(id);
            if (!sec) return null;
            const Icon = sec.icon;
            return (
              <div key={id}>
                {i === HOME_VISIBLE_STEP && (
                  <div className="my-2 flex items-center gap-2 px-1">
                    <span className="h-px flex-1 bg-border" />
                    <span className="shrink-0 text-2xs font-semibold uppercase tracking-wide text-muted">
                      {t('дальше — за кнопкой «Показать ещё»')}
                    </span>
                    <span className="h-px flex-1 bg-border" />
                  </div>
                )}
                {/* gap-2, а не 3: стрелкам нужно 64px вместо 34 (см. ниже), и
                    на 320px иначе от названия ничего не оставалось. */}
                <div className="flex items-center gap-2 card p-3">
                  <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-surface-2 text-xs font-bold text-muted">
                    {i + 1}
                  </span>
                  <div className="flex size-10 shrink-0 items-center justify-center rounded-xl tile-accent text-accent">
                    <Icon size={ICON.header} />
                  </div>
                  <span className="min-w-0 grow basis-auto truncate font-semibold">{t(sec.label)}</span>
                  {/* Центры стрелок ровно в 44px (20 + gap-6), и зоны касания
                      встают встык. Было gap-0.5 при зонах по 44: невидимая зона
                      «Опустить» лежала поверх почти всей «Поднять» — тап по
                      верхней стрелке опускал раздел. ml-1 держит 12px до
                      переключателя: столько зона стрелки выходит за её край. */}
                  <div className="flex shrink-0 items-center gap-6">
                    <button
                      type="button"
                      disabled={i === 0}
                      onClick={() => move(id, -1)}
                      aria-label={t('Поднять «{name}»', { name: t(sec.label) })}
                      className={`flex size-5 items-center justify-center rounded-full disabled:opacity-25 ${HIT_SLOP_44}`}
                    >
                      <ChevronDown size={ICON.action} className="rotate-180" />
                    </button>
                    <button
                      type="button"
                      disabled={i === state.items.length - 1}
                      onClick={() => move(id, 1)}
                      aria-label={t('Опустить «{name}»', { name: t(sec.label) })}
                      className={`flex size-5 items-center justify-center rounded-full disabled:opacity-25 ${HIT_SLOP_44}`}
                    >
                      <ChevronDown size={ICON.action} />
                    </button>
                  </div>
                  {!sec.nonHideable && (
                    <button
                      type="button"
                      onClick={() => toggle(id)}
                      aria-label={t('Скрыть раздел {name}', { name: t(sec.label) })}
                      className={`ml-1 h-6 w-11 shrink-0 rounded-full border border-transparent bg-accent transition-colors ${HIT_SLOP_44}`}
                    >
                      <span className="absolute top-0.5 left-[22px] size-4 rounded-full bg-white shadow transition-all" />
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>

        {state.hidden.length > 0 && (
          <>
            <div className="mb-1.5 px-1 text-xs font-bold uppercase tracking-wide text-muted">{t('Скрыто')}</div>
            <div className="mb-4 space-y-2">
              {state.hidden.map((id) => {
                const sec = SECTION_BY_ID.get(id);
                if (!sec) return null;
                const Icon = sec.icon;
                return (
                  <div key={id} className="flex items-center gap-3 card p-3 opacity-60">
                    <div className="flex size-10 shrink-0 items-center justify-center rounded-xl tile-accent text-accent">
                      <Icon size={ICON.header} />
                    </div>
                    <span className="min-w-0 grow basis-auto truncate font-semibold">{t(sec.label)}</span>
                    <button
                      type="button"
                      onClick={() => toggle(id)}
                      aria-label={t('Показать раздел {name}', { name: t(sec.label) })}
                      className={`h-6 w-11 shrink-0 rounded-full border border-border bg-surface-2 transition-colors ${HIT_SLOP_44}`}
                    >
                      <span className="absolute top-0.5 left-0.5 size-4 rounded-full bg-white shadow transition-all" />
                    </button>
                  </div>
                );
              })}
            </div>
          </>
        )}
      </div>

      <div className="relative px-6 pb-[calc(env(safe-area-inset-bottom)+20px)] pt-3">
        <button
          type="button"
          onClick={finish}
          className="flex w-full items-center justify-center rounded-2xl bg-accent-fill px-5 py-3.5 font-semibold text-white shadow-[var(--shadow-accent)] active:opacity-80"
        >
          {t('Готово')}
        </button>
      </div>
    </div>
  );
}
