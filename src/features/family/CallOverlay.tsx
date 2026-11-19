import { useCallback, useEffect, useRef, useState } from 'react';
import {
  PhoneOff,
  Mic,
  MicOff,
  Volume2,
  Headphones,
} from 'lucide-react';
import {
  GPhone as Phone,
  GLock as Lock,
  GChevronDown as ChevronDown,
} from '../../components/ui/glyphs';
import { callManager, type CallSnapshot } from '../../lib/family/familyCall';
import { getLang, t } from '../../lib/i18n';
import { CallGuard } from './CallGuard';
import { ICON } from '../../components/ui/icons';
import { HIT_SLOP_44_POSITIONED } from '../../components/ui/hitSlop';
import { Haptic } from '../../components/ui/Haptic';
import { buzz } from '../../lib/feedback';
import { useHoldToReorder } from '../tasks/useHoldToReorder';

/** Через сколько заблокировать экран после того, как звонок ушёл «к уху». */
const LOCK_AFTER_CONNECT_MS = 1800;
/** Пауза бездействия после разблокировки/нажатия, после которой снова блок.
 *  Держим коротким: чем меньше открытое окно, тем меньше шанс, что вернув
 *  телефон к уху, щека заденет кнопку до повторной блокировки. */
const RELOCK_IDLE_MS = 4000;

function fmtElapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

function statusText(snap: CallSnapshot): string {
  // Восстановление важнее самого статуса: человек должен понимать, что связь
  // не умерла, а подхватывается — иначе он кладёт трубку сам.
  if (snap.reconnecting && (snap.status === 'active' || snap.status === 'connecting')) {
    return t('Восстанавливаю связь…');
  }
  switch (snap.status) {
    case 'outgoing':
      return t('Вызов…');
    case 'incoming':
      return t('Входящий звонок');
    case 'connecting':
      return t('Соединение…');
    case 'active':
      return t('На связи');
    case 'ended':
      // endReason — внутренний русский код из familyCall (там он сравнивается
      // с литералами), перевод — только здесь, в точке отображения.
      return t(snap.endReason ?? 'Звонок завершён');
    default:
      return '';
  }
}

