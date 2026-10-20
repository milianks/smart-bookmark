import type { ReactNode } from 'react';
import { cn } from '../../lib/utils/cn';

interface DisclosureProps {
  title: string;
  description?: ReactNode;
  meta?: ReactNode;
  defaultOpen?: boolean;
  children: ReactNode;
  className?: string;
}

export function Disclosure({ title, description, meta, defaultOpen, children, className }: DisclosureProps) {
  return <details open={defaultOpen} className={cn('group', className)}>
    <summary className="flex cursor-pointer list-none items-center justify-between gap-3 rounded-lg py-1 text-sm font-semibold text-slate-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-500 focus-visible:ring-offset-2 focus-visible:ring-offset-white dark:text-slate-100 dark:focus-visible:ring-offset-slate-950 [&::-webkit-details-marker]:hidden">
      <span className="min-w-0">
        <span className="block">{title}</span>
        {description && <span className="mt-1 block text-xs font-normal leading-5 text-slate-500 dark:text-slate-400">{description}</span>}
      </span>
      <span className="flex shrink-0 items-center gap-2">
        {meta}
        <span aria-hidden="true" className="text-xs text-slate-400 transition-transform duration-150 ease-out group-open:rotate-180 motion-reduce:transition-none">▾</span>
      </span>
    </summary>
    <div className="mt-3">{children}</div>
  </details>;
}
