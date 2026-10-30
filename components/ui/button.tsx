import type { ButtonHTMLAttributes } from 'react';
import { cn } from '../../lib/utils/cn';

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: 'sm' | 'md';
}

export function Button({ className, variant = 'primary', size = 'md', ...props }: ButtonProps) {
  const variants: Record<ButtonVariant, string> = {
    primary: 'bg-gradient-to-b from-violet-500 to-violet-600 text-white shadow-sm shadow-violet-600/20 ring-1 ring-inset ring-white/15 hover:from-violet-500 hover:to-violet-500 active:from-violet-600 active:to-violet-700 focus-visible:ring-violet-500',
    secondary: 'border border-slate-200/90 bg-white text-slate-700 shadow-xs hover:border-slate-300 hover:bg-slate-50 active:bg-slate-100 dark:border-slate-700/80 dark:bg-slate-800/90 dark:text-slate-100 dark:hover:border-slate-600 dark:hover:bg-slate-700/90 dark:active:bg-slate-700',
    ghost: 'text-slate-600 hover:bg-slate-100/80 hover:text-slate-900 active:bg-slate-200/70 dark:text-slate-300 dark:hover:bg-slate-800/80 dark:hover:text-white dark:active:bg-slate-700',
    danger: 'bg-gradient-to-b from-rose-500 to-rose-600 text-white shadow-sm shadow-rose-600/20 ring-1 ring-inset ring-white/15 hover:from-rose-500 hover:to-rose-500 active:from-rose-600 active:to-rose-700 focus-visible:ring-rose-500',
  };
  return <button
    className={cn(
      'inline-flex cursor-pointer items-center justify-center gap-1.5 rounded-xl font-medium transition-all duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-400 focus-visible:ring-offset-2 focus-visible:ring-offset-white disabled:pointer-events-none disabled:opacity-50 dark:focus-visible:ring-slate-500 dark:focus-visible:ring-offset-slate-950',
      size === 'sm' ? 'min-h-8 px-3 text-xs' : 'min-h-10 px-4 text-sm',
      variants[variant], className,
    )}
    {...props}
  />;
}
