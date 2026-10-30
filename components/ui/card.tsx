import type { HTMLAttributes } from 'react';
import { cn } from '../../lib/utils/cn';

export function Card({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <section className={cn('rounded-2xl border border-slate-200/80 bg-white/95 shadow-sm shadow-slate-900/[0.03] backdrop-blur-sm transition-shadow dark:border-slate-800/80 dark:bg-slate-900/90 dark:shadow-black/20', className)} {...props} />;
}

export function CardHeader({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('border-b border-slate-100/90 px-4 py-3.5 dark:border-slate-800/80', className)} {...props} />;
}

export function CardContent({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('p-4', className)} {...props} />;
}
