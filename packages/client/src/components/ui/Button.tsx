import { cva, type VariantProps } from 'class-variance-authority';
import { Slot } from 'radix-ui';
import type { ComponentProps } from 'react';
import { cn } from '../../lib/utils';

/** shadcn/ui button on the design tokens: the rose only for a view's primary action. */
export const buttonVariants = cva(
  'inline-flex shrink-0 items-center justify-center gap-1.5 whitespace-nowrap rounded-sm font-[550] transition-colors disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0',
  {
    variants: {
      variant: {
        default: 'bg-brand text-brand-foreground hover:bg-brand-hover',
        secondary: 'border border-border bg-surface text-text shadow-1 hover:bg-hover',
        outline: 'border border-border bg-transparent text-text hover:bg-hover',
        ghost: 'text-text hover:bg-hover',
        destructive: 'bg-danger text-danger-foreground hover:opacity-90',
      },
      // On touch screens every button is a 40 px target.
      size: {
        sm: 'h-7 px-2.5 text-small pointer-coarse:h-[40px]',
        md: 'h-8 px-3 text-body pointer-coarse:h-[40px]',
        lg: 'h-10 px-4 text-body pointer-coarse:h-[40px]',
        icon: 'size-7 pointer-coarse:size-[40px]',
      },
    },
    defaultVariants: { variant: 'default', size: 'md' },
  }
);

export type ButtonProps = ComponentProps<'button'> &
  VariantProps<typeof buttonVariants> & { asChild?: boolean };

export function Button({ className, variant, size, asChild = false, ...props }: ButtonProps) {
  const Comp = asChild ? Slot.Root : 'button';
  return <Comp className={cn(buttonVariants({ variant, size }), className)} {...props} />;
}
