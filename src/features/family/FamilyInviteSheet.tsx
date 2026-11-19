import { useEffect, useState } from 'react';
import QRCode from 'qrcode';
import { Download, Share } from 'lucide-react';
import {
  GCheck as Check,
  GCopy as Copy,
  GAlert as TriangleAlert,
} from '../../components/ui/glyphs';
import { Sheet } from '../../components/ui/Sheet';
import { Button } from '../../components/ui/Button';
import { createFamilyInvite } from '../../lib/family/familyLifecycle';
import { formatInviteWord } from '../../lib/crypto';
import { formatRu } from '../../lib/dates';
import { t } from '../../lib/i18n';
import { ICON } from '../../components/ui/icons';
import { Haptic } from '../../components/ui/Haptic';

interface Props {
  familyId: string;
  /** Приглашение в личный чат: заголовок говорит, куда зовём, а не «в группу». */
  pair?: boolean;
  open: boolean;
  onClose: () => void;
}

type Invite = { code: string; word: string; expiresAt: string };

/** Последнее приглашение группы — только в памяти, пока приложение открыто и
 *  до срока минус час. Повторный показ отдаёт тот же код и то же слово: код
 *  часто уже ушёл собеседнику в мессенджер, а слово ему называют потом, и
 *  новое слово к старому коду дало бы «Слово не подошло». На диск не пишется:
 *  слово по-прежнему нигде не хранится (familyLifecycle.createFamilyInvite). */
const recent = new Map<string, Invite>();
const FRESH_MS = 3_600_000;

/** Показ QR-кода приглашения в группу (для второго устройства/человека). */
export function FamilyInviteSheet({ familyId, pair = false, open, onClose }: Props) {
  const [code, setCode] = useState('');
  const [word, setWord] = useState('');
  const [expiresAt, setExpiresAt] = useState('');
  const [qrUrl, setQrUrl] = useState('');
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!open) return;
    let live = true;
    void (async () => {
      const cached = recent.get(familyId);
      const inv = cached && Date.parse(cached.expiresAt) - Date.now() > FRESH_MS ? cached : await createFamilyInvite(familyId);
      if (!inv || !live) return;
      recent.set(familyId, inv);
      setCode(inv.code);
      setWord(inv.word);
      setExpiresAt(inv.expiresAt);
      const url = await QRCode.toDataURL(inv.code, { margin: 1, width: 260 });
      if (live) setQrUrl(url);
    })();
    return () => {
      live = false;
    };
  }, [open, familyId]);

  // Код уходит в мессенджер вместе с подсказкой, что с ним делать: голая
  // строка из сотен символов ничего не говорит тому, у кого приложения ещё
  // нет. Разбор вставленного (parsePastedInvite) сопроводительный текст терпит.
  const message = () =>
    `${t('Приглашение в LifeHearth. Откройте {url} → «Семья» → «Войти по приглашению» → «Вставить код» и вставьте это сообщение целиком. Кодовое слово скажу голосом.', {
      url: new URL(import.meta.env.BASE_URL, location.origin).href,
    })}\n\n${code}`;

  function copyCode() {
    void navigator.clipboard?.writeText(message()).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  }

  // Системное «Поделиться»: код с подсказкой — прямо в мессенджер собеседнику,
  // без «скопировать → открыть Telegram → вставить». Где его нет (часть
  // десктопных браузеров), остаётся «Сохранить» файлом.
  const canShare = typeof navigator.share === 'function';
  async function share() {
    try {
      await navigator.share({ text: message() });
    } catch (err) {
      // Закрыл шторку «Поделиться» — это ответ, а не сбой.
      if (err instanceof DOMException && err.name === 'AbortError') return;
      copyCode();
    }
  }

  function saveFile() {
    const file = new File([message()], 'life-hub-family-invite.txt', { type: 'text/plain' });
    const url = URL.createObjectURL(file);
    const a = document.createElement('a');
    a.href = url;
    a.download = file.name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }

  return (
    <Sheet open={open} onClose={onClose} title={pair ? t('Пригласить в личный чат') : t('Пригласить в группу')}>
      <div className="space-y-4">
        <p className="text-sm leading-snug text-lh-text-secondary">
          {t('Покажите QR участнику: у него — «Семья → Войти по приглашению», а если чаты уже есть — «Семья → Новый личный чат → Войти по приглашению». После сканирования он спросит кодовое слово — назовите его голосом, не пересылайте вместе с кодом.')}
        </p>
        {qrUrl && (
          <div className="flex justify-center">
            <img src={qrUrl} alt={t('QR-код приглашения')} className="rounded-2xl bg-white p-3" width={260} height={260} />
          </div>
        )}
        {/* «Поделиться» на месте «Сохранить» (канва design/family-share, А):
            шторка не растёт, и кодовое слово остаётся на экране целиком. */}
        <div className="flex gap-2">
          {/* Пока код считается (PBKDF2), отдавать нечего: сообщение без кода
              ушло бы собеседнику пустышкой. */}
          <Button variant="secondary" className="flex-1" disabled={!code} onClick={copyCode}>
            {copied ? <Check size={ICON.base} /> : <Copy size={ICON.base} />}
            {copied ? t('Скопировано') : t('Скопировать код')}
            <Haptic />
          </Button>
          {canShare ? (
            <Button variant="secondary" className="flex-1" disabled={!code} onClick={() => void share()}>
              <Share size={ICON.base} />
              {t('Поделиться')}
            </Button>
          ) : (
            <Button variant="secondary" className="flex-1" disabled={!code} onClick={saveFile}>
              <Download size={ICON.base} />
              {t('Сохранить')}
            </Button>
          )}
        </div>
        {/* Кодовое слово — второй фактор. Оно и есть то, что делает
            перехваченный код бесполезным, поэтому стоит крупно и отдельно. */}
        <div className="rounded-2xl border border-lh-accent/25 bg-lh-accent/[0.07] p-4 text-center">
          <p className="text-sm text-lh-text-secondary">{t('Кодовое слово')}</p>
          <p className="mt-1 font-mono text-2xl font-light tracking-[0.15em] tabular-nums">
            {word ? formatInviteWord(word) : '········'}
          </p>
          <p className="mt-1.5 text-xs leading-snug text-lh-text-secondary">
            {t('Назовите его вслух. Без слова код не откроется.')}
          </p>
        </div>

        <div className="flex gap-2 rounded-xl bg-warning/10 p-3 text-sm text-warning">
          <TriangleAlert size={ICON.base} className="mt-0.5 shrink-0" />
          <span className="min-w-0 leading-snug">
            {t('Кто войдёт по этому приглашению, увидит и прошлую переписку. Убрать его из группы может только её создатель.')}{' '}
            {expiresAt && t('Приглашение действует до {date}.', { date: formatRu(expiresAt.slice(0, 10), 'd MMMM') })}
          </span>
        </div>
      </div>
    </Sheet>
  );
}
