import {
  useEffect,
  useRef,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
} from 'react';
import {
  DRAG_CANCEL_MOVE,
  LONG_PRESS_MS,
} from './dragTuning';

// Машина удержания и переноса проектов.
//
// Вынесена из TasksPage.tsx перемещением, без изменения логики. Это самое
// чинёное место раздела: семь отдельных провалов в истории и четыре набора
// браузерных тестов вокруг. Держать её посреди файла на 1777 строк — значит
// каждый раз читать её заново вместе со всем остальным.

/** Удержание заголовка → перетаскивание секции.
 *
 *  Общая машинка для проектов и подпроектов: раньше она жила только внутри
 *  Section, из-за чего подпроект нельзя было сдвинуть вовсе. Тонкостей тут
 *  больше, чем кажется, и дублировать их вторым экземпляром — верный способ
 *  получить два разных поведения: блокировка нативного скролла ровно на время
 *  жеста, захват указателя (иначе вертикальный перенос заберёт себе iOS),
 *  отмена по сдвигу пальца (это скролл, а не удержание) и подавление клика
 *  после удачного удержания (иначе секция ещё и свернётся). */
export function useHoldToReorder(
  onReorderStart: ((at: { x: number; y: number; pointerId: number }) => void) | undefined,
  onToggle: () => void,
) {
  const pressTimer = useRef<number | null>(null);
  const longFired = useRef(false);
  const startPt = useRef({ x: 0, y: 0 });
  const headerRef = useRef<HTMLButtonElement>(null);
  const pointerIdRef = useRef(0);
  const reorderable = Boolean(onReorderStart);

  // Снятие взведённого удержания живёт в ref, а не в обычной функции.
  //
  // Им же вешается и снимается сторож окна, а removeEventListener сверяет
  // функции по идентичности: пересоздай её на рендере — и сторож остался бы
  // висеть. Ref даёт один экземпляр на всё время жизни заголовка.
  /** Показать, что удержание идёт.
   *
   *  Раньше между нажатием и стартом переноса не менялось НИЧЕГО: 400 мс
   *  человек не знает, взял он папку или уже сорвал жест движением. Отсюда
   *  два одинаково плохих исхода — повести палец рано (жест отменится как
   *  скролл) или замереть с запасом и вести неуверенно. Неуверенное ведение и
   *  есть «ищу точку».
   *
   *  Сжатие вешаем на саму кнопку заголовка, а НЕ на секцию: прямоугольник
   *  секции служит зоной попадания при вложении, масштабировать его нельзя.
   *  Вибрации здесь нет намеренно — WebKit её не поддерживает, а основная
   *  платформа приложения это iPhone: сигнал обязан быть видимым. */
  const showHold = (on: boolean) => {
    const el = headerRef.current;
    if (!el) return;
    el.style.transition = on ? 'transform 400ms ease-out' : 'transform 120ms ease-out';
    el.style.transform = on ? 'scale(0.97)' : '';
  };

  const cancelRef = useRef<() => void>(() => {});
  useEffect(() => {
    cancelRef.current = () => {
      if (pressTimer.current != null) {
        clearTimeout(pressTimer.current);
        pressTimer.current = null;
      }
      // Снимаем сжатие здесь, а не в каждом обработчике: cancelPress зовётся
      // из всех трёх путей отмены и из самого таймера — иначе заголовок
      // оставался бы уменьшенным.
      const el = headerRef.current;
      if (el) {
        el.style.transition = 'transform 120ms ease-out';
        el.style.transform = '';
      }
      window.removeEventListener('pointerup', cancelRef.current);
      window.removeEventListener('pointercancel', cancelRef.current);
    };
    // Та же подстраховка, что в строке задачи: снять висящий таймер при
    // размонтировании заголовка.
    return () => cancelRef.current();
  }, []);
  const cancelPress = () => cancelRef.current();

  // Отпускание пальца ловим на ОКНЕ, а не только на самом заголовке.
  //
  // Обработчик заголовка видит отпускание, лишь когда оно пришло в него: палец
  // соскользнул на соседний элемент, строку перерисовало, экран сменился — и
  // события нет. Тогда таймер срабатывал уже после конца касания: перенос
  // стартовал без пальца, плашка приклеивалась к экрану, и убрать её было
  // нечем — pointerup больше не придёт. Окно видит отпускание всегда.
  const armReleaseGuard = () => {
    window.addEventListener('pointerup', cancelRef.current);
    window.addEventListener('pointercancel', cancelRef.current);
  };
  const endHeaderDrag = () => {
    const el = headerRef.current;
    if (!el) return;
    el.style.touchAction = '';
    try {
      el.releasePointerCapture(pointerIdRef.current);
    } catch {
      /* указатель уже отпущен */
    }
  };

  const headerProps = {
    ref: headerRef,
    onPointerDown: (e: ReactPointerEvent<HTMLButtonElement>) => {
      if (!reorderable) return;
      longFired.current = false;
      startPt.current = { x: e.clientX, y: e.clientY };
      pointerIdRef.current = e.pointerId;
      cancelPress();
      showHold(true);
      pressTimer.current = window.setTimeout(() => {
        cancelPress(); // таймер отработал: снимаем сторожа окна
        longFired.current = true;
        const el = headerRef.current;
        if (el) {
          el.style.touchAction = 'none';
          try {
            el.setPointerCapture(pointerIdRef.current);
          } catch {
            /* указатель уже неактивен */
          }
        }
        onReorderStart?.({ ...startPt.current, pointerId: pointerIdRef.current });
      }, LONG_PRESS_MS);
      armReleaseGuard();
    },
    onPointerMove: (e: ReactPointerEvent<HTMLButtonElement>) => {
      if (pressTimer.current == null) return;
      if (
        Math.abs(e.clientX - startPt.current.x) > DRAG_CANCEL_MOVE ||
        Math.abs(e.clientY - startPt.current.y) > DRAG_CANCEL_MOVE
      ) {
        cancelPress();
      }
    },
    onPointerUp: () => {
      cancelPress();
      endHeaderDrag();
    },
    onPointerCancel: () => {
      cancelPress();
      endHeaderDrag();
    },
    onClick: (e: ReactMouseEvent<HTMLButtonElement>) => {
      if (longFired.current) {
        e.preventDefault();
        longFired.current = false;
        return;
      }
      onToggle();
    },
  };
  return { reorderable, headerProps };
}
