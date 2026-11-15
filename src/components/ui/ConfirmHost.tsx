import { useEffect, useState } from 'react';
import { t } from '../../lib/i18n';
import { Button } from './Button';
import { Sheet } from './Sheet';
import { subscribeConfirm, type ConfirmRequest } from './confirmStore';

/** Единый шит подтверждения (макет: «подтверждения — шит с кнопкой-глаголом
 *  + тост „Удалено · Вернуть“»). Монтируется один раз в App.tsx. */
export function ConfirmHost() {
  const [req, setReq] = useState<ConfirmRequest | null>(null);
  useEffect(() => subscribeConfirm(setReq), []);
  const close = () => req?.resolve(false);
  return (
    <Sheet open={req !== null} onClose={close} title={req?.title}>
      {req && (
        <div className="pb-2" role="alertdialog" aria-label={req.title} data-testid="confirm-sheet">
          {req.message && (
            <p className="mb-5 whitespace-pre-line text-sm leading-normal text-lh-text-secondary">
              {req.message}
            </p>
          )}
          <div className="flex flex-col gap-2">
            <Button
              variant={req.danger === false ? 'primary' : 'danger'}
              className="min-h-11 w-full"
              autoFocus
              onClick={() => req.resolve(true)}
            >
              {req.confirmLabel ?? t('Удалить')}
            </Button>
            <Button variant="secondary" className="min-h-11 w-full" onClick={close}>
              {req.cancelLabel ?? t('Не сейчас')}
            </Button>
          </div>
        </div>
      )}
    </Sheet>
  );
}
