import { useEffect, useRef, useState, type PointerEvent, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import {
  GClose as X,
} from '../../components/ui/glyphs';
import { t } from '../../lib/i18n';
import { useKeyboardInset } from '../../hooks/useKeyboardInset';
import { isTouch } from '../../lib/platform';
import { HIT_SLOP_44 } from './hitSlop';
import { ICON } from '../../components/ui/icons';

interface Props {
  open: boolean;
  onClose: () => void;
  title?: string;
  children: ReactNode;
}

/** Протянул дальше этого порога (px) — закрываем. */
const CLOSE_DISTANCE = 100;
/** Быстрый флик вниз (px/мс) — закрываем независимо от расстояния. */
const FLICK_VELOCITY = 0.55;

/** Bottom sheet — стандартный контейнер быстрых форм создания/редактирования.
 *  Закрывается свайпом вниз по «ручке»/шапке. */
export function Sheet({ open, onClose, title, children }: Props) {
  const panelRef = useRef<HTMLDivElement>(null);
  // Клавиатура накрывала нижнюю часть панели: она прибита к низу
  // layout-вьюпорта, а клавиатура живёт поверх него. Под ней оказывались
  // последние поля и ряд кнопок — «Сохранить» нажать было нельзя, и
  // доскроллить к ней тоже: низ самой панели уже под клавиатурой.
  const keyboardInset = useKeyboardInset();
  // Тап, который убрал клавиатуру, не должен ещё и закрыть шторку: click
  // приходит следом за pointerdown, и без этого флага одно касание делало бы
  // и то, и другое.
  const swallowClick = useRef(false);
  // Текущее смещение панели за пальцем; null — drag не активен (нет transform).
  const [dragY, setDragY] = useState<number | null>(null);
  // Сведения о текущем жесте для расчёта скорости и delta; вне state, чтобы не дёргать рендер.
  const gesture = useRef<{ startY: number; lastY: number; lastT: number; velocity: number } | null>(
    null,
  );

  // При открытии сбрасываем прокрутку шита наверх — формы открываются с верха,
  // а не «доскроленными» вниз (баг iOS с автофокусом/восстановлением скролла).
  useEffect(() => {
    if (open) {
      gesture.current = null;
      panelRef.current?.scrollTo({ top: 0 });
    }
  }, [open]);

  // Пока форма открыта, страница под ней не прокручивается вовсе.
  //
  // overscroll-contain на самой панели останавливает перетекание прокрутки,
  // но остаются пути мимо неё: палец на затемнении, инерция, колесо мыши над
  // краем. Замораживаем прокручиваемый контейнер приложения и возвращаем ему
  // ровно ту позицию, на которой человек остановился, — иначе форма
  // закрывается, а список оказывается не там, где был.
  useEffect(() => {
    if (!open) return;
    const scroller = document.querySelector<HTMLElement>('[data-app-scroll]');
    if (!scroller) return;
    const prev = scroller.style.overflowY;
    const at = scroller.scrollTop;
    scroller.style.overflowY = 'hidden';
    return () => {
      scroller.style.overflowY = prev;
      scroller.scrollTop = at;
    };
  }, [open]);

  if (!open) return null;

  function handlePointerDown(e: PointerEvent<HTMLDivElement>) {
    // Жест начинаем только когда контент прокручен к самому верху,
    // иначе свайп вниз — это обычная прокрутка.
    if ((panelRef.current?.scrollTop ?? 0) > 0) return;
    gesture.current = { startY: e.clientY, lastY: e.clientY, lastT: e.timeStamp, velocity: 0 };
    e.currentTarget.setPointerCapture(e.pointerId);
  }

  function handlePointerMove(e: PointerEvent<HTMLDivElement>) {
    const g = gesture.current;
    if (!g) return;
    const dy = e.clientY - g.startY;
    // Тянем только вниз; вверх не уводим (резинка только в одну сторону).
    const next = dy > 0 ? dy : 0;
    const dt = e.timeStamp - g.lastT;
    if (dt > 0) g.velocity = (e.clientY - g.lastY) / dt;
    g.lastY = e.clientY;
    g.lastT = e.timeStamp;
    setDragY(next);
  }

  function handlePointerUp() {
    const g = gesture.current;
    gesture.current = null;
    if (!g) return;
    const travelled = g.lastY - g.startY;
    if (travelled > CLOSE_DISTANCE || g.velocity > FLICK_VELOCITY) {
      // Сброс смещения делаем здесь, а не в эффекте открытия: иначе панель
      // при следующем открытии осталась бы сдвинутой на величину свайпа.
      setDragY(null);
      onClose();
    } else {
      // Пружинит обратно: transition включается только на отпускании.
      setDragY(null);
    }
  }

  const dragging = dragY !== null;

  return createPortal(
    <div className="fixed inset-0 z-50">
      <div
        // touch-none: перетаскивание по затемнению — это не прокрутка. Без
        // него палец на подложке двигал страницу под шторкой.
        className="absolute inset-0 animate-fade-in touch-none bg-black/60"
        // Решение принимаем на pointerdown, а не на click: браузер снимает
        // фокус с поля сам, ещё до клика, и к обработчику click проверять уже
        // нечего — активным элементом будет body.
        onPointerDown={(e) => {
          // Тап мимо панели, когда человек печатает, — это «убери клавиатуру»,
          // а не «выбрось форму». Раньше он закрывал шторку, и заполненная
          // задача с чек-листом и фотографиями исчезала от одного промаха.
          // Снимаем фокус сами; закрывает уже следующий тап.
          const active = document.activeElement as HTMLElement | null;
          const typing =
            active &&
            panelRef.current?.contains(active) &&
            (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA' || active.isContentEditable);
          if (!typing || (keyboardInset === 0 && !isTouch)) return;
          e.preventDefault(); // фокус не отдаём браузеру — снимаем сами
          active.blur();
          swallowClick.current = true;
        }}
        onClick={() => {
          if (swallowClick.current) {
            swallowClick.current = false;
            return;
          }
          onClose();
        }}
      />
      <div
        ref={panelRef}
        // overscroll-contain обязателен: без него прокрутка внутри панели,
        // дойдя до края, перетекает на страницу ПОД ней — и экран приложения
        // уезжает вместе с формой. Со стороны это выглядит как «всё плавает».
        className="absolute inset-x-0 bottom-0 mx-auto max-h-[88dvh] w-full max-w-lg animate-sheet-up overflow-y-auto overscroll-contain rounded-t-[1.6rem] border-t border-hairline bg-elevated pb-[calc(env(safe-area-inset-bottom)+16px)] shadow-[var(--shadow-pop)]"
        style={{
          // Панель поднимается ровно на высоту клавиатуры, а её потолок на ту
          // же величину опускается — иначе поднятая панель упёрлась бы в
          // верхний край экрана и нижние поля всё равно остались бы за кадром.
          transform: dragging
            ? `translateY(${dragY - keyboardInset}px)`
            : `translateY(-${keyboardInset}px)`,
          // Пустой transform держит панель на месте и даёт пружину обратно
          // после drag, не перезапуская keyframe-анимацию входа.
          transition: dragging ? 'none' : 'transform 0.2s ease-out',
          maxHeight: keyboardInset > 0 ? `calc(88dvh - ${keyboardInset}px)` : undefined,
        }}
      >
        <div
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerUp}
          onPointerCancel={handlePointerUp}
          className="sticky top-0 z-10 cursor-grab touch-none bg-elevated px-4 pt-2.5 pb-2 active:cursor-grabbing"
        >
          <div className="mx-auto mb-2.5 h-1 w-9 rounded-full bg-muted/40" />
          <div className="flex items-center justify-between">
            <h2 className="text-lg font-bold">{title}</h2>
            {/* Крестик остаётся мелким (30px): визуально он служебный и
                раздувать его незачем. А вот зону касания псевдоэлемент
                добирает до 44×44 — палец мимо служебной кнопки промахивается
                ровно так же, как мимо главной. Ограничение hitSlop про 11px
                между соседями соблюдено: рядом с крестиком ничего нет. */}
            <button
              onClick={onClose}
              onPointerDown={(e) => e.stopPropagation()}
              aria-label={t('Закрыть')}
              className={`rounded-full bg-surface-2 p-1.5 text-muted transition-transform active:scale-90 ${HIT_SLOP_44}`}
            >
              <X size={ICON.base} />
            </button>
          </div>
        </div>
        <div className="px-4 pt-1">{children}</div>
      </div>
    </div>,
    document.body,
  );
}
