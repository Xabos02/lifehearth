import { useState } from 'react';
import {
  GCheck as Check,
  GCopy as Copy,
  GExternalLink as ExternalLink,
} from '../../components/ui/glyphs';
import { INSTALL_URL } from '../../lib/appInstall';
import { HIT_SLOP_44 } from '../../components/ui/hitSlop';
import { t } from '../../lib/i18n';
import { ICON } from '../../components/ui/icons';

/**
 * Постоянный блок «ссылка для установки»: показывает адрес сайта, даёт
 * скопировать его и открыть. Живёт в Настройках и в инструкции — чтобы
 * переустановить приложение или поделиться им можно было в любой момент.
 */
export function InstallLink() {
  const [copied, setCopied] = useState(false);

  const copy = () => {
    void navigator.clipboard?.writeText(INSTALL_URL).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  };

  return (
    <div className="space-y-2.5">
      <div className="flex items-center gap-2">
        <code className="min-w-0 flex-1 truncate rounded-lg bg-lh-surface-2 px-2.5 py-2 font-mono text-xs">
          {INSTALL_URL}
        </code>
        <button
          type="button"
          onClick={copy}
          aria-label={t('Скопировать ссылку')}
          className={`flex size-9 shrink-0 items-center justify-center rounded-lg bg-lh-surface-2 text-lh-accent active:opacity-60 ${HIT_SLOP_44}`}
        >
          {copied ? <Check size={ICON.base} /> : <Copy size={ICON.base} />}
        </button>
      </div>
      <a
        href={INSTALL_URL}
        target="_blank"
        rel="noopener noreferrer"
        className="inline-flex min-h-11 items-center gap-1.5 text-sm font-semibold text-lh-accent active:opacity-70"
      >
        <ExternalLink size={ICON.action} />
        {t('Открыть сайт установки')}
      </a>
    </div>
  );
}
