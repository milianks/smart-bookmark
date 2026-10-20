import type { ReactNode } from 'react';
import { cn } from '../../lib/utils/cn';

type NoticeTone = 'success' | 'error' | 'warning' | 'info';

interface NoticeProps {
  tone?: NoticeTone;
  children: ReactNode;
  className?: string;
}

const tones: Record<NoticeTone, { role: 'status' | 'alert'; className: string }> = {
  success: {
    role: 'status',
    className: 'border-emerald-200 bg-emerald-50 text-emerald-800 dark:border-emerald-900 dark:bg-emerald-950/50 dark:text-emerald-200',
  },
  error: {
    role: 'alert',
    className: 'border-rose-200 bg-rose-50 text-rose-800 dark:border-rose-900 dark:bg-rose-950/50 dark:text-rose-200',
  },
  warning: {
    role: 'status',
    className: 'border-amber-200 bg-amber-50 text-amber-900 dark:border-amber-900 dark:bg-amber-950/50 dark:text-amber-200',
  },
  info: {
    role: 'status',
    className: 'border-slate-200 bg-slate-50 text-slate-700 dark:border-slate-800 dark:bg-slate-900 dark:text-slate-200',
  },
};

export function Notice({ tone = 'info', children, className }: NoticeProps) {
  const config = tones[tone];
  return <p role={config.role} className={cn('rounded-xl border px-3 py-2 text-xs leading-5', config.className, className)}>{children}</p>;
}
