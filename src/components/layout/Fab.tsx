import { useLayoutEffect, useRef, useState, type PointerEvent } from 'react';
import {
  GPlus as Plus,
} from '../../components/ui/glyphs';
import { usePomodoroActions } from '../../features/focus/pomodoro';
import { useSettings, updateSettings } from '../../hooks/useSettings';
import { t } from '../../lib/i18n';
import { ICON, STROKE_HEAVY } from '../ui/icons';

interface Props {
  onClick: () => void;
  label?: string;
}

const FAB_SIZE = 56; // size-14 (3.5rem)
const EDGE = 12; // отступ от боковых краёв
const TOP_GAP = 76; // не заходить под шапку
const BOTTOM_GAP = 96; // не заходить под таб-бар (+ запас на safe-area)
const TIMER_SPACE = 48; // мини-помодоро — полоска над таб-баром
const LONG_PRESS_MS = 450; // удержание без ухода пальца → режим перетаскивания
const CANCEL_MOVE = 10; // уход пальца до срабатывания удержания = не перетаскивание
/** Высота полосы, которую лента отдаёт кнопке (см. App.tsx: нижний отступ
 *  скролл-контейнера). Кнопка стоит на 4px выше таб-бара и сама высотой 56 —
 *  68 накрывают её целиком и оставляют 8px воздуха над ней. При идущем
 *  помодоро счёт тот же: клиренс растёт на 48, но ровно на столько же
 *  поднимается низ ленты — полоску таймера каркас держит своим элементом. */
const FAB_STRIP = '68px';

/** Держит кнопку в допустимой зоне во время переноса (и, значит, в том виде, в
 *  каком позиция уходит в settings): не под шапку, не за боковые края и не под
 *  таб-бар. reserve — полоска мини-помодоро сверх таб-бара. Границы уже отрисованной
 *  кнопки повторяет CSS-clamp в style — он переживает поворот без ре-рендера. */
function clampToViewport(x: number, y: number, reserve: number): { x: number; y: number } {
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const maxX = Math.max(EDGE, vw - FAB_SIZE - EDGE);
  const maxY = Math.max(TOP_GAP, vh - FAB_SIZE - BOTTOM_GAP - reserve);
  return { x: Math.min(Math.max(x, EDGE), maxX), y: Math.min(Math.max(y, TOP_GAP), maxY) };
}

// Сколько кнопок сейчас на экране. При смене маршрута React сначала прогоняет
// все cleanup, потом все эффекты, поэтому счётчик на мгновение падает в 0 и
// сразу возвращается в 1 — резерв не залипает и не пропадает между страницами.
let mounted = 0;

/** Плавающая кнопка добавления. Короткий тап — нажатие (открыть добавление).
 *  Удержание ~0.45с включает режим перетаскивания (кнопка приподнимается) —
 *  дальше тащишь её в любое удобное место. Так согласуется с переносом задач и
 *  проектов (тоже удержанием) и исключает случайный сдвиг при обычном нажатии.
 *  Позиция хранится в settings (device-local) — у каждого человека своя.
 *  Во время переноса двигаем через transform (без reflow) — движение плавное.
 *  Кнопка поднимается выше мини-помодоро в ЛЮБОЙ позиции, включая
 *  перенесённую руками: раньше подъём жил только в bottom-классе дефолта.
 *
 *  Кнопка НИЧЕГО не перекрывает: лента заканчивается выше неё (FAB_STRIP), а
 *  под кнопкой — фон каркаса. До этого она висела поверх ленты и воровала
 *  тапы у того, что оказывалось под ней: на «Сегодня» при прокрутке под неё
 *  попадали «отправить» и микрофон строки быстрого ввода (100% и 22% площади),
 *  крестик подсказки (100%), кружок оценки энергии (54%). Прятание при
 *  прокрутке вниз, которым это лечили раньше, снято: оно спасало наполовину
 *  (возвращаясь при движении вверх, кнопка вставала на то же место) и ценой
 *  того, что кнопка пропадала без причины. */