export function CallOverlay({ snap, onMinimize }: { snap: CallSnapshot; onMinimize?: () => void }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (snap.status !== 'active') return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [snap.status]);

  const incoming = snap.status === 'incoming';
  const ended = snap.status === 'ended';
  const active = snap.status === 'active';
  // «К уху» = активный звонок с маршрутом на слуховой динамик (не громкая связь).
  // Именно тогда телефон у щеки и нужна защита от случайных нажатий.
  const earpiece = active && !snap.speakerOn;
  const initial = (snap.peerName || '?').slice(0, 1).toUpperCase();

  // --- Защита от нажатий щекой ---
  const [locked, setLocked] = useState(false);
  const lockTimer = useRef<number | undefined>(undefined);
  // Свежий earpiece для отложенного колбэка — иначе таймер заблокирует экран,
  // даже если за время паузы включили громкую связь. Обновляем в эффекте
  // (обращаться к ref во время рендера нельзя).
  const earpieceRef = useRef(earpiece);
  useEffect(() => {
    earpieceRef.current = earpiece;
  }, [earpiece]);

  const scheduleLock = useCallback((delay: number) => {
    window.clearTimeout(lockTimer.current);
    lockTimer.current = window.setTimeout(() => {
      if (earpieceRef.current) setLocked(true);
    }, delay);
  }, []);

  // Ушли «к уху» — заблокировать после короткой паузы (даём увидеть, что
  // соединились). Не «к уху» (громкая связь, конец звонка) — снимаем таймер и
  // сбрасываем блок: overlay не размонтируется во время короткого окна 'ended',
  // и без сброса следующий звонок в том же mount открылся бы уже заблокированным
  // (без паузы-грации). Это осознанная синхронизация состояния с жизненным
  // циклом звонка, а не вычислимое во время рендера значение.
  useEffect(() => {
    if (!earpiece) {
      window.clearTimeout(lockTimer.current);
      // eslint-disable-next-line react-hooks/set-state-in-effect -- сброс блокировки на завершение/смену маршрута звонка
      setLocked(false);
      return;
    }
    scheduleLock(LOCK_AFTER_CONNECT_MS);
    return () => window.clearTimeout(lockTimer.current);
  }, [earpiece, scheduleLock]);

  const unlock = () => {
    setLocked(false);
    scheduleLock(RELOCK_IDLE_MS); // снова к уху — заблокируем сами
  };
  const lockNow = () => {
    window.clearTimeout(lockTimer.current);
    setLocked(true);
  };
  // Обёртка нажатий: после осознанного действия отодвигаем авто-блокировку.
  const bump = (fn: () => void) => () => {
    fn();
    if (earpiece) scheduleLock(RELOCK_IDLE_MS);
  };

  return (
    <>
    <div className="fixed inset-0 z-50 flex flex-col items-center justify-between bg-lh-bg/95 px-6 pb-[calc(env(safe-area-inset-bottom)+40px)] pt-[calc(env(safe-area-inset-top)+72px)] backdrop-blur-xl">
      {/* Свернуть звонок — та же стрелка, что и «назад» в шапках приложения:
          звонок продолжается в фоне, а под ней открывается остальной интерфейс.
          Не для входящего (сначала ответить/отклонить) и не для «завершён»
          (оверлей и сам сейчас исчезнет). */}
      {onMinimize && !incoming && !ended && (
        <button
          onClick={onMinimize}
          aria-label={t('Свернуть звонок')}
          // POSITIONED, а не обычный: тот несёт relative, и он перебивал
          // absolute — стрелка уезжала из своего угла в поток (hitSlop.ts).
          className={`absolute left-3 flex size-11 items-center justify-center rounded-full text-lh-text-secondary active:opacity-70 ${HIT_SLOP_44_POSITIONED}`}
          style={{ top: 'calc(env(safe-area-inset-top) + 12px)' }}
        >
          <ChevronDown size={ICON.accent} />
        </button>
      )}
      {/* Шифрование — тихой строкой сверху, как в макете «Звонок». */}
      <p
        className="absolute left-1/2 flex -translate-x-1/2 items-center gap-1.5 text-xs text-lh-text-secondary"
        style={{ top: 'calc(env(safe-area-inset-top) + 26px)' }}
      >
        <Lock size={ICON.inline} aria-hidden />
        {t('Зашифровано')}
      </p>
      {/* Кто и статус */}
      <div className="flex flex-1 flex-col items-center justify-center">
        <span className="relative flex size-40 items-center justify-center">
          <span
            aria-hidden
            className={`absolute inset-0 rounded-full border border-lh-accent-border ${
              snap.status === 'outgoing' || incoming ? 'animate-ping [animation-duration:2.4s]' : ''
            }`}
          />
          <span aria-hidden className="absolute -inset-[18px] rounded-full border border-lh-accent/10" />
          <span className="flex size-36 items-center justify-center rounded-full border border-lh-accent-border bg-lh-accent-dim text-5xl font-light text-lh-accent">
            {initial}
          </span>
        </span>
        <div className="mt-10 text-center">
          <p className="text-3xl font-light tracking-tight">{snap.peerName || t('Участник')}</p>
          <p
            className={`mt-2 flex items-center justify-center gap-2 text-base tabular-nums ${
              snap.status === 'active' ? 'text-success' : 'text-lh-text-secondary'
            }`}
          >
            {snap.status === 'active' && <span aria-hidden className="size-2 rounded-full bg-success" />}
            {snap.status === 'active' && snap.startedAt
              ? fmtElapsed(now - snap.startedAt)
              : statusText(snap)}
          </p>
        </div>
      </div>

      {/* Управление */}
      {!ended && (
        <div className="flex w-full max-w-xs flex-wrap items-start justify-center gap-x-8 gap-y-7">
          {incoming ? (
            <>
              <CallButton color="danger" label={t('Отклонить')} onClick={() => callManager.decline()}>
                <PhoneOff size={ICON.accent} />
              </CallButton>
              {/* «Ответить» — омоним: в чате это Reply, на звонке — Answer.
                  Словарь держит один ключ, поэтому здесь явная ветка языка. */}
              <CallButton
                color="success"
                label={getLang() === 'en' ? 'Answer' : 'Ответить'}
                onClick={() => void callManager.accept()}
              >
                <Phone size={ICON.accent} />
              </CallButton>
            </>
          ) : (
            <>
              {/* «Включить» — омоним: словарь держит «Turn on» (уведомления),
                  под выключенным микрофоном звонка привычнее «Unmute». */}
              <CallButton
                color={snap.muted ? 'active' : 'surface'}
                label={snap.muted ? (getLang() === 'en' ? 'Unmute' : 'Включить') : t('Микрофон')}
                onClick={bump(() => callManager.toggleMute())}
                haptic
              >
                {snap.muted ? <MicOff size={ICON.accent} /> : <Mic size={ICON.accent} />}
              </CallButton>
              {snap.speakerAvailable && (
                <CallButton
                  color={snap.speakerOn ? 'active' : 'surface'}
                  label={snap.speakerOn ? t('Динамик') : t('К уху')}
                  onClick={bump(() => void callManager.toggleSpeaker())}
                  haptic
                >
                  <Volume2 size={ICON.accent} />
                </CallButton>
              )}
              {snap.outputPickerAvailable && (
                <CallButton
                  color="surface"
                  label={t('Наушники')}
                  onClick={bump(() => callManager.showOutputPicker())}
                >
                  <Headphones size={ICON.accent} />
                </CallButton>
              )}
              {earpiece && (
                <CallButton color="surface" label={t('Блокировка')} onClick={lockNow}>
                  <Lock size={ICON.accent} />
                </CallButton>
              )}
              <CallButton color="danger" label={t('Завершить')} onClick={bump(() => callManager.hangup())}>
                <PhoneOff size={ICON.accent} />
              </CallButton>
            </>
          )}
        </div>
      )}
    </div>
    {locked && earpiece && (
      <CallGuard
        peerName={snap.peerName || t('Участник')}
        elapsed={snap.startedAt ? fmtElapsed(now - snap.startedAt) : '0:00'}
        onUnlock={unlock}
      />
    )}
    </>
  );
}

