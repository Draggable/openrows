import { BRAND, LOGO_MARK_PATH } from '@openrows/shared';
import { cn } from '../lib/utils';

export { BRAND };

/** The wordmark: "OpenRows" in Inter Bold, tracking −1% (DESIGN.md §2). */
export function Wordmark({ className }: { className?: string }) {
  return <span className={cn('font-bold tracking-[-0.01em] text-text', className)}>{BRAND}</span>;
}

/** The rose mark alone (DESIGN.md §2), in the brand rose. */
export function LogoMark({ size = 22, className }: { size?: number; className?: string }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 64 64"
      aria-hidden="true"
      className={cn('shrink-0 text-brand', className)}
    >
      <path fill="currentColor" d={LOGO_MARK_PATH} />
    </svg>
  );
}

/** The mark and wordmark, a little smaller in the app than on the site. */
export function Logo({ withWordmark = true }: { withWordmark?: boolean }) {
  return (
    <span className="inline-flex items-center gap-2">
      <LogoMark />
      {withWordmark && <Wordmark className="text-[18px]" />}
    </span>
  );
}

/**
 * The "Made with OpenRows" credit under public forms and shared views, the same
 * words and wordmark on both, linking to the project site.
 */
export function MadeWith({ className }: { className?: string }) {
  return (
    <a
      href="https://openrows.io"
      target="_blank"
      rel="noopener noreferrer"
      className={cn(
        'inline-flex items-center gap-1 text-small text-text-2 hover:text-text',
        className
      )}
    >
      Made with <LogoMark size={14} className="ml-0.5" />
      <Wordmark />
    </a>
  );
}