export function Fab({ onClick, label }: Props) {
  // Без тикающего времени: кнопке нужен только флаг «идёт сеанс».
  const { active } = usePomodoroActions();
  const settings = useSettings();
  const saved = settings.fabPosition ?? null;

  const [dragging, setDragging] = useState(false);
  // Позиция, применённая сразу после переноса — чтобы кнопка не мигнула в момент
  // между отпусканием и синком с settings. null — берём из settings (или дефолт).
  const [override, setOverride] = useState<{ x: number; y: number } | null>(null);

  const ref = useRef<HTMLButtonElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const g = useRef({
    armed: false, // палец опущен, ждём удержание
    dragMode: false, // удержание сработало — тащим
    moved: false, // было реальное перемещение
    wasDrag: false, // подавить click после режима перетаскивания
    sx: 0,
    sy: 0,
    baseX: 0,
    baseY: 0,
    curX: 0,
    curY: 0,
    pointerId: 0,
  });

  // Пока кнопка на экране — лента отдаёт ей полосу внизу (её читает нижний
  // отступ скролл-контейнера в App.tsx), и контент физически заканчивается
  // выше кнопки. Layout-эффект, а не обычный: полоса появляется до отрисовки
  // кадра, иначе на переходе виден скачок ленты.
  useLayoutEffect(() => {
    mounted += 1;
    document.documentElement.style.setProperty('--fab-strip', FAB_STRIP);
    return () => {
      mounted -= 1;
      if (mounted === 0) document.documentElement.style.setProperty('--fab-strip', '0px');
    };
  }, []);

  // Клиренс снизу: таб-бар с safe-area + полоска мини-помодоро, когда он идёт.
  // Install-баннера здесь больше нет: он переехал в ленту (App.tsx) и уезжает
  // с прокруткой. Пока он стоял отдельным блоком над таб-баром, кнопка
  // поднималась на его высоту (до 150px) и садилась в середину экрана, где
  // перекрывала живые элементы — сегмент «Год» в Финансах на 66%, карандаш
  // раздела на 93%.
  const clearance = `calc(env(safe-area-inset-bottom) + ${active ? 128 : 80}px)`;

  // Куда рисуем: только что перенесли (override) → сохранённая → дефолт
  // (right/bottom). Границы для своей позиции считает CSS через clamp(), а не JS:
  // так подъём над баннером/таймером пересчитывается сам при их появлении и при
  // повороте экрана — без ре-рендера, которого кнопке взять неоткуда (высоту
  // баннера ей никто не сообщает). Во время переноса left/top остаются базой,
  // а смещение идёт через transform.
  const pos = override ?? saved;

  const clearTimer = () => {
    clearTimeout(timer.current);
    timer.current = undefined;
  };
  const releaseCapture = () => {
    try {
      ref.current?.releasePointerCapture(g.current.pointerId);
    } catch {
      /* указатель уже отпущен */
    }
  };

  const onPointerDown = (e: PointerEvent<HTMLButtonElement>) => {
    const r = ref.current?.getBoundingClientRect();
    if (!r) return;
    g.current = {
      armed: true,
      dragMode: false,
      moved: false,
      wasDrag: false,
      sx: e.clientX,
      sy: e.clientY,
      baseX: r.left,
      baseY: r.top,
      curX: r.left,
      curY: r.top,
      pointerId: e.pointerId,
    };
    try {
      ref.current?.setPointerCapture(e.pointerId);
    } catch {
      /* указатель уже неактивен */
    }
    clearTimer();
    timer.current = setTimeout(() => {
      if (!g.current.armed) return;
      g.current.dragMode = true;
      g.current.wasDrag = true;
      try {
        navigator.vibrate?.(10); // тактильный сигнал «взял» (где поддерживается)
      } catch {
        /* без вибрации */
      }
      setDragging(true);
    }, LONG_PRESS_MS);
  };

  const onPointerMove = (e: PointerEvent<HTMLButtonElement>) => {
    const s = g.current;
    if (!s.armed) return;
    if (!s.dragMode) {
      // Ждём удержание. Заметный сдвиг раньше времени = не перетаскивание: отменяем
      // (и глушим последующий click, чтобы свайп по кнопке не добавил задачу).
      if (Math.hypot(e.clientX - s.sx, e.clientY - s.sy) > CANCEL_MOVE) {
        clearTimer();
        s.armed = false;
        s.wasDrag = true;
        releaseCapture();
      }
      return;
    }
    const reserve = active ? TIMER_SPACE : 0;
    const clamped = clampToViewport(
      s.baseX + (e.clientX - s.sx),
      s.baseY + (e.clientY - s.sy),
      reserve,
    );
    s.curX = clamped.x;
    s.curY = clamped.y;
    s.moved = true;
    // Императивно, без ре-рендера: transform не вызывает reflow — движение плавное.
    if (ref.current) {
      ref.current.style.transform = `translate(${clamped.x - s.baseX}px, ${clamped.y - s.baseY}px)`;
    }
  };

  const onPointerUp = () => {
    const s = g.current;
    clearTimer();
    releaseCapture();
    if (s.dragMode) {
      if (ref.current) ref.current.style.transform = '';
      if (s.moved) {
        const final = { x: s.curX, y: s.curY };
        setOverride(final);
        void updateSettings({ fabPosition: final });
      }
      setDragging(false);
    }
    s.armed = false;
    s.dragMode = false;
  };

  const handleClick = () => {
    if (g.current.wasDrag) {
      g.current.wasDrag = false;
      return; // был режим перетаскивания / отменённый свайп — не нажатие
    }
    onClick();
  };

  return (
    <button
      ref={ref}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      onClick={handleClick}
      aria-label={label ?? t('Добавить')}
      style={{
        background: 'var(--app-accent-fill)',
        touchAction: 'none', // касание кнопки не скроллит страницу — тащим её саму
        ...(pos
          ? {
              left: `clamp(${EDGE}px, ${pos.x}px, calc(100vw - ${FAB_SIZE + EDGE}px))`,
              top: `clamp(${TOP_GAP}px, ${pos.y}px, calc(100dvh - ${FAB_SIZE}px - ${clearance}))`,
            }
          : // Дефолт: у правого края центральной колонки (max-w-lg = 32rem).
            { right: 'max(1.25rem, calc(50vw - 16rem))', bottom: clearance }),
        ...(dragging ? { willChange: 'transform' } : {}),
      }}
      // select-none + webkit-touch-callout/user-select/tap-highlight — глушим
      // нативную iOS-реакцию на удержание (лупа, синее выделение, callout),
      // иначе она перебивает наш жест переноса. Позиция задана в style (right/
      // bottom для дефолта, left/top для своей) — в ней CSS-функции с env() и
      // переменными, Tailwind-классы такое не покрывают. Плавность (transition)
      // выключаем на время переноса, иначе она «догоняет» transform и кнопка
      // дёргается; top и bottom в списке — кнопка уезжает вверх при появлении
      // полоски таймера. active:scale-90 — только вне переноса (в переносе
      // кнопка приподнята scale-105). motion-reduce:transition-none — при
      // «уменьшить движение» кнопка просто переключается, без проезда.
      className={`fixed z-40 flex size-14 select-none items-center justify-center rounded-full text-white shadow-[var(--shadow-accent)] [-webkit-touch-callout:none] [-webkit-user-select:none] [-webkit-tap-highlight-color:transparent] ${
        dragging ? 'scale-105 shadow-2xl' : 'active:scale-90'
      } ${
        dragging ? '' : 'transition-[transform,bottom,top] duration-200 motion-reduce:transition-none'
      }`}
    >
      <Plus size={ICON.accent} strokeWidth={STROKE_HEAVY} className="pointer-events-none" />
    </button>
  );
}
