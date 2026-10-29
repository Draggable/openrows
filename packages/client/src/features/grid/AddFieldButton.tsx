import type { TableMeta } from '@openrows/shared';
import { Plus } from 'lucide-react';
import { useState } from 'react';
import { Popover, PopoverContent, PopoverTrigger } from '../../components/ui';
import { FieldEditor, focusRequested } from '../fields/FieldEditor';

/** The "+" at the end of the header: the field editor for a new last field. */
export function AddFieldButton({ table, onCreated }: { table: TableMeta; onCreated?: () => void }) {
  const [open, setOpen] = useState(false);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        aria-label="Add field"
        className="flex h-full w-full items-center justify-center text-text-2 hover:bg-hover hover:text-text"
      >
        <Plus className="size-4" />
      </PopoverTrigger>
      <PopoverContent
        align="end"
        collisionPadding={8}
        onOpenAutoFocus={focusRequested}
        className="max-h-(--radix-popover-content-available-height) w-[440px] overflow-y-auto"
      >
        <FieldEditor
          tableId={table.id}
          fields={table.fields}
          target={{ mode: 'create' }}
          onDone={(field) => {
            setOpen(false);
            if (field) onCreated?.();
          }}
        />
      </PopoverContent>
    </Popover>
  );
}
