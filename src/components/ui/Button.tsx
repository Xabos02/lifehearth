import type { ButtonHTMLAttributes } from 'react';

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger';

const styles: Record<Variant, string> = {
  primary: 'bg-lh-accent text-lh-bg active:opacity-90',
  secondary: 'bg-lh-surface-2 text-lh-text-primary border border-lh-border active:opacity-80',
  ghost: 'bg-transparent text-lh-accent active:opacity-60',
  danger: 'bg-danger/15 text-danger active:opacity-80',
};

interface Props extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
}

export function Button({ variant = 'primary', className = '', ...props }: Props) {
  return (
    <button
      className={`rounded-lh-btn px-4 py-3 font-semibold transition-[transform,opacity] duration-150 active:scale-[0.98] disabled:opacity-40 disabled:active:scale-100 ${styles[variant]} ${className}`}
      {...props}
    />
  );
}
