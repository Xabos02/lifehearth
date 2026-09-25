import { Mic } from 'lucide-react';
import { isIOS, useSpeechInput } from '../../hooks/useSpeechInput';
import { t } from '../../lib/i18n';
import { useToast } from './toastContext';
import { IconButton } from './IconButton';
import { askConsent, hasConsent } from '../../lib/consent';

interface Props {
  /** получает распознанный текст — обычно дописывает в поле */
  onText: (text: string) => void;
  className?: string;
}

/**
 * Кнопка голосового ввода. В Chrome/Android реально распознаёт речь.
 * На iOS Web Speech API недоступен — подсказываем диктовку с клавиатуры
 * (микрофон рядом с пробелом), вместо неработающей кнопки.
 */
export function MicButton({ onText, className = '' }: Props) {
  const { listening, start, stop, supported } = useSpeechInput({ onResult: onText });
  // Подсказка про диктовку на iOS — не ошибка и не блокирующее сообщение:
  // кнопка стоит в основном потоке ввода, и системное окно посреди набора
  // текста читается как сбой, хотя человек ничего не сломал.
  const toast = useToast();

  if (!supported) {
    if (isIOS()) {
      return (
        <IconButton
          icon={Mic}
          label={t('Голосовой ввод')}
          tone="muted"
          onClick={() =>
            toast(
              t('Для диктовки нажмите 🎤 на клавиатуре iPhone (рядом с пробелом) и говорите — текст появится в поле.'),
            )
          }
          className={`active:scale-90 ${className}`}
        />
      );
    }
    return null;
  }

  // Речь распознаёт сервис браузера (Chrome — Google, Safari — Apple): это
  // внешнее, и без согласия тап открывает окно. Ветка iOS выше в сеть не
  // ходит — там только подсказка про диктовку клавиатуры.
  const listen = () => {
    if (hasConsent()) start();
    else void askConsent('voice').then((ok) => ok && start());
  };

  return (
    <IconButton
      icon={Mic}
      label={listening ? t('Остановить') : t('Голосовой ввод')}
      onClick={listening ? stop : listen}
      tone={listening ? 'danger' : 'muted'}
      className={`transition-transform active:scale-90 ${
        listening ? 'animate-pulse bg-danger/20' : ''
      } ${className}`}
    />
  );
}
