import type { Notice } from '@openrows/shared';

/** "December 1, 2026": the day a notice's change takes effect (UTC, as the email says it). */
export function noticeDate(iso: string): string {
  return new Date(iso).toLocaleDateString('en-US', {
    timeZone: 'UTC',
    month: 'long',
    day: 'numeric',
    year: 'numeric',
  });
}

/** The banner's line under the title: when the change took or takes effect. */
export function noticeWhen(notice: Pick<Notice, 'effectiveAt'>, now = Date.now()): string {
  const day = noticeDate(notice.effectiveAt);
  return new Date(notice.effectiveAt).getTime() > now
    ? `Takes effect on ${day}.`
    : `In effect since ${day}.`;
}
