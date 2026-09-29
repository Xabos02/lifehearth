interface Props {
  /** 0..100 */
  value: number;
  color?: string;
}

export function ProgressBar({ value, color = 'var(--lh-accent)' }: Props) {
  const clamped = Math.max(0, Math.min(100, value));
  return (
    <div className="h-1.5 w-full overflow-hidden rounded-full bg-lh-border-strong">
      <div
        className="h-full rounded-full transition-[width] duration-300"
        style={{ width: `${clamped}%`, background: color }}
      />
    </div>
  );
}
