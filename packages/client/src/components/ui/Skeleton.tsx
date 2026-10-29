import type { ComponentProps } from 'react';
import { cn } from '../../lib/utils';

/** A loading placeholder block. */
export function Skeleton({ className, ...props }: ComponentProps<'div'>) {
  return (
    <div
      aria-hidden="true"
      className={cn('animate-pulse rounded-sm bg-hover', className)}
      {...props}
    />
  );
}
