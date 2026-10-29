import { type ApiRequest, contracts, createApiClient } from '@openrows/shared';
import { describe, expect, it } from 'vitest';
import { useTestDb } from '../helpers/db.js';
import { authedClient, createUser } from '../helpers/factories.js';

const ORIGIN = 'http://localhost:5173';

/**
 * The contract test end to end: the typed client the browser uses (built from the shared
 * contracts) drives the real server and database through a whole session. Each call checks the
 * server's status and response body against the contract, so any drift between them fails here.
 */
describe('typed client against the server', () => {
  const t = useTestDb();

  async function apiFor() {
    const client = await authedClient(t, await createUser(t.db));
    const failures: string[] = [];
    const api = createApiClient(contracts, async ({ method, url, body }: ApiRequest) => {
      const res = await client.request(url, {
        method,
        headers: { origin: ORIGIN, 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const text = await res.text();
      const data: unknown = text ? JSON.parse(text) : undefined;
      if (!res.ok) {
        failures.push(`${method} ${url}: ${res.status} ${text}`);
        throw new Error(`${method} ${url} answered ${res.status}`);
      }
      return { status: res.status, data };
    });
    return { api, failures };
  }

  it('walks every resource through the contracts', async () => {
    const { api, failures } = await apiFor();

    const me = await api.me.get();
    const workspace = await api.workspaces.create({ body: { name: 'Acme' } });
    expect((await api.workspaces.list()).workspaces.map((w) => w.id)).toEqual([workspace.id]);
    await api.workspaces.get({ params: { workspaceId: workspace.id } });
    await api.workspaces.update({
      params: { workspaceId: workspace.id },
      body: { name: 'Acme 2' },
    });

    const base = await api.bases.create({
      params: { workspaceId: workspace.id },
      body: { name: 'CRM' },
    });
    expect((await api.bases.list({ params: { workspaceId: workspace.id } })).bases).toHaveLength(1);
    await api.bases.update({ params: { baseId: base.id }, body: { color: '#146C55' } });
    expect((await api.bases.get({ params: { baseId: base.id } })).color).toBe('#146C55');

    // Personal access tokens: created, listed (without the secret), revoked.
    const pat = await api.tokens.create({
      body: { name: 'CI', scopes: ['data.records:read'], baseIds: [base.id] },
    });
    expect(pat.token.startsWith(pat.prefix)).toBe(true);
    expect((await api.tokens.list()).tokens.map((k) => k.id)).toEqual([pat.id]);
    await api.tokens.revoke({ params: { tokenId: pat.id } });
    expect((await api.tokens.list()).tokens).toEqual([]);

    const table = await api.tables.create({ params: { baseId: base.id }, body: { name: 'Leads' } });
    await api.tables.list({ params: { baseId: base.id } });
    await api.tables.update({ params: { tableId: table.id }, body: { description: 'Inbound' } });
    const primary = table.fields.find((f) => f.isPrimary);
    if (!primary) throw new Error('new table without a primary field');

    const amount = await api.fields.create({
      params: { tableId: table.id },
      body: { name: 'Amount', type: 'number' },
    });
    await api.fields.update({ params: { fieldId: amount.id }, body: { name: 'Value' } });
    expect((await api.tables.get({ params: { tableId: table.id } })).fields).toHaveLength(4);

    const one = await api.records.create({
      params: { tableId: table.id },
      body: { fields: { [primary.id]: 'Ada', [amount.id]: 3 } },
    });
    expect('id' in one && one.fields[primary.id]).toBe('Ada');
    const many = await api.records.create({
      params: { tableId: table.id },
      body: { records: [{ fields: { [primary.id]: 'Grace', [amount.id]: 5 } }, { fields: {} }] },
    });
    if (!('records' in many)) throw new Error('bulk create answered one record');
    const [grace, empty] = many.records;
    if (!grace || !empty || !('id' in one)) throw new Error('records missing');

    const page = await api.records.list({ params: { tableId: table.id }, query: { limit: 2 } });
    expect(page.records).toHaveLength(2);
    const next = await api.records.list({
      params: { tableId: table.id },
      query: { limit: 2, cursor: page.nextCursor ?? undefined },
    });
    expect(next.records.map((r) => r.id)).toEqual([empty.id]);

    const updated = await api.records.update({
      params: { tableId: table.id, recordId: one.id },
      body: { fields: { [amount.id]: 4 }, ifVersion: one.version },
    });
    expect(updated.version).toBe(one.version + 1);
    await api.records.updateMany({
      params: { tableId: table.id },
      body: { records: [{ id: grace.id, fields: { [amount.id]: 6 } }] },
    });
    expect(
      (await api.records.get({ params: { tableId: table.id, recordId: grace.id } })).fields[
        amount.id
      ]
    ).toBe(6);

    const result = await api.records.query({
      params: { tableId: table.id },
      body: {
        query: {
          filter: {
            conjunction: 'and',
            conditions: [{ fieldId: amount.id, operator: '>', value: 3 }],
          },
          sorts: [{ fieldId: amount.id, direction: 'desc' }],
        },
        aggregates: [{ fieldId: amount.id, fn: 'sum' }],
      },
    });
    expect(result.records.map((r) => r.id)).toEqual([grace.id, one.id]);
    expect(result.total).toBe(2);
    expect(result.aggregates?.[amount.id]?.['sum']).toBe(10);

    await api.records.deleteMany({
      params: { tableId: table.id },
      body: { recordIds: [grace.id] },
    });
    await api.records.restoreMany({
      params: { tableId: table.id },
      body: { recordIds: [grace.id] },
    });
    expect(
      await api.records.delete({ params: { tableId: table.id, recordId: empty.id } })
    ).toBeNull();

    await api.fields.delete({ params: { fieldId: amount.id } });
    const trash = await api.fields.trash({ params: { tableId: table.id } });
    expect(trash.fields.map((f) => f.id)).toContain(amount.id);
    await api.fields.restore({ params: { tableId: table.id, deletedFieldId: amount.id } });

    const copy = await api.tables.duplicate({
      params: { tableId: table.id },
      body: { includeRecords: true },
    });
    await api.tables.delete({ params: { tableId: copy.id } });

    const { views } = await api.views.list({ params: { tableId: table.id } });
    const [grid] = views;
    if (!grid) throw new Error('no default view');
    const board = await api.views.create({ params: { tableId: table.id }, body: { name: 'Mine' } });
    await api.views.update({ params: { viewId: board.id }, body: { name: 'Mine 2' } });
    const viewCopy = await api.views.duplicate({ params: { viewId: grid.id }, body: {} });
    expect((await api.views.get({ params: { viewId: viewCopy.id } })).name).toBe('Grid view copy');
    expect(await api.views.delete({ params: { viewId: viewCopy.id } })).toBeNull();

    // Share links: made by the signed-in creator, read through the public routes.
    const { share, token } = await api.shares.create({ params: { viewId: grid.id }, body: {} });
    expect((await api.shares.list({ params: { viewId: grid.id } })).shares).toHaveLength(1);
    const sharedParams = { shareToken: token, viewId: grid.id };
    expect((await api.shared.share({ params: { shareToken: token } })).kind).toBe('view');
    expect((await api.shared.view({ params: sharedParams })).view.name).toBe('Grid view');
    const shown = await api.shared.records({ params: sharedParams, query: { limit: 10 } });
    expect(shown.offset).toBe(0);
    expect(
      await api.shared.unlock({ params: { shareToken: token }, body: { password: 'x' } })
    ).toBeNull();
    const changed = await api.shares.update({
      params: { viewId: grid.id, shareId: share.id },
      body: { allowDownload: true },
    });
    expect(changed.allowDownload).toBe(true);
    expect(await api.shares.revoke({ params: { viewId: grid.id, shareId: share.id } })).toBeNull();
    const baseShare = await api.shares.createBase({ params: { baseId: base.id }, body: {} });
    expect((await api.shares.listBase({ params: { baseId: base.id } })).shares).toHaveLength(1);
    expect(
      (
        await api.shares.updateBase({
          params: { baseId: base.id, shareId: baseShare.share.id },
          body: { allowCopy: false },
        })
      ).allowCopy
    ).toBe(false);
    expect(
      await api.shares.revokeBase({ params: { baseId: base.id, shareId: baseShare.share.id } })
    ).toBeNull();

    await api.bases.delete({ params: { baseId: base.id } });

    expect(me.user.id).toBeTruthy();
    expect(failures).toEqual([]);
  });

  it('answers a malformed record id with 404', async () => {
    const { api } = await apiFor();
    const workspace = await api.workspaces.create({ body: { name: 'W' } });
    const base = await api.bases.create({
      params: { workspaceId: workspace.id },
      body: { name: 'B' },
    });
    const table = await api.tables.create({ params: { baseId: base.id }, body: { name: 'T' } });
    await expect(
      api.records.get({ params: { tableId: table.id, recordId: 'not-a-uuid' } })
    ).rejects.toThrow(/answered 404/);
  });
});
