import { Command as CommandPrimitive } from 'cmdk';
import { SearchIcon } from 'lucide-react';
import type { ComponentProps } from 'react';
import { cn } from '../../lib/utils';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from './Dialog';

export function Command({ className, ...props }: ComponentProps<typeof CommandPrimitive>) {
  return (
    <CommandPrimitive
      className={cn('flex h-full w-full flex-col overflow-hidden bg-surface text-text', className)}
      {...props}
    />
  );
}

export function CommandDialog({
  open,
  onOpenChange,
  children,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  children: React.ReactNode;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {/* A full-screen sheet on phones: the list fills the screen under the input. */}
      <DialogContent className="top-[20%] max-w-[560px] translate-y-0 gap-0 overflow-hidden p-0 max-md:flex max-md:flex-col">
        <DialogTitle className="sr-only">Search and commands</DialogTitle>
        <DialogDescription className="sr-only">
          Search bases and tables, or run a command
        </DialogDescription>
        <Command loop className="max-md:min-h-0 max-md:flex-1">
          {children}
        </Command>
      </DialogContent>
    </Dialog>
  );
}

export function CommandInput({
  className,
  ...props
}: ComponentProps<typeof CommandPrimitive.Input>) {
  return (
    <div className="flex h-11 items-center gap-2 border-b border-border px-3">
      <SearchIcon className="size-4 shrink-0 text-text-2" />
      <CommandPrimitive.Input
        className={cn(
          'h-full w-full bg-transparent text-body outline-none placeholder:text-text-3 focus-visible:shadow-none',
          className
        )}
        {...props}
      />
    </div>
  );
}

export function CommandList({ className, ...props }: ComponentProps<typeof CommandPrimitive.List>) {
  return (
    <CommandPrimitive.List
      className={cn('max-h-80 overflow-y-auto overflow-x-hidden p-1', className)}
      {...props}
    />
  );
}

export function CommandEmpty(props: ComponentProps<typeof CommandPrimitive.Empty>) {
  return <CommandPrimitive.Empty className="py-6 text-center text-text-2" {...props} />;
}

export function CommandGroup({
  className,
  ...props
}: ComponentProps<typeof CommandPrimitive.Group>) {
  return (
    <CommandPrimitive.Group
      className={cn(
        '[&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:py-1.5 [&_[cmdk-group-heading]]:text-caps [&_[cmdk-group-heading]]:font-semibold [&_[cmdk-group-heading]]:tracking-[0.06em] [&_[cmdk-group-heading]]:text-text-2 [&_[cmdk-group-heading]]:uppercase',
        className
      )}
      {...props}
    />
  );
}

export function CommandItem({ className, ...props }: ComponentProps<typeof CommandPrimitive.Item>) {
  return (
    <CommandPrimitive.Item
      className={cn(
        'flex h-8 cursor-default items-center gap-2 rounded-sm px-2 text-body select-none data-[selected=true]:bg-selected [&_svg]:size-4 [&_svg]:text-text-2',
        className
      )}
      {...props}
    />
  );
}
