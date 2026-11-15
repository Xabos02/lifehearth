import { useRef, useState, type PointerEvent, type ReactNode } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import {
  AudioWaveform,
  Bell,
  BellOff,
  Clock,
  Coffee,
  ListChecks,
  Maximize2,
  SkipForward,
  type LucideIcon,
} from 'lucide-react';
import {
  GChevronRight as ChevronRight,
  GPencil as Pencil,
  GPlus as Plus,
  GTrash as Trash2,
  GPause as Pause,
  GPlay as Play,
  GRepeat as RotateCcw,
} from '../../components/ui/glyphs';
import { db } from '../../db/db';
import { alive } from '../../db/repo';
import { t } from '../../lib/i18n';
import { Screen } from '../../components/layout/Screen';
import { Sheet } from '../../components/ui/Sheet';
import { EmptyState } from '../../components/ui/EmptyState';
import {
  formatClock,
  formatFocusTime,
  usePomodoro,
  type Phase,
} from './pomodoro';
import { ICON } from '../../components/ui/icons';
import { ALARM_OPTIONS, alarmOption, type AlarmType } from './alarms';
import { NOISE_OPTIONS, noiseLabel } from './noise';
import { SoundPickerSheet } from './SoundPickerSheet';
import { FocusFullscreen } from './FocusFullscreen';
import { FOCUS_VARS } from './focusVars';
import { Switch } from '../../components/ui/Switch';
import { enablePush, isStandalone, pushEnabled, pushPaused, pushSupported } from '../../lib/push';
import { useConsent } from '../../lib/consent';
import { useToast } from '../../components/ui/toastContext';

const PHASE_LABEL: Record<Phase, string> = {
  work: 'Фокус',
  break: 'Перерыв',
  long: 'Длинный перерыв',
};

// Пользовательский шаблон длительности (создаётся/правится/удаляется юзером).
// Хранится в localStorage — рядом с состоянием помодоро, вне Dexie/бэкапа.
interface Preset {
  id: string;
  name: string;
  work: number;
  break: number;
  long: number;
}

const PRESETS_KEY = 'life-hub-pomodoro-presets';
const DEFAULT_PRESETS: Preset[] = [
  { id: 'def-25-5', name: '25 / 5', work: 25, break: 5, long: 15 },
  { id: 'def-50-10', name: '50 / 10', work: 50, break: 10, long: 15 },
  { id: 'def-90-20', name: '90 / 20', work: 90, break: 20, long: 20 },
];

function loadPresets(): Preset[] {
  try {
    const raw = localStorage.getItem(PRESETS_KEY);
    if (!raw) return DEFAULT_PRESETS;
    const arr = JSON.parse(raw) as Preset[];
    return Array.isArray(arr) ? arr : DEFAULT_PRESETS;
  } catch {
    return DEFAULT_PRESETS;
  }
}

function savePresets(list: Preset[]): void {
  try {
    localStorage.setItem(PRESETS_KEY, JSON.stringify(list));
  } catch {
    /* квота */
  }
}

const R = 130;
const STROKE = 8;
const RING_HIT = 24; // допуск касания от оси дорожки (в единицах viewBox)
const CIRC = 2 * Math.PI * R;
const MAX_MIN = 90; // базовый максимум круга (растёт под бо́льшие значения)
const STEP_MIN = 5; // шаг при перетаскивании кольца

/** Поле числа: шаг ±1 кнопками и ввод любого значения. Длительности — без
 *  верхнего предела; у кругов до длинного перерыва предел есть (max). */
