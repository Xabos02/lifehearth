import { useLiveQuery } from 'dexie-react-hooks';
import { Sheet } from '../../components/ui/Sheet';
import { Button } from '../../components/ui/Button';
import { PinForm } from '../cycle/CycleLock';
import { db } from '../../db/db';
import { t } from '../../lib/i18n';

/** Код перед копией файлом, когда «Женские дни» закрыты кодом (ST4 аудита
 *  1.64.0). Файл — обычный JSON: без этого окна любой, кто взял
 *  разблокированный телефон, уносил записи раздела двумя тапами мимо кода.
 *
 *  Второй путь — копия без раздела: кто код не знает, сохраняет остальное, а
 *  восстановление такой копии историю цикла не трогает (exportBackup,
 *  withoutCycle).
 *
 *  Раздел окно не называет (канва design/backup-pin, Б): его видит либо
 *  хозяйка кода, которой название не нужно, либо тот, от кого код ставился,
 *  а раздел бывает спрятан из меню — сам факт его ведения тоже информация
 *  (PROTOCOL §7.2). */
export function BackupPinSheet({
  open,
  onClose,
  onSave,
}: {
  open: boolean;
  onClose: () => void;
  onSave: (withoutCycle: boolean) => void;
}) {
  const settings = useLiveQuery(() => db.cycleSettings.get('app'), []);

  return (
    <Sheet open={open} onClose={onClose} title={t('Нужен код')}>
      <div className="flex flex-col items-center gap-4">
        <p className="w-full text-sm leading-snug text-lh-text-secondary">
          {t('Часть записей закрыта кодом. Введите его, чтобы сохранить копию целиком, или сохраните без закрытых записей.')}
        </p>
        {/* ponytail: пауза после неверных попыток живёт, пока открыто окно
            (Sheet снимает содержимое при закрытии) — как у экрана замка до
            перезагрузки. Подбор вручную она замедляет, а не запрещает;
            общий счётчик в lockState, если понадобится строже. */}
        {settings && (
          <PinForm settings={settings} onUnlock={() => onSave(false)} submitLabel={t('Сохранить')} width="" />
        )}
        <Button variant="secondary" className="w-full" onClick={() => onSave(true)}>
          {t('Сохранить без закрытых записей')}
        </Button>
      </div>
    </Sheet>
  );
}
