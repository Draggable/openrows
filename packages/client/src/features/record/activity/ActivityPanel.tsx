import {
  type FieldMeta,
  getFieldType,
  type Revision,
  type RevisionChange,
  roleAllows,
  type TableMeta,
  type UserRole,
} from '@openrows/shared';
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { ArrowRight, History, RotateCcw, Zap } from 'lucide-react';
import { useEffect, useMemo, useRef } from 'react';
import { ApiError } from '../../../api/client';
import { commentQueries, revisionQueries } from '../../../api/queries';
import { useRestoreRevision } from '../../../api/records';
import { Button, Skeleton, Tooltip, toast } from '../../../components/ui';
import { cn } from '../../../lib/utils';
import { useDirectory } from '../../collaborators/context';
import { Avatar } from '../../collaborators/UserChip';
import { CellContent, RichText } from '../../grid/cells';
import { cellText } from '../../grid/cells/model';
import { useEditRights } from '../../permissions/model';
import { relativeTime } from '../model';
import {
  type ActivityItem,
  activityItems,
  isEmptyValue,
  plainValue,
  revisionVerb,
  sameType,
} from './model';

const message = (err: unknown, fallback: string) =>
  err instanceof ApiError ? err.message : fallback;

/**
 * The record's Activity tab (mockup b-record-modal): its revision history and comments in
 * one timeline, oldest first. Each changed cell shows its value before and after, rendered as
 * the grid renders the field; editors restore one value ("Restore this value") or the whole
 * record to how it was right after a change. Restores are normal writes: edit permissions
 * apply and each one is itself a new entry. Older history loads on demand.
 */
export function ActivityPanel({
  table,
  fields,
  recordId,
  userRole,
  className,
}: {
  table: TableMeta;
  fields: readonly FieldMeta[];
  recordId: string;
  userRole: UserRole | undefined;
  className?: string;
}) {
  const revisions = useInfiniteQuery(revisionQueries.record(table.id, recordId));
  const comments = useQuery(commentQueries.record(table.id, recordId));
  const loaded = useMemo(
    () => revisions.data?.pages.flatMap((p) => p.revisions) ?? [],
    [revisions.data]
  );
  const items = useMemo(
    () => activityItems(loaded, comments.data?.comments ?? [], !revisions.hasNextPage),
    [loaded, comments.data, revisions.hasNextPage]
  );
  const fieldsById = useMemo(() => new Map(fields.map((f) => [f.id, f])), [fields]);
  const rights = useEditRights(table, userRole);
  const canWrite = userRole !== undefined && roleAllows(userRole, 'record:update');
  const restore = useRestoreRevision(table.id, recordId);
  const end = useRef<HTMLDivElement>(null);
  const newest = items.at(-1)?.id;

  // biome-ignore lint/correctness/useExhaustiveDependencies: on a new latest entry only
  useEffect(() => {
    end.current?.scrollIntoView?.({ block: 'nearest' });
  }, [newest]);

  const run = (revision: Revision, fieldId?: string) =>
    restore.mutate(
      { revisionId: revision.id, ...(fieldId ? { fieldId } : {}) },
      {
        onSuccess: () => toast.success(fieldId ? 'Value restored' : 'Record restored'),
        onError: (err) => toast.error(message(err, "Couldn't restore")),
      }
    );

  const canRestoreField = (change: RevisionChange) => {
    const field = fieldsById.get(change.fieldId);
    if (!canWrite || !field || !sameType(change, field)) return false;
    const def = getFieldType(field.type);
    return !def.readOnly && !def.computed && rights.canEditField(field);
  };

  return (
    <section
      aria-label="Activity"
      data-testid="activity-panel"
      className={cn('flex min-h-0 flex-col bg-app', className)}
    >
      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4">
        {revisions.isPending ? (
          <div className="grid gap-3 py-2" aria-busy="true">
            <Skeleton className="h-10" />
            <Skeleton className="h-10" />
          </div>
        ) : revisions.isError ? (
          <p role="alert" className="py-6 text-center text-text-2">
            Couldn't load the activity.
          </p>
        ) : (
          <>
            {revisions.hasNextPage && (
              <div className="flex justify-center pt-3">
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={revisions.isFetchingNextPage}
                  onClick={() => void revisions.fetchNextPage()}
                >
                  <History className="size-4" aria-hidden />
                  Show older activity
                </Button>
              </div>
            )}
            {items.length === 0 ? (
              <p className="py-6 text-center text-text-2">No activity yet.</p>
            ) : (
              <ol className="divide-y divide-border" aria-label="Activity list">
                {items.map((item) => (
                  <Entry
                    key={`${item.type}:${item.id}`}
                    item={item}
                    fieldsById={fieldsById}
                    canRestoreRecord={canWrite}
                    canRestoreField={canRestoreField}
                    pending={restore.isPending}
                    onRestore={run}
                  />
                ))}
              </ol>
            )}
          </>
        )}
        <div ref={end} />
      </div>
    </section>
  );
}

