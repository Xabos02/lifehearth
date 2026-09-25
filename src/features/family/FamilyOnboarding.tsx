import { useEffect, useRef, useState } from 'react';
import jsQR from 'jsqr';
import { ScanLine, ImageUp } from 'lucide-react';
import {
  GPlus as Plus,
} from '../../components/ui/glyphs';
import { Sheet } from '../../components/ui/Sheet';
import { Field, Input } from '../../components/ui/Input';
import { Button } from '../../components/ui/Button';
import { SegmentedControl } from '../../components/ui/SegmentedControl';
import { t } from '../../lib/i18n';
import { createFamily, joinFamily } from '../../lib/family/familyLifecycle';
import {
  InviteDamagedError,
  InviteExpiredError,
  InviteWordError,
  normalizeInviteWord,
  parsePastedInvite,
} from '../../lib/crypto';
import { ICON, STROKE_HEAVY } from '../../components/ui/icons';

const JOIN_TABS = [
  { value: 'scan' as const, label: 'Сканировать' },
  { value: 'paste' as const, label: 'Вставить код' },
];

/** Первый экран семьи (групп ещё нет): крупная иконка «＋» с подсказкой.
 *  По нажатию — выбор «Создать группу / Войти по приглашению».
 *  onReady получает familyId созданной/выбранной группы — чтобы её сразу открыть. */
export function FamilyOnboarding({ onReady }: { onReady?: (familyId: string) => void }) {
  const [mode, setMode] = useState<null | 'create' | 'join'>(null);

  // Кнопки действий — прямо на экране, а не за иконкой-плюсом: раньше первый
  // тап открывал шит с теми же двумя кнопками, то есть человек делал два шага
  // там, где хватает одного, а сама иконка не читалась как кнопка. Плюс
  // остаётся декорацией, действия — действиями.
  return (
    <div className="flex h-full flex-col items-center justify-center gap-5 py-10 text-center">
      <div
        aria-hidden
        className="flex size-20 items-center justify-center rounded-3xl bg-gradient-to-br from-accent-fill to-accent-2-fill text-white shadow-accent"
      >
        <Plus size={ICON.hero} strokeWidth={STROKE_HEAVY} />
      </div>
      <div className="space-y-1.5">
        <p className="text-lg font-semibold">{t('Семейная группа')}</p>
        <p className="px-6 text-sm text-muted">{t('Общий чат и задачи с близкими. Содержимое шифруется на устройстве.')}</p>
      </div>
      <div className="w-full max-w-sm space-y-3 px-6 pt-2">
        <Button className="w-full" onClick={() => setMode('create')}>
          {t('Создать группу')}
        </Button>
        <Button variant="secondary" className="w-full" onClick={() => setMode('join')}>
          {t('Войти по приглашению')}
        </Button>
      </div>
      <CreateFamilySheet
        open={mode === 'create'}
        onClose={() => setMode(null)}
        onReady={(id) => {
          setMode(null);
          onReady?.(id);
        }}
      />
      <JoinFamilySheet
        open={mode === 'join'}
        onClose={() => setMode(null)}
        onReady={(id) => {
          setMode(null);
          onReady?.(id);
        }}
      />
    </div>
  );
}

export function CreateFamilySheet({ open, onClose, onReady }: { open: boolean; onClose: () => void; onReady?: (familyId: string) => void }) {
  const [familyName, setFamilyName] = useState('');
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);

  async function create() {
    if (!familyName.trim() || !name.trim() || busy) return;
    setBusy(true);
    try {
      const id = await createFamily(familyName, name);
      onClose();
      onReady?.(id);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Sheet open={open} onClose={onClose} title={t('Создать группу')}>
      <div className="space-y-4">
        <Field label={t('Название группы')}>
          <Input value={familyName} onChange={(e) => setFamilyName(e.target.value)} placeholder={t('Например, «Наша семья»')} />
        </Field>
        <Field label={t('Ваше имя')}>
          <Input value={name} onChange={(e) => setName(e.target.value)} placeholder={t('Например, Влад')} />
        </Field>
        <Button className="w-full" disabled={!familyName.trim() || !name.trim() || busy} onClick={() => void create()}>
          {busy ? t('Создаю…') : t('Создать группу')}
        </Button>
      </div>
    </Sheet>
  );
}

