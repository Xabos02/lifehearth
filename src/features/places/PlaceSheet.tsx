import { useRef, useState, type ChangeEvent } from 'react';
import { ImagePlus } from 'lucide-react';
import {
  GClose as X,
} from '../../components/ui/glyphs';
import { Button } from '../../components/ui/Button';
import { AutoGrowTextarea, Field, Input } from '../../components/ui/Input';
import { SegmentedControl } from '../../components/ui/SegmentedControl';
import { Sheet } from '../../components/ui/Sheet';
import { db } from '../../db/db';
import { create, remove, update } from '../../db/repo';
import { t } from '../../lib/i18n';
import type { PlaceItem, PlaceKind, PlaceStatus } from '../../db/types';
import { ICON } from '../../components/ui/icons';

// Уменьшает фото до ~1280px и пережимает в JPEG — чтобы dataURL в IndexedDB
// весил сотни КБ, а не мегабайты с камеры телефона.
async function compressImage(file: File): Promise<string> {
  const dataUrl = await new Promise<string>((res, rej) => {
    const fr = new FileReader();
    fr.onload = () => res(fr.result as string);
    fr.onerror = () => rej(new Error('read'));
    fr.readAsDataURL(file);
  });
  const img = await new Promise<HTMLImageElement>((res, rej) => {
    const i = new Image();
    i.onload = () => res(i);
    i.onerror = () => rej(new Error('decode'));
    i.src = dataUrl;
  });
  const MAX = 1280;
  let { width, height } = img;
  if (Math.max(width, height) > MAX) {
    const s = MAX / Math.max(width, height);
    width = Math.round(width * s);
    height = Math.round(height * s);
  }
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) return dataUrl;
  ctx.drawImage(img, 0, 0, width, height);
  return canvas.toDataURL('image/jpeg', 0.8);
}

interface Props {
  open: boolean;
  onClose: () => void;
  item: PlaceItem | null;
}

export function PlaceSheet({ open, onClose, item }: Props) {
  return (
    <Sheet open={open} onClose={onClose} title={item ? t('Запись') : t('Новая запись')}>
      {/* Sheet при !open возвращает null → форма размонтируется и при
          следующем открытии инициализируется заново из item. */}
      <PlaceForm key={item?.id ?? 'new'} item={item} onClose={onClose} />
    </Sheet>
  );
}

