import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { db } from '../../db/db';
import { updateSettings } from '../../hooks/useSettings';
import { Screen } from '../../components/layout/Screen';
import {
  sectionsFor,
  SECTION_BY_ID,
  MAX_BOTTOM,
  DEFAULT_BOTTOM,
  ANCHOR_ID,
  HOME_VISIBLE_STEP,
} from '../../lib/sections';
import { computeNavLayout } from '../../lib/navLayout';
import { freezeAllForSection, unfreezeSectionFrozen } from '../habits/habitRepo';
import { t } from '../../lib/i18n';
import { ICON } from '../../components/ui/icons';
import { GripVertical } from 'lucide-react';
import { GLock as Lock } from '../../components/ui/glyphs';
import { HIT_SLOP_44 } from '../../components/ui/hitSlop';
import { Haptic } from '../../components/ui/Haptic';
import { buzz } from '../../lib/feedback';

const LAYOUT_OPTS = { maxBottom: MAX_BOTTOM, defaultBottom: DEFAULT_BOTTOM, anchorId: ANCHOR_ID };

/** Разделы, которые пользователь ВКЛЮЧИЛ, одним списком по порядку: первые
 *  MAX_BOTTOM — нижняя панель, остальные — экран «Главная». Один порядок
 *  вместо двух зон — «Главная» просто читает свой кусок того же списка,
 *  никакой отдельной модели для нижней панели не нужно. */
interface State {
  enabled: string[]; // без якоря «Главная» — он не двигается и не хранится
  hidden: string[];
}

const PRESS_MS = 300; // удержание без движения → старт переноса
const CANCEL_MOVE = 8; // сдвиг пальца до этого порога — скролл, а не перенос; отменяем как в TasksPage

/** Экран «Настроить разделы»: единый вертикальный список вместо трёх зон.
 *  Тумблер — включает/выключает разДел нажатием. Порядок и переход через
 *  черту в нижнюю панель — удержанием строки (жест как в переносе задач:
 *  порог удержания, отмена по pointercancel, отмена при уходе пальца до
 *  старта — но без авто-скролла, список короткий). Раскладка автосохраняется
 *  в settings.navConfig (device-local). «Главная» — жёсткий якорь панели,
 *  «Сегодня»/«Настройки» нельзя выключить. */
