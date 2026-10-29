import type { ViewMeta } from '@openrows/shared';
import { CheckIcon, CopyIcon } from 'lucide-react';
import { useState } from 'react';
import { ApiError } from '../../api/client';
import { useCreateShare, useRevokeShare, useShares } from '../../api/queries';
import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  Input,
  Skeleton,
  toast,
} from '../../components/ui';
import { formUrl } from './form-model';
import { shareSummary } from './model';

const errorText = (err: unknown, fallback: string) =>
  err instanceof ApiError ? err.message : fallback;

/**
 * A form view's "Share form": make the public link of the form (shown once: the server
 * keeps only its hash), copy it, and turn links off. Creators and owners.
 */
export function FormLinkDialog({
  view,
  open,
  onOpenChange,
}: {
  view: ViewMeta;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  // Remounting on close forgets the link shown once.
  const [round, setRound] = useState(0);
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) setRound((r) => r + 1);
        onOpenChange(next);
      }}
    >
      <DialogContent className="sm:max-w-[520px]">
        <DialogHeader>
          <DialogTitle>Share {view.name}</DialogTitle>
          <DialogDescription>
            Anyone with the link can fill in this form, signed in or not. Each submission adds a
            record; submitters never see the table.
          </DialogDescription>
        </DialogHeader>
        <FormLinks key={round} viewId={view.id} open={open} />
      </DialogContent>
    </Dialog>
  );
}

function FormLinks({ viewId, open }: { viewId: string; open: boolean }) {
  const target = { kind: 'view', viewId } as const;
  const links = useShares(target, open);
  const create = useCreateShare(target);
  const revoke = useRevokeShare(target);
  const [made, setMade] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const url = made ? formUrl(made) : null;

  return (
    <div className="grid gap-4">
      {url ? (
        <div className="grid gap-2">
          <p className="text-small text-text-2">
            Copy the link now: it is shown only once. Prefill answers with
            <code className="mx-1">?prefill_Name=value</code>(fields that allow it) and hide them
            with <code>&amp;hide_Name=true</code>.
          </p>
          <div className="flex gap-2">
            <Input readOnly value={url} aria-label="Form link" onFocus={(e) => e.target.select()} />
            <Button
              variant="secondary"
              onClick={() => {
                void navigator.clipboard.writeText(url).then(
                  () => setCopied(true),
                  () => toast.error('Couldn’t copy the link.')
                );
              }}
            >
              {copied ? <CheckIcon /> : <CopyIcon />}
              {copied ? 'Copied' : 'Copy'}
            </Button>
          </div>
        </div>
      ) : (
        <div>
          <Button
            disabled={create.isPending}
            onClick={() =>
              create.mutate(
                {},
                {
                  onSuccess: ({ token }) => setMade(token),
                  onError: (err) => toast.error(errorText(err, 'Couldn’t make the link.')),
                }
              )
            }
          >
            Create form link
          </Button>
        </div>
      )}
      <section aria-label="Form links" className="grid gap-2">
        <h3 className="text-small font-semibold text-text-2">Links</h3>
        {links.isPending ? (
          <Skeleton className="h-8 w-full" />
        ) : (links.data?.shares.length ?? 0) === 0 ? (
          <p className="text-small text-text-2">No links yet: the form is private.</p>
        ) : (
          <ul className="grid gap-1">
            {links.data?.shares.map((s) => (
              <li key={s.id} className="flex items-center justify-between gap-2">
                <span className="text-small">{shareSummary(s)}</span>
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={revoke.isPending}
                  onClick={() =>
                    revoke.mutate(s.id, {
                      onSuccess: () => toast('Link turned off.'),
                      onError: (err) => toast.error(errorText(err, 'Couldn’t turn it off.')),
                    })
                  }
                >
                  Turn off
                </Button>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
