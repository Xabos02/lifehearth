import { useEffect, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { t } from '../../lib/i18n';

/** Снимок на весь экран.
 *
 *  Жил внутри семейного чата и был доступен только там. В задачах снимок был
 *  просто картинкой без обработчика: тап по нему уходил в строку и открывал
 *  форму задачи — рассмотреть фото было нельзя вовсе, хотя это ровно то, зачем
 *  его к задаче и прикрепляют («замерил, сфотографировал, потом посмотрю»).
 *
 *  Отличие от чатовой версии: снимков может быть несколько, поэтому между ними
 *  листают свайпом, а в углу видно, какой по счёту. В чате список всегда из
 *  одного — счётчик и свайп там просто не появляются.
 */
export function PhotoViewer({
  photos,
  index = 0,
  onClose,
}: {
  photos: string[];
  index?: number;
  onClose: () => void;
}) {
  const [i, setI] = useState(index);
  const [dx, setDx] = useState(0);
  const [from, setFrom] = useState<number | null>(null);

  // Открыт поверх всего — Escape закрывает: на маке приложение живёт в окне
  // браузера, и тянуться мышью к картинке ради закрытия неудобно.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
      if (e.key === 'ArrowRight') setI((v) => Math.min(photos.length - 1, v + 1));
      if (e.key === 'ArrowLeft') setI((v) => Math.max(0, v - 1));
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose, photos.length]);

  const many = photos.length > 1;
  const src = photos[Math.max(0, Math.min(photos.length - 1, i))];
  if (!src) return null;

  // Порог листания — четверть ширины. Меньше значит «дрогнула рука»: снимок
  // возвращается на место, а не перескакивает на соседний.
  const SWIPE = typeof window === 'undefined' ? 90 : window.innerWidth / 4;

  const onDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (!many) return;
    setFrom(e.clientX);
    setDx(0);
  };
  const onMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (from == null) return;
    setDx(e.clientX - from);
  };
  const onUp = () => {
    if (from == null) return;
    if (dx <= -SWIPE && i < photos.length - 1) setI(i + 1);
    else if (dx >= SWIPE && i > 0) setI(i - 1);
    setFrom(null);
    setDx(0);
  };

  return (
    <div
      data-testid="photo-viewer"
      className="fixed inset-0 z-[80] flex touch-none select-none items-center justify-center bg-black/95 p-3"
      // Закрытие тапом по фону — как в чате. Свайп тапом не считается:
      // сдвинул палец, отпустил — снимок листается, а не закрывается.
      onClick={() => {
        if (Math.abs(dx) < 8) onClose();
      }}
      onPointerDown={onDown}
      onPointerMove={onMove}
      onPointerUp={onUp}
      onPointerCancel={onUp}
    >
      <img
        src={src}
        alt={t('Фото')}
        draggable={false}
        style={{ transform: dx ? `translateX(${dx}px)` : undefined }}
        className="max-h-full max-w-full rounded-xl object-contain"
      />
      {many && (
        <span className="pointer-events-none absolute top-[calc(env(safe-area-inset-top)+12px)] right-4 rounded-full bg-black/50 px-2.5 py-1 text-xs font-medium text-white">
          {i + 1} / {photos.length}
        </span>
      )}
    </div>
  );
}
