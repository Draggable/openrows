import {
  COMMENT_REACTION_KEYS,
  COMMENT_REACTIONS,
  type Comment,
  type CommentReaction,
  roleAllows,
  type UserRole,
} from '@openrows/shared';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Ellipsis, Pencil, SmilePlus, Trash2 } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { ApiError } from '../../../api/client';
import { commentQueries, loadEarlierComments, useCommentMutations } from '../../../api/queries';
import {
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  Skeleton,
  Tooltip,
  toast,
} from '../../../components/ui';
import { cn } from '../../../lib/utils';
import { useDirectory } from '../../collaborators/context';
import { Avatar } from '../../collaborators/UserChip';
import { RichText } from '../../grid/cells';
import { relativeTime } from '../model';
import { Composer } from './Composer';

const message = (err: unknown, fallback: string) =>
  err instanceof ApiError ? err.message : fallback;

/**
 * The record's comments (mockup b-record-modal): oldest first, Markdown with @mentions,
 * reactions, and edit/delete of your own comments (creators and owners may delete any). The
 * composer at the bottom suggests people with access to the base after `@`; Ctrl/⌘ Enter sends.
 * Read-only members read; commenters and up write. Live: realtime events patch the list.
 */
export function CommentsPanel({
  tableId,
  recordId,
  userRole,
  className,
  showHeading = true,
  focusCommentId,
}: {
  tableId: string;
  recordId: string;
  userRole: UserRole | undefined;
  className?: string;
  showHeading?: boolean;
  /** A comment to scroll to and highlight once loaded (a notification's deep link). */
  focusCommentId?: string | undefined;
}) {
  const query = useQuery(commentQueries.record(tableId, recordId));
  const canComment = userRole !== undefined && roleAllows(userRole, 'comment:create');
  const canModerate = userRole !== undefined && roleAllows(userRole, 'comment:moderate');
  const mutations = useCommentMutations(tableId, recordId);
  const comments = query.data?.comments ?? [];
  const end = useRef<HTMLDivElement>(null);
  const count = comments.length;

  const list = useRef<HTMLOListElement>(null);
  const [focused, setFocused] = useState(false);
  const focusing = !!focusCommentId && comments.some((c) => c.id === focusCommentId);
  const qc = useQueryClient();
  const [earlier, setEarlier] = useState<'idle' | 'loading' | 'error'>('idle');
  const hasEarlier = !!query.data?.previousCursor;
  // With earlier pages not loaded yet, the table's comment counts know the thread's size.
  const counts = useQuery({ ...commentQueries.counts(tableId), enabled: hasEarlier });
  const total = hasEarlier ? Math.max(count, counts.data?.counts[recordId] ?? 0) : count;
  // Earlier pages prepend: keep the reader where they were instead of jumping to the end.
  const prepending = useRef(false);
  const loadEarlier = async () => {
    setEarlier('loading');
    prepending.current = true;
    try {
      await loadEarlierComments(qc, tableId, recordId);
      setEarlier('idle');
    } catch {
      prepending.current = false;
      setEarlier('error');
    }
  };

  // A linked comment older than the newest page: load earlier pages until it shows (up to
  // the thread's 1,000-comment cap, 20 pages).
  // biome-ignore lint/correctness/useExhaustiveDependencies: on a new page only
  useEffect(() => {
    if (focusCommentId && !focused && !focusing && hasEarlier && earlier === 'idle') {
      void loadEarlier();
    }
  }, [focusCommentId, focusing, hasEarlier, count]);

  // Keep the newest comment in sight as comments arrive, or the linked one, once.
  // biome-ignore lint/correctness/useExhaustiveDependencies: on a new count only
  useEffect(() => {
    if (focusing && !focused) {
      const item = list.current?.querySelector(`[data-comment-id="${focusCommentId}"]`);
      item?.scrollIntoView?.({ block: 'center' });
      setFocused(true);
      prepending.current = false;
      return;
    }
    if (prepending.current) {
      prepending.current = false;
      return;
    }
    end.current?.scrollIntoView?.({ block: 'nearest' });
  }, [count, focusing]);

  const send = (body: string, done: () => void) => {
    mutations.create.mutate(body, {
      onSuccess: done,
      onError: (err) => toast.error(message(err, "Couldn't post the comment")),
    });
  };

  return (
    <section
      aria-label="Comments"
      data-testid="comments-panel"
      className={cn('flex min-h-0 flex-col bg-app', className)}
    >
      {showHeading && (
        <h2 className="flex shrink-0 items-center gap-2 px-4 pt-3 pb-2 font-semibold">
          Comments
          <span
            data-testid="comments-count"
            className="rounded-xs border border-border px-1.5 text-small font-normal text-text-2"
          >
            {total}
          </span>
        </h2>
      )}
      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4">
        {query.isPending ? (
          <div className="grid gap-3 py-2" aria-busy="true">
            <Skeleton className="h-10" />
            <Skeleton className="h-10" />
          </div>
        ) : query.isError ? (
          <p role="alert" className="py-6 text-center text-text-2">
            Couldn't load the comments.
          </p>
        ) : count === 0 ? (
          <p className="py-6 text-center text-text-2">No comments yet.</p>
        ) : (
          <>
            {hasEarlier && (
              <div className="flex items-center justify-center gap-2 pt-2">
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={earlier === 'loading'}
                  onClick={() => void loadEarlier()}
                >
                  {earlier === 'loading' ? 'Loading…' : 'Load earlier comments'}
                </Button>
                {earlier === 'error' && (
                  <span role="alert" className="text-small text-danger">
                    Couldn't load them.
                  </span>
                )}
              </div>
            )}
            <ol ref={list} className="divide-y divide-border" aria-label="Comment list">
              {comments.map((c) => (
                <CommentItem
                  key={c.id}
                  highlighted={c.id === focusCommentId}
                  comment={c}
                  canComment={canComment}
                  canModerate={canModerate}
                  tableId={tableId}
                  mutations={mutations}
                />
              ))}
            </ol>
          </>
        )}
        <div ref={end} />
      </div>
      <div className="shrink-0 p-3">
        {canComment ? (
          <Composer
            tableId={tableId}
            label="Write a comment"
            submitLabel="Send"
            pending={mutations.create.isPending}
            onSubmit={send}
          />
        ) : (
          <p className="px-1 text-small text-text-2">
            You can read comments. Commenters and up can write them.
          </p>
        )}
      </div>
    </section>
  );
}

