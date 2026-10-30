import type { InputHTMLAttributes, ReactNode, SelectHTMLAttributes, TextareaHTMLAttributes } from 'react';
import { cn } from '../../lib/utils/cn';

interface FieldProps {
  label: string;
  hint?: ReactNode;
  children: ReactNode;
}

export function Field({ label, hint, children }: FieldProps) {
  return <label className="grid gap-1.5 text-sm font-medium text-slate-800 dark:text-slate-100">
    <span className="tracking-tight">{label}</span>
    {children}
    {hint && <span className="text-xs font-normal leading-5 text-slate-500 dark:text-slate-400">{hint}</span>}
  </label>;
}

const controlClass = 'min-h-10 w-full rounded-xl border border-slate-200/90 bg-slate-50/50 px-3.5 text-sm text-slate-900 shadow-2xs outline-none transition-all placeholder:text-slate-400 hover:border-slate-300 focus:border-violet-500 focus:bg-white focus:ring-3 focus:ring-violet-500/15 disabled:opacity-60 dark:border-slate-700/80 dark:bg-slate-950/70 dark:text-slate-100 dark:placeholder:text-slate-500 dark:hover:border-slate-600 dark:focus:border-violet-400 dark:focus:bg-slate-950 dark:focus:ring-violet-500/20';

export function Input({ className, ...props }: InputHTMLAttributes<HTMLInputElement>) {
  return <input className={cn(controlClass, className)} {...props} />;
}

export function Select({ className, ...props }: SelectHTMLAttributes<HTMLSelectElement>) {
  return <select className={cn(controlClass, 'pr-8', className)} {...props} />;
}

export function Textarea({ className, ...props }: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea className={cn(controlClass, 'min-h-24 py-2.5', className)} {...props} />;
}
