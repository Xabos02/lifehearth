import { useEffect, useState } from 'react';
import { Download, ShieldCheck } from 'lucide-react';
import {
  GCheck as Check,
  GCopy as Copy,
  GAlert as TriangleAlert,
} from '../../../components/ui/glyphs';
import { Sheet } from '../../../components/ui/Sheet';
import { Button } from '../../../components/ui/Button';
import { useToast } from '../../../components/ui/toastContext';
import { getBackupCode } from '../../../lib/sync';
import {
  extractRecoveryCode,
  groupCode,
  recoveryKeyFileText,
  recoveryKeyFilename,
} from '../../../lib/recoveryKey';
import { updateSettings } from '../../../hooks/useSettings';
import { now } from '../../../db/repo';
import { t } from '../../../lib/i18n';
import { ICON } from '../../../components/ui/icons';

interface Props {
  open: boolean;
  /** Уже подтверждённый ключ: экран открыт «посмотреть», а не «сохранить». */
  saved: boolean;
  onClose: () => void;
}

/** Экран с ОДНИМ смыслом: сохранить ключ восстановления и убедиться, что
 *  сохранённое рабочее.
 *
 *  Раньше ключ жил внутри шторки «Код для другого устройства» — кнопкой под
 *  QR-кодом. Человек с одним телефоном туда не заходил вовсе, а тот, кто
 *  заходил, видел две одинаковые кнопки: «Скопировать код» (одноразовый код
 *  встречи, живёт 15 минут) и «Сохранить ключ» (вечный доступ ко всем
 *  данным). Разной судьбы вещи выглядели одинаково.
 *
 *  Проверка вставкой — не церемония. Она ловит три беды разом: файл ушёл
 *  пустым, скопировано не то, сохранено туда, где человек это не найдёт. Так
 *  делает Signal с кодом восстановления, и по той же причине: единственный
 *  момент, когда ошибку ещё можно исправить, — сейчас. */
export function RecoveryKeySheet({ open, saved, onClose }: Props) {
  const toast = useToast();
  const [code, setCode] = useState('');
  const [copied, setCopied] = useState(false);
  const [check, setCheck] = useState('');
  const [checkError, setCheckError] = useState('');
  const [confirmed, setConfirmed] = useState(saved);

  // Сброс полей — внутри цепочки, а не синхронно в теле эффекта: на прямой
  // setState в эффекте справедливо ругается React Compiler (тот же приём и в
  // соседнем PairingSheet).
  useEffect(() => {
    if (!open) return;
    void getBackupCode().then((c) => {
      setCode(c ?? '');
      setCheck('');
      setCheckError('');
      setConfirmed(saved);
    });
  }, [open, saved]);

  async function copyCode() {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      window.prompt(t('Ключ восстановления — скопируйте вручную:'), code);
    }
  }

  async function saveFile() {
    // Пустой код — не абстракция: кнопка сохранения не ждала загрузки, и
    // нажатие сразу после открытия давало файл на ноль байт. Человек видел,
    // что файл скачался, и считал дело сделанным.
    if (!code) {
      toast(t('Ключ ещё готовится, повторите через мгновение'));
      return;
    }
    const file = new File([recoveryKeyFileText(code)], recoveryKeyFilename(), {
      type: 'text/plain',
    });
    // На iOS системное «Поделиться» — единственный путь положить файл в
    // «Файлы» или отправить его себе; загрузка там утонет в «Загрузках»
    // ровно того телефона, который потом и теряют. На десктопе share-диалог
    // блокирует страницу, поэтому там обычное скачивание.
    const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent);
    if (isIOS && navigator.canShare?.({ files: [file] })) {
      try {
        await navigator.share({ files: [file] });
      } catch (err) {
        if (!(err instanceof DOMException && err.name === 'AbortError')) {
          toast(t('Не удалось поделиться файлом. Он сохранён — найдите его в «Файлах»'));
        }
        return;
      }
    } else {
      const url = URL.createObjectURL(file);
      const a = document.createElement('a');
      a.href = url;
      a.download = file.name;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    }
    toast(t('Файл сохранён. Теперь вставьте его содержимое ниже — проверим, что он рабочий'));
  }

  async function verify() {
    const got = extractRecoveryCode(check);
    if (!got || got !== code) {
      setCheckError(t('Это не тот ключ. Вставьте содержимое сохранённого файла целиком.'));
      return;
    }
    setCheckError('');
    setConfirmed(true);
    await updateSettings({ recoveryKeySavedAt: now() });
    toast(t('Ключ сохранён и проверен'));
  }

  function handleClose() {
    if (
      !confirmed &&
      !window.confirm(
        t('Ключ восстановления не сохранён. Без него записи из облака не вернуть ничем. Всё равно закрыть?'),
      )
    )
      return;
    onClose();
  }

  return (
    <Sheet open={open} onClose={handleClose} title={t('Ключ восстановления')}>
      <div className="space-y-4">
        <p className="text-sm text-muted">
          {t('Этим ключом возвращают все записи, если телефон потерян или заменён. Второй копии нет ни у кого, включая разработчика.')}
        </p>

        <div className="rounded-xl bg-surface-2 p-3">
          <p className="font-mono text-xs leading-relaxed break-all select-all">
            {code ? groupCode(code) : t('готовим…')}
          </p>
        </div>

        <Button className="w-full inline-flex items-center justify-center gap-2" onClick={() => void saveFile()}>
          <Download size={ICON.base} />
          {t('Сохранить в файл')}
        </Button>
        <Button
          variant="secondary"
          className="w-full inline-flex items-center justify-center gap-2"
          onClick={() => void copyCode()}
        >
          {copied ? <Check size={ICON.base} /> : <Copy size={ICON.base} />}
          {copied ? t('Скопировано') : t('Скопировать ключ')}
        </Button>

        <div className="flex gap-2 rounded-xl bg-warning/10 p-3 text-sm text-warning">
          <TriangleAlert size={ICON.base} className="mt-0.5 shrink-0" />
          <span>
            {t('Храните файл НЕ на этом телефоне: облако, второе устройство, распечатка. Кто получит файл — получит все ваши записи.')}
          </span>
        </div>

        {confirmed ? (
          <p className="flex items-center justify-center gap-2 text-sm font-semibold text-success">
            <ShieldCheck size={ICON.base} />
            {t('Ключ сохранён и проверен')}
          </p>
        ) : (
          <div className="space-y-2 border-t border-hairline pt-4">
            <p className="text-sm font-medium">{t('Проверьте сохранённое')}</p>
            <p className="text-xs text-muted">
              {t('Откройте сохранённый файл и вставьте сюда — целиком, как есть. Так вы узнаете, что он рабочий, пока телефон ещё при вас.')}
            </p>
            <textarea
              className="h-24 w-full rounded-xl bg-surface-2 p-3 font-mono text-xs"
              value={check}
              onChange={(e) => setCheck(e.target.value)}
              placeholder={t('Вставьте содержимое файла')}
            />
            {checkError && <p className="text-sm text-danger">{checkError}</p>}
            <Button className="w-full" disabled={!check.trim()} onClick={() => void verify()}>
              {t('Проверить')}
            </Button>
          </div>
        )}
      </div>
    </Sheet>
  );
}
