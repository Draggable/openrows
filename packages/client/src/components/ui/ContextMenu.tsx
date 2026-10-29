import { ContextMenu as Menu } from 'radix-ui';
import type { ComponentProps } from 'react';
import { cn } from '../../lib/utils';

export const ContextMenu = Menu.Root;
export const ContextMenuTrigger = Menu.Trigger;

export function ContextMenuContent({ className, ...props }: ComponentProps<typeof Menu.Content>) {
  return (
    <Menu.Portal>
      <Menu.Content
        className={cn(
          'z-50 min-w-48 overflow-hidden rounded-md border border-border bg-surface p-1 text-text shadow-2',
          className
        )}
        {...props}
      />
    </Menu.Portal>
  );
}

export function ContextMenuItem({
  className,
  variant,
  ...props
}: ComponentProps<typeof Menu.Item> & { variant?: 'destructive' }) {
  return (
    <Menu.Item
      className={cn(
        'flex h-8 cursor-default items-center gap-2 rounded-sm px-2 text-body outline-none select-none data-[disabled]:opacity-50 data-[highlighted]:bg-hover [&_svg]:size-4 [&_svg]:text-text-2',
        variant === 'destructive' && 'text-danger [&_svg]:text-danger',
        className
      )}
      {...props}
    />
  );
}

export function ContextMenuSeparator({
  className,
  ...props
}: ComponentProps<typeof Menu.Separator>) {
  return <Menu.Separator className={cn('-mx-1 my-1 h-px bg-border', className)} {...props} />;
}
