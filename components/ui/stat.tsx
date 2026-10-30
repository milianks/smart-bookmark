import type { ReactNode } from 'react';
import { cn } from '../../lib/utils/cn';

type StatTone = 'neutral' | 'primary' | 'warning' | 'success';

interface StatProps {
  label: string;
  value: ReactNode;
  hint?: ReactNode;
  href?: string;
  onClick?: () => void;
  tone?: StatTone;
  className?: string;
}

const valueTones: Record<StatTone, string> = {
  neutral: 'text-slate-900 dark:text-slate-100',
  primary: 'text-violet-700 dark:text-violet-300',
  warning: 'text-amber-700 dark:text-amber-300',
  success: 'text-emerald-700 dark:text-emerald-300',
};

const cardTones: Record<StatTone, string> = {
  neutral: 'border-slate-200/70 bg-slate-50/70 dark:border-slate-800/80 dark:bg-slate-950/50',
  primary: 'border-violet-200/80 bg-gradient-to-br from-violet-50/90 to-indigo-50/50 dark:border-violet-800/60 dark:from-violet-950/50 dark:to-indigo-950/30',
  warning: 'border-amber-200/80 bg-amber-50/70 dark:border-amber-800/60 dark:bg-amber-950/40',
  success: 'border-emerald-200/80 bg-emerald-50/70 dark:border-emerald-800/60 dark:bg-emerald-950/40',
};

export function Stat({ label, value, hint, href, onClick, tone = 'neutral', className }: StatProps) {
  const interactive = Boolean(href || onClick);
  const classes = cn(
    'group flex min-w-0 flex-col gap-1 rounded-xl border px-3 py-2.5 transition-all duration-150',
    cardTones[tone],
    interactive && 'cursor-pointer hover:-translate-y-0.5 hover:border-violet-300 hover:bg-violet-50/80 hover:shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-500 focus-visible:ring-offset-2 focus-visible:ring-offset-white dark:hover:border-violet-700 dark:hover:bg-violet-950/60 dark:focus-visible:ring-offset-slate-950',
    onClick && 'text-left',
    className,
  );
  const content = <>
    <span className="flex items-center justify-between gap-1 truncate text-[11px] font-medium text-slate-500 dark:text-slate-400">
      <span className="truncate">{label}</span>
      {interactive && <span aria-hidden="true" className="text-violet-500 transition-transform group-hover:translate-x-0.5 dark:text-violet-400">→</span>}
    </span>
    <span className={cn('truncate text-sm font-semibold tracking-tight', valueTones[tone])}>{value}</span>
    {hint && <span className="truncate text-[11px] leading-4 text-slate-500 dark:text-slate-400">{hint}</span>}
  </>;
  if (onClick) return <button type="button" onClick={onClick} className={classes}>{content}</button>;
  return href ? <a href={href} className={classes}>{content}</a> : <div className={classes}>{content}</div>;
}