function Entry({
  item,
  fieldsById,
  canRestoreRecord,
  canRestoreField,
  pending,
  onRestore,
}: {
  item: ActivityItem;
  fieldsById: ReadonlyMap<string, FieldMeta>;
  canRestoreRecord: boolean;
  canRestoreField: (change: RevisionChange) => boolean;
  pending: boolean;
  onRestore: (revision: Revision, fieldId?: string) => void;
}) {
  const { byId, loaded } = useDirectory();
  const actorId = item.type === 'revision' ? item.revision.actorId : item.comment.authorId;
  const actor = actorId ? byId.get(actorId) : undefined;
  const revision = item.type === 'revision' ? item.revision : null;
  // A public form's submission has no person behind it; an automation's step ran
  // as its person, named on hover.
  const automated = revision?.via === 'automation';
  const personName = actor?.name ?? (loaded ? 'Former member' : '');
  const name = revision?.via === 'form' ? 'Form' : automated ? 'Automation' : personName;
  const restorable =
    revision !== null &&
    canRestoreRecord &&
    (revision.kind === 'created' || (revision.kind === 'updated' && revision.changes.length > 0));

  return (
    <li
      data-testid="activity-entry"
      data-kind={revision ? revision.kind : 'comment'}
      className="group flex gap-3 py-3"
    >
      {automated ? (
        <span
          aria-hidden
          className="mt-0.5 grid size-7 shrink-0 place-items-center rounded-full bg-hover text-text-2"
        >
          <Zap className="size-3.5" />
        </span>
      ) : actor ? (
        <Avatar person={actor} className="mt-0.5 size-7 text-[11px]" />
      ) : (
        <span aria-hidden className="mt-0.5 size-7 shrink-0 rounded-full bg-hover" />
      )}
      <div className="min-w-0 flex-1">
        {/* Actor and verb wrap: only long values truncate, with the full text on hover. */}
        <div className="flex items-start gap-2">
          <p className="min-w-0 flex-1 break-words">
            <span
              className="font-semibold"
              title={automated && personName ? `Ran as ${personName}` : undefined}
            >
              {name}
            </span>{' '}
            <span className="text-text-2">
              {revision ? revisionVerb(revision, fieldsById) : 'commented'}
            </span>
          </p>
          <time
            dateTime={item.at}
            title={item.at}
            className="shrink-0 pt-px text-small leading-5 text-text-2"
          >
            {relativeTime(item.at)}
          </time>
          {restorable && revision && (
            <Tooltip content="Restore the record to how it was right after this change">
              <Button
                variant="ghost"
                size="icon"
                aria-label="Restore record to this point"
                className="-my-1 size-7 shrink-0 opacity-0 group-hover:opacity-100 focus-visible:opacity-100 pointer-coarse:opacity-100"
                disabled={pending}
                onClick={() => onRestore(revision)}
              >
                <RotateCcw className="size-3.5" aria-hidden />
              </Button>
            </Tooltip>
          )}
        </div>
        {item.type === 'comment' && (
          <RichText text={item.comment.body} comment className="mt-0.5 min-w-0 break-words" />
        )}
        {revision && revision.changes.length > 0 && (
          <div className="mt-1.5 grid gap-1.5">
            {revision.changes.map((change) => {
              const field = fieldsById.get(change.fieldId);
              return (
                <div
                  key={change.fieldId}
                  data-testid="activity-change"
                  className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-2 rounded-sm border border-border bg-surface px-2 py-1.5"
                >
                  <dl className="min-w-0">
                    <dt className="text-small text-text-2">{field?.name ?? 'Field'}</dt>
                    <dd className="flex min-w-0 items-center gap-2">
                      <Value field={field} change={change} value={change.before} old />
                      <ArrowRight className="size-3.5 shrink-0 text-text-3" aria-hidden />
                      <Value field={field} change={change} value={change.after} />
                    </dd>
                  </dl>
                  {canRestoreField(change) && (
                    <Tooltip content={`Set ${field?.name ?? 'the field'} back to this value`}>
                      <Button
                        variant="ghost"
                        size="icon"
                        aria-label={`Restore this value of ${field?.name ?? 'the field'}`}
                        disabled={pending}
                        onClick={() => onRestore(revision, change.fieldId)}
                      >
                        <RotateCcw className="size-3.5" aria-hidden />
                      </Button>
                    </Tooltip>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </li>
  );
}

/** One side of a change, as the grid shows the field (plain text if its type changed since). */
function Value({
  field,
  change,
  value,
  old = false,
}: {
  field: FieldMeta | undefined;
  change: RevisionChange;
  value: unknown;
  old?: boolean;
}) {
  const label = old ? 'Before' : 'After';
  if (isEmptyValue(value)) {
    return (
      <span className="shrink-0 text-small text-text-3 italic">
        <span className="sr-only">{label}: </span>
        empty
      </span>
    );
  }
  const text = field && sameType(change, field) ? cellText(field, value) : plainValue(value);
  const content = (
    <span
      data-testid={old ? 'activity-before' : 'activity-after'}
      className={cn(
        'flex h-6 min-w-0 max-w-[45%] items-center overflow-hidden',
        old && 'text-text-2 line-through decoration-text-3'
      )}
    >
      <span className="sr-only">{label}: </span>
      {field && sameType(change, field) ? (
        <CellContent field={field} value={value} />
      ) : (
        <span className="truncate">{plainValue(value)}</span>
      )}
    </span>
  );
  // A long value is cut off at the column's width: its whole text on hover.
  if (text.length <= LONG_VALUE) return content;
  return (
    <Tooltip
      content={<span className="block max-w-80 break-words whitespace-pre-wrap">{text}</span>}
    >
      {content}
    </Tooltip>
  );
}

/** Characters above which a value may not fit its half of the change row. */
const LONG_VALUE = 18;
