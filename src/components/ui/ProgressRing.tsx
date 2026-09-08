interface Props {
  /** 0..100 */
  value: number;
  size?: number;
  strokeWidth?: number;
  color?: string;
  /** текст в центре; по умолчанию «NN%» */
  label?: string;
}

export function ProgressRing({
  value,
  size = 56,
  strokeWidth = 5,
  color = 'var(--app-accent)',
  label,
}: Props) {
  const r = (size - strokeWidth) / 2;
  const circumference = 2 * Math.PI * r;
  // NaN тоже зажимаем в ноль.
  //
  // Math.min/max с NaN дают NaN, он уезжает в strokeDashoffset, и React ругается
  // «Received NaN for the strokeDashoffset attribute», а кольцо рисуется пустым
  // ободом без объяснения. Приходит NaN оттуда, где делят на ноль: цель без
  // измеримого показателя, проект без задач, привычка без плана. Виноват не
  // компонент, но падать на его глазах он не обязан — ноль честнее NaN.
  const clamped = Number.isFinite(value) ? Math.max(0, Math.min(100, value)) : 0;
  return (
    <div className="relative shrink-0" style={{ width: size, height: size }}>
      <svg width={size} height={size} className="-rotate-90">
        <circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill="none"
          stroke="var(--app-surface-2)"
          strokeWidth={strokeWidth}
        />
        <circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill="none"
          stroke={color}
          strokeWidth={strokeWidth}
          strokeLinecap="round"
          strokeDasharray={circumference}
          strokeDashoffset={circumference * (1 - clamped / 100)}
          style={{ filter: clamped > 0 ? `drop-shadow(0 0 3px ${color})` : undefined }}
          className="transition-[stroke-dashoffset] duration-500 ease-out"
        />
      </svg>
      <span className="absolute inset-0 flex items-center justify-center text-xs font-bold">
        {label ?? `${Math.round(clamped)}%`}
      </span>
    </div>
  );
}
