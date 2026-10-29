import type { Notification } from '@openrows/shared';

/** The bell's badge: the count, capped at "99+". */
export function badgeCount(unread: number): string {
  return unread > 99 ? '99+' : String(unread);
}

/** One line saying what happened: "Ada mentioned you on Launch plan". */
export function notificationTitle(n: Notification): string {
  const record = n.recordName.trim() || 'Unnamed record';
  switch (n.kind) {
    case 'mention':
      return `${n.actorName} mentioned you on ${record}`;
    case 'reply':
      return `${n.actorName} replied on ${record}`;
    case 'assigned':
      return n.fieldName
        ? `${n.actorName} added you to ${n.fieldName} on ${record}`
        : `${n.actorName} assigned you ${record}`;
  }
}
