import type { HTMLAttributes } from 'react';
import { cn } from '../../lib/utils/cn';

export function Skeleton({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div aria-hidden="true" className={cn('animate-pulse rounded-xl bg-slate-100 motion-reduce:animate-none dark:bg-slate-800', className)} {...props} />;
}