function DurationStepper({
  label,
  value,
  onChange,
  unit = 'минут',
  max = Infinity,
  hint,
}: {
  label: string;
  /** Пояснение под подписью — для неочевидных настроек. */
  hint?: string;
  value: number;
  onChange: (v: number) => void;
  /** Подпись единицы для читалки: «Фокус, минут» / «Кругов до него, штук». */
  unit?: string;
  max?: number;
}) {
  // Локальный текст: позволяет полностью стереть поле во время ввода (value=число
  // нельзя сделать пустым). Живое обновление — только при валидном числе ≥ 1;
  // пустое/невалидное на blur откатывается к текущему значению. Синхронизация с
  // внешним value (кнопки ±, пресеты, кольцо) — во время рендера, не в эффекте.
  const [text, setText] = useState(String(value));
  const [seenValue, setSeenValue] = useState(value);
  if (seenValue !== value) {
    setSeenValue(value);
    setText(String(value));
  }

  // Ряд карточки «подпись · − число +». Кнопки ± — size-11 (минимум 44×44 по
  // HIG), поле фиксированной ширины; подпись сжимается и переносится (min-w-0),
  // поэтому на 320px ряд не выталкивает «+» за край экрана.
  return (
    <div className="flex min-h-[52px] items-center gap-1.5 px-4 py-1.5">
      <span className="min-w-0 flex-1 pr-1">
        <span className="block">{label}</span>
        {hint && <span className="block text-xs leading-snug text-lh-text-secondary">{hint}</span>}
      </span>
      <div className="flex shrink-0 items-center gap-1">
        <button
          type="button"
          aria-label={t('{label}: меньше', { label })}
          onClick={() => onChange(Math.max(1, value - 1))}
          className="flex size-11 shrink-0 items-center justify-center rounded-full bg-lh-surface-2 text-lg text-lh-text-primary active:scale-90"
        >
          −
        </button>
        <input
          type="text"
          inputMode="numeric"
          pattern="[0-9]*"
          aria-label={unit === 'минут' ? t('{label}, минут', { label }) : t('{label}, штук', { label })}
          value={text}
          onChange={(e) => {
            const raw = e.target.value.replace(/\D/g, '');
            setText(raw);
            const n = parseInt(raw, 10);
            if (raw !== '' && n >= 1) {
              const clamped = Math.min(max, n);
              onChange(clamped);
              // Предел применён — показать его, а не набранное «12».
              if (clamped !== n) setText(String(clamped));
            }
          }}
          onBlur={() => {
            const n = parseInt(text, 10);
            if (!Number.isFinite(n) || n < 1) setText(String(value));
          }}
          // text-2xl! — с `!`: правило полей font-size: 16px (iOS, index.css)
          // лежит вне слоёв и без него оставило бы цифры 16px.
          className="w-14 rounded-lg bg-transparent text-center text-2xl! font-extralight tabular-nums outline-none focus-visible:ring-2 focus-visible:ring-lh-accent/60"
        />
        <button
          type="button"
          aria-label={t('{label}: больше', { label })}
          onClick={() => onChange(Math.min(max, value + 1))}
          disabled={value >= max}
          className="flex size-11 shrink-0 items-center justify-center rounded-full bg-lh-surface-2 text-lg text-lh-text-primary active:scale-90 disabled:opacity-40"
        >
          +
        </button>
      </div>
    </div>
  );
}

/** Форма шаблона в нижнем шите: имя + три степпера + сохранить/удалить. */
function PresetForm({
  initial,
  onSave,
  onDelete,
}: {
  initial: Preset;
  onSave: (preset: Preset) => void;
  onDelete?: () => void;
}) {
  const [name, setName] = useState(initial.name);
  const [work, setWork] = useState(initial.work);
  const [brk, setBrk] = useState(initial.break);
  const [long, setLong] = useState(initial.long);
  const fallbackName = `${work} / ${brk}`;

  return (
    <div className="flex flex-col gap-4 pb-2">
      <div>
        <p className="mb-2 px-1 text-sm font-medium text-lh-text-secondary">{t('Название')}</p>
        <input
          value={name}
          maxLength={24}
          onChange={(e) => setName(e.target.value)}
          placeholder={fallbackName}
          className="w-full rounded-2xl bg-lh-surface-2 px-4 py-3 text-base outline-none transition-[box-shadow] placeholder:text-lh-text-secondary focus-visible:ring-2 focus-visible:ring-lh-accent/60"
        />
      </div>
      <div>
        <p className="mb-2 px-1 text-sm font-medium text-lh-text-secondary">{t('Длительность (мин)')}</p>
        <div className="divide-y divide-lh-border overflow-hidden rounded-2xl bg-lh-surface-2/60">
          <DurationStepper label={t('Фокус')} value={work} onChange={setWork} />
          <DurationStepper label={t('Перерыв')} value={brk} onChange={setBrk} />
          <DurationStepper label={t('Длинный перерыв')} value={long} onChange={setLong} />
        </div>
      </div>
      <button
        onClick={() => onSave({ ...initial, name: name.trim() || fallbackName, work, break: brk, long })}
        style={{ backgroundImage: 'linear-gradient(150deg, var(--focus-accent-fill), var(--focus-accent-2-fill))' }}
        className="rounded-2xl py-3 text-center font-semibold text-white active:opacity-95"
      >
        {t('Сохранить')}
      </button>
      {onDelete && (
        <button
          onClick={onDelete}
          className="flex items-center justify-center gap-1.5 rounded-2xl border border-lh-border-strong py-3 text-center font-medium text-danger active:opacity-70"
        >
          <Trash2 size={ICON.action} /> {t('Удалить')}
        </button>
      )}
    </div>
  );
}

