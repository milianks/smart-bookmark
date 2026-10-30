import type { HTMLAttributes } from 'react';
import { cn } from '../../lib/utils/cn';

export type BadgeTone = 'neutral' | 'primary' | 'success' | 'warning' | 'danger';

interface BadgeProps extends HTMLAttributes<HTMLSpanElement> {
  tone?: BadgeTone;
}

const tones: Record<BadgeTone, string> = {
  neutral: 'border border-slate-200/80 bg-slate-100/80 text-slate-600 dark:border-slate-700/70 dark:bg-slate-800/80 dark:text-slate-300',
  primary: 'border border-violet-200/80 bg-violet-50 text-violet-700 dark:border-violet-800/60 dark:bg-violet-950/70 dark:text-violet-300',
  success: 'border border-emerald-200/80 bg-emerald-50 text-emerald-700 dark:border-emerald-800/60 dark:bg-emerald-950/70 dark:text-emerald-300',
  warning: 'border border-amber-200/80 bg-amber-50 text-amber-800 dark:border-amber-800/60 dark:bg-amber-950/70 dark:text-amber-300',
  danger: 'border border-rose-200/80 bg-rose-50 text-rose-700 dark:border-rose-800/60 dark:bg-rose-950/70 dark:text-rose-300',
};

export function Badge({ className, tone = 'neutral', ...props }: BadgeProps) {
  return <span className={cn('inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-[11px] font-medium tracking-tight', tones[tone], className)} {...props} />;
}
