import { useEffect, useRef, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { Camera, User } from 'lucide-react';
import { GLock, GTrash as Trash2 } from '../../components/ui/glyphs';
import { Screen } from '../../components/layout/Screen';
import { SegmentedControl } from '../../components/ui/SegmentedControl';
import { useToast } from '../../components/ui/toastContext';
import { db } from '../../db/db';
import type { UserProfile } from '../../db/types';
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
import { ICON, STROKE_STRONG } from '../../components/ui/icons';
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

/** Правка профиля поверх СВЕЖЕГО из базы, а не `p` кадра. Сохранение при
 *  уходе с экрана зовётся из первого кадра, где база ещё не ответила и `p`
 *  пуст: аватар стирался, а прежний вес считался новым. Фото так же
 *  ложилось на профиль, снятый до сжатия, — сохранение, успевшее за время
 *  сжатия, откатилось бы. Возвращает профиль до правки. */
async function patchProfile(patch: UserProfile): Promise<UserProfile | undefined> {
  const before = (await db.settings.get('app'))?.profile;
  await updateSettings({ profile: { ...before, ...patch } });
  return before;
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

  // Поля, которые человек менял в этом черновике, — в профиль пишутся только
  // они. Вес теперь приходит и синком (sync.ts): черновик, начатый до него,
  // иначе вернул бы в профиль и в дневник прежнее число, которого никто не
  // вводил, — и оно ушло бы обратно на все устройства.
  const touched = useRef(new Set<keyof typeof form>());

  const set = (patch: Partial<typeof form>) => {
    for (const k of Object.keys(patch)) touched.current.add(k as keyof typeof form);
    const next = { ...form, ...patch };
    setDraft(next);
    clearTimeout(saveTimer.current);
    // Незаконченное число («79,») не записываем: автосохранение переписывало
    // поле в «79», следующая цифра давала «796».
    if (/[.,]$/.test(next.weightKg) || /[.,]$/.test(next.heightCm)) return;
    saveTimer.current = setTimeout(() => void commit(next), 600);
  };

  async function commit(f: typeof form) {
    saveTimer.current = undefined;
    const dirty = touched.current;
    touched.current = new Set();
    const weightKg = parseNumber(f.weightKg);
    const patch: UserProfile = {};
    if (dirty.has('name')) patch.name = f.name.trim() || undefined;
    if (dirty.has('birthDate')) patch.birthDate = f.birthDate || null;
    if (dirty.has('heightCm')) patch.heightCm = parseNumber(f.heightCm);
    if (dirty.has('weightKg')) patch.weightKg = weightKg;
    const before = await patchProfile(patch);
    // Вес из профиля — в дневник замеров («Здоровье»), чтобы источник был
    // один: раньше «Главная» показывала профильное число, а раздел — своё.
    if (dirty.has('weightKg') && weightKg != null && weightKg !== before?.weightKg && weightKg >= 20 && weightKg <= 300) {
      await logMeasure('weight', todayKey(), weightKg);
    }
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
      await patchProfile({ avatar: dataUrl });
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

  const initials = form.name
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]!.toUpperCase())
    .join('');
  const birthAge = ageFrom(form.birthDate);
  const formBmi = bmiFrom(parseNumber(form.heightCm), parseNumber(form.weightKg)) ?? (draft ? null : bmi);
  const decimal = (v: number) => v.toFixed(1).replace('.', getLang() === 'en' ? '.' : ',');

  return (
    <Screen title={t('Профиль')} backTo="/home">
      <div className="space-y-6">
        {/* ШАПКА по макету: крупный аватар по центру, под ним имя и сводка.
            Значок камеры — часть кнопки аватара, а не вторая кнопка с тем же
            названием: две цели «Добавить фото» рядом путают скринридер. */}
        <section className="flex flex-col items-center pt-1">
          <button
            type="button"
            disabled={busy}
            onClick={() => fileRef.current?.click()}
            aria-label={p?.avatar ? t('Заменить фото') : t('Добавить фото')}
            className="relative rounded-full active:opacity-80"
          >
            {p?.avatar ? (
              <img src={p.avatar} alt="" className="size-24 rounded-full object-cover" width={96} height={96} />
            ) : (
              <span className="flex size-24 items-center justify-center rounded-full border border-lh-border bg-lh-surface-2 text-[32px] font-light text-lh-accent">
                {initials || <User size={ICON.display} />}
              </span>
            )}
            <span className="absolute -right-0.5 -bottom-0.5 flex size-11 items-center justify-center rounded-full border-[3px] border-lh-bg bg-lh-surface text-lh-accent">
              <Camera size={ICON.inline} strokeWidth={STROKE_STRONG} />
            </span>
          </button>
          <p className="mt-3 max-w-full truncate text-xl font-semibold">{form.name.trim() || t('Без имени')}</p>
          {summary && <p className="max-w-full truncate text-sm text-lh-text-secondary">{summary}</p>}
          {p?.avatar && (
            <button
              type="button"
              disabled={busy}
              onClick={() => void patchProfile({ avatar: null })}
              className="flex h-11 items-center gap-1.5 px-3 text-base text-lh-text-secondary active:opacity-60"
            >
              <Trash2 size={ICON.action} />
              {t('Удалить фото')}
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
        </section>

        <section>
          <h2 className="lh-section mb-2.5 px-1">{t('О вас')}</h2>
          <div className="card divide-y divide-lh-border">
            <label className="flex h-14 items-center gap-3 px-4">
              <span className="shrink-0 whitespace-nowrap text-base text-lh-text-secondary">{t('Имя')}</span>
              <input
                value={form.name}
                onChange={(e) => set({ name: e.target.value })}
                placeholder={t('Как вас зовут')}
                autoComplete="name"
                className="min-w-0 flex-1 bg-transparent text-right text-base outline-none placeholder:text-lh-text-secondary"
              />
            </label>
            {/* Нативное поле показывает дату в формате СИСТЕМЫ, а не языка
                приложения: «29 июня 1998» выглядело как 06/29/1998. Поле
                остаётся (системный календарь удобнее самодельного), но лежит
                прозрачным поверх подписи словами — нажатие открывает календарь,
                а видно дату по-человечески и сразу возраст. */}
            <label className="relative flex min-h-14 items-center gap-3 px-4 py-2 focus-within:ring-2 focus-within:ring-inset focus-within:ring-lh-accent">
              <span className="shrink-0 whitespace-nowrap text-base text-lh-text-secondary">{t('Дата рождения')}</span>
              <span className="min-w-0 flex-1 text-right text-base tabular-nums">
                {form.birthDate && birthAge != null ? (
                  <>
                    <span className="whitespace-nowrap">{formatRu(form.birthDate, 'd MMMM yyyy')}</span>
                    <span className="whitespace-nowrap text-lh-text-secondary"> · {yearsLabel(birthAge)}</span>
                  </>
                ) : (
                  <span className="text-lh-text-secondary">{t('Не указана')}</span>
                )}
              </span>
              <input
                type="date"
                value={form.birthDate}
                onChange={(e) => set({ birthDate: e.target.value })}
                onClick={(e) => {
                  try {
                    e.currentTarget.showPicker?.();
                  } catch {
                    /* браузер без showPicker — откроется своим способом */
                  }
                }}
                className="absolute inset-0 h-full w-full cursor-pointer opacity-0"
              />
            </label>
          </div>
        </section>

        <section>
          <h2 className="lh-section mb-2.5 px-1">{t('Тело')}</h2>
          <div className="grid grid-cols-2 gap-3">
            <label className="card block px-4 py-3.5">
              <span className="text-sm text-lh-text-secondary">{t('Рост, см')}</span>
              <input
                inputMode="numeric"
                value={form.heightCm}
                onChange={(e) => set({ heightCm: e.target.value.replace(/[^\d]/g, '') })}
                placeholder={t('—')}
                className="mt-1 block w-full bg-transparent text-[26px] font-light tabular-nums outline-none placeholder:text-lh-text-secondary"
              />
            </label>
            <label className="card block px-4 py-3.5">
              <span className="text-sm text-lh-text-secondary">{t('Вес, кг')}</span>
              <input
                inputMode="decimal"
                value={form.weightKg}
                onChange={(e) => set({ weightKg: e.target.value.replace(/[^\d.,]/g, '') })}
                placeholder={t('—')}
                className="mt-1 block w-full bg-transparent text-[26px] font-light tabular-nums outline-none placeholder:text-lh-text-secondary"
              />
            </label>
          </div>
          {/* Рост и вес человек уже ввёл — показать, что из них следует, дешевле,
              чем заставлять считать самому. Никаких советов: число, категория
              ВОЗ одним словом и шкала с границами 18,5 / 25 / 30. */}
          {formBmi && (
            <div className="card mt-3 px-4 py-4">
              <div className="flex items-baseline gap-2">
                <span className="flex-1 text-base">{t('Индекс массы тела')}</span>
                <span className={`text-sm ${formBmi.tone === 'success' ? 'text-success' : 'text-warning'}`}>
                  {t(formBmi.label)}
                </span>
                <span className="text-[26px] font-light tabular-nums">{decimal(formBmi.value)}</span>
              </div>
              <BmiScale value={formBmi.value} />
              <p className="mt-2 text-xs text-lh-text-secondary">{t('Считается сам по росту и весу')}</p>
            </div>
          )}
        </section>

        {/* Пол сохраняется сразу: от него зависит состав приложения (раздел
            «Женские дни» существует только в женском профиле). */}
        <section>
          <h2 className="lh-section mb-2.5 px-1">{t('Пол')}</h2>
          <SegmentedControl<'female' | 'male'>
            options={[
              { value: 'female', label: t('Женский') },
              { value: 'male', label: t('Мужской') },
            ]}
            value={settings?.gender ?? 'female'}
            onChange={(v) => void updateSettings({ gender: v })}
          />
          <p className="mt-2.5 px-1 text-sm leading-snug text-lh-text-secondary">
            {t(
              'Определяет набор разделов: «Женские дни» есть только в женском профиле. При смене пола записи раздела не удаляются — он просто скрывается, а задачи, которые он поставил сам, уходят в «Корзину», если вы их не меняли.',
            )}
          </p>
        </section>

        {/* Отметку рендерим ТОЛЬКО когда есть что сказать, а не прячем
            прозрачностью: элемент с opacity:0 остаётся в дереве — скринридер в
            aria-live читает его, а браузерные тесты считают видимым. */}
        <div className="min-h-5 px-1" aria-live="polite">
          {saved && <p className="animate-fade-in text-sm text-success">{t('Сохранено')}</p>}
        </div>

        {/* Куда попадут рост и вес — человек вправе знать до того, как напишет.
            Вес ещё и замер «Здоровья» (logMeasure), а замеры синхронизируются. */}
        <div className="flex gap-3 px-1">
          <GLock size={ICON.inline} className="mt-0.5 shrink-0 text-lh-text-secondary" />
          <p className="text-sm leading-snug text-lh-text-secondary">
            {t(
              'Эти данные хранятся на устройстве и в вашей резервной копии. Вес ещё записывается замером в «Здоровье» — с синхронизацией он зашифрованным идёт через наш сервер на ваши устройства; сервер видит дни замеров.',
            )}
          </p>
        </div>
      </div>
    </Screen>
  );
}

/** Шкала ИМТ: четыре зоны ВОЗ, норма подсвечена, метка — текущее значение.
 *  Края шкалы условные (15 и 35): за ними метка просто прижимается к краю. */
const BMI_STOPS = [15, 18.5, 25, 30, 35];
const BMI_WIDTHS = [18, 34, 24, 24];

function bmiPos(v: number): number {
  let acc = 0;
  for (let i = 0; i < BMI_WIDTHS.length; i++) {
    const lo = BMI_STOPS[i]!;
    const hi = BMI_STOPS[i + 1]!;
    if (v < hi || i === BMI_WIDTHS.length - 1) {
      const frac = Math.min(1, Math.max(0, (v - lo) / (hi - lo)));
      return acc + frac * BMI_WIDTHS[i]!;
    }
    acc += BMI_WIDTHS[i]!;
  }
  return 100;
}

function BmiScale({ value }: { value: number }) {
  const sep = getLang() === 'en' ? '.' : ',';
  return (
    <div aria-hidden="true">
      <div className="relative mt-3 flex h-1.5 gap-[3px]">
        {BMI_WIDTHS.map((w, i) => (
          <i
            key={i}
            className={`rounded-full ${i === 1 ? 'bg-success/55' : 'bg-lh-surface-2'}`}
            style={{ width: `${w}%` }}
          />
        ))}
        <i
          className="absolute -top-[5px] h-4 w-[3px] -translate-x-1/2 rounded-full bg-lh-text-primary"
          style={{ left: `${bmiPos(value)}%` }}
        />
      </div>
      <div className="relative mt-2 h-4 text-[11px] tabular-nums text-lh-text-secondary">
        <span className="absolute -translate-x-1/2" style={{ left: '18%' }}>{`18${sep}5`}</span>
        <span className="absolute -translate-x-1/2" style={{ left: '52%' }}>25</span>
        <span className="absolute -translate-x-1/2" style={{ left: '76%' }}>30</span>
      </div>
    </div>
  );
}