type Mutations = ReturnType<typeof useCommentMutations>;

function CommentItem({
  comment,
  highlighted,
  canComment,
  canModerate,
  tableId,
  mutations,
}: {
  comment: Comment;
  highlighted: boolean;
  canComment: boolean;
  canModerate: boolean;
  tableId: string;
  mutations: Mutations;
}) {
  const { byId, meId, loaded } = useDirectory();
  const [editing, setEditing] = useState(false);
  const author = comment.authorId ? byId.get(comment.authorId) : undefined;
  const mine = comment.authorId !== null && comment.authorId === meId;
  const name = author?.name ?? (loaded ? 'Former member' : '');
  const canDelete = canComment && (mine || canModerate);

  const react = (reaction: CommentReaction, on: boolean) =>
    mutations.react.mutate(
      { commentId: comment.id, reaction, on },
      { onError: (err) => toast.error(message(err, "Couldn't save the reaction")) }
    );

  return (
    <li
      data-testid="comment"
      data-comment-id={comment.id}
      aria-current={highlighted ? 'true' : undefined}
      className={cn('group flex gap-3 py-3', highlighted && '-mx-2 rounded-sm bg-selected px-2')}
    >
      {author ? (
        <Avatar person={author} className="mt-0.5 size-7 text-[11px]" />
      ) : (
        <span aria-hidden className="mt-0.5 size-7 shrink-0 rounded-full bg-hover" />
      )}
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="truncate font-semibold">{name}</span>
          <time
            dateTime={comment.createdAt}
            title={comment.createdAt}
            className="text-small text-text-2"
          >
            {relativeTime(comment.createdAt)}
          </time>
          {comment.editedAt && <span className="text-small text-text-2">(edited)</span>}
          {(mine || canDelete) && canComment && !editing && (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label="Comment actions"
                  className="ml-auto opacity-0 group-hover:opacity-100 focus-visible:opacity-100 data-[state=open]:opacity-100 pointer-coarse:opacity-100"
                >
                  <Ellipsis className="size-4" aria-hidden />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                {mine && (
                  <DropdownMenuItem onSelect={() => setEditing(true)}>
                    <Pencil className="size-4" aria-hidden />
                    Edit comment
                  </DropdownMenuItem>
                )}
                {canDelete && (
                  <DropdownMenuItem
                    className="text-danger"
                    onSelect={() =>
                      mutations.remove.mutate(comment.id, {
                        onSuccess: () => toast('Comment deleted'),
                        onError: (err) => toast.error(message(err, "Couldn't delete the comment")),
                      })
                    }
                  >
                    <Trash2 className="size-4" aria-hidden />
                    Delete comment
                  </DropdownMenuItem>
                )}
              </DropdownMenuContent>
            </DropdownMenu>
          )}
        </div>
        {editing ? (
          <div className="mt-1">
            <Composer
              tableId={tableId}
              label="Edit comment"
              submitLabel="Save"
              initialBody={comment.body}
              autoFocus
              pending={mutations.update.isPending}
              onCancel={() => setEditing(false)}
              onSubmit={(body) => {
                mutations.update.mutate(
                  { commentId: comment.id, body },
                  {
                    onSuccess: () => setEditing(false),
                    onError: (err) => toast.error(message(err, "Couldn't save the comment")),
                  }
                );
              }}
            />
          </div>
        ) : (
          <RichText text={comment.body} comment className="mt-0.5 min-w-0 break-words" />
        )}
        {(comment.reactions.length > 0 || canComment) && !editing && (
          <div className="mt-1.5 flex flex-wrap items-center gap-1">
            {comment.reactions.map((r) => {
              const pressed = meId !== undefined && r.userIds.includes(meId);
              const who = r.userIds.map((id) => byId.get(id)?.name ?? 'Former member').join(', ');
              return (
                <Tooltip key={r.reaction} content={who}>
                  <button
                    type="button"
                    aria-pressed={pressed}
                    aria-label={`${r.reaction}: ${r.userIds.length}`}
                    disabled={!canComment}
                    onClick={() => react(r.reaction, !pressed)}
                    className={cn(
                      'inline-flex h-6 items-center gap-1 rounded-full border border-border bg-surface px-2 text-small outline-none hover:border-border-strong focus-visible:border-brand disabled:hover:border-border',
                      pressed && 'border-primary bg-selected'
                    )}
                  >
                    <span aria-hidden>{COMMENT_REACTIONS[r.reaction]}</span>
                    {r.userIds.length}
                  </button>
                </Tooltip>
              );
            })}
            {canComment && (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label="Add reaction"
                    className="size-6 opacity-0 group-hover:opacity-100 focus-visible:opacity-100 data-[state=open]:opacity-100 pointer-coarse:opacity-100"
                  >
                    <SmilePlus className="size-4" aria-hidden />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="start" className="flex min-w-0 gap-0.5 p-1">
                  {COMMENT_REACTION_KEYS.map((key) => {
                    const on =
                      meId !== undefined &&
                      comment.reactions.some((r) => r.reaction === key && r.userIds.includes(meId));
                    return (
                      <DropdownMenuItem
                        key={key}
                        aria-label={key}
                        className={cn('justify-center px-1.5 text-[16px]', on && 'bg-selected')}
                        onSelect={() => react(key, !on)}
                      >
                        {COMMENT_REACTIONS[key]}
                      </DropdownMenuItem>
                    );
                  })}
                </DropdownMenuContent>
              </DropdownMenu>
            )}
          </div>
        )}
      </div>
    </li>
  );
}
