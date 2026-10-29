import { contracts, type MeResponse } from '@openrows/shared';
import { vi } from 'vitest';

export const ME: MeResponse = {
  user: {
    id: '0192f1d2-3c4b-7a6e-8f90-a1b2c3d4e5f6',
    email: 'ada@example.test',
    name: 'Ada Lovelace',
    avatarUrl: null,
    isSystemAdmin: false,
  },
  session: { createdAt: '2026-10-25T10:00:00.000Z', expiresAt: '2026-11-24T10:00:00.000Z' },
};

/** Stubs fetch so `/api/me` answers as signed in (`me`) or signed out (401 problem+json). */
export function stubMe(me: MeResponse | null) {
  const fetch = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (!url.endsWith(contracts.me.get.path)) throw new Error(`unexpected fetch ${url}`);
    if (me) return new Response(JSON.stringify(me), { status: 200 });
    return new Response(
      JSON.stringify({
        type: 'https://openrows.io/problems/unauthenticated',
        title: 'Authentication required',
        status: 401,
        code: 'UNAUTHENTICATED',
        requestId: 'test',
      }),
      { status: 401, headers: { 'content-type': 'application/problem+json' } }
    );
  });
  vi.stubGlobal('fetch', fetch);
  return fetch;
}
