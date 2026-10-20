import { useId, useLayoutEffect, useRef, useState } from 'react';
import type { FocusEvent, HTMLAttributes, KeyboardEvent, PointerEvent } from 'react';
import { createPortal } from 'react-dom';
import { cn } from '../../lib/utils/cn';
import { computeTooltipPosition } from './tooltip-position';

interface TruncatedTextProps extends HTMLAttributes<HTMLParagraphElement> {
  text: string;
}

const TOOLTIP_GAP = 8;
const TOOLTIP_MARGIN = 8;

export function TruncatedText({
  text,
  className,
  tabIndex: _tabIndex,
  'aria-describedby': _ariaDescribedBy,
  onPointerEnter,
  onPointerLeave,
  onFocus,
  onBlur,
  onKeyDown,
  ...props
}: TruncatedTextProps) {
  const textRef = useRef<HTMLParagraphElement>(null);
  const tooltipRef = useRef<HTMLDivElement>(null);
  const tooltipId = useId();
  const [isTruncated, setIsTruncated] = useState(false);
  const [isOpen, setIsOpen] = useState(false);
  const [position, setPosition] = useState<{ top: number; left: number } | null>(null);

  useLayoutEffect(() => {
    const element = textRef.current;
    if (!element) return;

    const measure = () => {
      if (element.clientWidth === 0) return;
      const nextIsTruncated = element.scrollWidth > element.clientWidth + 1;
      setIsTruncated((current) => current === nextIsTruncated ? current : nextIsTruncated);
    };

    measure();
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure);
    observer?.observe(element);
    window.addEventListener('resize', measure);
    return () => {
      observer?.disconnect();
      window.removeEventListener('resize', measure);
    };
  }, [text]);

  useLayoutEffect(() => {
    if (!isTruncated) {
      setIsOpen(false);
      setPosition(null);
      return;
    }

    if (!isOpen) return;

    const reposition = () => {
      const anchor = textRef.current?.getBoundingClientRect();
      const tooltip = tooltipRef.current?.getBoundingClientRect();
      if (!anchor || !tooltip) return;
      setPosition(computeTooltipPosition({
        anchor,
        tooltip,
        viewport: { width: window.innerWidth, height: window.innerHeight },
        gap: TOOLTIP_GAP,
        margin: TOOLTIP_MARGIN,
      }));
    };

    reposition();
    window.addEventListener('resize', reposition);
    window.addEventListener('scroll', reposition, true);
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(reposition);
    if (textRef.current) observer?.observe(textRef.current);
    if (tooltipRef.current) observer?.observe(tooltipRef.current);

    return () => {
      window.removeEventListener('resize', reposition);
      window.removeEventListener('scroll', reposition, true);
      observer?.disconnect();
    };
  }, [isOpen, isTruncated, text]);

  const openTooltip = () => {
    if (isTruncated) setIsOpen(true);
  };

  const closeTooltip = () => setIsOpen(false);

  const handlePointerEnter = (event: PointerEvent<HTMLParagraphElement>) => {
    onPointerEnter?.(event);
    openTooltip();
  };

  const handlePointerLeave = (event: PointerEvent<HTMLParagraphElement>) => {
    onPointerLeave?.(event);
    closeTooltip();
  };

  const handleFocus = (event: FocusEvent<HTMLParagraphElement>) => {
    onFocus?.(event);
    openTooltip();
  };

  const handleBlur = (event: FocusEvent<HTMLParagraphElement>) => {
    onBlur?.(event);
    closeTooltip();
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLParagraphElement>) => {
    onKeyDown?.(event);
    if (event.key === 'Escape') closeTooltip();
  };

  const tooltipVisible = isOpen && position !== null;
  const tooltip = isTruncated && typeof document !== 'undefined'
    ? createPortal(
      <div
        ref={tooltipRef}
        id={tooltipId}
        role="tooltip"
        aria-hidden={!tooltipVisible}
        className={cn(
          'pointer-events-none fixed z-50 max-h-[calc(100vh-16px)] max-w-[min(320px,calc(100vw-16px))] overflow-y-auto rounded-lg border border-slate-700 bg-slate-900 px-2.5 py-1.5 text-xs leading-5 text-white shadow-lg transition-[opacity,transform] duration-150 ease-out dark:border-slate-600 dark:bg-slate-800',
          isOpen ? 'opacity-100 translate-y-0' : 'opacity-0 translate-y-1',
        )}
        style={{
          top: position?.top ?? 0,
          left: position?.left ?? 0,
          visibility: position ? 'visible' : 'hidden',
        }}
      >
        <span className="whitespace-normal break-words">{text}</span>
      </div>,
      document.body,
    )
    : null;

  return <>
    <p
      {...props}
      ref={textRef}
      className={cn('focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-500 focus-visible:ring-offset-1 dark:focus-visible:ring-offset-slate-950', className)}
      tabIndex={isTruncated ? 0 : undefined}
      aria-describedby={tooltipVisible ? tooltipId : undefined}
      onPointerEnter={handlePointerEnter}
      onPointerLeave={handlePointerLeave}
      onFocus={handleFocus}
      onBlur={handleBlur}
      onKeyDown={handleKeyDown}
    >
      {text}
    </p>
    {tooltip}
  </>;
}
