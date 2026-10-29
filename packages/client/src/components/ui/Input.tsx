import type { ComponentProps } from 'react';
import { cn } from '../../lib/utils';

export type InputProps = ComponentProps<'input'>;

export function Input({ className, type = 'text', ...props }: InputProps) {
  return (
    <input
      type={type}
      className={cn(
        'flex h-8 w-full rounded-sm border border-border bg-surface px-2.5 text-body pointer-coarse:h-[40px] text-text placeholder:text-text-3 hover:border-border-strong disabled:cursor-not-allowed disabled:opacity-50',
        className
      )}
      {...props}
    />
  );
}