export function JoinFamilySheet({ open, onClose, onReady }: { open: boolean; onClose: () => void; onReady?: (familyId: string) => void }) {
  const [name, setName] = useState('');
  const [tab, setTab] = useState<'scan' | 'paste'>('scan');
  const [pasteVal, setPasteVal] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const rafRef = useRef(0);
  const fileRef = useRef<HTMLInputElement>(null);

  // Код прочитан, ждём кодовое слово. null — этого шага сейчас нет.
  const [pendingCode, setPendingCode] = useState<string | null>(null);
  const [pendingName, setPendingName] = useState('');
  const [wordInput, setWordInput] = useState('');

  async function confirmWord() {
    if (!pendingCode || busy) return;
    setBusy(true);
    setError('');
    try {
      const id = await joinFamily(pendingCode, name, wordInput);
      onClose();
      onReady?.(id);
    } catch (err) {
      setError(
        err instanceof InviteExpiredError
          ? t('Срок действия приглашения истёк — попросите новое')
          : err instanceof InviteWordError
            ? t('Слово не подошло. Проверьте и попробуйте снова')
            : t('Не удалось войти. Проверьте код'),
      );
      setBusy(false);
    }
  }

  // Подключение через ref (стабильная ссылка для камеры-эффекта).
  const joinRef = useRef<(code: string) => void>(() => {});
  useEffect(() => {
    joinRef.current = (raw: string) => {
      if (busy) return;
      if (!name.trim()) {
        setError(t('Сначала введите своё имя'));
        return;
      }
      // Разбор терпит то, что приезжает из мессенджера вместе с кодом:
      // сопроводительный текст, невидимые символы, переносы. Битый код при
      // этом называется битым, а не «неверным» — человеку с верным кодом
      // на руках сообщение «проверьте код» не давало никакого хода.
      let parsed;
      try {
        parsed = parsePastedInvite(raw);
      } catch (err) {
        setError(
          err instanceof InviteDamagedError
            ? t('Код неполный или повреждён. Скопируйте сообщение с кодом целиком и вставьте ещё раз')
            : t('Это не похоже на код приглашения. Вставьте код из приложения целиком'),
        );
        return;
      }
      if (parsed.kind === 'v2') {
        // Старый код без слова (v:2) с ключом группы внутри — не принимается
        // с 25.09 (familyLifecycle.joinFamily): новый живёт сутки.
        setError(t('Срок действия приглашения истёк — попросите новое'));
        return;
      }
      // Код прочитан — теперь нужно кодовое слово. Раньше вход происходил
      // сразу, потому что ключ лежал прямо в коде; теперь код без слова
      // бесполезен, и это второй шаг, а не лишний вопрос.
      setPendingCode(parsed.code);
      setPendingName(parsed.peeked.familyName);
      setError('');
    };
  });

  useEffect(() => {
    if (!(open && tab === 'scan')) return;
    let cancelled = false;
    const stop = () => {
      cancelAnimationFrame(rafRef.current);
      streamRef.current?.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
    };
    (async () => {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } });
        if (cancelled) {
          stream.getTracks().forEach((t) => t.stop());
          return;
        }
        streamRef.current = stream;
        const v = videoRef.current;
        if (!v) return;
        v.srcObject = stream;
        await v.play();
        const canvas = document.createElement('canvas');
        const ctx = canvas.getContext('2d');
        if (!ctx) return;
        const tick = () => {
          if (cancelled) return;
          if (v.readyState >= v.HAVE_ENOUGH_DATA && v.videoWidth) {
            canvas.width = v.videoWidth;
            canvas.height = v.videoHeight;
            ctx.drawImage(v, 0, 0, canvas.width, canvas.height);
            const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
            const found = jsQR(img.data, img.width, img.height);
            if (found?.data) {
              cancelled = true;
              stop();
              joinRef.current(found.data);
              return;
            }
          }
          rafRef.current = requestAnimationFrame(tick);
        };
        rafRef.current = requestAnimationFrame(tick);
      } catch {
        setError(t('Нет доступа к камере. Вставьте код вручную.'));
        setTab('paste');
      }
    })();
    return () => {
      cancelled = true;
      stop();
    };
  }, [open, tab]);

  // Распознать QR из выбранной картинки (фото/скриншот из галереи телефона).
  async function decodeImageFile(file: File) {
    setError('');
    const url = URL.createObjectURL(file);
    try {
      const img = new Image();
      await new Promise<void>((res, rej) => {
        img.onload = () => res();
        img.onerror = () => rej(new Error('image'));
        img.src = url;
      });
      // Крупные фото уменьшаем — и быстрее, и jsQR стабильнее.
      const max = 1600;
      const scale = Math.min(1, max / Math.max(img.naturalWidth, img.naturalHeight));
      const w = Math.round(img.naturalWidth * scale);
      const h = Math.round(img.naturalHeight * scale);
      const canvas = document.createElement('canvas');
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext('2d');
      if (!ctx) {
        setError(t('Не удалось открыть фото. Попробуйте другой файл'));
        return;
      }
      ctx.drawImage(img, 0, 0, w, h);
      const data = ctx.getImageData(0, 0, w, h);
      const found = jsQR(data.data, data.width, data.height);
      if (found?.data) joinRef.current(found.data);
      else setError(t('На картинке не найден QR-код. Попробуйте другое фото или вставьте код вручную.'));
    } catch {
      setError(t('Не удалось открыть фото. Попробуйте другой файл'));
    } finally {
      URL.revokeObjectURL(url);
    }
  }

  return (
    <Sheet open={open} onClose={onClose} title={t('Войти по приглашению')}>
      <div className="space-y-4">
        <Field label={t('Ваше имя')}>
          <Input value={name} onChange={(e) => setName(e.target.value)} placeholder={t('Например, Брат')} />
        </Field>
        <SegmentedControl
          options={JOIN_TABS.map((o) => ({ ...o, label: t(o.label) }))}
          value={tab}
          onChange={setTab}
        />
        {pendingCode !== null ? (
          // Второй шаг входа: код прочитан, нужно слово. Показываем название
          // группы — человек должен видеть, куда его зовут, до ввода.
          <div className="space-y-3">
            <div className="card p-4 text-center">
              <p className="text-sm text-muted">{t('Приглашение в группу')}</p>
              <p className="mt-0.5 font-semibold">{pendingName || t('Семья')}</p>
            </div>
            <label className="block">
              <span className="mb-1.5 block text-sm font-medium text-muted">
                {t('Кодовое слово от приглашающего')}
              </span>
              <input
                value={wordInput}
                onChange={(e) => setWordInput(normalizeInviteWord(e.target.value).slice(0, 8))}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') void confirmWord();
                }}
                placeholder="ABCD EFGH"
                autoComplete="off"
                autoCapitalize="characters"
                className="w-full rounded-xl border border-border bg-surface p-3 text-center font-mono text-lg tracking-[0.15em] uppercase"
                aria-label={t('Кодовое слово')}
              />
            </label>
            <p className="text-xs leading-snug text-muted">
              {t('Его называет тот, кто вас приглашает. Без слова код не открыть — так перехваченное приглашение остаётся бесполезным.')}
            </p>
            {/* Столбиком: на 320px две кнопки в ряд обрезают «Назад к коду». */}
            <div className="flex flex-col gap-2 min-[380px]:flex-row">
              <Button
                className="min-[380px]:flex-1"
                disabled={wordInput.length < 4 || busy}
                onClick={() => void confirmWord()}
              >
                {busy ? t('Вхожу…') : t('Войти')}
              </Button>
              <Button
                variant="secondary"
                onClick={() => {
                  setPendingCode(null);
                  setWordInput('');
                  setError('');
                }}
              >
                {t('Назад к коду')}
              </Button>
            </div>
          </div>
        ) : tab === 'scan' ? (
          <div className="space-y-2">
            <div className="relative overflow-hidden rounded-2xl bg-black">
              <video ref={videoRef} className="aspect-square w-full object-cover" muted playsInline />
              {/* 120 — намеренно вне шкалы ICON: это не значок, а рамка
                  видоискателя поверх камеры, её размер задаёт кадр наведения. */}
              <ScanLine className="pointer-events-none absolute inset-0 m-auto text-white/40" size={120} />
            </div>
            <p className="text-center text-sm text-muted">{t('Наведите камеру на QR приглашения')}</p>
          </div>
        ) : (
          <div className="space-y-2">
            <textarea
              value={pasteVal}
              onChange={(e) => setPasteVal(e.target.value)}
              placeholder={t('Вставьте код приглашения')}
              rows={4}
              className="w-full rounded-xl border border-border bg-surface p-3 font-mono text-xs"
            />
            <Button className="w-full" disabled={!pasteVal.trim() || busy} onClick={() => joinRef.current(pasteVal)}>
              {busy ? t('Вхожу…') : t('Войти')}
            </Button>
          </div>
        )}
        {/* Распознать QR из картинки в галерее телефона — доступно всегда */}
        <input
          ref={fileRef}
          type="file"
          accept="image/*"
          className="hidden"
          onChange={(e) => {
            const f = e.target.files?.[0];
            e.target.value = ''; // чтобы повторный выбор того же файла сработал
            if (f) void decodeImageFile(f);
          }}
        />
        <Button
          variant="secondary"
          className="inline-flex w-full items-center justify-center gap-2"
          onClick={() => fileRef.current?.click()}
        >
          <ImageUp size={ICON.base} />
          {t('Выбрать фото с QR-кодом')}
        </Button>

        {error && <p className="text-sm text-danger">{error}</p>}
      </div>
    </Sheet>
  );
}
