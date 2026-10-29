import type { Page, Route } from '@playwright/test';
import { IDS } from './mockApi.js';

// The interface routes in memory, for the mocked-API specs (interfaces-designer,
// interfaces-dashboard): pages with a draft and a published copy, as the server keeps them.

export type MockPage = {
  id: string;
  interfaceId: string;
  name: string;
  position: number;
  draft: { elements: { id: string; type: string; x: number }[] } | null;
  published: unknown;
  publishedAt: string | null;
  hasChanges: boolean;
};
export type MockInterface = {
  id: string;
  baseId: string;
  name: string;
  position: number;
  pages: MockPage[];
};

export const PREFIX = `/api/bases/${IDS.base}/interfaces`;

/** The interface routes, in memory; `canEdit` as for a creator (true) or a viewer. */
export async function mockInterfaces(page: Page, canEdit: boolean, start: MockInterface[] = []) {
  const state = { interfaces: start, n: 0 };
  const id = () => `0190e000-0000-7000-8000-${String(++state.n).padStart(12, '0')}`;
  const json = (route: Route, data: unknown, status = 200) =>
    route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(data) });
  const view = (p: MockPage): MockPage => ({
    ...p,
    draft: canEdit ? p.draft : null,
    hasChanges: canEdit && JSON.stringify(p.draft) !== JSON.stringify(p.published),
  });
  await page.route(`**${PREFIX}**`, async (route) => {
    const req = route.request();
    const path = new URL(req.url()).pathname;
    const body = req.postData() ? JSON.parse(req.postData() ?? '{}') : {};
    const method = req.method();
    if (path === PREFIX && method === 'GET') {
      return json(route, {
        canEdit,
        interfaces: state.interfaces
          .map((i) => ({
            ...i,
            pages: i.pages.filter((p) => canEdit || p.published !== null).map(view),
          }))
          .filter((i) => canEdit || i.pages.length > 0),
      });
    }
    if (!canEdit) return json(route, { title: 'Forbidden', status: 403 }, 403);
    if (path === PREFIX && method === 'POST') {
      const iface = { id: id(), baseId: IDS.base, name: body.name, position: 1, pages: [] };
      state.interfaces.push(iface);
      return json(route, iface, 201);
    }
    const m = path.match(/\/interfaces\/([^/]+)\/pages(?:\/([^/]+))?(?:\/(publish|unpublish))?$/);
    const iface = state.interfaces.find((i) => i.id === m?.[1]);
    if (!m || !iface) return json(route, {}, 404);
    if (!m[2] && method === 'POST') {
      const p: MockPage = {
        id: id(),
        interfaceId: iface.id,
        name: body.name,
        position: iface.pages.length + 1,
        draft: { layout: body.layout, tableId: body.tableId, sorts: [], fields: [], elements: [] },
        published: null,
        publishedAt: null,
        hasChanges: true,
      } as MockPage;
      iface.pages.push(p);
      return json(route, view(p), 201);
    }
    const p = iface.pages.find((x) => x.id === m[2]);
    if (!p) return json(route, {}, 404);
    if (m[3] === 'publish') {
      p.published = p.draft;
      p.publishedAt = new Date().toISOString();
    } else if (m[3] === 'unpublish') {
      p.published = null;
    } else if (method === 'PATCH') {
      if (body.draft) p.draft = body.draft;
      if (body.name) p.name = body.name;
    }
    return json(route, view(p));
  });
  return state;
}