/** Строка карточки «Звуки»: значок, подпись, текущее значение, шеврон. */
function SoundRow({
  icon: Icon,
  label,
  value,
  onClick,
}: {
  icon: LucideIcon;
  label: string;
  value: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex min-h-[52px] w-full items-center gap-3 px-4 py-2.5 text-left active:bg-lh-surface-2"
    >
      <Icon size={ICON.base} className="shrink-0 text-lh-text-secondary" />
      <span className="min-w-0 flex-1">{label}</span>
      <span className="flex min-w-0 items-center gap-1 text-lh-text-secondary">
        <span className="truncate">{value}</span>
        <ChevronRight size={ICON.base} className="shrink-0" />
      </span>
    </button>
  );
}

/** Вторичная кнопка управления таймером: круг 48px и подпись под ним. */
function ControlButton({
  label,
  onClick,
  disabled,
  children,
}: {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      className="flex w-20 flex-col items-center gap-1.5 pt-3 text-lh-text-secondary active:opacity-70 disabled:opacity-40"
    >
      <span className="flex size-12 items-center justify-center rounded-full border border-lh-border bg-lh-surface text-lh-text-primary">
        {children}
      </span>
      <span className="text-center text-xs leading-tight">{label}</span>
    </button>
  );
}

/** Точки цикла под меткой фазы: закрашено — круг сделан, контур — идёт сейчас.
 *  Читаются с расстояния вытянутой руки, в отличие от строки «круг 2 из 4». */
function CycleDots({ done, total, color }: { done: number; total: number; color: string }) {
  const current = Math.min(done, total - 1);
  return (
    <div
      role="img"
      aria-label={t('Круг {n} из {total}', { n: String(Math.min(done + 1, total)), total: String(total) })}
      data-testid="cycle-dots"
      data-done={done}
      className="mt-3 flex items-center gap-1.5"
    >
      {Array.from({ length: total }, (_, i) => (
        <span
          key={i}
          className="size-2 rounded-full"
          style={
            i < done
              ? { background: color }
              : i === current && done < total
                ? { boxShadow: `inset 0 0 0 2px ${color}` }
                : { background: 'var(--app-hairline)' }
          }
        />
      ))}
    </div>
  );
}

