import type { ReactNode } from 'react';
import { cn } from '../../lib/utils/cn';

type StatTone = 'neutral' | 'primary' | 'warning' | 'success';

interface StatProps {
  label: string;
  value: ReactNode;
  hint?: ReactNode;
  href?: string;
  tone?: StatTone;
  className?: string;
}

const valueTones: Record<StatTone, string> = {
  neutral: 'text-slate-900 dark:text-slate-100',
  primary: 'text-violet-700 dark:text-violet-300',
  warning: 'text-amber-700 dark:text-amber-300',
  success: 'text-emerald-700 dark:text-emerald-300',
};

export function Stat({ label, value, hint, href, tone = 'neutral', className }: StatProps) {
  const classes = cn(
    'flex min-w-0 flex-col gap-1 rounded-xl border border-slate-100 bg-slate-50/80 px-2.5 py-2 transition-colors dark:border-slate-800 dark:bg-slate-950/50',
    href && 'hover:border-violet-200 hover:bg-violet-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-500 focus-visible:ring-offset-2 focus-visible:ring-offset-white dark:hover:border-violet-800 dark:hover:bg-violet-950/40 dark:focus-visible:ring-offset-slate-950',
    className,
  );
  const content = <>
    <span className="truncate text-[11px] font-medium text-slate-500 dark:text-slate-400">{label}</span>
    <span className={cn('truncate text-sm font-semibold', valueTones[tone])}>{value}</span>
    {hint && <span className="truncate text-[11px] leading-4 text-slate-500 dark:text-slate-400">{hint}</span>}
  </>;
  return href ? <a href={href} className={classes}>{content}</a> : <div className={classes}>{content}</div>;
}
