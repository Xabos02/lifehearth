import { useEffect, useRef, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { db } from '../../db/db';
import { now } from '../../db/repo';
import { updateSettings } from '../../hooks/useSettings';
import { computeNavLayout } from '../../lib/navLayout';
import { ANCHOR_ID, DEFAULT_BOTTOM, HOME_VISIBLE_STEP, MAX_BOTTOM, SECTION_BY_ID, sectionsFor } from '../../lib/sections';
import { t } from '../../lib/i18n';
import { ICON } from '../../components/ui/icons';
import { ArrowDown, ArrowUp, Eye, EyeOff } from 'lucide-react';

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

  // Кнопки строки — настоящие 44×44 вплотную, без невидимых расширений:
  // зоны касания не налезают друг на друга (touch.spec.ts).
  const btn =
    'flex size-11 shrink-0 items-center justify-center rounded-lg text-lh-text-secondary active:bg-lh-surface-2 disabled:opacity-25';

  return (
    <div className="fixed inset-0 z-[82] flex flex-col bg-lh-bg">
      <div className="relative min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-md px-4 pb-6 pt-[calc(env(safe-area-inset-top)+32px)]">
          <div className="px-2 pb-5">
            <p className="text-sm text-lh-text-secondary">{t('Последний шаг')}</p>
            <h2 className="mt-1.5 text-[30px] font-light leading-[1.15] tracking-[-.6px]">{t('Что для вас важнее всего?')}</h2>
            <p className="mt-2.5 text-sm leading-normal text-lh-text-secondary">
              {t('Поднимите важное наверх и скройте лишнее: первые {n} сразу видны в «Ещё». Порядок можно менять в настройках.', { n: HOME_VISIBLE_STEP })}
            </p>
          </div>

          <div className="card divide-y divide-lh-border overflow-hidden">
            {state.items.map((id, i) => {
              const sec = SECTION_BY_ID.get(id);
              if (!sec) return null;
              const Icon = sec.icon;
              return (
                <div key={id}>
                  {i === HOME_VISIBLE_STEP && (
                    <div className="flex items-center gap-2 border-b border-lh-border px-4 py-2.5">
                      <span className="h-px flex-1 bg-lh-accent/50" />
                      <span className="shrink-0 text-xs text-lh-accent">
                        {t('дальше — за кнопкой «Показать ещё»')}
                      </span>
                      <span className="h-px flex-1 bg-lh-accent/50" />
                    </div>
                  )}
                  <div className="flex min-h-14 items-center gap-2 py-1 pl-4 pr-1.5 max-[375px]:pl-3">
                    <span className="w-5 shrink-0 text-center text-xs tabular-nums text-lh-text-secondary">{i + 1}</span>
                    <span aria-hidden className="flex w-6 shrink-0 justify-center text-lh-text-primary">
                      <Icon size={ICON.base} />
                    </span>
                    <span className="min-w-0 grow basis-auto truncate text-sm">{t(sec.label)}</span>
                    <div className="flex shrink-0 items-center">
                      <button
                        type="button"
                        disabled={i === 0}
                        onClick={() => move(id, -1)}
                        aria-label={t('Поднять «{name}»', { name: t(sec.label) })}
                        className={btn}
                      >
                        <ArrowUp size={ICON.inline} />
                      </button>
                      <button
                        type="button"
                        disabled={i === state.items.length - 1}
                        onClick={() => move(id, 1)}
                        aria-label={t('Опустить «{name}»', { name: t(sec.label) })}
                        className={btn}
                      >
                        <ArrowDown size={ICON.inline} />
                      </button>
                      {!sec.nonHideable && (
                        <button
                          type="button"
                          onClick={() => toggle(id)}
                          aria-label={t('Скрыть раздел {name}', { name: t(sec.label) })}
                          className={btn}
                        >
                          <Eye size={ICON.action} />
                        </button>
                      )}
                    </div>
                  </div>
                </div>
              );
            })}
            {state.hidden.map((id) => {
              const sec = SECTION_BY_ID.get(id);
              if (!sec) return null;
              const Icon = sec.icon;
              return (
                <div key={id} className="flex min-h-14 items-center gap-2 py-1 pl-4 pr-1.5 max-[375px]:pl-3">
                  <span className="w-5 shrink-0" />
                  <span aria-hidden className="flex w-6 shrink-0 justify-center text-lh-text-secondary">
                    <Icon size={ICON.base} />
                  </span>
                  <div className="min-w-0 grow basis-auto">
                    <p className="truncate text-sm text-lh-text-secondary">{t(sec.label)}</p>
                    <p className="text-xs text-lh-text-secondary">{t('Скрыто')}</p>
                  </div>
                  <button
                    type="button"
                    onClick={() => toggle(id)}
                    aria-label={t('Показать раздел {name}', { name: t(sec.label) })}
                    className={`${btn} !text-lh-accent`}
                  >
                    <EyeOff size={ICON.action} />
                  </button>
                </div>
              );
            })}
          </div>
        </div>
      </div>

      <div className="relative border-t border-lh-border px-4 pb-[calc(env(safe-area-inset-bottom)+24px)] pt-3">
        <button
          type="button"
          onClick={finish}
          className="mx-auto flex h-[52px] w-full max-w-md items-center justify-center rounded-xl bg-lh-accent text-base font-semibold text-lh-bg active:opacity-80"
        >
          {t('Готово')}
        </button>
      </div>
    </div>
  );
}