export function FocusPage() {
  const p = usePomodoro();
  const toast = useToast();
  // pushEnabled() синхронный; включение из баннера ниже обновляет состояние само.
  // С согласием в зависимостях рендера: «Принимаю» в другом месте возвращает
  // уведомления, и баннер «выключены» не должен висеть до ухода с экрана.
  // На паузе баннер не показываем вовсе — уведомления не выключены, а ждут
  // согласия (плашка в настройках).
  useConsent();
  const [pushOnLocal, setPushOn] = useState(false);
  const pushOn = pushOnLocal || pushEnabled() || pushPaused();

  async function enableFocusPush() {
    if (!pushSupported()) {
      toast(t('Уведомления не поддерживаются этим браузером.'));
      return;
    }
    if (!isStandalone()) {
      toast(t('Уведомления работают только в установленном приложении. Добавьте LifeHearth на экран «Домой» и откройте оттуда.'));
      return;
    }
    const res = await enablePush();
    // Окно согласия закрыли без «Принимаю» — это ответ, а не сбой.
    if (res.reason === 'consent') return;
    if (!res.ok) {
      toast(res.reason === 'denied' ? t('Разрешение не выдано. Включите в настройках устройства.') : t('Не удалось включить уведомления. Проверьте разрешения в настройках устройства'));
      return;
    }
    setPushOn(true);
  }
  const [pickerOpen, setPickerOpen] = useState(false);
  const [soundSheet, setSoundSheet] = useState<'work' | 'break' | 'noise' | null>(null);
  const [fullscreen, setFullscreen] = useState(false);
  const [presets, setPresets] = useState<Preset[]>(loadPresets);
  const [managing, setManaging] = useState(false);
  const [presetSheetOpen, setPresetSheetOpen] = useState(false);
  const [editingPreset, setEditingPreset] = useState<Preset | null>(null);

  const applyPreset = (pr: Preset) => {
    p.setDurations(pr.work, pr.break);
    p.setLongMin(pr.long);
  };
  const persistPresets = (next: Preset[]) => {
    setPresets(next);
    savePresets(next);
  };
  const openNewPreset = () => {
    setEditingPreset({ id: crypto.randomUUID(), name: '', work: p.workMin, break: p.breakMin, long: p.longMin });
    setPresetSheetOpen(true);
  };
  const openEditPreset = (pr: Preset) => {
    setEditingPreset(pr);
    setPresetSheetOpen(true);
  };
  const savePreset = (pr: Preset) => {
    persistPresets(
      presets.some((x) => x.id === pr.id) ? presets.map((x) => (x.id === pr.id ? pr : x)) : [...presets, pr],
    );
    setPresetSheetOpen(false);
  };
  const deletePreset = (id: string) => {
    persistPresets(presets.filter((x) => x.id !== id));
    setPresetSheetOpen(false);
  };
  // Список задач для фокуса — как в «Задачах»: без выполненных и
  // замороженных, по порядку sortOrder (toArray отдавал по uuid — вразнобой).
  const tasks = alive(useLiveQuery(() => db.tasks.toArray(), []) ?? [])
    .filter((task) => !task.completedAt && !task.frozenAt)
    .sort((a, b) => (a.projectId ?? '').localeCompare(b.projectId ?? '') || a.sortOrder - b.sortOrder);

  const isWork = p.phase === 'work';
  // Метка фазы и «ручка» слайдера — сплошной цвет (акцент перекрыт тёплым ниже
  // по дереву); сама дуга в фокусе — красно-оранжевый градиент Focus To-Do.
  const accentColor = isWork ? 'var(--lh-accent)' : 'var(--app-success)';
  const ringStroke = isWork ? 'url(#focusGrad)' : 'var(--app-success)';
  // Когда сессии нет и фаза «работа» — кольцо это слайдер длительности
  // (заполнение = workMin/ringMax); тянешь по кругу → меняешь время. Иначе — отсчёт.
  // ringMax растёт под значения больше 90 (длительность задаётся без верхнего предела).
  // Именно «сессии нет», а не «таймер стоит»: на паузе кольцо раньше тоже
  // становилось слайдером, дуга прыгала на workMin/90, а касание сбрасывало
  // остаток на полную длительность — прогресс круга терялся без предупреждения.
  const idleWork = !p.active && isWork;
  const ringMax = Math.max(MAX_MIN, p.workMin);
  const ringFrac = idleWork
    ? Math.min(1, p.workMin / ringMax)
    : p.totalMs > 0
      ? 1 - p.remainingMs / p.totalMs
      : 0;
  const handleA = 2 * Math.PI * ringFrac;
  const handleX = 150 + R * Math.sin(handleA);
  const handleY = 150 - R * Math.cos(handleA);

  const svgRef = useRef<SVGSVGElement>(null);
  const dragging = useRef(false);
  // Шкала кольца фиксируется на старте жеста: max = max(90, workMin) иначе
  // пересчитывался после первого же setWorkMin, и дуга скакала под пальцем.
  const gestureMax = useRef(MAX_MIN);

  /** Расстояние касания от центра в единицах viewBox (300×300). */
  function distFromCenter(clientX: number, clientY: number): number {
    const svg = svgRef.current;
    if (!svg) return 0;
    const rect = svg.getBoundingClientRect();
    const k = 300 / rect.width;
    const dx = (clientX - rect.left) * k - 150;
    const dy = (clientY - rect.top) * k - 150;
    return Math.hypot(dx, dy);
  }

  function setFromPointer(clientX: number, clientY: number) {
    const svg = svgRef.current;
    if (!svg) return;
    const rect = svg.getBoundingClientRect();
    const cx = rect.left + rect.width / 2;
    const cy = rect.top + rect.height / 2;
    let deg = (Math.atan2(clientX - cx, -(clientY - cy)) * 180) / Math.PI;
    if (deg < 0) deg += 360;
    const max = gestureMax.current;
    let minutes = Math.round(((deg / 360) * max) / STEP_MIN) * STEP_MIN;
    minutes = Math.max(STEP_MIN, Math.min(max, minutes));
    p.setWorkMin(minutes);
  }

  const onRingDown = (e: PointerEvent<SVGSVGElement>) => {
    if (!idleWork) return;
    // Жест принимается только на дорожке кольца (с запасом в ширину штриха
    // с каждой стороны). Раньше угол считался от любого касания, и тап по
    // цифрам в центре — самое естественное место «а что тут» — переставлял
    // длительность: 25 → 55 минут одним пальцем.
    if (Math.abs(distFromCenter(e.clientX, e.clientY) - R) > RING_HIT) return;
    dragging.current = true;
    gestureMax.current = Math.max(MAX_MIN, p.workMin);
    try {
      svgRef.current?.setPointerCapture(e.pointerId);
    } catch {
      /* указатель уже неактивен */
    }
    setFromPointer(e.clientX, e.clientY);
  };
  const onRingMove = (e: PointerEvent<SVGSVGElement>) => {
    if (!dragging.current || !idleWork) return;
    setFromPointer(e.clientX, e.clientY);
  };
  const onRingUp = () => {
    dragging.current = false;
  };

  return (
    <Screen
      title={t('Фокус')}
      backTo="/home"
      right={
        // На весь экран — как в Focus To-Do: только круг и время, экран не гаснет.
        <button
          type="button"
          onClick={() => setFullscreen(true)}
          aria-label={t('На весь экран')}
          className="flex size-11 items-center justify-center rounded-full text-lh-text-secondary active:opacity-60"
        >
          <Maximize2 size={ICON.header} />
        </button>
      }
    >
      <div className="flex flex-col gap-6" style={FOCUS_VARS}>
        <section className="flex flex-col items-center pt-2">
        {/* Фаза — указатель, а не переключатель: фазы сменяет сам таймер. */}
        <div className="flex items-center gap-1 rounded-full border border-lh-border bg-lh-surface p-1 text-xs">
          {(['work', 'break', 'long'] as Phase[]).map((ph) => (
            <span
              key={ph}
              className={`flex h-8 items-center rounded-full px-3.5 ${
                p.phase === ph ? 'bg-lh-surface-2 font-semibold text-lh-text-primary' : 'text-lh-text-secondary'
              }`}
            >
              {t(PHASE_LABEL[ph])}
            </span>
          ))}
        </div>

        <div className="relative mt-6">
          <svg
            ref={svgRef}
            viewBox="0 0 300 300"
            className="w-[248px] max-w-[72vw]"
            style={{ touchAction: idleWork ? 'none' : 'auto' }}
            onPointerDown={onRingDown}
            onPointerMove={onRingMove}
            onPointerUp={onRingUp}
            onPointerCancel={onRingUp}
          >
            <defs>
              <linearGradient id="focusGrad" gradientUnits="userSpaceOnUse" x1="150" y1="20" x2="150" y2="280">
                <stop offset="0%" stopColor="var(--focus-accent)" />
                <stop offset="100%" stopColor="var(--focus-accent-2)" />
              </linearGradient>
            </defs>
            <circle cx="150" cy="150" r={R} fill="none" stroke="var(--app-hairline)" strokeWidth={STROKE} />
            <circle
              cx="150"
              cy="150"
              r={R}
              fill="none"
              stroke={ringStroke}
              strokeWidth={STROKE}
              strokeLinecap="round"
              strokeDasharray={CIRC}
              strokeDashoffset={CIRC * (1 - ringFrac)}
              transform="rotate(-90 150 150)"
              style={{ transition: p.running ? 'stroke-dashoffset 0.5s linear' : 'none' }}
            />
            {idleWork && (
              <circle
                cx={handleX}
                cy={handleY}
                r={11}
                fill={accentColor}
                stroke="var(--lh-bg)"
                strokeWidth={3}
              />
            )}
          </svg>
          <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center">
            <span className="text-xs uppercase tracking-[.08em] text-lh-text-secondary">
              {idleWork ? t('Длительность') : t('Осталось')}
            </span>
            <span className="mt-1 text-5xl font-light leading-none tabular-nums tracking-tight">
              {formatClock(p.remainingMs)}
            </span>
            <CycleDots done={p.cycle.done} total={p.cycle.total} color={accentColor} />
            <span className="mt-1.5 text-xs tabular-nums text-lh-text-secondary">
              {idleWork
                ? t('крутите кольцо ↻')
                : t('Круг {n} из {total}', { n: String(Math.min(p.cycle.done + 1, p.cycle.total)), total: String(p.cycle.total) })}
            </span>
          </div>
        </div>

        <div className="mt-6 flex items-start justify-center gap-6">
          <ControlButton label={t('Сбросить')} onClick={p.reset}>
            <RotateCcw size={ICON.action} />
          </ControlButton>
          <button
            type="button"
            onClick={p.running ? p.toggle : () => (p.active ? p.toggle() : p.start())}
            aria-label={p.running ? t('Пауза') : t('Старт')}
            className="flex w-20 flex-col items-center gap-1.5 text-lh-text-primary active:opacity-80"
          >
            <span
              className="flex size-[72px] items-center justify-center rounded-full bg-lh-accent text-lh-bg"
              style={{ boxShadow: 'var(--shadow-focus)' }}
            >
              {p.running ? <Pause size={ICON.hero} fill="currentColor" /> : <Play size={ICON.hero} fill="currentColor" className="ml-1" />}
            </span>
            <span className="text-xs font-semibold">{p.running ? t('Пауза') : t('Старт')}</span>
          </button>
          <ControlButton
            label={isWork ? t('Завершить круг') : t('Пропустить перерыв')}
            onClick={p.skip}
            disabled={!p.active}
          >
            <SkipForward size={ICON.action} />
          </ControlButton>
        </div>
        </section>

        {/* Выбор задачи фокуса */}
        <button
          type="button"
          onClick={() => setPickerOpen(true)}
          className="card flex w-full items-center gap-3 px-4 py-3.5 text-left active:opacity-80"
        >
          <span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-lh-surface-2 text-lh-accent">
            <ListChecks size={ICON.base} />
          </span>
          <span className="min-w-0 flex-1">
            <span className="block text-xs text-lh-text-secondary">{t('Задача для фокуса')}</span>
            <span className={`mt-0.5 block truncate ${p.taskTitle ? '' : 'text-lh-text-secondary'}`}>
              {p.taskTitle || t('Выбрать задачу')}
            </span>
          </span>
          {p.taskTitle ? (
            <span className="shrink-0 text-sm text-lh-accent">{t('Сменить')}</span>
          ) : (
            <ChevronRight size={ICON.base} className="shrink-0 text-lh-text-secondary" />
          )}
        </button>

        <div className="grid grid-cols-2 gap-3">
          <div className="card p-4">
            <p className="text-2xl font-extralight leading-none tabular-nums">{p.completedToday}</p>
            <p className="mt-2 text-xs text-lh-text-secondary">{t('кругов сегодня')}</p>
          </div>
          <div className="card p-4">
            <p className="text-2xl font-extralight leading-none tabular-nums">{formatFocusTime(p.focusMinToday)}</p>
            <p className="mt-2 text-xs text-lh-text-secondary">{t('фокуса сегодня')}</p>
          </div>
        </div>

        {/* Без уведомлений конец круга в свёрнутом приложении проходит молча —
            таймер это переживёт, человек нет. Тот же баннер, что в семейном чате. */}
        {!pushOn && (
          <div className="flex w-full items-center gap-3 rounded-2xl border border-warning/30 bg-warning/[0.07] px-4 py-2 text-xs leading-snug">
            <BellOff size={ICON.base} className="shrink-0 text-warning" />
            <span className="min-w-0 flex-1 text-lh-text-primary">
              {t('Уведомления выключены — о конце круга в свёрнутом приложении не узнать.')}
            </span>
            <button
              type="button"
              onClick={() => void enableFocusPush()}
              className="flex h-11 shrink-0 items-center px-1 text-sm font-semibold text-lh-accent active:opacity-60"
            >
              {t('Включить')}
            </button>
          </div>
        )}

        {/* Звуки одной карточкой — по скринам Focus To-Do: мелодии конца
            фокуса и конца перерыва разные, у каждой громкость, шум отдельно.
            Списки открываются шитом: пятнадцать мелодий чипами не влезают. */}
        <section>
          <h2 className="lh-section mb-2.5 px-1">{t('Звуки')}</h2>
          <div className="card divide-y divide-lh-border">
            <SoundRow icon={Bell} label={t('Конец фокуса')} value={t(alarmOption(p.alarmWork).label)} onClick={() => setSoundSheet('work')} />
            <SoundRow icon={Coffee} label={t('Конец перерыва')} value={t(alarmOption(p.alarmBreak).label)} onClick={() => setSoundSheet('break')} />
            <SoundRow icon={AudioWaveform} label={t('Фоновый шум')} value={t(noiseLabel(p.sound))} onClick={() => setSoundSheet('noise')} />
            <div className="flex min-h-[52px] items-center gap-3 px-4 py-2">
              <Clock size={ICON.base} className="shrink-0 text-lh-text-secondary" />
              <span className="min-w-0 flex-1">
                <span className="block">{t('Предупредить за 5 минут')}</span>
                <span className="block text-xs text-lh-text-secondary">{t('Уведомление до конца фокуса')}</span>
              </span>
              <Switch checked={p.preNotify} onChange={p.setPreNotify} label={t('Предупредить за 5 минут')} />
            </div>
          </div>
          <p className="mt-1.5 px-1 text-xs leading-snug text-lh-text-secondary">
            {t('Мелодии звучат, пока приложение открыто. В свёрнутом — стандартный сигнал уведомления.')}
          </p>
        </section>

        <section>
          <h2 className="lh-section mb-2.5 px-1">{t('Длительность (мин)')}</h2>
          <div className="card divide-y divide-lh-border">
            <DurationStepper label={t('Фокус')} value={p.workMin} onChange={p.setWorkMin} />
            <DurationStepper label={t('Перерыв')} value={p.breakMin} onChange={p.setBreakMin} />
            <DurationStepper label={t('Длинный перерыв')} value={p.longMin} onChange={p.setLongMin} />
            {/* Было застывшей фразой «после каждых 4 фокусов» — число кругов
                до длинного перерыва теперь своё, как и длительности. */}
            <DurationStepper
              label={t('Кругов до него')}
              hint={t('После скольких кругов — длинный перерыв')}
              value={p.longAfter}
              onChange={p.setLongAfter}
              unit="штук"
              max={8}
            />
          </div>
        </section>

        <section>
          <div className="mb-1 flex items-center justify-between px-1">
            <h2 className="lh-section">{t('Шаблоны')}</h2>
            <button
              type="button"
              onClick={() => setManaging((v) => !v)}
              className="flex h-11 items-center text-sm text-lh-accent active:opacity-60"
            >
              {managing ? t('Готово') : t('Изменить')}
            </button>
          </div>
          <div className="-mx-4 flex gap-2 overflow-x-auto px-4 pb-1 [scrollbar-width:none]">
            {presets.map((pr) => {
              const active = !managing && pr.work === p.workMin && pr.break === p.breakMin && pr.long === p.longMin;
              return (
                <button
                  key={pr.id}
                  type="button"
                  aria-pressed={managing ? undefined : active}
                  onClick={() => (managing ? openEditPreset(pr) : applyPreset(pr))}
                  className={`flex min-h-11 shrink-0 flex-col items-start rounded-xl border px-4 py-2.5 text-left active:opacity-80 ${
                    active ? 'border-lh-accent bg-lh-accent-dim' : 'border-lh-border bg-lh-surface'
                  }`}
                >
                  <span className={`flex max-w-[12rem] items-center gap-1 text-sm ${active ? 'font-semibold text-lh-accent' : ''}`}>
                    {managing && <Pencil size={ICON.inline} className="shrink-0" />}
                    <span className="truncate">{pr.name}</span>
                  </span>
                  <span className="text-2xs tabular-nums text-lh-text-secondary">
                    {t('длинный {n} мин', { n: String(pr.long) })}
                  </span>
                </button>
              );
            })}
            <button
              type="button"
              onClick={openNewPreset}
              className="flex min-h-11 shrink-0 items-center gap-2 whitespace-nowrap rounded-xl border border-dashed border-lh-border-strong px-4 py-2.5 text-sm text-lh-text-secondary active:opacity-70"
            >
              <Plus size={ICON.inline} /> {t('Новый шаблон')}
            </button>
          </div>
        </section>
      </div>

      <Sheet open={pickerOpen} onClose={() => setPickerOpen(false)} title={t('Задача для фокуса')}>
        <div className="flex flex-col">
          <button
            onClick={() => {
              p.setTask(null, null);
              setPickerOpen(false);
            }}
            className="border-b border-lh-border py-3 text-left text-lh-text-secondary active:opacity-60"
          >
            {t('Без задачи')}
          </button>
          {tasks.length === 0 ? (
            <EmptyState icon={ListChecks} title={t('Нет активных задач')} />
          ) : (
            tasks.map((task) => (
              <button
                key={task.id}
                onClick={() => {
                  p.setTask(task.id, task.title);
                  setPickerOpen(false);
                }}
                className="border-b border-lh-border py-3 text-left active:opacity-60"
              >
                {task.title}
              </button>
            ))
          )}
        </div>
      </Sheet>

      <SoundPickerSheet<AlarmType>
        open={soundSheet === 'work' || soundSheet === 'break'}
        onClose={() => setSoundSheet(null)}
        title={soundSheet === 'break' ? t('Конец перерыва') : t('Конец фокуса')}
        items={ALARM_OPTIONS.map((a) => ({ value: a.value, label: a.label, hint: a.seconds ? `0:${String(a.seconds).padStart(2, '0')}` : '—' }))}
        value={soundSheet === 'break' ? p.alarmBreak : p.alarmWork}
        onPick={soundSheet === 'break' ? p.setAlarmBreak : p.setAlarmWork}
        volume={p.alarmVolume}
        onVolume={p.setAlarmVolume}
        volumeLabel={t('Громкость сигнала')}
        note={t('Нажатие — послушать. В свёрнутом приложении на iPhone звучит стандартный сигнал уведомления.')}
      />
      <SoundPickerSheet
        open={soundSheet === 'noise'}
        onClose={() => setSoundSheet(null)}
        title={t('Фоновый шум')}
        items={NOISE_OPTIONS.map((n) => ({ value: n.value, label: n.label }))}
        value={p.sound}
        onPick={p.setSound}
        volume={p.noiseVolume}
        onVolume={p.setNoiseVolume}
        volumeLabel={t('Громкость шума')}
        note={t('Шум идёт во время фокуса. Нажатие — послушать несколько секунд.')}
      />
      {fullscreen && <FocusFullscreen onClose={() => setFullscreen(false)} />}

      <Sheet
        open={presetSheetOpen}
        onClose={() => setPresetSheetOpen(false)}
        title={
          editingPreset && presets.some((x) => x.id === editingPreset.id)
            ? t('Изменить шаблон')
            : t('Новый шаблон')
        }
      >
        {editingPreset && (
          <PresetForm
            key={editingPreset.id}
            initial={editingPreset}
            onSave={savePreset}
            onDelete={
              presets.some((x) => x.id === editingPreset.id)
                ? () => deletePreset(editingPreset.id)
                : undefined
            }
          />
        )}
      </Sheet>
    </Screen>
  );
}
