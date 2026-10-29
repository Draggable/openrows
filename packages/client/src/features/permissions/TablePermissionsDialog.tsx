import {
  type EditPermission,
  type TableMeta,
  type TablePermissions,
  tablePermissionsOf,
} from '@openrows/shared';
import { useState } from 'react';
import { toast } from 'sonner';
import { ApiError } from '../../api/client';
import { useUpdateTable } from '../../api/queries';
import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '../../components/ui';
import { PermissionPicker } from './PermissionPicker';

const ACTIONS: { key: keyof TablePermissions; label: string }[] = [
  { key: 'addRecords', label: 'Who can add records' },
  { key: 'deleteRecords', label: 'Who can delete records' },
  { key: 'editRecords', label: 'Who can edit records' },
];

/** The table menu's "Edit permissions" (creators and up). */
export function TablePermissionsDialog({
  table,
  onClose,
}: {
  table: Omit<TableMeta, 'fields'>;
  onClose: () => void;
}) {
  const [value, setValue] = useState<TablePermissions>(tablePermissionsOf(table.permissions));
  const update = useUpdateTable(table.id);
  const set = (key: keyof TablePermissions) => (next: EditPermission) =>
    setValue((v) => ({ ...v, [key]: next }));
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-h-[90dvh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Permissions for {table.name}</DialogTitle>
          <DialogDescription>
            Narrow who can change records. Everyone with access still sees them.
          </DialogDescription>
        </DialogHeader>
        <form
          className="grid gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            update.mutate(
              { permissions: value },
              {
                onSuccess: () => {
                  toast.success(`Updated permissions for ${table.name}`);
                  onClose();
                },
                onError: (err) =>
                  toast.error(
                    err instanceof ApiError ? err.message : "Couldn't save the permissions"
                  ),
              }
            );
          }}
        >
          {ACTIONS.map((a) => (
            <PermissionPicker
              key={a.key}
              label={a.label}
              value={value[a.key]}
              onChange={set(a.key)}
            />
          ))}
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={update.isPending}>
              {update.isPending ? 'Saving…' : 'Save'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
