import type { ReactNode } from 'react';
import { cn } from '../../lib/utils/cn';

type NoticeTone = 'success' | 'error' | 'warning' | 'info';

interface NoticeProps {
  tone?: NoticeTone;
  children: ReactNode;
  className?: string;
}

const tones: Record<NoticeTone, { role: 'status' | 'alert'; className: string; dotClass: string }> = {
  success: {
    role: 'status',
    className: 'border-emerald-200/90 bg-emerald-50/90 text-emerald-900 dark:border-emerald-800/70 dark:bg-emerald-950/60 dark:text-emerald-200',
    dotClass: 'bg-emerald-500',
  },
  error: {
    role: 'alert',
    className: 'border-rose-200/90 bg-rose-50/90 text-rose-900 dark:border-rose-800/70 dark:bg-rose-950/60 dark:text-rose-200',
    dotClass: 'bg-rose-500',
  },
  warning: {
    role: 'status',
    className: 'border-amber-200/90 bg-amber-50/90 text-amber-900 dark:border-amber-800/70 dark:bg-amber-950/60 dark:text-amber-200',
    dotClass: 'bg-amber-500',
  },
  info: {
    role: 'status',
    className: 'border-violet-200/70 bg-violet-50/60 text-slate-700 dark:border-violet-900/60 dark:bg-violet-950/40 dark:text-slate-200',
    dotClass: 'bg-violet-500',
  },
};

export function Notice({ tone = 'info', children, className }: NoticeProps) {
  const config = tones[tone];
  return <p role={config.role} className={cn('flex items-start gap-2.5 rounded-xl border px-3.5 py-2.5 text-xs font-medium leading-5 shadow-2xs', config.className, className)}>
    <span aria-hidden="true" className={cn('mt-1.5 size-2 shrink-0 rounded-full', config.dotClass)} />
    <span className="min-w-0 flex-1">{children}</span>
  </p>;
}
