import {
  type EditPermission,
  type FieldMeta,
  FORM_SUBJECT,
  fieldPermissionsOf,
  permissionAllows,
  type TableMeta,
  tablePermissionsOf,
} from '@openrows/shared';
import { useState } from 'react';
import { toast } from 'sonner';
import { ApiError } from '../../api/client';
import { useUpdateField } from '../../api/queries';
import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '../../components/ui';
import { summary } from './model';
import { PermissionPicker } from './PermissionPicker';

/**
 * The field menu's "Edit permissions" (creators and up): who may edit the field's cells,
 * and, when editors can't, whether public forms may still fill it in.
 */
export function FieldPermissionsDialog({
  table,
  field,
  onClose,
}: {
  table: TableMeta;
  field: FieldMeta;
  onClose: () => void;
}) {
  const stored = fieldPermissionsOf(field.permissions);
  const [edit, setEdit] = useState<EditPermission>(stored.edit);
  const [allowForms, setAllowForms] = useState(stored.allowForms === true);
  const update = useUpdateField(table.id);
  const tableEdit = tablePermissionsOf(table.permissions).editRecords;
  // Forms write as an editor: the override only matters when editors can't edit.
  const locked = !permissionAllows(edit, FORM_SUBJECT);
  const save = () =>
    update.mutate(
      {
        fieldId: field.id,
        permissions: { edit, ...(locked && allowForms ? { allowForms: true } : {}) },
      },
      {
        onSuccess: () => {
          toast.success(`Updated who can edit ${field.name}`);
          onClose();
        },
        onError: (err) =>
          toast.error(err instanceof ApiError ? err.message : "Couldn't save the permission"),
      }
    );
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Permissions for {field.name}</DialogTitle>
          <DialogDescription>
            Everyone who can see the table still sees this field. This only limits who can change
            its values.
          </DialogDescription>
        </DialogHeader>
        <form
          className="grid gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            save();
          }}
        >
          <PermissionPicker label="Who can edit this field" value={edit} onChange={setEdit} />
          {locked && (
            <label className="flex cursor-pointer items-start gap-2">
              <input
                type="checkbox"
                checked={allowForms}
                onChange={(e) => setAllowForms(e.target.checked)}
                className="mt-0.5 size-4 accent-[var(--accent)]"
              />
              <span className="grid gap-0.5">
                Allow this field to be filled through forms
                <span className="text-small text-text-2">
                  Public forms can set it on the records they create.
                </span>
              </span>
            </label>
          )}
          {tableEdit.level !== 'editors' && (
            <p className="text-text-2">
              The table limits editing records to: {summary(tableEdit)}. Both apply.
            </p>
          )}
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
