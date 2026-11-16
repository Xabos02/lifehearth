import { useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { db } from '../../db/db';
import { IconButton } from '../../components/ui/IconButton';
import { PhotoViewer } from '../../components/ui/PhotoViewer';
import { GPhoto } from '../../components/ui/glyphs';
import { useToast } from '../../components/ui/toastContext';
import { confirmAction } from '../../components/ui/confirmStore';
import { compressImage, ImageTooLargeError, MAX_INPUT_BYTES } from '../../lib/image';
import { t } from '../../lib/i18n';
import {
  addBoardPhoto,
  assembleBoard,
  BOARD_ID,
  BOARD_MAX,
  boardLayout,
  boardMaxHeight,
  removeBoardPhoto,
} from '../../lib/photoBoard';

/** Снимки панели — живым запросом. Пусто, пока не загрузилось. */
function useBoardPhotos() {
  const rows = useLiveQuery(() => db.taskPhotos.where('taskId').equals(BOARD_ID).toArray(), []);
  return useMemo(() => assembleBoard(rows ?? []), [rows]);
}

/**
 * Фото-панель наверху «Задач».
 *
 * Пустая — не занимает ни пикселя: добавляют её кнопкой в шапке экрана, и
 * тем, кому панель не нужна, она не мешает. С фото — снимки раскладываются по
 * ширине экрана целиком, без обрезки (lib/photoBoard.ts). Тап — снимок на весь
 * экран, оттуда же его и убирают. Раскладка — вариант А канвы
 * design/photo-board (выбран 16.11.2026).
 */
export function PhotoBoard() {
  const photos = useBoardPhotos();
  const box = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  const [viewportHeight, setViewportHeight] = useState(() => window.innerHeight);
  const [viewerAt, setViewerAt] = useState<number | null>(null);
  const has = photos.length > 0;

  // Раскладка в пикселях, поэтому нужна ширина. Меряем до отрисовки, чтобы
  // плитки не прыгали, и следим за поворотом экрана. Высота окна — для
  // предела панели: ResizeObserver на блоке её смену не видит.
  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    setWidth(el.clientWidth);
    const ro = new ResizeObserver(() => setWidth(el.clientWidth));
    ro.observe(el);
    const onResize = () => setViewportHeight(window.innerHeight);
    window.addEventListener('resize', onResize);
    return () => {
      ro.disconnect();
      window.removeEventListener('resize', onResize);
    };
  }, [has]);

  const layout = useMemo(
    () => boardLayout(photos.map((p) => p.aspect), width, boardMaxHeight(width, viewportHeight)),
    [photos, width, viewportHeight],
  );

  if (!has) return null;

  const onDelete = async (i: number) => {
    const photo = photos[i];
    // Просмотр закрываем до вопроса: он выше шторки подтверждения по слоям.
    setViewerAt(null);
    if (!photo) return;
    // Спрашиваем, потому что вернуть будет неоткуда: содержимое снимка
    // стирается сразу (lib/photoBoard.ts, removeBoardPhoto).
    if (!(await confirmAction({ title: t('Убрать фото с панели?'), confirmLabel: t('Убрать с панели') }))) return;
    await removeBoardPhoto(photo.photoId);
  };

  return (
    <section aria-label={t('Фотопанель')} className="mb-4">
      <div ref={box} className="relative" style={{ height: layout.height }}>
        {layout.tiles.map((tile, i) => {
          const photo = photos[i];
          if (!photo) return null;
          // Рамка шире снимка (поджали по высоте) — по бокам размытая копия
          // того же снимка, а не пустые поля. Порог в пикселях: от округления
          // краёв остаётся до пикселя, и подложка ради него не нужна.
          const filler =
            Math.max(tile.w - photo.aspect * tile.h, tile.h - tile.w / photo.aspect) >= 2;
          return (
            <button
              key={photo.photoId}
              type="button"
              aria-label={t('Открыть фото')}
              onClick={() => setViewerAt(i)}
              className="absolute overflow-hidden rounded-xl bg-lh-surface-2 active:opacity-70 after:pointer-events-none after:absolute after:inset-0 after:rounded-xl after:border after:border-lh-border"
              style={{ left: tile.x, top: tile.y, width: tile.w, height: tile.h }}
            >
              {filler && (
                <img
                  src={photo.src}
                  alt=""
                  aria-hidden
                  draggable={false}
                  className="absolute inset-0 size-full scale-125 object-cover blur-xl brightness-75"
                />
              )}
              <img src={photo.src} alt="" draggable={false} className="relative size-full object-contain" />
            </button>
          );
        })}
      </div>
      {viewerAt !== null && (
        <PhotoViewer
          photos={photos.map((p) => p.src)}
          index={viewerAt}
          onClose={() => setViewerAt(null)}
          onDelete={(i) => void onDelete(i)}
        />
      )}
    </section>
  );
}

/** Пропорции готового снимка — для раскладки панели без ожидания картинок. */
function aspectOf(src: string): Promise<number> {
  return new Promise((res) => {
    const img = new Image();
    img.onload = () => res(img.naturalHeight > 0 ? img.naturalWidth / img.naturalHeight : 1);
    img.onerror = () => res(1);
    img.src = src;
  });
}

/** Кнопка «Добавить фото на панель» — в шапку экрана «Задачи». */
export function AddBoardPhotoButton() {
  const photos = useBoardPhotos();
  const toast = useToast();
  const input = useRef<HTMLInputElement>(null);

  const add = async (files: FileList | null) => {
    if (!files?.length) return;
    const room = BOARD_MAX - photos.length;
    const list = Array.from(files);
    if (room <= 0) {
      toast(t('На панели уже {n} фото — уберите одно, чтобы добавить новое', { n: BOARD_MAX }));
      return;
    }
    let tooBig = 0;
    let broken = 0;
    for (const f of list.slice(0, room)) {
      try {
        // Крупнее, чем у фото задач (1280): на панели снимок смотрят как есть,
        // и мелкий текст на нём — расписание, схема — должен читаться.
        const src = await compressImage(f, 2048, 0.8);
        await addBoardPhoto(src, await aspectOf(src));
      } catch (e) {
        if (e instanceof ImageTooLargeError) tooBig++;
        else broken++;
      }
    }
    if (tooBig) toast(t('Фото больше {mb} МБ — выберите поменьше', { mb: MAX_INPUT_BYTES / 1024 / 1024 }));
    else if (broken) toast(t('Не удалось открыть фото. Попробуйте другой файл'));
    else if (list.length > room) toast(t('На панели помещается {n} фото — лишние не добавлены', { n: BOARD_MAX }));
  };

  return (
    <>
      <IconButton icon={GPhoto} label={t('Добавить фото на панель')} onClick={() => input.current?.click()} />
      <input
        ref={input}
        type="file"
        accept="image/*"
        multiple
        className="hidden"
        onChange={(e) => {
          void add(e.target.files);
          // Тот же файл можно выбрать снова — иначе change не придёт.
          e.target.value = '';
        }}
      />
    </>
  );
}
