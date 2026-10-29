import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TooltipProvider } from '../../components/ui';
import { BANNER_DELAY_MS, ConnectionStatus, OfflineBanner } from './ConnectionStatus';
import { RealtimeConnection } from './connection';
import { RealtimeProvider, useRealtimeSubscription } from './RealtimeProvider';

const TABLE = '0190a000-0000-7000-8000-00000000000a';

class FakeSocket {
  onmessage: ((ev: MessageEvent) => void) | null = null;
  onclose: ((ev: CloseEvent) => void) | null = null;
  send() {}
  close() {}
}

function Page() {
  useRealtimeSubscription({ tableId: TABLE });
  return (
    <>
      <ConnectionStatus />
      <OfflineBanner />
    </>
  );
}

function renderPage() {
  const sockets: FakeSocket[] = [];
  const conn = new RealtimeConnection({
    createSocket: () => {
      const s = new FakeSocket();
      sockets.push(s);
      return s;
    },
    fetchEvents: async (_b, since) => ({ events: [], next: since, hasMore: false }),
    onEvents: () => {},
    onResync: () => {},
  });
  render(
    <QueryClientProvider client={new QueryClient()}>
      <TooltipProvider>
        <RealtimeProvider connection={conn}>
          <Page />
        </RealtimeProvider>
      </TooltipProvider>
    </QueryClientProvider>
  );
  const ready = () =>
    act(() =>
      sockets.at(-1)?.onmessage?.(
        new MessageEvent('message', {
          data: JSON.stringify({ type: 'ready', userId: '0190a000-0000-7000-8000-0000000000ff' }),
        })
      )
    );
  const drop = () => act(() => sockets.at(-1)?.onclose?.(new CloseEvent('close', { code: 1006 })));
  return { conn, ready, drop };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('connection status', () => {
  it('shows connecting, live and reconnecting; the banner only after a few seconds down', () => {
    const t = renderPage();
    const status = () => screen.getByTestId('connection-status');
    expect(status().getAttribute('data-status')).toBe('connecting');
    t.ready();
    expect(status().getAttribute('data-status')).toBe('live');
    expect(status().getAttribute('aria-label')).toBe('Live updates: Live');
    expect(screen.queryByTestId('offline-banner')).toBeNull();

    t.drop();
    expect(status().getAttribute('data-status')).toBe('reconnecting');
    // A quick reconnect shows no banner.
    act(() => vi.advanceTimersByTime(BANNER_DELAY_MS - 1));
    expect(screen.queryByTestId('offline-banner')).toBeNull();
    act(() => vi.advanceTimersByTime(1));
    expect(screen.getByTestId('offline-banner').textContent).toContain('Connection lost');
    // The retry opens a socket; once it's live the banner goes.
    act(() => vi.advanceTimersByTime(1000));
    t.ready();
    expect(screen.queryByTestId('offline-banner')).toBeNull();
  });

  it("leaves an offline browser to the app's offline banner (#144)", () => {
    const t = renderPage();
    t.ready();
    act(() => t.conn.offline());
    expect(screen.getByTestId('connection-status').getAttribute('data-status')).toBe('offline');
    act(() => vi.advanceTimersByTime(BANNER_DELAY_MS * 2));
    expect(screen.queryByTestId('offline-banner')).toBeNull();
  });
});