/** Где стоит свёрнутый звонок: доли 0…1 от свободного хода по каждой оси.
 *  Доли, а не пиксели: плашка меняет ширину («Соединяю…» → «3:28») и экран
 *  поворачивается — прижатая к правому краю остаётся у правого края. */
type CallBarPos = { x: number; y: number };
const CALL_BAR_POS_KEY = 'life-hub-call-bar-pos';
/** Сверху справа — не под стрелкой «назад» экрана (та слева). */
const CALL_BAR_DEFAULT: CallBarPos = { x: 1, y: 0 };

function loadCallBarPos(): CallBarPos {
  try {
    const p = JSON.parse(localStorage.getItem(CALL_BAR_POS_KEY) ?? 'null') as Partial<CallBarPos> | null;
    const ok = (v: unknown): v is number => typeof v === 'number' && v >= 0 && v <= 1;
    if (ok(p?.x) && ok(p?.y)) return { x: p.x, y: p.y };
  } catch {
    /* хранилище закрыто или запись битая — ставим по умолчанию */
  }
  return CALL_BAR_DEFAULT;
}

function saveCallBarPos(p: CallBarPos) {
  try {
    localStorage.setItem(CALL_BAR_POS_KEY, JSON.stringify(p));
  } catch {
    /* приватный режим: позиция доживёт только до конца звонка */
  }
}

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));

/** Свёрнутый звонок: плашка поверх приложения, по умолчанию сверху справа.
 *  Тап разворачивает звонок, удержание (та же машина, что у проектов и
 *  папок, 400 мс) берёт плашку — её можно перетащить куда удобно, и место
 *  запоминается между звонками. Таймер идёт своим тиком: полноэкранный
 *  оверлей размонтирован, и его собственный интервал вместе с ним. */
