import { ScrollTextIcon, XIcon } from 'lucide-react';
import { useDismissNotice, useNotices } from '../../api/queries';
import { Button } from '../../components/ui';
import { noticeWhen } from './model';

/**
 * Service notices on every signed-in page: a Terms, privacy, price or plan change the
 * operator announced (also by email), with the date it takes effect and a link to the details.
 * Dismissed per user on the server, so it stays dismissed on every device. Ledger: a neutral
 * fill, never a coloured left border.
 */
export function NoticeBanner() {
  const notices = useNotices();
  const dismiss = useDismissNotice();
  const list = notices.data?.notices ?? [];
  if (list.length === 0) return null;
  return (
    <>
      {list.map((n) => (
        <section
          key={n.id}
          aria-label="Service notice"
          data-testid="notice-banner"
          data-kind={n.kind}
          className="flex shrink-0 items-start gap-2 border-b border-border bg-header px-3 py-2 md:px-6"
        >
          <ScrollTextIcon aria-hidden className="mt-0.5 size-4 shrink-0 text-text-2" />
          <div className="min-w-0 flex-1">
            <p>
              <span className="font-[550]">{n.title}</span>{' '}
              <span className="text-text-2">{noticeWhen(n)}</span>
            </p>
            <p className="line-clamp-2 text-text-2">{n.summary}</p>
          </div>
          <div className="flex shrink-0 items-center gap-1">
            <Button variant="ghost" size="sm" asChild>
              <a href={n.url} target="_blank" rel="noopener noreferrer">
                Read the details
              </a>
            </Button>
            <Button
              variant="ghost"
              size="icon"
              aria-label={`Dismiss notice: ${n.title}`}
              onClick={() => dismiss.mutate(n.id)}
            >
              <XIcon />
            </Button>
          </div>
        </section>
      ))}
    </>
  );
}
