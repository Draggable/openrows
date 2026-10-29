import { CheckIcon } from 'lucide-react';
import { DropdownMenu as Menu } from 'radix-ui';
import type { ComponentProps } from 'react';
import { cn } from '../../lib/utils';

export const DropdownMenu = Menu.Root;
export const DropdownMenuTrigger = Menu.Trigger;

export function DropdownMenuContent({
  className,
  sideOffset = 4,
  ...props
}: ComponentProps<typeof Menu.Content>) {
  return (
    <Menu.Portal>
      <Menu.Content
        sideOffset={sideOffset}
        className={cn(
          'z-50 min-w-44 overflow-hidden rounded-md border border-border bg-surface p-1 text-text shadow-2',
          className
        )}
        {...props}
      />
    </Menu.Portal>
  );
}

export function DropdownMenuItem({
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

export function DropdownMenuSeparator({
  className,
  ...props
}: ComponentProps<typeof Menu.Separator>) {
  return <Menu.Separator className={cn('-mx-1 my-1 h-px bg-border', className)} {...props} />;
}

/** A non-interactive heading inside a menu (e.g. "Move to section"). */
export function DropdownMenuLabel({ className, ...props }: ComponentProps<typeof Menu.Label>) {
  return (
    <Menu.Label
      className={cn('px-2 pt-1.5 pb-1 text-small font-[550] text-text-2', className)}
      {...props}
    />
  );
}

/** A menu item with a checkbox (e.g. "Only me"); `onSelect` with `preventDefault` keeps it open. */
export function DropdownMenuCheckboxItem({
  className,
  children,
  ...props
}: ComponentProps<typeof Menu.CheckboxItem>) {
  return (
    <Menu.CheckboxItem
      className={cn(
        'group/check flex h-8 cursor-default items-center gap-2 rounded-sm px-2 text-body outline-none select-none data-[disabled]:opacity-50 data-[highlighted]:bg-hover [&_svg]:size-4 [&_svg]:text-text-2',
        className
      )}
      {...props}
    >
      <span
        aria-hidden
        className="flex size-4 shrink-0 items-center justify-center rounded-xs border border-border-strong bg-surface group-data-[state=checked]/check:border-primary group-data-[state=checked]/check:bg-primary"
      >
        <Menu.ItemIndicator>
          <CheckIcon className="size-3! text-primary-foreground!" strokeWidth={3} />
        </Menu.ItemIndicator>
      </span>
      {children}
    </Menu.CheckboxItem>
  );
}