export function SectionsSettingsPage() {
  const settingsRow = useLiveQuery(() => db.settings.get('app'), []);
  const [state, setState] = useState<State | null>(null);
  const inited = useRef(false);
  // Прошлое сохранённое состояние «скрыт ли раздел „Привычки“» — по нему
  // ловим именно ПЕРЕХОД тумблера (см. эффект ниже), а не факт скрытости.
  const habitsHiddenRef = useRef(false);

  // Инициализация из сохранённой раскладки — один раз, когда settings загрузились.
  useEffect(() => {
    if (inited.current || !settingsRow) return;
    inited.current = true;
    // Реестр с учётом пола: в мужском профиле «Женские дни» не существуют и
    // на этом экране — ни в списке, ни среди выключенных.
    const l = computeNavLayout(sectionsFor(settingsRow.gender), settingsRow.navConfig, LAYOUT_OPTS);
    setState({ enabled: [...l.bottom.filter((id) => id !== ANCHOR_ID), ...l.more], hidden: l.hidden });
    // Только фиксируем стартовое состояние — переход «выключен⇄включён» ниже
    // должен реагировать на нажатия тумблера, а не на саму загрузку экрана.
    habitsHiddenRef.current = l.hidden.includes('habits');
  }, [settingsRow]);

  // Выключение раздела «Привычки» — это «выгорел, всё замолчи»: замораживаем
  // разом все привычки, чтобы серии не сгорали за отдых (см. freezeAllForSection
  // в habitRepo). Включение обратно снимает только эти, section-заморозки —
  // ручные, поставленные человеком из шита, остаются как были. Сравниваем с
  // РЕФОМ прошлого сохранённого состояния, а не с константой: на самой
  // инициализации (эффект выше) переход не должен засчитываться.
  useEffect(() => {
    if (!state) return;
    const nowHidden = state.hidden.includes('habits');
    if (habitsHiddenRef.current === nowHidden) return;
    habitsHiddenRef.current = nowHidden;
    if (nowHidden) void freezeAllForSection();
    else void unfreezeSectionFrozen();
  }, [state]);

  // Автосохранение при каждом изменении: первые MAX_BOTTOM включённых — в
  // панель, остальные — в «Главную». Порядок внутри «Главной» тоже сохраняем,
  // чтобы он пережил перезапуск.
  useEffect(() => {
    if (!state) return;
    void updateSettings({
      navConfig: {
        bottom: state.enabled.slice(0, MAX_BOTTOM),
        more: state.enabled.slice(MAX_BOTTOM),
        hidden: state.hidden,
      },
    });
  }, [state]);

  // --- перетаскивание: удержание строки → перенос по единому списку enabled ---
  const [dragId, setDragId] = useState<string | null>(null);
  const [pointer, setPointer] = useState({ x: 0, y: 0 });
  const [dropIndex, setDropIndex] = useState<number | null>(null);
  const dragIdRef = useRef<string | null>(null);
  const dropIndexRef = useRef<number | null>(null);
  const pressTimerRef = useRef<number | null>(null);
  const pressStartRef = useRef({ x: 0, y: 0 });
  const pressRowRef = useRef<HTMLElement | null>(null);
  const pressPointerIdRef = useRef(0);

  const applyMove = (id: string, toIndex: number) => {
    setState((prev) => {
      if (!prev) return prev;
      const rest = prev.enabled.filter((x) => x !== id);
      const clamped = Math.max(0, Math.min(toIndex, rest.length));
      rest.splice(clamped, 0, id);
      // Никакого отдельного «вытеснения» из панели не нужно: панель — это
      // просто первые MAX_BOTTOM элементов этого списка (см. save-эффект),
      // так что вставка выше черты автоматически сдвигает четвёртый вниз.
      return { ...prev, enabled: rest };
    });
  };

  const clearPressTimer = () => {
    if (pressTimerRef.current != null) {
      clearTimeout(pressTimerRef.current);
      pressTimerRef.current = null;
    }
  };

  // Пока таймер тикает — жест ещё не начался по факту. Сдвиг пальца дальше
  // CANCEL_MOVE до его срабатывания читается как обычный скролл списка.
  const beginPress = (id: string, e: ReactPointerEvent<HTMLDivElement>) => {
    pressStartRef.current = { x: e.clientX, y: e.clientY };
    pressRowRef.current = e.currentTarget;
    pressPointerIdRef.current = e.pointerId;
    clearPressTimer();
    pressTimerRef.current = window.setTimeout(() => {
      pressTimerRef.current = null;
      dragIdRef.current = id;
      dropIndexRef.current = null;
      setPointer({ x: pressStartRef.current.x, y: pressStartRef.current.y });
      setDragId(id);
      buzz(); // «взял» — только Android, PROTOCOL §6.4
      setDropIndex(null);
      const el = pressRowRef.current;
      if (el) {
        el.style.touchAction = 'none';
        try {
          el.setPointerCapture(pressPointerIdRef.current);
        } catch {
          /* указатель уже неактивен */
        }
      }
    }, PRESS_MS);
  };

  const handlePressMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (pressTimerRef.current == null) return; // жест уже стартовал или не начинался вовсе
    const dx = e.clientX - pressStartRef.current.x;
    const dy = e.clientY - pressStartRef.current.y;
    if (Math.abs(dx) > CANCEL_MOVE || Math.abs(dy) > CANCEL_MOVE) clearPressTimer();
  };

  const endPress = () => clearPressTimer();

  useEffect(() => {
    if (!dragId) return;
    const hitTest = (y: number): number => {
      const zoneEl = document.querySelector('[data-zone="enabled"]');
      if (!zoneEl) return 0;
      const cards = [...zoneEl.querySelectorAll('[data-sid]')];
      let idx = 0;
      for (const c of cards) {
        if (c.getAttribute('data-sid') === dragId) continue; // себя не считаем
        const cr = c.getBoundingClientRect();
        if (y > cr.top + cr.height / 2) idx++;
      }
      return idx;
    };
    const resetDragState = () => {
      dragIdRef.current = null;
      dropIndexRef.current = null;
      setDragId(null);
      setDropIndex(null);
      const el = pressRowRef.current;
      if (el) {
        el.style.touchAction = '';
        try {
          el.releasePointerCapture(pressPointerIdRef.current);
        } catch {
          /* указатель уже отпущен */
        }
      }
    };
    const move = (e: PointerEvent) => {
      e.preventDefault();
      setPointer({ x: e.clientX, y: e.clientY });
      const idx = hitTest(e.clientY);
      dropIndexRef.current = idx;
      setDropIndex(idx);
    };
    const finish = () => {
      const id = dragIdRef.current;
      const idx = dropIndexRef.current;
      if (id && idx != null) applyMove(id, idx);
      // Раздел встал на новое место — короткая вибрация, только Android
      // (PROTOCOL §6.4). Разметка до отрисовки ещё в старом порядке: idx равен
      // прежнему номеру строки — отпустил там же, где взял, и молчим.
      const cards = [...document.querySelectorAll('[data-zone="enabled"] [data-sid]')];
      if (id && idx != null && idx !== cards.findIndex((c) => c.getAttribute('data-sid') === id)) buzz();
      resetDragState();
    };
    // Системный обрыв жеста (звонок, шторка уведомлений) — не то же самое,
    // что отпускание пальца над целью: перенос не коммитим (как в TasksPage),
    // раздел остаётся там, где был до начала переноса.
    const cancel = () => resetDragState();
    // touch-action на body к уже начавшемуся касанию не применяется: браузер
    // решил «это скролл» на touchstart, и второй pointermove приходил как
    // pointercancel — палец просто крутил список. Глушим touchmove явно,
    // как в переносе задач (TasksPage).
    const preventScroll = (ev: TouchEvent) => ev.preventDefault();
    window.addEventListener('pointermove', move, { passive: false });
    window.addEventListener('touchmove', preventScroll, { passive: false });
    window.addEventListener('pointerup', finish);
    window.addEventListener('pointercancel', cancel);
    const prevTouch = document.body.style.touchAction;
    // Правило react-hooks/immutability считает это изменением неизменяемого
    // значения. Здесь оно ошибается: страница на время переноса запрещает
    // собственную прокрутку, и это законная работа с DOM внутри эффекта —
    // ровно то, для чего эффекты и нужны. Прежнее значение возвращается в
    // функции очистки ниже.
    // eslint-disable-next-line react-hooks/immutability
    document.body.style.touchAction = 'none';
    return () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('touchmove', preventScroll);
      window.removeEventListener('pointerup', finish);
      window.removeEventListener('pointercancel', cancel);
      document.body.style.touchAction = prevTouch;
    };
  }, [dragId]);

  const toggle = (id: string) => {
    setState((prev) => {
      if (!prev) return prev;
      if (SECTION_BY_ID.get(id)?.nonHideable) return prev;
      if (prev.hidden.includes(id)) {
        return { enabled: [...prev.enabled, id], hidden: prev.hidden.filter((x) => x !== id) };
      }
      return { enabled: prev.enabled.filter((x) => x !== id), hidden: [...prev.hidden, id] };
    });
  };

  const reset = () => {
    const l = computeNavLayout(sectionsFor(settingsRow?.gender), undefined, LAYOUT_OPTS);
    setState({ enabled: [...l.bottom.filter((id) => id !== ANCHOR_ID), ...l.more], hidden: l.hidden });
  };

  const previewBottom = useMemo(() => {
    if (!state) return [];
    const l = computeNavLayout(
      sectionsFor(settingsRow?.gender),
      { bottom: state.enabled.slice(0, MAX_BOTTOM), hidden: state.hidden },
      LAYOUT_OPTS,
    );
    return l.bottom.map((id) => SECTION_BY_ID.get(id)).filter((s) => Boolean(s));
  }, [state, settingsRow?.gender]);

  if (!state) {
    return (
      <Screen title={t('Настроить разделы')} backTo="/more/settings">
        <div className="py-10 text-center text-sm text-lh-text-secondary">{t('Загрузка…')}</div>
      </Screen>
    );
  }

  const dropLine = (index: number) =>
    dropIndex === index ? (
      <div
        className="mx-4 my-0.5 h-1 rounded-full bg-lh-accent"
        aria-hidden
      />
    ) : null;

  const row = (id: string, opts: { hidden?: boolean; homeIndex?: number } = {}) => {
    const sec = SECTION_BY_ID.get(id);
    if (!sec) return null;
    const Icon = sec.icon;
    const hidden = Boolean(opts.hidden);
    const draggable = !hidden; // выключенные не двигаются — за это отвечает тумблер
    const locked = Boolean(sec.nonHideable);
    return (
      <div
        key={id}
        data-sid={draggable ? id : undefined}
        onPointerDown={draggable ? (e) => beginPress(id, e) : undefined}
        onPointerMove={draggable ? handlePressMove : undefined}
        onPointerUp={draggable ? endPress : undefined}
        onPointerCancel={draggable ? endPress : undefined}
        // Ниже 375px строка режет собственные зазоры, а не текст: на 320px под
        // содержимое остаётся 258.5px, а строке «Настройки» с бейджем «всегда»
        // нужно 295px. px-2 вместо px-3 даёт 8.5px, gap-2 вместо gap-3 — ещё
        // 12.75px (три зазора). Вместе с ужатым бейджем этого хватает, чтобы
        // название влезало целиком (см. комментарии у бейджа).
        className={`flex min-h-14 items-center gap-3 px-4 py-2 transition-opacity max-[375px]:gap-2 max-[375px]:px-3 ${
          dragId === id ? 'opacity-30' : ''
        } ${
          draggable ? 'touch-pan-y cursor-grab select-none [-webkit-touch-callout:none] [-webkit-user-select:none] active:cursor-grabbing' : ''
        }`}
      >
        {/* Ручка — у всех включённых строк: их можно перетащить, включая
            «Сегодня» и «Настройки» (их нельзя только выключить — это говорит
            «всегда»). У выключенных ручки нет — они не двигаются, пустой слот
            держит выравнивание. Замок — только у якоря «Ещё» (anchorRow), он
            не двигается. Сам жест — удержание всей строки. Цвет secondary:
            значимой иконке нужно 3:1, tertiary давал 1.96 в тёмной и 2.74 в
            светлой, secondary — 5.12 и 5.53 на карточке. */}
        <span aria-hidden className="flex w-4 shrink-0 justify-center text-lh-text-secondary">
          {draggable && <GripVertical size={ICON.inline} />}
        </span>
        {/* Номер приоритета — только у разделов «Ещё»: панель и так видна
            целиком. Число — позиция в списке экрана «Ещё», а не абстрактный
            ранг: 1 значит «первым увидите там». Пустой слот держит выравнивание. */}
        <span className="w-5 shrink-0 text-center text-xs tabular-nums text-lh-text-secondary">
          {opts.homeIndex ?? ''}
        </span>
        <span aria-hidden className={`flex w-6 shrink-0 justify-center ${hidden ? 'text-lh-text-secondary' : 'text-lh-text-primary'}`}>
          <Icon size={ICON.base} />
        </span>
        {/* min-w-0 + truncate: недостачу ширины берёт название, а бейдж
            и тумблер остаются целыми. */}
        <div className="min-w-0 grow basis-auto">
          <p className={`truncate text-sm ${hidden ? 'text-lh-text-secondary' : ''}`}>{t(sec.label)}</p>
          {hidden ? (
            <p className="truncate text-xs text-lh-text-secondary">{t('Записи сохранены, раздел скрыт')}</p>
          ) : (
            sec.subtitle && <p className="truncate text-xs text-lh-text-secondary">{t(sec.subtitle)}</p>
          )}
        </div>
        {locked ? (
          // shrink-0: бейдж короткий и осмысленный только целиком — «вс…» и тем
          // более одно «…» не значат ничего. Ниже 375px он отдаёт названию свои
          // 16.25px, пряча замок (12px иконка + 4.25px зазор): слово «всегда»
          // несёт смысл само, а замок здесь лишь украшение. Плюс 4.25px на
          // сжатии боковых полей — этого хватает, чтобы «Настройки» влезли.
          <span className="shrink-0 text-xs text-lh-text-secondary">{t('всегда')}</span>
        ) : (
          <button
            type="button"
            // Тумблер — своё отдельное действие по нажатию: гасим всплытие,
            // иначе pointerdown по нему же запускал бы таймер переноса строки.
            onPointerDown={(e) => e.stopPropagation()}
            // Переключение уводит строку в другой список, а системный
            // переключатель накладки щёлкает уже после обработчика: тем же
            // тиком строка исчезла бы раньше щелчка (PROTOCOL §6.4).
            onClick={() => setTimeout(() => toggle(id))}
            aria-label={hidden ? t('Включить раздел {name}', { name: t(sec.label) }) : t('Выключить раздел {name}', { name: t(sec.label) })}
            className={`h-[31px] w-[51px] shrink-0 rounded-full transition-colors ${HIT_SLOP_44} ${
              hidden ? 'bg-lh-surface-2 ring-1 ring-inset ring-lh-border-strong' : 'bg-lh-accent'
            }`}
          >
            <span
              className={`absolute top-[2px] size-[27px] rounded-full shadow transition-all ${
                hidden ? 'left-[2px] bg-lh-text-secondary' : 'left-[22px] bg-white'
              }`}
            />
            <Haptic />
          </button>
        )}
      </div>
    );
  };

  const anchor = SECTION_BY_ID.get(ANCHOR_ID);
  // Якорь панели: показывается как последний слот панели, всегда над чертой,
  // без тумблера и без переноса. Раскладка и поведение при нехватке ширины —
  // как у обычной строки (см. row): те же зазоры, тот же неусыхаемый бейдж.
  const anchorRow = anchor && (
    <div className="flex min-h-14 items-center gap-3 px-4 py-2 max-[375px]:gap-2 max-[375px]:px-3">
      <span aria-hidden className="flex w-4 shrink-0 justify-center text-lh-text-secondary">
        <Lock size={ICON.inline} />
      </span>
      <span className="w-5 shrink-0" />
      <span aria-hidden className="flex w-6 shrink-0 justify-center text-lh-text-secondary">
        <anchor.icon size={ICON.base} />
      </span>
      <span className="min-w-0 grow basis-auto truncate text-sm">{t(anchor.label)}</span>
      <span className="shrink-0 text-xs text-lh-text-secondary">{t('всегда')}</span>
    </div>
  );

  // Черта: первые MAX_BOTTOM включённых разделов — над ней, они в нижней
  // панели; остальные — под ней, они в списке «Главной». Если включённых
  // меньше MAX_BOTTOM, черта просто едет к концу списка.
  const dividerAt = Math.min(state.enabled.length, MAX_BOTTOM);
  const divider = (
    <div className="flex items-center gap-2 border-t border-lh-border bg-lh-bg/40 px-4 py-2.5">
      <span className="h-px flex-1 bg-lh-accent/50" />
      <span className="shrink-0 text-xs text-lh-accent">
        {t('выше — панель · ниже — «Ещё»')}
      </span>
      <span className="h-px flex-1 bg-lh-accent/50" />
    </div>
  );

  // Второй ориентир — уже внутри списка «Главной»: первые HOME_VISIBLE_STEP
  // после черты видны на HomePage сразу, остальные — за кнопкой «Показать
  // ещё». Значит показываем его только если разделов «Главной» больше этого
  // порога — иначе делить нечего.
  const homeExpandAt = dividerAt + HOME_VISIBLE_STEP;
  const homeExpandDivider = (
    <div className="flex items-center gap-2 px-4 py-2">
      <span className="h-px flex-1 border-t border-dashed border-lh-border-strong" />
      <span className="shrink-0 text-xs text-lh-text-secondary">
        {t('в «Ещё» — за кнопкой «Показать ещё»')}
      </span>
      <span className="h-px flex-1 border-t border-dashed border-lh-border-strong" />
    </div>
  );

  return (
    <Screen
      title={t('Настроить разделы')}
      subtitle={t('Задержите строку пальцем и перетащите, чтобы поменять порядок. Первые {n} попадут в нижнюю панель рядом с «Ещё». Номер — место раздела на экране «Ещё»: первые {home} видны сразу.', { n: MAX_BOTTOM, home: HOME_VISIBLE_STEP })}
      backTo="/more/settings"
    >
      <div className="space-y-6">
        <section>
          <h2 className="mb-2.5 px-1 lh-section">{t('Как будет выглядеть панель')}</h2>
          <div className="card grid px-1 py-2.5" style={{ gridTemplateColumns: `repeat(${Math.max(1, previewBottom.length)}, minmax(0, 1fr))` }}>
            {previewBottom.map((s, i) =>
              s ? (
                <div
                  key={s.id}
                  className={`flex min-w-0 flex-col items-center gap-1 ${
                    i === 0 ? 'text-lh-accent' : s.id === ANCHOR_ID ? 'text-lh-text-secondary' : 'text-lh-text-primary'
                  }`}
                >
                  {i === 0 && s.activeIcon ? <s.activeIcon size={ICON.base} /> : <s.icon size={ICON.base} />}
                  <span className={`max-w-full truncate text-2xs ${i === 0 ? 'font-semibold' : ''}`}>{t(s.label)}</span>
                </div>
              ) : null,
            )}
          </div>
        </section>

        <div data-zone="enabled" className="card divide-y divide-lh-border overflow-hidden">
          {state.enabled.map((id, i) => (
            <div key={id}>
              {i === dividerAt && (
                <div className="border-b border-lh-border">
                  {anchorRow}
                  {divider}
                </div>
              )}
              {i === homeExpandAt && i > dividerAt && homeExpandDivider}
              {dropLine(i)}
              {row(id, i >= dividerAt ? { homeIndex: i - dividerAt + 1 } : {})}
            </div>
          ))}
          {dividerAt === state.enabled.length && (
            <div>
              {anchorRow}
              {divider}
            </div>
          )}
          {dropLine(state.enabled.length)}
        </div>

        {state.hidden.length > 0 && (
          <section>
            <h2 className="mb-2.5 px-1 lh-section">{t('Выключено')}</h2>
            <div data-zone="hidden" className="card divide-y divide-lh-border overflow-hidden">
              {state.hidden.map((id) => row(id, { hidden: true }))}
            </div>
          </section>
        )}

        <button
          type="button"
          onClick={reset}
          className="h-12 w-full rounded-xl text-sm text-lh-accent active:opacity-60"
        >
          {t('Сбросить по умолчанию')}
        </button>
      </div>

      {dragId && (
        <div
          className="pointer-events-none fixed z-[70] max-w-[60vw] -translate-y-1/2 translate-x-3 truncate rounded-xl border border-lh-accent bg-lh-surface-2 px-3 py-2 text-sm font-semibold shadow-lg shadow-black/30"
          style={{ left: pointer.x, top: pointer.y }}
        >
          {SECTION_BY_ID.get(dragId)?.label}
        </div>
      )}
    </Screen>
  );
}
