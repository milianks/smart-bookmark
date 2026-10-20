import type { ButtonHTMLAttributes } from 'react';
import { cn } from '../../lib/utils/cn';

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: 'sm' | 'md';
}

export function Button({ className, variant = 'primary', size = 'md', ...props }: ButtonProps) {
  const variants: Record<ButtonVariant, string> = {
    primary: 'bg-violet-600 text-white shadow-sm hover:bg-violet-500 active:bg-violet-700 focus-visible:ring-violet-500',
    secondary: 'border border-slate-200 bg-white text-slate-800 shadow-sm hover:bg-slate-50 active:bg-slate-100 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-100 dark:hover:bg-slate-700 dark:active:bg-slate-600',
    ghost: 'text-slate-600 hover:bg-slate-100 active:bg-slate-200 dark:text-slate-300 dark:hover:bg-slate-800 dark:active:bg-slate-700',
    danger: 'bg-rose-600 text-white shadow-sm hover:bg-rose-500 active:bg-rose-700 focus-visible:ring-rose-500',
  };
  return <button
    className={cn(
      'inline-flex items-center justify-center gap-2 rounded-xl font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-400 focus-visible:ring-offset-2 focus-visible:ring-offset-white disabled:pointer-events-none disabled:opacity-50 dark:focus-visible:ring-slate-500 dark:focus-visible:ring-offset-slate-950',
      size === 'sm' ? 'min-h-8 px-3 text-xs' : 'min-h-10 px-4 text-sm',
      variants[variant], className,
    )}
    {...props}
  />;
}
