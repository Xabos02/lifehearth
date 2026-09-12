import { useRef, useState, type CSSProperties, type PointerEvent } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import {
  BellOff,
  ListChecks,
  SkipForward,
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
import { getLang, t } from '../../lib/i18n';
import { Screen } from '../../components/layout/Screen';
import { Sheet } from '../../components/ui/Sheet';
import { Chip, ChipRow } from '../../components/ui/Chip';
import { EmptyState } from '../../components/ui/EmptyState';
import {
  formatClock,
  formatFocusTime,
  usePomodoro,
  type Phase,
  type SoundType,
} from './pomodoro';
import { ICON } from '../../components/ui/icons';
import { HIT_SLOP_44 } from '../../components/ui/hitSlop';
import { ALARM_OPTIONS } from './alarms';
import { enablePush, isStandalone, pushEnabled, pushSupported } from '../../lib/push';
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

// Фоновый шум на время работы. Не путать с сигналом конца круга (ALARM_OPTIONS):
// раньше ряд назывался «Звук фокуса», и владелец искал в нём выбор сигнала.
const SOUNDS: { value: SoundType; label: string }[] = [
  { value: 'none', label: 'Тишина' },
  { value: 'white', label: 'Белый' },
  { value: 'pink', label: 'Розовый' },
  { value: 'brown', label: 'Коричневый' },
  { value: 'rain', label: 'Дождь' },
];

const R = 130;
const STROKE = 12;
const CIRC = 2 * Math.PI * R;
const MAX_MIN = 90; // базовый максимум круга (растёт под бо́льшие значения)
const STEP_MIN = 5; // шаг при перетаскивании кольца

// Перекрытие акцента приложения тёплой гаммой Focus To-Do — только в пределах
// экрана «Фокус»: кнопка, чипы, иконки и метка фазы наследуют его автоматически.
const FOCUS_VARS = {
  '--app-accent': 'var(--focus-accent)',
  '--app-accent-2': 'var(--focus-accent-2)',
  // Заливки перекрываем отдельно: они живут в своих токенах, и без этой пары
  // кнопка «Фокуса» брала бы общий синий вместо тёплого — весь смысл
  // перекрытия пропадает.
  '--app-accent-fill': 'var(--focus-accent-fill)',
  '--app-accent-2-fill': 'var(--focus-accent-2-fill)',
  '--shadow-accent': 'var(--shadow-focus)',
} as unknown as CSSProperties;

// Пара степперов в ряд физически не влезает на узкий телефон: min-content одного
// степпера ≈ 178px (p-3 + две кнопки 44px + поле + gap), пары с gap-3 — ≈ 370px,
// а колонка контента это (ширина вьюпорта − 34px). На 320–390px правый степпер
// уезжал за экран вместе с кнопкой «+», и из-за overflow-x:hidden у #app-scroll
// до неё нельзя было доскроллить — длительность перерыва не менялась в принципе.
// Ниже 400px строим степперы столбиком: каждому достаётся вся ширина.
const STEPPER_PAIR = 'flex flex-col gap-3 min-[400px]:flex-row';

/** Поле числа: шаг ±1 кнопками и ввод любого значения. Длительности — без
 *  верхнего предела; у кругов до длинного перерыва предел есть (max). */
function DurationStepper({
  label,
  value,
  onChange,
  unit = 'минут',
  max = Infinity,
}: {
  label: string;
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

  // Кнопки ± — size-11 (46.75px при базовых 17px), это минимум 44×44 по HIG;
  // поле растягивается на остаток (min-w-0), поэтому степпер сжимается по ширине
  // родителя, а не задаёт ему жёсткий min-content. flex-1 нужен только в ряду —
  // в колонке степпер и так растянут по ширине (align-items: stretch).
  return (
    <div className="min-w-0 rounded-2xl bg-surface-2 p-3 min-[400px]:flex-1">
      <p className="mb-2 text-center text-xs text-muted">{label}</p>
      <div className="flex items-center justify-between gap-1">
        <button
          type="button"
          aria-label={t('{label}: меньше', { label })}
          onClick={() => onChange(Math.max(1, value - 1))}
          className="flex size-11 shrink-0 items-center justify-center rounded-full border border-border text-lg text-muted active:scale-90"
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
            if (raw !== '' && n >= 1) onChange(Math.min(max, n));
          }}
          onBlur={() => {
            const n = parseInt(text, 10);
            if (!Number.isFinite(n) || n < 1) setText(String(value));
          }}
          className="min-w-0 flex-1 rounded-lg bg-transparent text-center text-2xl font-bold tabular-nums outline-none focus-visible:ring-2 focus-visible:ring-accent/60"
        />
        <button
          type="button"
          aria-label={t('{label}: больше', { label })}
          onClick={() => onChange(Math.min(max, value + 1))}
          disabled={value >= max}
          className="flex size-11 shrink-0 items-center justify-center rounded-full border border-border text-lg text-muted active:scale-90 disabled:opacity-40"
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
        <p className="mb-2 px-1 text-sm font-medium text-muted">{t('Название')}</p>
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder={fallbackName}
          className="w-full rounded-2xl bg-surface-2 px-4 py-3 text-base outline-none transition-[box-shadow] placeholder:text-muted focus-visible:ring-2 focus-visible:ring-accent/60"
        />
      </div>
      <div>
        <p className="mb-2 px-1 text-sm font-medium text-muted">{t('Длительность (мин)')}</p>
        <div className={STEPPER_PAIR}>
          <DurationStepper label={t('Фокус')} value={work} onChange={setWork} />
          <DurationStepper label={t('Перерыв')} value={brk} onChange={setBrk} />
        </div>
        <div className={`mt-3 ${STEPPER_PAIR}`}>
          <DurationStepper label={t('Длинный перерыв')} value={long} onChange={setLong} />
          {/* Добор половины строки только в ряду; в колонке пустой блок не нужен. */}
          <div className="hidden min-[400px]:block min-[400px]:flex-1" />
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
          className="flex items-center justify-center gap-1.5 rounded-2xl border border-border py-3 text-center font-medium text-danger active:opacity-70"
        >
          <Trash2 size={ICON.action} /> {t('Удалить')}
        </button>
      )}
    </div>
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
      className="mb-4 flex items-center gap-2"
    >
      {Array.from({ length: total }, (_, i) => (
        <span
          key={i}
          className="size-2.5 rounded-full"
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
  const [pushOn, setPushOn] = useState(() => pushEnabled());

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
    if (!res.ok) {
      toast(res.reason === 'denied' ? t('Разрешение не выдано. Включите в настройках устройства.') : t('Не удалось включить уведомления. Проверьте разрешения в настройках устройства'));
      return;
    }
    setPushOn(true);
  }
  const [pickerOpen, setPickerOpen] = useState(false);
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
  const tasks = alive(useLiveQuery(() => db.tasks.toArray(), []) ?? []).filter(
    (task) => !task.completedAt,
  );

  const isWork = p.phase === 'work';
  // Метка фазы и «ручка» слайдера — сплошной цвет (акцент перекрыт тёплым ниже
  // по дереву); сама дуга в фокусе — красно-оранжевый градиент Focus To-Do.
  const accentColor = isWork ? 'var(--app-accent)' : 'var(--app-success)';
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
    const max = Math.max(MAX_MIN, p.workMin);
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
    if (Math.abs(distFromCenter(e.clientX, e.clientY) - R) > STROKE * 2) return;
    dragging.current = true;
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
    <Screen title={t('Фокус')} backTo="/home">
      <div className="flex flex-col items-center" style={FOCUS_VARS}>
        <p className="mb-2 text-sm font-semibold" style={{ color: accentColor }}>
          {t(PHASE_LABEL[p.phase])}
        </p>
        <CycleDots done={p.cycle.done} total={p.cycle.total} color={accentColor} />

        <div className="relative">
          <svg
            ref={svgRef}
            viewBox="0 0 300 300"
            className="w-64 max-w-[72vw]"
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
                r={13}
                fill={accentColor}
                stroke="var(--app-bg)"
                strokeWidth={3}
              />
            )}
          </svg>
          <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center">
            <span className="text-5xl font-bold tabular-nums tracking-tight">
              {formatClock(p.remainingMs)}
            </span>
            {p.taskTitle ? (
              <span className="mt-1 max-w-[60%] truncate text-sm text-muted">{p.taskTitle}</span>
            ) : idleWork ? (
              <span className="mt-1 text-xs text-muted">{t('крутите кольцо ↻')}</span>
            ) : null}
          </div>
        </div>

        <div className="mt-8 flex items-center gap-4">
          <button
            onClick={p.reset}
            aria-label={t('Сбросить')}
            className="flex size-12 items-center justify-center rounded-full border border-border text-muted active:scale-90"
          >
            <RotateCcw size={ICON.header} />
          </button>
          <button
            onClick={p.running ? p.toggle : () => (p.active ? p.toggle() : p.start())}
            aria-label={p.running ? t('Пауза') : t('Старт')}
            style={{
              backgroundImage: 'linear-gradient(150deg, var(--focus-accent-fill), var(--focus-accent-2-fill))',
              boxShadow: 'var(--shadow-focus)',
            }}
            className="flex size-20 items-center justify-center rounded-full text-white active:scale-90"
          >
            {p.running ? <Pause size={ICON.hero} fill="currentColor" /> : <Play size={ICON.hero} fill="currentColor" className="ml-1" />}
          </button>
          <button
            onClick={p.skip}
            disabled={!p.active}
            aria-label={isWork ? t('Завершить круг') : t('Пропустить перерыв')}
            className="flex size-12 items-center justify-center rounded-full border border-border text-muted active:scale-90 disabled:opacity-40"
          >
            <SkipForward size={ICON.header} />
          </button>
        </div>

        {/* Выбор задачи фокуса */}
        <button
          onClick={() => setPickerOpen(true)}
          className="card mt-8 flex w-full items-center gap-3 px-4 py-3 active:opacity-80"
        >
          <ListChecks size={ICON.header} className="shrink-0 text-accent" />
          <span className={`min-w-0 flex-1 truncate text-left ${p.taskTitle ? '' : 'text-muted'}`}>
            {p.taskTitle || t('Выбрать задачу')}
          </span>
          <ChevronRight size={ICON.base} className="shrink-0 text-muted" />
        </button>

        <div className="mt-6 w-full">
          <p className="mb-2 px-1 text-sm font-medium text-muted">{t('Сигнал в конце круга')}</p>
          <ChipRow>
            {ALARM_OPTIONS.map((a) => (
              <Chip key={a.value} active={p.alarm === a.value} onClick={() => p.setAlarm(a.value)}>
                {t(a.label)}
              </Chip>
            ))}
          </ChipRow>
          {/* Честно про границу: в свёрнутом PWA на iPhone своего звука нет —
              конец круга приходит фоновым пушем со стандартным звуком системы. */}
          <p className="mt-1.5 px-1 text-xs leading-snug text-muted">
            {t('Нажатие на вариант — проиграть. В свёрнутом приложении звучит стандартный сигнал уведомления.')}
          </p>
        </div>

        <div className="mt-6 w-full">
          <p className="mb-2 px-1 text-sm font-medium text-muted">{t('Фоновый шум')}</p>
          <ChipRow>
            {SOUNDS.map((sd) => (
              <Chip key={sd.value} active={p.sound === sd.value} onClick={() => p.setSound(sd.value)}>
                {t(sd.label)}
              </Chip>
            ))}
          </ChipRow>
        </div>

        <div className="mt-6 w-full">
          <p className="mb-2 px-1 text-sm font-medium text-muted">{t('Длительность (мин)')}</p>
          <div className={STEPPER_PAIR}>
            <DurationStepper label={t('Фокус')} value={p.workMin} onChange={p.setWorkMin} />
            <DurationStepper label={t('Перерыв')} value={p.breakMin} onChange={p.setBreakMin} />
          </div>
          <div className={`mt-3 ${STEPPER_PAIR}`}>
            <DurationStepper label={t('Длинный перерыв')} value={p.longMin} onChange={p.setLongMin} />
            {/* Было застывшей фразой «после каждых 4 фокусов» — число кругов
                до длинного перерыва теперь своё, как и длительности. */}
            <DurationStepper label={t('Кругов до него')} value={p.longAfter} onChange={p.setLongAfter} unit="штук" max={8} />
          </div>
          <div className="mb-2 mt-5 flex items-center justify-between px-1">
            <p className="text-sm font-medium text-muted">{t('Шаблоны')}</p>
            <button
              onClick={() => setManaging((v) => !v)}
              className={`text-sm font-medium text-accent active:opacity-60 ${HIT_SLOP_44}`}
            >
              {managing ? t('Готово') : t('Изменить')}
            </button>
          </div>
          <ChipRow>
            {presets.map((pr) => (
              <Chip
                key={pr.id}
                active={
                  !managing && pr.work === p.workMin && pr.break === p.breakMin && pr.long === p.longMin
                }
                onClick={() => (managing ? openEditPreset(pr) : applyPreset(pr))}
              >
                <span className="flex items-center gap-1">
                  {managing && <Pencil size={ICON.inline} />}
                  {pr.name}
                </span>
              </Chip>
            ))}
            <button
              onClick={openNewPreset}
              className={`flex shrink-0 items-center gap-1 whitespace-nowrap rounded-full border border-dashed border-border px-3.5 py-1.5 text-sm font-medium text-muted active:opacity-70 ${HIT_SLOP_44}`}
            >
              <Plus size={ICON.inline} /> {t('Шаблон')}
            </button>
          </ChipRow>
        </div>

        <div className="mt-8 flex w-full gap-3">
          <div className="flex-1 rounded-2xl bg-surface-2 p-3 text-center">
            <p className="text-2xl font-bold">{p.completedToday}</p>
            <p className="text-xs text-muted">{t('кругов сегодня')}</p>
          </div>
          <div className="flex-1 rounded-2xl bg-surface-2 p-3 text-center">
            <p className="text-2xl font-bold">{formatFocusTime(p.focusMinToday)}</p>
            <p className="text-xs text-muted">{t('фокуса сегодня')}</p>
          </div>
        </div>

        {/* Без уведомлений конец круга в свёрнутом приложении проходит молча —
            таймер это переживёт, человек нет. Тот же баннер, что в семейном чате. */}
        {!pushOn && (
          <div className="mt-3 flex w-full items-start gap-2 rounded-xl border border-hairline bg-bg px-3 py-2.5 text-sm leading-snug">
            <BellOff size={ICON.base} className="mt-0.5 shrink-0 text-warning" />
            <span className="min-w-0 flex-1 text-muted">
              {t('Уведомления выключены — о конце круга в свёрнутом приложении не узнать.')}{' '}
              <button
                onClick={() => void enableFocusPush()}
                className={`font-semibold text-accent active:opacity-60 ${HIT_SLOP_44}`}
              >
                {/* «Включить» в словаре занято звуком чата ('Unmute') — тот же
                    обход, что в семейном чате. */}
                {getLang() === 'en' ? 'Turn on' : 'Включить'}
              </button>
            </span>
          </div>
        )}
      </div>

      <Sheet open={pickerOpen} onClose={() => setPickerOpen(false)} title={t('Задача для фокуса')}>
        <div className="flex flex-col">
          <button
            onClick={() => {
              p.setTask(null, null);
              setPickerOpen(false);
            }}
            className="border-b border-hairline py-3 text-left text-muted active:opacity-60"
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
                className="border-b border-hairline py-3 text-left active:opacity-60"
              >
                {task.title}
              </button>
            ))
          )}
        </div>
      </Sheet>

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
