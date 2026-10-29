import { XIcon } from 'lucide-react';
import { Dialog as DialogPrimitive } from 'radix-ui';
import type { ComponentProps } from 'react';
import { cn } from '../../lib/utils';

export const Dialog = DialogPrimitive.Root;
export const DialogTrigger = DialogPrimitive.Trigger;
export const DialogClose = DialogPrimitive.Close;

/**
 * Below 768 px a dialog is a full-screen sheet, clear of the safe-area insets. Applied
 * after the caller's classes so it wins on phones.
 */
export const FULL_SCREEN_ON_PHONES =
  'max-md:inset-0 max-md:h-dvh max-md:max-h-none max-md:w-full max-md:max-w-none max-md:translate-x-0 max-md:translate-y-0 max-md:content-start max-md:overflow-y-auto max-md:rounded-none max-md:border-0 max-md:pt-[calc(env(safe-area-inset-top)+20px)] max-md:pb-[calc(env(safe-area-inset-bottom)+20px)]';

export function DialogContent({
  className,
  children,
  ...props
}: ComponentProps<typeof DialogPrimitive.Content>) {
  return (
    <DialogPrimitive.Portal>
      <DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-scrim" />
      <DialogPrimitive.Content
        className={cn(
          'fixed top-1/2 left-1/2 z-50 grid w-full max-w-[440px] -translate-x-1/2 -translate-y-1/2 gap-4 rounded-lg border border-border bg-surface p-5 text-text shadow-3',
          className,
          FULL_SCREEN_ON_PHONES
        )}
        {...props}
      >
        {children}
        <DialogPrimitive.Close
          className="absolute top-3 right-3 flex items-center justify-center rounded-xs p-1 text-text-2 hover:bg-hover max-md:top-[calc(env(safe-area-inset-top)+4px)] max-md:right-1 pointer-coarse:size-[40px]"
          aria-label="Close"
        >
          <XIcon className="size-4" />
        </DialogPrimitive.Close>
      </DialogPrimitive.Content>
    </DialogPrimitive.Portal>
  );
}

export function DialogHeader({ className, ...props }: ComponentProps<'div'>) {
  return <div className={cn('flex flex-col gap-1', className)} {...props} />;
}

export function DialogFooter({ className, ...props }: ComponentProps<'div'>) {
  return <div className={cn('flex justify-end gap-2', className)} {...props} />;
}

export function DialogTitle({ className, ...props }: ComponentProps<typeof DialogPrimitive.Title>) {
  return (
    <DialogPrimitive.Title className={cn('text-heading font-semibold', className)} {...props} />
  );
}

export function DialogDescription({
  className,
  ...props
}: ComponentProps<typeof DialogPrimitive.Description>) {
  return <DialogPrimitive.Description className={cn('text-text-2', className)} {...props} />;
}
