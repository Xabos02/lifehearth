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
import {
  GLock as Lock,
  GRepeat as RotateCcw,
} from '../../components/ui/glyphs';
import { HIT_SLOP_44 } from '../../components/ui/hitSlop';

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
    const l = computeNavLayout(sectionsFor(settingsRow.gender, settingsRow.aiEnabled), settingsRow.navConfig, LAYOUT_OPTS);
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
    const l = computeNavLayout(sectionsFor(settingsRow?.gender, settingsRow?.aiEnabled), undefined, LAYOUT_OPTS);
    setState({ enabled: [...l.bottom.filter((id) => id !== ANCHOR_ID), ...l.more], hidden: l.hidden });
  };

  const previewBottom = useMemo(() => {
    if (!state) return [];
    const l = computeNavLayout(
      sectionsFor(settingsRow?.gender, settingsRow?.aiEnabled),
      { bottom: state.enabled.slice(0, MAX_BOTTOM), hidden: state.hidden },
      LAYOUT_OPTS,
    );
    return l.bottom.map((id) => SECTION_BY_ID.get(id)).filter((s) => Boolean(s));
  }, [state, settingsRow?.gender, settingsRow?.aiEnabled]);

  if (!state) {
    return (
      <Screen title={t('Настроить разделы')} backTo="/more/settings">
        <div className="py-10 text-center text-sm text-muted">{t('Загрузка…')}</div>
      </Screen>
    );
  }

  const dropLine = (index: number) =>
    dropIndex === index ? (
      <div
        className="my-1 h-1 rounded-full bg-accent"
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
        className={`flex items-center gap-3 card p-3 transition-opacity max-[375px]:gap-2 max-[375px]:px-2 ${
          hidden ? 'opacity-45' : ''
        } ${dragId === id ? 'opacity-30' : ''} ${
          draggable ? 'touch-pan-y cursor-grab select-none [-webkit-touch-callout:none] [-webkit-user-select:none] active:cursor-grabbing' : ''
        }`}
      >
        {/* Номер приоритета — только у разделов «Главной»: панель и так
            видна целиком, спорить там не о чем. Число — это позиция в
            списке HomePage, а не абстрактный ранг: 1 значит «первым увидите
            на „Главной“». */}
        {opts.homeIndex != null && (
          <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-surface-2 text-xs font-bold text-muted">
            {opts.homeIndex}
          </span>
        )}
        <div className="flex size-10 shrink-0 items-center justify-center rounded-xl tile-accent text-accent">
          <Icon size={ICON.header} />
        </div>
        {/* Обычный shrink (был shrink-[0.05]): при сумме flex-факторов меньше 1
            браузер раздаёт только эту долю нехватки, поэтому строка не ужималась,
            а вылезала за свой content-box — у «Статистики» на 7.53px в правый
            паддинг, к тумблеру. Теперь недостачу целиком берёт на себя название
            (min-w-0 + truncate), а бейдж остаётся целым. */}
        <div className="min-w-0 grow basis-auto">
          <p className="truncate font-semibold">{t(sec.label)}</p>
          {sec.subtitle && <p className="truncate text-xs text-muted">{t(sec.subtitle)}</p>}
        </div>
        {locked ? (
          // shrink-0: бейдж короткий и осмысленный только целиком — «вс…» и тем
          // более одно «…» не значат ничего. Ниже 375px он отдаёт названию свои
          // 16.25px, пряча замок (12px иконка + 4.25px зазор): слово «всегда»
          // несёт смысл само, а замок здесь лишь украшение. Плюс 4.25px на
          // сжатии боковых полей — этого хватает, чтобы «Настройки» влезли.
          <span className="flex shrink-0 items-center gap-1 rounded-full border border-hairline px-2 py-1 text-xs text-muted max-[375px]:px-1.5">
            <Lock size={ICON.inline} className="shrink-0 max-[375px]:hidden" /> <span>{t('всегда')}</span>
          </span>
        ) : (
          <button
            type="button"
            // Тумблер — своё отдельное действие по нажатию: гасим всплытие,
            // иначе pointerdown по нему же запускал бы таймер переноса строки.
            onPointerDown={(e) => e.stopPropagation()}
            onClick={() => toggle(id)}
            aria-label={hidden ? t('Включить раздел {name}', { name: t(sec.label) }) : t('Выключить раздел {name}', { name: t(sec.label) })}
            className={`h-6 w-11 shrink-0 rounded-full border transition-colors ${HIT_SLOP_44} ${
              hidden ? 'border-border bg-surface-2' : 'border-transparent bg-accent'
            }`}
          >
            <span
              className={`absolute top-0.5 size-4 rounded-full bg-white shadow transition-all ${
                hidden ? 'left-0.5' : 'left-[22px]'
              }`}
            />
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
    <div className="flex items-center gap-3 card p-3 max-[375px]:gap-2 max-[375px]:px-2">
      <div className="flex size-10 shrink-0 items-center justify-center rounded-xl tile-accent text-accent">
        <anchor.icon size={ICON.header} />
      </div>
      <span className="min-w-0 grow basis-auto truncate font-semibold">{t(anchor.label)}</span>
      <span className="flex shrink-0 items-center gap-1 rounded-full border border-hairline px-2 py-1 text-xs text-muted max-[375px]:px-1.5">
        <Lock size={ICON.inline} className="shrink-0 max-[375px]:hidden" /> <span>{t('всегда')}</span>
      </span>
    </div>
  );

  // Черта: первые MAX_BOTTOM включённых разделов — над ней, они в нижней
  // панели; остальные — под ней, они в списке «Главной». Если включённых
  // меньше MAX_BOTTOM, черта просто едет к концу списка.
  const dividerAt = Math.min(state.enabled.length, MAX_BOTTOM);
  const divider = (
    <div className="my-1 flex items-center gap-2 px-1" aria-hidden={false}>
      <span className="h-px flex-1 bg-border" />
      <span className="shrink-0 text-2xs font-semibold uppercase tracking-wide text-muted">
        {t('выше — панель · ниже — «Главная»')}
      </span>
      <span className="h-px flex-1 bg-border" />
    </div>
  );

  // Второй ориентир — уже внутри списка «Главной»: первые HOME_VISIBLE_STEP
  // после черты видны на HomePage сразу, остальные — за кнопкой «Показать
  // ещё». Значит показываем его только если разделов «Главной» больше этого
  // порога — иначе делить нечего.
  const homeExpandAt = dividerAt + HOME_VISIBLE_STEP;
  const homeExpandDivider = (
    <div className="my-1 flex items-center gap-2 px-1" aria-hidden={false}>
      <span className="h-px flex-1 border-t border-dashed border-border" />
      <span className="shrink-0 text-2xs font-semibold uppercase tracking-wide text-muted">
        {t('на «Главной» — за кнопкой «Показать ещё»')}
      </span>
      <span className="h-px flex-1 border-t border-dashed border-border" />
    </div>
  );

  return (
    <Screen title={t('Настроить разделы')} backTo="/more/settings">
      <p className="mb-4 px-1 text-sm leading-relaxed text-muted">
        {t('Тумблер включает и выключает раздел нажатием. Чтобы поменять порядок или перенести раздел через черту в нижнюю панель (до {n} мест, не считая «Главной») — задержите строку пальцем и перетащите. Номер у раздела — его место в списке «Главной»: первые {home} видны сразу, остальные — за кнопкой «Показать ещё».', { n: MAX_BOTTOM, home: HOME_VISIBLE_STEP })}
      </p>

      <div data-zone="enabled" className="mb-6 space-y-2">
        {state.enabled.map((id, i) => (
          <div key={id}>
            {i === dividerAt && (
              <>
                {anchorRow}
                {divider}
              </>
            )}
            {i === homeExpandAt && i > dividerAt && homeExpandDivider}
            {dropLine(i)}
            {row(id, i >= dividerAt ? { homeIndex: i - dividerAt + 1 } : {})}
          </div>
        ))}
        {dividerAt === state.enabled.length && (
          <>
            {anchorRow}
            {divider}
          </>
        )}
        {dropLine(state.enabled.length)}
      </div>

      {state.hidden.length > 0 && (
        <>
          <div className="mb-1.5 px-1 text-xs font-bold uppercase tracking-wide text-muted">
            {t('Выключено')}
          </div>
          <div data-zone="hidden" className="mb-6 space-y-2">
            {state.hidden.map((id) => row(id, { hidden: true }))}
          </div>
        </>
      )}

      <button
        type="button"
        onClick={reset}
        className="mb-8 flex w-full items-center justify-center gap-2 rounded-2xl border border-dashed border-border py-3.5 text-sm font-semibold text-muted active:opacity-70"
      >
        <RotateCcw size={ICON.action} /> {t('Сбросить по умолчанию')}
      </button>

      {/* Превью панели */}
      <div className="mb-2 px-1 text-xs font-bold uppercase tracking-wide text-muted">
        {t('Как будет выглядеть панель')}
      </div>
      <div className="flex overflow-hidden rounded-2xl border border-hairline bg-elevated">
        {previewBottom.map((s) =>
          s ? (
            <div key={s.id} className="flex min-w-0 flex-1 flex-col items-center gap-1 py-2.5">
              <s.icon size={ICON.header} className="text-muted" />
              {/* без max-w-full подпись раздвигает колонку и превью уезжает вбок.
                  Кегль плавающий и мельче, чем в самой панели: колонка превью
                  уже настоящей вкладки (страница отъедает px-4 = 34px), на 320px
                  это 56.8px против 62.3px. При фиксированных 10px «Статистика»
                  (64.95px) обрезалась бы именно в том превью, ради которого
                  пользователь её сюда и переносит. 2.6vw даёт 8.32px на 320px —
                  запас 2.76px, а с 393px кегль упирается в прежние 10px.
                  Боковых полей нет: 4.25px в такой колонке дороже, чем воздух. */}
              <span className="max-w-full truncate text-2xs font-semibold text-muted">
                {t(s.label)}
              </span>
            </div>
          ) : null,
        )}
      </div>

      {dragId && (
        <div
          className="pointer-events-none fixed z-[70] max-w-[60vw] -translate-y-1/2 translate-x-3 truncate rounded-xl border border-accent bg-elevated px-3 py-2 text-sm font-semibold shadow-lg shadow-black/30"
          style={{ left: pointer.x, top: pointer.y }}
        >
          {SECTION_BY_ID.get(dragId)?.label}
        </div>
      )}
    </Screen>
  );
}
