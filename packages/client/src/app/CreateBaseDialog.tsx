import type { MeResponse } from '@openrows/shared';
import { type FormEvent, useEffect, useState } from 'react';
import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Input,
} from '../components/ui';
import { TemplateGallery } from '../features/templates/TemplateGallery';
import { useCreateBaseFlow } from './useCreateBaseFlow';

export function CreateBaseDialog({
  me,
  open,
  workspaceId,
  onOpenChange,
}: {
  me: MeResponse;
  open: boolean;
  workspaceId?: string;
  onOpenChange: (open: boolean) => void;
}) {
  const [name, setName] = useState('Untitled base');
  const [galleryOpen, setGalleryOpen] = useState(false);
  const create = useCreateBaseFlow(me);
  useEffect(() => {
    if (open) setName('Untitled base');
  }, [open]);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const trimmed = name.trim();
    if (!trimmed) return;
    create.mutate({ name: trimmed, workspaceId }, { onSuccess: () => onOpenChange(false) });
  };

  return (
    <>
      <TemplateGallery
        me={me}
        open={galleryOpen}
        onOpenChange={setGalleryOpen}
        workspaceId={workspaceId}
      />
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent>
          <form onSubmit={submit} className="grid gap-4">
            <DialogHeader>
              <DialogTitle>Create a base</DialogTitle>
              <DialogDescription>
                An empty base with one table. You can rename it later, or start from a template with
                tables and sample records.
              </DialogDescription>
            </DialogHeader>
            <div className="grid gap-1.5">
              <label htmlFor="new-base-name" className="text-small text-text-2">
                Name
              </label>
              <Input
                id="new-base-name"
                autoFocus
                value={name}
                maxLength={255}
                onFocus={(e) => e.currentTarget.select()}
                onChange={(e) => setName(e.target.value)}
              />
            </div>
            <DialogFooter>
              <Button
                type="button"
                variant="ghost"
                className="sm:mr-auto"
                onClick={() => {
                  onOpenChange(false);
                  setGalleryOpen(true);
                }}
              >
                Start from a template
              </Button>
              <Button type="button" variant="secondary" onClick={() => onOpenChange(false)}>
                Cancel
              </Button>
              <Button type="submit" disabled={create.isPending || !name.trim()}>
                {create.isPending ? 'Creating…' : 'Create base'}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </>
  );
}
