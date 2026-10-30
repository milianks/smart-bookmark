import type { ReactNode } from 'react';
import { cn } from '../../lib/utils/cn';

interface DisclosureProps {
  title: string;
  description?: ReactNode;
  meta?: ReactNode;
  defaultOpen?: boolean;
  children: ReactNode;
  className?: string;
  contentClassName?: string;
}

export function Disclosure({ title, description, meta, defaultOpen, children, className, contentClassName }: DisclosureProps) {
  return <details open={defaultOpen} className={cn('group', className)}>
    <summary className="flex cursor-pointer list-none items-center justify-between gap-3 rounded-xl px-1 py-1 text-sm font-semibold text-slate-900 transition-colors hover:text-violet-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-500 focus-visible:ring-offset-2 focus-visible:ring-offset-white dark:text-slate-100 dark:hover:text-violet-300 dark:focus-visible:ring-offset-slate-950 [&::-webkit-details-marker]:hidden">
      <span className="min-w-0">
        <span className="block tracking-tight">{title}</span>
        {description && <span className="mt-0.5 block text-xs font-normal leading-5 text-slate-500 dark:text-slate-400">{description}</span>}
      </span>
      <span className="flex shrink-0 items-center gap-2">
        {meta}
        <span aria-hidden="true" className="inline-flex size-6 items-center justify-center rounded-lg bg-slate-100/80 text-slate-500 transition-all duration-150 ease-out group-hover:bg-violet-50 group-hover:text-violet-600 group-open:rotate-180 motion-reduce:transition-none dark:bg-slate-800 dark:text-slate-400 dark:group-hover:bg-violet-950/60 dark:group-hover:text-violet-300">
          <svg viewBox="0 0 16 16" fill="none" className="size-3.5" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
            <path d="M4 6l4 4 4-4" />
          </svg>
        </span>
      </span>
    </summary>
    <div className={cn('scroll-region mt-3.5 max-h-56 overflow-y-auto overscroll-contain border-t border-slate-100 pr-1 pt-3.5 dark:border-slate-800/80', contentClassName)}>
      {children}
    </div>
  </details>;
}
