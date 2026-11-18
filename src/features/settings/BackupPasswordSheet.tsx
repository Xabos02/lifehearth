import { useState, type FormEvent } from 'react';
import { Sheet } from '../../components/ui/Sheet';
import { Button } from '../../components/ui/Button';
import { Input } from '../../components/ui/Input';
import { t } from '../../lib/i18n';
import { MIN_BACKUP_PASSWORD } from '../../lib/backupCrypto';

/** Пароль копии файлом (lib/backupCrypto.ts).
 *
 *  mode 'set' — перед сохранением: пароль дважды, плюс осознанный выход
 *  «без пароля» для тех, кто хранит файл в надёжном месте сам.
 *  mode 'enter' — при восстановлении зашифрованной копии.
 *
 *  Собрано из существующих Sheet/Input/Button без новых стилей; отдельной
 *  канвы в design/ под это окно пока нет. */
export function BackupPasswordSheet({
  open,
  mode,
  busy = false,
  error = '',
  onClose,
  onSubmit,
  onSkip,
}: {
  open: boolean;
  mode: 'set' | 'enter';
  busy?: boolean;
  error?: string;
  onClose: () => void;
  onSubmit: (password: string) => void;
  onSkip?: () => void;
}) {
  const [pass, setPass] = useState('');
  const [repeat, setRepeat] = useState('');
  const [touched, setTouched] = useState(false);

  const tooShort = mode === 'set' && pass.length < MIN_BACKUP_PASSWORD;
  const mismatch = mode === 'set' && repeat !== pass;
  const hint = touched && mode === 'set'
    ? tooShort
      ? t('Пароль — не короче {n} символов', { n: MIN_BACKUP_PASSWORD })
      : mismatch
        ? t('Пароли не совпадают')
        : ''
    : '';

  function close() {
    setPass('');
    setRepeat('');
    setTouched(false);
    onClose();
  }

  function submit(e: FormEvent) {
    e.preventDefault();
    setTouched(true);
    if (busy || !pass || tooShort || mismatch) return;
    onSubmit(pass);
    setPass('');
    setRepeat('');
    setTouched(false);
  }

  return (
    <Sheet
      open={open}
      onClose={close}
      title={mode === 'set' ? t('Пароль для копии') : t('Копия под паролем')}
    >
      <form className="flex flex-col gap-3" onSubmit={submit}>
        <p className="text-sm leading-snug text-lh-text-secondary">
          {mode === 'set'
            ? t('Файл будет зашифрован: без пароля его не прочитает никто. Пароль нигде не хранится — забудете, и копию не открыть.')
            : t('Введите пароль, который задали при сохранении копии.')}
        </p>
        <Input
          type="password"
          autoComplete={mode === 'set' ? 'new-password' : 'current-password'}
          aria-label={t('Пароль')}
          placeholder={t('Пароль')}
          value={pass}
          onChange={(e) => setPass(e.target.value)}
          autoFocus
        />
        {mode === 'set' && (
          <Input
            type="password"
            autoComplete="new-password"
            aria-label={t('Повторите пароль')}
            placeholder={t('Повторите пароль')}
            value={repeat}
            onChange={(e) => setRepeat(e.target.value)}
          />
        )}
        {(hint || error) && (
          <p role="alert" className="text-sm text-danger">
            {error || hint}
          </p>
        )}
        <Button type="submit" className="w-full" disabled={busy}>
          {busy ? (mode === 'set' ? t('Шифруем…') : t('Проверяем пароль…')) : mode === 'set' ? t('Зашифровать и сохранить') : t('Открыть копию')}
        </Button>
        {mode === 'set' && onSkip && (
          <Button type="button" variant="secondary" className="w-full" onClick={onSkip} disabled={busy}>
            {t('Сохранить без пароля')}
          </Button>
        )}
      </form>
    </Sheet>
  );
}
