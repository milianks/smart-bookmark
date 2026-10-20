import type { ReactNode } from 'react';
import { cn } from '../../lib/utils/cn';

interface SwitchProps {
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  label: string;
  disabled?: boolean;
  className?: string;
  title?: ReactNode;
  description?: ReactNode;
}

export function Switch({ checked, onCheckedChange, label, disabled, className, title, description }: SwitchProps) {
  const track = <span
    aria-hidden="true"
    className={cn(
      'relative inline-flex h-7 w-12 shrink-0 items-center rounded-full transition-colors',
      checked ? 'bg-violet-600' : 'bg-slate-300 dark:bg-slate-700',
    )}
  >
    <span
      className={cn(
        'absolute left-1 size-5 rounded-full bg-white shadow transition-transform duration-150 ease-out motion-reduce:transition-none',
        checked ? 'translate-x-5' : 'translate-x-0',
      )}
    />
  </span>;

  if (title !== undefined) return <button
    type="button"
    role="switch"
    aria-checked={checked}
    aria-label={label}
    disabled={disabled}
    onClick={() => onCheckedChange(!checked)}
    className={cn(
      'flex w-full items-center justify-between gap-4 rounded-xl py-1 text-left transition-colors hover:bg-slate-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-500 focus-visible:ring-offset-2 focus-visible:ring-offset-white disabled:pointer-events-none disabled:opacity-60 dark:hover:bg-slate-800/60 dark:focus-visible:ring-offset-slate-950',
      className,
    )}
  >
    <span className="min-w-0">
      <span className="block text-sm font-medium text-slate-900 dark:text-slate-100">{title}</span>
      {description && <span className="mt-1 block text-xs leading-5 text-slate-500 dark:text-slate-400">{description}</span>}
    </span>
    {track}
  </button>;

  return <button
    type="button"
    role="switch"
    aria-checked={checked}
    aria-label={label}
    disabled={disabled}
    onClick={() => onCheckedChange(!checked)}
    className={cn(
      'inline-flex shrink-0 rounded-full transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-500 focus-visible:ring-offset-2 focus-visible:ring-offset-white disabled:pointer-events-none disabled:opacity-50 dark:focus-visible:ring-offset-slate-950',
      className,
    )}
  >
    {track}
  </button>;
}
