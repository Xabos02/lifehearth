import { useEffect, useState } from 'react';
import QRCode from 'qrcode';
import {
  Download,
} from 'lucide-react';
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

interface Props {
  familyId: string;
  open: boolean;
  onClose: () => void;
}

/** Показ QR-кода приглашения в группу (для второго устройства/человека). */
export function FamilyInviteSheet({ familyId, open, onClose }: Props) {
  const [code, setCode] = useState('');
  const [word, setWord] = useState('');
  const [expiresAt, setExpiresAt] = useState('');
  const [qrUrl, setQrUrl] = useState('');
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!open) return;
    void createFamilyInvite(familyId).then(async (inv) => {
      if (!inv) return;
      setCode(inv.code);
      setWord(inv.word);
      setExpiresAt(inv.expiresAt);
      setQrUrl(await QRCode.toDataURL(inv.code, { margin: 1, width: 260 }));
    });
  }, [open, familyId]);

  function copyCode() {
    void navigator.clipboard?.writeText(code).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  }

  function saveFile() {
    const file = new File([code], 'life-hub-family-invite.txt', { type: 'text/plain' });
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
    <Sheet open={open} onClose={onClose} title={t('Пригласить в группу')}>
      <div className="space-y-4">
        <p className="text-sm leading-snug text-muted">
          {t('Покажите QR участнику: у него — «Главная → Семья → Войти по приглашению». После сканирования он спросит кодовое слово — назовите его голосом, не пересылайте вместе с кодом.')}
        </p>
        {qrUrl && (
          <div className="flex justify-center">
            <img src={qrUrl} alt={t('QR-код приглашения')} className="rounded-2xl bg-white p-3" width={260} height={260} />
          </div>
        )}
        <div className="flex gap-2">
          <Button variant="secondary" className="flex-1 inline-flex items-center justify-center gap-2" onClick={copyCode}>
            {copied ? <Check size={ICON.base} /> : <Copy size={ICON.base} />}
            {copied ? t('Скопировано') : t('Скопировать код')}
          </Button>
          <Button variant="secondary" className="flex-1 inline-flex items-center justify-center gap-2" onClick={saveFile}>
            <Download size={ICON.base} />
            {t('Сохранить')}
          </Button>
        </div>
        {/* Кодовое слово — второй фактор. Оно и есть то, что делает
            перехваченный код бесполезным, поэтому стоит крупно и отдельно. */}
        <div className="rounded-2xl border border-accent/25 bg-accent/[0.07] p-4 text-center">
          <p className="text-sm text-muted">{t('Кодовое слово')}</p>
          <p className="mt-1 font-mono text-2xl font-bold tracking-[0.15em] tabular-nums">
            {word ? formatInviteWord(word) : '········'}
          </p>
          <p className="mt-1.5 text-xs leading-snug text-muted">
            {t('Назовите его вслух. Без слова код не откроется.')}
          </p>
        </div>

        <div className="flex gap-2 rounded-xl bg-warning/10 p-3 text-sm text-warning">
          <TriangleAlert size={ICON.base} className="mt-0.5 shrink-0" />
          <span className="min-w-0 leading-snug">
            {t('Кто войдёт по этому приглашению, увидит и прошлую переписку тоже, а отозвать доступ обратно пока нельзя.')}{' '}
            {expiresAt && t('Приглашение действует до {date}.', { date: formatRu(expiresAt.slice(0, 10), 'd MMMM') })}
          </span>
        </div>
      </div>
    </Sheet>
  );
}