export function MinimizedCallBar({ snap, onExpand }: { snap: CallSnapshot; onExpand: () => void }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (snap.status !== 'active') return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [snap.status]);

  const areaRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState(loadCallBarPos);
  // Снять идущий жест (слушатели окна). Зовётся и при размонтировании: звонок
  // может кончиться, пока палец ещё ведёт плашку, — тогда место не пишем.
  const stop = useRef<(() => void) | null>(null);
  useEffect(() => () => stop.current?.(), []);
  const { headerProps } = useHoldToReorder(({ x, y, pointerId }) => {
    if (stop.current) return; // один жест за раз: второй палец не ведёт свой
    const area = areaRef.current;
    const bar = area?.firstElementChild as HTMLElement | null;
    if (!area || !bar) return;
    buzz(); // захват — Android вибрирует, на iPhone сигнал — сжатие при удержании (PROTOCOL §6.4)
    // Ход считается от размеров без transform: удержание ещё доигрывает
    // сжатие 0.97, и прямоугольник с экрана был бы на пару пикселей меньше.
    const spanX = area.clientWidth - bar.offsetWidth;
    const spanY = area.clientHeight - bar.offsetHeight;
    const from = pos;
    let to = pos;
    const move = (e: PointerEvent) => {
      if (e.pointerId !== pointerId) return;
      to = {
        x: spanX > 0 ? clamp01(from.x + (e.clientX - x) / spanX) : from.x,
        y: spanY > 0 ? clamp01(from.y + (e.clientY - y) / spanY) : from.y,
      };
      setPos(to);
    };
    const off = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', end);
      window.removeEventListener('pointercancel', end);
      stop.current = null;
    };
    const end = (e: PointerEvent) => {
      if (e.pointerId !== pointerId) return;
      off();
      // Жест отняла система — плашка возвращается, как перенос в списках.
      if (e.type === 'pointercancel') setPos(from);
      else saveCallBarPos(to);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', end);
    window.addEventListener('pointercancel', end);
    stop.current = off;
  }, onExpand);

  return (
    // Рамка хода: под вырезом и у краёв — safe-area, снизу — над таб-баром
    // (линия 1 + pt 6 + вкладка 52 + нижний отступ ≤8 = 67px, плюс зазор 10;
    // нижнюю safe-area таб-бар уже вобрал). Сама рамка касаний не ловит.
    <div
      ref={areaRef}
      className="pointer-events-none fixed z-50"
      style={{
        top: 'calc(env(safe-area-inset-top) + 10px)',
        left: 'calc(env(safe-area-inset-left) + 12px)',
        right: 'calc(env(safe-area-inset-right) + 12px)',
        bottom: '77px',
      }}
    >
      <button
        {...headerProps}
        aria-label={t('Развернуть звонок: {name}, {status}', { name: snap.peerName || t('Участник'), status: statusText(snap) })}
        // Плашка ~34px в высоту — зона добирается до 44 невидимо; POSITIONED,
        // потому что relative из обычного HIT_SLOP сбил бы absolute. Зелёный по
        // смыслу светлый — глиф тёмный, как у «Принять» (белый давал 1.75).
        // touch-none: с плашки нечего листать, а начатая прокрутка отняла бы
        // жест у переноса — iOS решает это в миг касания, touchAction из хука
        // через 400 мс уже поздно. Без выделения и системного меню, как у
        // остальных удержаний. w-max: у края хода (left: 100%) ширина иначе
        // сжалась бы до нуля. Сдвиг — свойством translate: transform занят
        // сжатием удержания.
        className={`pointer-events-auto absolute flex w-max touch-none select-none [-webkit-touch-callout:none] items-center gap-2 rounded-full bg-success-fill px-3 py-2 text-on-light shadow-lg active:opacity-90 ${HIT_SLOP_44_POSITIONED}`}
        style={{ left: `${pos.x * 100}%`, top: `${pos.y * 100}%`, translate: `${-pos.x * 100}% ${-pos.y * 100}%` }}
      >
        <Phone size={ICON.inline} className="animate-pulse" />
        <span className="max-w-[7rem] truncate text-xs font-semibold">{snap.peerName || t('Участник')}</span>
        <span className="text-xs tabular-nums opacity-90">
          {snap.status === 'active' && snap.startedAt ? fmtElapsed(now - snap.startedAt) : statusText(snap)}
        </span>
      </button>
    </div>
  );
}

function CallButton({
  children,
  label,
  color,
  onClick,
  haptic = false,
}: {
  children: React.ReactNode;
  label: string;
  color: 'danger' | 'success' | 'surface' | 'active';
  onClick: () => void;
  /** Кнопка-переключатель (микрофон, динамик) — щёлкает, PROTOCOL §6.4. */
  haptic?: boolean;
}) {
  const cls =
    color === 'danger'
      ? 'bg-danger-fill text-white'
      : color === 'success'
        ? 'bg-success-fill text-on-light'
        : color === 'active'
          ? 'bg-lh-text-primary text-lh-bg'
          : 'bg-lh-surface-2 text-lh-text-primary ring-1 ring-inset ring-lh-border';
  return (
    <button onClick={onClick} className="flex flex-col items-center gap-2 active:scale-95" aria-label={label}>
      <span className={`flex items-center justify-center rounded-full ${color === 'danger' || color === 'success' ? 'size-[72px]' : 'size-16'} ${cls}`}>{children}</span>
      <span className={`text-xs ${color === 'active' ? 'text-lh-text-primary' : 'text-lh-text-secondary'}`}>{label}</span>
      {haptic && <Haptic />}
    </button>
  );
}
