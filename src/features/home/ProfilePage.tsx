import { useEffect, useRef, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { Camera, User } from 'lucide-react';
import {
  GTrash as Trash2,
} from '../../components/ui/glyphs';
import { Screen } from '../../components/layout/Screen';
import { Field, Input } from '../../components/ui/Input';
import { SegmentedControl } from '../../components/ui/SegmentedControl';
import { useToast } from '../../components/ui/toastContext';
import { db } from '../../db/db';
import { logMeasure } from '../health/measures';
import { updateSettings } from '../../hooks/useSettings';
import { getLang, t } from '../../lib/i18n';
import { formatRu, todayKey } from '../../lib/dates';
import {
  compressImage,
  ImageDecodeError,
  ImageTooLargeError,
  MAX_INPUT_BYTES,
} from '../../lib/image';
import { ICON } from '../../components/ui/icons';
import { HIT_SLOP_44 } from '../../components/ui/hitSlop';
import { ageFrom, bmiFrom, yearsLabel } from '../../lib/profile';

/** Числовое поле профиля: пустая строка означает «не указано», а не ноль.
 *  Ноль здесь — не значение: рост 0 см не бывает, а сохранённый ноль потом
 *  неотличим от «человек стёр». */
function parseNumber(raw: string): number | null {
  const s = raw.replace(',', '.').trim();
  if (s === '') return null;
  const v = Number(s);
  return Number.isFinite(v) && v > 0 ? v : null;
}

export function ProfilePage() {
  const settings = useLiveQuery(() => db.settings.get('app'), []);
  const toast = useToast();
  const fileRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);

  // Форма редактируется локально и сохраняется по кнопке: посимвольная запись
  // в базу дёргала бы useLiveQuery на каждое нажатие и подменяла бы значение
  // под курсором.
  const [draft, setDraft] = useState<{
    name: string;
    birthDate: string;
    heightCm: string;
    weightKg: string;
  } | null>(null);

  const p = settings?.profile;
  const age = ageFrom(p?.birthDate);
  const bmi = bmiFrom(p?.heightCm, p?.weightKg);
  // Сводка под именем — то же, что видно в карточке на «Главной», только с
  // возрастом вместо даты: сколько человеку лет, понятнее, чем когда он родился.
  const summary = [
    age != null ? yearsLabel(age) : null,
    p?.heightCm ? t('{n} см', { n: p.heightCm }) : null,
    p?.weightKg ? t('{n} кг', { n: p.weightKg }) : null,
  ]
    .filter(Boolean)
    .join(' · ');
  const form = draft ?? {
    name: p?.name ?? '',
    birthDate: p?.birthDate ?? '',
    heightCm: p?.heightCm != null ? String(p.heightCm) : '',
    weightKg: p?.weightKg != null ? String(p.weightKg) : '',
  };
  // САМО СОХРАНЯЕТСЯ, БЕЗ КНОПКИ. Пол на этом же экране сохранялся сразу, а
  // имя с ростом — по кнопке: две разные механики на одном экране, и человек
  // не может знать, какая где. Везде в приложении изменения записываются сами,
  // профиль был единственным исключением.
  //
  // Пауза 600 мс, а не запись на каждое нажатие: иначе useLiveQuery дёргается
  // посимвольно и подменяет значение под курсором (ровно поэтому здесь и
  // появился черновик).
  const saveTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  // Отдельный таймер у отметки «Сохранено»: без него таймеры от соседних
  // сохранений накладываются, и отметка гаснет раньше времени — при быстром
  // наборе она мигала вместо того, чтобы держаться.
  const markTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const [saved, setSaved] = useState(false);
  // Актуальные значения для сброса при уходе с экрана: эффект размонтирования
  // видит только то, что было при его создании.
  const formRef = useRef(form);
  formRef.current = form;

  const set = (patch: Partial<typeof form>) => {
    const next = { ...form, ...patch };
    setDraft(next);
    clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => void commit(next), 600);
  };

  async function commit(f: typeof form) {
    saveTimer.current = undefined;
    const weightKg = parseNumber(f.weightKg);
    await updateSettings({
      profile: {
        ...p,
        name: f.name.trim() || undefined,
        birthDate: f.birthDate || null,
        heightCm: parseNumber(f.heightCm),
        weightKg,
      },
    });
    // Вес из профиля — в дневник замеров («Здоровье»), чтобы источник был
    // один: раньше «Главная» показывала профильное число, а раздел — своё.
    if (weightKg != null && weightKg !== p?.weightKg) await logMeasure('weight', todayKey(), weightKg);
    setDraft(null);
    setSaved(true);
    clearTimeout(markTimer.current);
    markTimer.current = setTimeout(() => setSaved(false), 1600);
  }

  // Уход с экрана раньше паузы не должен терять последние нажатия.
  useEffect(() => {
    return () => {
      clearTimeout(markTimer.current);
      if (saveTimer.current === undefined) return;
      clearTimeout(saveTimer.current);
      void commit(formRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function pickAvatar(file: File) {
    setBusy(true);
    try {
      // Аватар мельче фото в чате: он рисуется кружком 56px, и хранить под
      // него мегабайт незачем. 256px хватает и для будущих крупных мест.
      const dataUrl = await compressImage(file, 256, 0.75);
      await updateSettings({ profile: { ...p, avatar: dataUrl } });
    } catch (err) {
      if (err instanceof ImageTooLargeError) {
        toast(t('Файл больше {mb} МБ', { mb: Math.round(MAX_INPUT_BYTES / 1024 / 1024) }));
      } else if (err instanceof ImageDecodeError) {
        toast(t('Не удалось открыть фото. Попробуйте другой файл'));
      } else {
        toast(t('Не удалось сохранить фото. Попробуйте ещё раз'));
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <Screen title={t('Профиль')} backTo="/home">
      <div className="space-y-5">
        {/* ШАПКА. Раньше аватар с кнопкой занимали 300px до первого поля —
          столбик по центру, где половина ширины пустует. Теперь строка: фото,
          имя и сводка о себе рядом, а «сменить фото» — значком на самом
          аватаре, как в мессенджерах: кнопка, повторяющая то, на что и так
          нажимают, отдельной строки не стоит. */}
      <div className="card flex items-center gap-3.5 p-3.5">
        <button
          type="button"
          disabled={busy}
          onClick={() => fileRef.current?.click()}
          aria-label={p?.avatar ? t('Заменить фото') : t('Добавить фото')}
          className="relative shrink-0 rounded-full active:opacity-80"
        >
          {p?.avatar ? (
            <img src={p.avatar} alt="" className="size-[72px] rounded-full object-cover" width={72} height={72} />
          ) : (
            <span className="flex size-[72px] items-center justify-center rounded-full bg-surface-2 text-muted">
              <User size={ICON.display} />
            </span>
          )}
          <span className="absolute -right-0.5 -bottom-0.5 flex size-7 items-center justify-center rounded-full bg-accent-fill text-white ring-[3px] ring-surface">
            <Camera size={ICON.inline} />
          </span>
        </button>
        <div className="min-w-0 flex-1">
          <p className="truncate text-lg font-semibold">{form.name.trim() || t('Без имени')}</p>
          {summary && <p className="truncate text-sm text-muted">{summary}</p>}
        </div>
        {p?.avatar && (
          <button
            type="button"
            disabled={busy}
            aria-label={t('Удалить фото')}
            onClick={() => void updateSettings({ profile: { ...p, avatar: null } })}
            className={`shrink-0 p-1 text-muted active:opacity-60 ${HIT_SLOP_44}`}
          >
            <Trash2 size={ICON.action} />
          </button>
        )}
        <input
          ref={fileRef}
          type="file"
          accept="image/*"
          className="hidden"
          onChange={(e) => {
            const f = e.target.files?.[0];
            e.target.value = '';
            if (f) void pickAvatar(f);
          }}
        />
      </div>

        <div className="card space-y-4 p-4">
          <Field label={t('Имя')}>
            <Input
              value={form.name}
              onChange={(e) => set({ name: e.target.value })}
              placeholder={t('Как вас зовут')}
              autoComplete="name"
            />
          </Field>
          <Field label={t('Дата рождения')}>
            <Input
              type="date"
              value={form.birthDate}
              onChange={(e) => set({ birthDate: e.target.value })}
            />
            {/* Нативное поле показывает дату в формате СИСТЕМЫ, а не языка
                приложения: «29 июня 1998» выглядело как 06/29/1998 — владелец
                приложения посмотрел и спросил, что это за дата. Само поле
                оставляем (системный календарь удобнее самодельного), но
                подписываем по-человечески и добавляем главное — сколько лет. */}
            {form.birthDate && ageFrom(form.birthDate) != null && (
              <p className="mt-1.5 px-1 text-sm text-muted">
                {formatRu(form.birthDate, 'd MMMM yyyy')} · {yearsLabel(ageFrom(form.birthDate)!)}
              </p>
            )}
          </Field>
          {/* Рост и вес рядом: числа короткие, а вместе они читаются как одна
              строка о себе. Ниже 380px переносим — два поля по 118px оставляют
              подписям меньше, чем нужно словам «Дата рождения». */}
          <div className="flex flex-col gap-4 min-[380px]:flex-row">
            <div className="min-w-0 flex-1">
              <Field label={t('Рост, см')}>
                <Input
                  inputMode="numeric"
                  value={form.heightCm}
                  onChange={(e) => set({ heightCm: e.target.value.replace(/[^\d]/g, '') })}
                  placeholder={t('—')}
                />
              </Field>
            </div>
            <div className="min-w-0 flex-1">
              <Field label={t('Вес, кг')}>
                <Input
                  inputMode="decimal"
                  value={form.weightKg}
                  onChange={(e) => set({ weightKg: e.target.value.replace(/[^\d.,]/g, '') })}
                  placeholder={t('—')}
                />
              </Field>
            </div>
          </div>
          {/* Рост и вес человек уже ввёл — показать, что из них следует, дешевле,
              чем заставлять считать самому. Никаких советов: число, категория
              ВОЗ одним словом, и всё. */}
          {bmi && (
            <div className="flex items-center gap-2 border-t border-hairline pt-3">
              <span className="flex-1 text-sm text-muted">{t('Индекс массы тела')}</span>
              <span className="font-semibold tabular-nums">
                {bmi.value.toFixed(1).replace('.', getLang() === 'en' ? '.' : ',')}
              </span>
              <span className={`text-sm ${bmi.tone === 'success' ? 'text-success' : 'text-warning'}`}>
                {t(bmi.label)}
              </span>
            </div>
          )}
        </div>

        {/* Пол сохраняется сразу, мимо формы с кнопкой: от него зависит состав
            приложения (раздел «Женские дни» существует только в женском
            профиле), и отложенное «Сохранить» здесь только запутывало бы. */}
        <div className="card space-y-2 p-4">
          <Field label={t('Пол')}>
            <SegmentedControl<'female' | 'male'>
              options={[
                { value: 'female', label: t('Женский') },
                { value: 'male', label: t('Мужской') },
              ]}
              value={settings?.gender ?? 'female'}
              onChange={(v) => void updateSettings({ gender: v })}
            />
          </Field>
          <p className="text-xs leading-snug text-muted">
            {t(
              'Определяет набор разделов: «Женские дни» есть только в женском профиле. При смене пола записи раздела не удаляются — он просто скрывается.',
            )}
          </p>
        </div>

        {/* Кнопки «Сохранить» больше нет: изменения записываются сами через
            паузу после последнего нажатия. Отметка держится полторы секунды —
            без неё автосохранение выглядит как «ничего не произошло».

            Рендерим её ТОЛЬКО когда есть что сказать, а не прячем прозрачностью:
            элемент с opacity:0 остаётся в дереве — скринридер в aria-live читает
            его, а браузерные тесты считают видимым (на этом и попался первый
            вариант теста: он проходил ещё до записи). */}
        <div className="min-h-5 px-1" aria-live="polite">
          {saved && <p className="animate-fade-in text-sm text-success">{t('Сохранено')}</p>}
        </div>

        {/* Профиль хранится там же, где остальные настройки приложения, — на
            устройстве. Человек, заполняющий рост и вес, вправе знать, куда они
            попадут, до того как их напишет. */}
        <p className="px-1 text-xs leading-snug text-muted">
          {t(
            'Эти данные остаются на устройстве и попадают только в вашу резервную копию. Никуда больше они не отправляются.',
          )}
        </p>
      </div>
    </Screen>
  );
}
