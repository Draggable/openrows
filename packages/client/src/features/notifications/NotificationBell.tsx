import type { Notification } from '@openrows/shared';
import { useNavigate } from '@tanstack/react-router';
import { BellIcon } from 'lucide-react';
import { useState } from 'react';
import {
  useMarkAllNotificationsRead,
  useMarkNotificationRead,
  useNotifications,
  useUnreadNotifications,
} from '../../api/queries';
import { Button, Popover, PopoverContent, PopoverTrigger, Spinner } from '../../components/ui';
import { cn } from '../../lib/utils';
import { relativeTime } from '../record/model';
import { badgeCount, notificationTitle } from './model';

/**
 * The bell in the top bar: the unread count (live through the realtime hint, polled without
 * a socket) and the inbox popover. Opening a notification marks it read and goes to its record
 * (and comment) through the table's deep link.
 */
export function NotificationBell() {
  const [open, setOpen] = useState(false);
  const unread = useUnreadNotifications().data?.unread ?? 0;
  const label = unread > 0 ? `Notifications, ${unread} unread` : 'Notifications';
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button variant="ghost" size="icon" aria-label={label} className="relative">
          <BellIcon />
          {unread > 0 && (
            <span
              data-testid="notification-count"
              aria-hidden
              className="-right-1 -top-1 absolute flex h-4 min-w-4 items-center justify-center rounded-full bg-primary px-1 font-[600] text-[10px] text-primary-foreground leading-none"
            >
              {badgeCount(unread)}
            </span>
          )}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-[min(380px,calc(100vw-16px))] p-0">
        <Inbox unread={unread} onDone={() => setOpen(false)} />
      </PopoverContent>
    </Popover>
  );
}

function Inbox({ unread, onDone }: { unread: number; onDone: () => void }) {
  const list = useNotifications(true);
  const markAll = useMarkAllNotificationsRead();
  const items = list.data?.pages.flatMap((p) => p.notifications) ?? [];
  return (
    <section aria-label="Notifications" className="flex max-h-[min(520px,70vh)] flex-col">
      <header className="flex items-center justify-between gap-2 border-border border-b px-3 py-2">
        <h2 className="font-semibold">Notifications</h2>
        <Button
          variant="ghost"
          size="sm"
          disabled={unread === 0 || markAll.isPending}
          onClick={() => markAll.mutate()}
        >
          Mark all as read
        </Button>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {list.isPending ? (
          <div className="flex justify-center p-6">
            <Spinner />
          </div>
        ) : list.isError ? (
          <p className="p-4 text-text-2">Couldn't load notifications.</p>
        ) : items.length === 0 ? (
          <p className="p-6 text-center text-text-2">You're all caught up.</p>
        ) : (
          <ul className="divide-y divide-border">
            {items.map((n) => (
              <li key={n.id}>
                <Item notification={n} onDone={onDone} />
              </li>
            ))}
          </ul>
        )}
        {list.hasNextPage && (
          <div className="flex justify-center border-border border-t p-2">
            <Button
              variant="ghost"
              size="sm"
              disabled={list.isFetchingNextPage}
              onClick={() => void list.fetchNextPage()}
            >
              Show older
            </Button>
          </div>
        )}
      </div>
    </section>
  );
}

function Item({ notification: n, onDone }: { notification: Notification; onDone: () => void }) {
  const navigate = useNavigate();
  const markRead = useMarkNotificationRead();
  const isUnread = n.readAt === null;
  const open = () => {
    if (isUnread) markRead.mutate(n.id);
    onDone();
    void navigate({
      to: '/b/$baseId/$tableId',
      params: { baseId: n.baseId, tableId: n.tableId },
      search: { record: n.recordId, ...(n.commentId ? { comment: n.commentId } : {}) },
    });
  };
  return (
    <button
      type="button"
      onClick={open}
      className="flex w-full gap-2.5 px-3 py-2.5 text-left hover:bg-hover focus-visible:bg-hover focus-visible:outline-none"
    >
      <span
        aria-hidden
        className={cn('mt-1.5 size-2 shrink-0 rounded-full', isUnread && 'bg-primary')}
      />
      <span className="min-w-0 flex-1">
        <span className={cn('block', isUnread ? 'font-[550]' : 'text-text-2')}>
          {notificationTitle(n)}
        </span>
        {n.excerpt && <span className="mt-0.5 line-clamp-2 block text-text-2">{n.excerpt}</span>}
        <span className="mt-0.5 block truncate text-small text-text-3">
          {n.baseName} · {n.tableName} · {relativeTime(n.createdAt)}
          {isUnread && <span className="sr-only"> (unread)</span>}
        </span>
      </span>
    </button>
  );
}