function PlaceForm({ item, onClose }: { item: PlaceItem | null; onClose: () => void }) {
  const [title, setTitle] = useState(item?.title ?? '');
  const [kind, setKind] = useState<PlaceKind>(item?.kind ?? 'place');
  const [description, setDescription] = useState(item?.description ?? '');
  const [source, setSource] = useState(item?.source ?? '');
  const [location, setLocation] = useState(item?.location ?? '');
  const [link, setLink] = useState(item?.link ?? '');
  const [photo, setPhoto] = useState<string | null>(item?.photo ?? null);
  const [tagsStr, setTagsStr] = useState(item?.tags.join(', ') ?? '');
  const [status, setStatus] = useState<PlaceStatus>(item?.status ?? 'idea');

  const photoInputRef = useRef<HTMLInputElement>(null);
  const handlePhoto = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = ''; // позволяет выбрать тот же файл повторно
    if (!file) return;
    try {
      setPhoto(await compressImage(file));
    } catch {
      /* битый файл — игнорируем */
    }
  };

  const savingRef = useRef(false);
  const handleSave = async () => {
    const trimmed = title.trim();
    if (!trimmed) return;
    if (savingRef.current) return; // защита от дабл-тапа
    savingRef.current = true;
    try {
      const tags = tagsStr
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
      const base = {
        title: trimmed,
        kind,
        description: description.trim(),
        source: source.trim(),
        location: location.trim(),
        // Без протокола ссылка открывалась внутри приложения как «не найдено».
        link: normalizeLink(link),
        photo,
        tags,
        status,
      };
      if (item) {
        await update(db.placeItems, item.id, base);
      } else {
        await create(db.placeItems, { ...base, sortOrder: Date.now() });
      }
      onClose();
    } finally {
      savingRef.current = false;
    }
  };

  const handleDelete = async () => {
    if (!item) return;
    if (!window.confirm(t('Удалить запись?'))) return;
    await remove(db.placeItems, item.id);
    onClose();
  };

  return (
    <div className="space-y-4 pb-2">
      <Field label={t('Название')}>
        <AutoGrowTextarea
          value={title}
          onChange={(e: ChangeEvent<HTMLTextAreaElement>) => setTitle(e.target.value)}
          onClear={() => setTitle('')}
          placeholder={t('Например, «Кафе у моря»')}
        />
      </Field>
      <Field label={t('Вид')}>
        <SegmentedControl<PlaceKind>
          options={[
            { value: 'place', label: t('Места') },
            { value: 'thing', label: t('Вещи') },
            { value: 'tip', label: t('Советы') },
            { value: 'food', label: t('Еда') },
            { value: 'travel', label: t('Путешествия') },
          ]}
          value={kind}
          onChange={setKind}
        />
      </Field>
      <Field label={t('Описание')}>
        <AutoGrowTextarea
          value={description}
          onChange={(e: ChangeEvent<HTMLTextAreaElement>) => setDescription(e.target.value)}
          placeholder={t('Совет, опыт, рекомендация…')}
          className="min-h-[4.5rem]"
        />
      </Field>
      <Field label={t('От кого')}>
        <Input
          value={source}
          onChange={(e: ChangeEvent<HTMLInputElement>) => setSource(e.target.value)}
          placeholder={t('Кто посоветовал')}
        />
      </Field>
      <Field label={t('Где')}>
        <Input
          value={location}
          onChange={(e: ChangeEvent<HTMLInputElement>) => setLocation(e.target.value)}
          placeholder={t('Город или адрес')}
        />
      </Field>
      <Field label={t('Ссылка')}>
        <Input
          type="url"
          inputMode="url"
          value={link}
          onChange={(e: ChangeEvent<HTMLInputElement>) => setLink(e.target.value)}
          placeholder="https://"
        />
      </Field>
      <Field label={t('Фото')}>
        {photo ? (
          <div className="relative">
            <img src={photo} alt="" className="max-h-56 w-full rounded-xl object-cover" />
            <button
              type="button"
              aria-label={t('Удалить фото')}
              onClick={() => setPhoto(null)}
              className="absolute top-2 right-2 rounded-full bg-black/60 p-1.5 text-white active:opacity-80"
            >
              <X size={ICON.action} />
            </button>
          </div>
        ) : (
          <button
            type="button"
            onClick={() => photoInputRef.current?.click()}
            className="flex w-full items-center justify-center gap-2 rounded-xl border border-dashed border-border py-6 text-sm text-muted active:opacity-70"
          >
            <ImagePlus size={ICON.base} />
            {t('Добавить фото')}
          </button>
        )}
        <input
          ref={photoInputRef}
          type="file"
          accept="image/*"
          className="hidden"
          onChange={(e) => void handlePhoto(e)}
        />
      </Field>
      <Field label={t('Теги')}>
        <Input
          value={tagsStr}
          onChange={(e: ChangeEvent<HTMLInputElement>) => setTagsStr(e.target.value)}
          placeholder={t('Через запятую')}
        />
      </Field>
      <Field label={t('Статус')}>
        <SegmentedControl<PlaceStatus>
          options={[
            { value: 'idea', label: t('Идея') },
            { value: 'want', label: t('Хочу') },
            { value: 'done', label: t('Был') },
          ]}
          value={status}
          onChange={setStatus}
        />
      </Field>
      <div className="flex gap-2 pt-1">
        {item && (
          <Button variant="danger" onClick={() => void handleDelete()}>
            {t('Удалить')}
          </Button>
        )}
        <Button className="flex-1" disabled={!title.trim()} onClick={() => void handleSave()}>
          {t('Сохранить')}
        </Button>
      </div>
    </div>
  );
}

/** «vk.com/kafe» → «https://vk.com/kafe»; пустое — пустое. */
function normalizeLink(raw: string): string {
  const v = raw.trim();
  if (!v) return '';
  return /^[a-z][a-z0-9+.-]*:/i.test(v) ? v : `https://${v}`;
}
