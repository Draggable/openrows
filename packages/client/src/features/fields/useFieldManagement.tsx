import type { FieldMeta, GridLayout, TableMeta } from '@openrows/shared';
import { type ReactNode, useRef, useState } from 'react';
import { ApiError } from '../../api/client';
import { useDeleteField, useRestoreField } from '../../api/queries';
import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Popover,
  PopoverAnchor,
  PopoverContent,
  toast,
} from '../../components/ui';
import { FieldEditor, type FieldEditorTarget, focusRequested } from './FieldEditor';
import { copyName, insertIntoOrder, insertPosition, type Side } from './model';

type Open = {
  target: FieldEditorTarget;
  anchor: HTMLElement;
  /** Where a created field goes in the view's order. */
  insert?: { anchorId: string; side: Side };
  key: number;
};

export type FieldActions = {
  editField: (
    field: FieldMeta,
    anchor: HTMLElement,
    focus?: 'name' | 'description' | 'type'
  ) => void;
  insertField: (field: FieldMeta, side: Side, anchor: HTMLElement) => void;
  duplicateField: (field: FieldMeta, anchor: HTMLElement) => void;
  hideField: (fieldId: string) => void;
  deleteField: (field: FieldMeta) => void;
};

const message = (err: unknown, fallback: string) =>
  err instanceof ApiError ? err.message : fallback;

/**
 * Field management from the column headers: the field editor in a popover under the
 * header (edit, rename, change type, describe, insert left/right, duplicate), hiding a field
 * in the view, and deleting one after a confirmation, with an undo toast that restores it from
 * the trash. `ui` renders the popover and the dialog.
 */
export function useFieldManagement({
  table,
  fullOrder,
  hidden,
  saveLayout,
}: {
  table: TableMeta;
  /** The view's field order, hidden fields included. */
  fullOrder: string[];
  hidden: string[];
  saveLayout: (patch: GridLayout) => void;
}): { actions: FieldActions; ui: ReactNode } {
  const [open, setOpen] = useState<Open | null>(null);
  const [deleting, setDeleting] = useState<FieldMeta | null>(null);
  const counter = useRef(0);
  const anchorRef = useRef({
    getBoundingClientRect: () => open?.anchor.getBoundingClientRect() ?? new DOMRect(),
  });
  anchorRef.current.getBoundingClientRect = () =>
    open?.anchor.getBoundingClientRect() ?? new DOMRect();
  const remove = useDeleteField(table.id);
  const restore = useRestoreField(table.id);

  const show = (next: Omit<Open, 'key'>) => {
    counter.current += 1;
    setOpen({ ...next, key: counter.current });
  };

  const actions: FieldActions = {
    editField: (field, anchor, focus) => show({ target: { mode: 'edit', field, focus }, anchor }),
    insertField: (field, side, anchor) =>
      show({
        target: { mode: 'create', position: insertPosition(table.fields, field.id, side) },
        anchor,
        insert: { anchorId: field.id, side },
      }),
    duplicateField: (field, anchor) =>
      show({
        target: {
          mode: 'create',
          position: insertPosition(table.fields, field.id, 'right'),
          initial: {
            name: copyName(field.name, table.fields),
            type: field.type,
            options: field.options,
            description: field.description ?? '',
          },
        },
        anchor,
        insert: { anchorId: field.id, side: 'right' },
      }),
    hideField: (fieldId) => saveLayout({ hiddenFields: [...new Set([...hidden, fieldId])] }),
    deleteField: setDeleting,
  };

  const onDone = (field?: FieldMeta) => {
    if (field && open?.insert && open.target.mode === 'create') {
      const { anchorId, side } = open.insert;
      saveLayout({ fieldOrder: insertIntoOrder(fullOrder, field.id, anchorId, side) });
    }
    setOpen(null);
  };

  const confirmDelete = () => {
    const field = deleting;
    if (!field) return;
    remove.mutate(field.id, {
      onSuccess: () => {
        setDeleting(null);
        toast(`Deleted "${field.name}"`, {
          action: {
            label: 'Undo',
            onClick: () =>
              restore.mutate(field.id, {
                onSuccess: () => toast.success(`Restored "${field.name}"`),
                onError: (err) => toast.error(message(err, "Couldn't restore the field")),
              }),
          },
        });
      },
      onError: (err) => toast.error(message(err, "Couldn't delete the field")),
    });
  };

  const ui = (
    <>
      <Popover
        open={open !== null}
        onOpenChange={(o) => {
          if (!o) setOpen(null);
        }}
      >
        <PopoverAnchor virtualRef={anchorRef} />
        {open && (
          <PopoverContent
            align="start"
            collisionPadding={8}
            onOpenAutoFocus={focusRequested}
            className="max-h-(--radix-popover-content-available-height) w-[440px] overflow-y-auto"
          >
            <FieldEditor
              key={open.key}
              tableId={table.id}
              fields={table.fields}
              target={open.target}
              onDone={onDone}
            />
          </PopoverContent>
        )}
      </Popover>
      <Dialog
        open={deleting !== null}
        onOpenChange={(o) => {
          if (!o) setDeleting(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete the field "{deleting?.name}"?</DialogTitle>
            <DialogDescription>
              Its values go to the trash with it. You can undo this from the notification that
              follows.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setDeleting(null)}>
              Cancel
            </Button>
            <Button variant="destructive" onClick={confirmDelete} disabled={remove.isPending}>
              Delete field
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
  return { actions, ui };
}
