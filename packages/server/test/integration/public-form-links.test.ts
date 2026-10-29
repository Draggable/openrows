import type {
  CreatedShare,
  FieldMeta,
  FormLayout,
  FormLinkRecords,
  PublicForm,
  RecordData,
  TableMeta,
  ViewMeta,
} from '@openrows/shared';
import { uuidv7 } from 'uuidv7';
import { beforeAll, describe, expect, it } from 'vitest';
import { SESSION_COOKIE } from '../../src/auth/session-token.js';
import type { users } from '../../src/db/index.js';
import { testApp } from '../helpers/app.js';
import { useTestDb } from '../helpers/db.js';
import { createSession, createWorkspace } from '../helpers/factories.js';

/**
 * Public forms' linked record fields and the "allow via forms" override. A link field's
 * picker (`GET /api/forms/:token/fields/:fieldId/records`) lists only the records of the view
 * the form's creator chose, by primary field; a submission may only pick those. People fields
 * stay off public forms. A field editors can't edit is on the public form only when it allows
 * forms.
 */
describe('public forms: linked records and permission overrides', () => {
  const t = useTestDb();
  let owner: typeof users.$inferSelect;
  let workspaceId: string;
  let app: ReturnType<typeof testApp>;
  let ownerCookie: string;

  const request = (method: string, path: string, body?: unknown, cookie?: string) =>
    app.app.request(path, {
      method,
      headers: {
        origin: app.config.appUrl,
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
        ...(cookie ? { cookie: `${SESSION_COOKIE}=${cookie}` } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
  const asOwner = (method: string, path: string, body?: unknown) =>
    request(method, path, body, ownerCookie);

  async function ok<T>(res: Response | Promise<Response>, status = 200): Promise<T> {
    const r = await res;
    if (r.status !== status) throw new Error(`${r.status}: ${await r.text()}`);
    return (await r.json()) as T;
  }

  const problemPaths = async (res: Response) => {
    expect(res.status).toBe(422);
    const body = (await res.json()) as { errors?: { path: string }[] };
    return (body.errors ?? []).map((e) => e.path).sort();
  };

  interface Fixture {
    baseId: string;
    requests: TableMeta;
    teams: TableMeta;
    name: FieldMeta;
    team: FieldMeta;
    person: FieldMeta;
    secret: FieldMeta;
    teamName: FieldMeta;
    teamNote: FieldMeta;
    active: ViewMeta;
    all: ViewMeta;
    form: ViewMeta;
    token: string;
    /** Team records by name: Alpha, Beta (active), Gamma (inactive). */
    teamIds: Record<string, string>;
  }

  async function fixture(layout?: (f: Omit<Fixture, 'form' | 'token'>) => FormLayout) {
    const base = await ok<{ id: string }>(
      asOwner('POST', `/api/workspaces/${workspaceId}/bases`, { name: 'Base' }),
      201
    );
    const table = (name: string) =>
      ok<TableMeta>(asOwner('POST', `/api/bases/${base.id}/tables`, { name }), 201);
    const requests = await table('Requests');
    const teams = await table('Teams');
    const field = (tableId: string, body: unknown) =>
      ok<FieldMeta>(asOwner('POST', `/api/tables/${tableId}/fields`, body), 201);
    const primary = (tm: TableMeta) => {
      const p = tm.fields.find((f) => f.isPrimary);
      if (!p) throw new Error('no primary field');
      return p;
    };
    const teamNote = await field(teams.id, { name: 'Budget note', type: 'singleLineText' });
    const isActive = await field(teams.id, { name: 'Active', type: 'checkbox' });
    const teamName = primary(teams);
    const teamIds: Record<string, string> = {};
    for (const [name, on] of [
      ['Alpha', true],
      ['Beta', true],
      ['Gamma', false],
    ] as const) {
      const r = await ok<RecordData>(
        asOwner('POST', `/api/tables/${teams.id}/records`, {
          fields: { [teamName.id]: name, [isActive.id]: on, [teamNote.id]: `${name} secret` },
        }),
        201
      );
      teamIds[name] = r.id;
    }
    const view = (tableId: string, body: unknown) =>
      ok<ViewMeta>(asOwner('POST', `/api/tables/${tableId}/views`, body), 201);
    const active = await view(teams.id, { name: 'Active teams' });
    await ok(
      asOwner('PATCH', `/api/views/${active.id}`, {
        query: {
          filter: { conditions: [{ fieldId: isActive.id, operator: 'is', value: true }] },
          sorts: [{ fieldId: teamName.id, direction: 'desc' }],
        },
      })
    );
    const all = await view(teams.id, { name: 'All teams' });
    const fields = {
      baseId: base.id,
      requests,
      teams,
      name: primary(requests),
      team: await field(requests.id, {
        name: 'Team',
        type: 'link',
        options: { linkedTableId: teams.id },
      }),
      person: await field(requests.id, { name: 'Owner', type: 'user' }),
      secret: await field(requests.id, { name: 'Priority', type: 'number' }),
      teamName,
      teamNote,
      active,
      all,
      teamIds,
    };
    const form = await view(requests.id, { name: 'Intake', type: 'form' });
    const wanted: FormLayout = layout?.(fields) ?? {
      fields: [
        { fieldId: fields.name.id, required: true },
        { fieldId: fields.team.id, viewIdForRecordSelection: active.id },
        { fieldId: fields.person.id },
      ],
    };
    await ok(asOwner('PATCH', `/api/views/${form.id}`, { form: wanted }));
    const { token } = await ok<CreatedShare>(
      asOwner('POST', `/api/views/${form.id}/shares`, {}),
      201
    );
    return { ...fields, form, token };
  }

  const picker = (token: string, fieldId: string, query = '') =>
    request('GET', `/api/forms/${token}/fields/${fieldId}/records${query}`);
  const submit = (token: string, fields: Record<string, unknown>) =>
    request('POST', `/api/forms/${token}/submissions`, { submissionId: uuidv7(), fields });

  beforeAll(async () => {
    const created = await createWorkspace(t.db);
    owner = created.owner;
    workspaceId = created.workspace.id;
    app = testApp({ db: t.appDb });
    ownerCookie = await createSession(t.db, owner);
  });

  it('shows a link field with a chosen view, never people fields', async () => {
    const f = await fixture();
    const form = await ok<PublicForm>(request('GET', `/api/forms/${f.token}`));
    expect(form.fields.map((x) => x.id)).toEqual([f.name.id, f.team.id]);
    const text = JSON.stringify(form);
    // Neither the linked table, its view nor the people field leak.
    for (const id of [f.teams.id, f.active.id, f.person.id, owner.id]) {
      expect(text).not.toContain(id);
    }
    expect(await problemPaths(await submit(f.token, { [f.person.id]: [owner.id] }))).toEqual([
      `fields.${f.person.id}`,
    ]);
  });

  it("lists only the chosen view's records, by primary field, searched and paged", async () => {
    const f = await fixture();
    const page = await ok<FormLinkRecords>(picker(f.token, f.team.id));
    // The view's filter (active only) and sort (name descending).
    expect(page).toEqual({
      records: [
        { id: f.teamIds['Beta'], name: 'Beta' },
        { id: f.teamIds['Alpha'], name: 'Alpha' },
      ],
      nextOffset: null,
    });
    expect(JSON.stringify(page)).not.toContain('secret');
    const searched = await ok<FormLinkRecords>(picker(f.token, f.team.id, '?search=alp'));
    expect(searched.records.map((r) => r.name)).toEqual(['Alpha']);
    // A record outside the view can't be found by name...
    const gamma = await ok<FormLinkRecords>(picker(f.token, f.team.id, '?search=Gamma'));
    expect(gamma.records).toEqual([]);
    // ...and other fields aren't searched (no probing hidden values).
    const probe = await ok<FormLinkRecords>(picker(f.token, f.team.id, '?search=secret'));
    expect(probe.records).toEqual([]);
    const first = await ok<FormLinkRecords>(picker(f.token, f.team.id, '?limit=1'));
    expect(first).toEqual({ records: [{ id: f.teamIds['Beta'], name: 'Beta' }], nextOffset: 1 });
    const second = await ok<FormLinkRecords>(picker(f.token, f.team.id, '?limit=1&offset=1'));
    expect(second.records.map((r) => r.name)).toEqual(['Alpha']);
    // Strict query, capped page size.
    expect((await picker(f.token, f.team.id, '?limit=51')).status).toBe(422);
    expect((await picker(f.token, f.team.id, '?fields=x')).status).toBe(422);
    expect((await picker(f.token, f.team.id, '?viewId=x')).status).toBe(422);
  });

  it("can't enumerate other fields, tables, bases or forms through the picker", async () => {
    const f = await fixture();
    const other = await fixture();
    // Fields that aren't a pickable link on this form: the primary field, the people field, a
    // field of the linked table, a link field of another form's table, made-up and bad ids.
    for (const fieldId of [
      f.name.id,
      f.person.id,
      f.teamName.id,
      f.teamNote.id,
      other.team.id,
      uuidv7(),
    ]) {
      expect((await picker(f.token, fieldId)).status, fieldId).toBe(404);
    }
    expect((await picker(f.token, 'not-a-uuid')).status).toBe(404);
    expect((await picker('A'.repeat(43), f.team.id)).status).toBe(404);
    // The other form's token can't list this form's field, nor the other way round.
    expect((await picker(other.token, f.team.id)).status).toBe(404);
    // A link field on the form without a chosen view is off the public form: no picker.
    const noView = await fixture((x) => ({
      fields: [{ fieldId: x.name.id }, { fieldId: x.team.id }],
    }));
    expect((await picker(noView.token, noView.team.id)).status).toBe(404);
    const form = await ok<PublicForm>(request('GET', `/api/forms/${noView.token}`));
    expect(form.fields.map((x) => x.id)).toEqual([noView.name.id]);
  });

  it('submits picked records of the view, and refuses any other record', async () => {
    const f = await fixture();
    const res = await submit(f.token, {
      [f.name.id]: 'Need access',
      [f.team.id]: [f.teamIds['Alpha'], f.teamIds['Beta']],
    });
    expect(res.status).toBe(201);
    const { records } = await ok<{ records: RecordData[] }>(
      asOwner('GET', `/api/tables/${f.requests.id}/records`)
    );
    expect(records[0]?.fields[f.team.id]).toEqual([
      { id: f.teamIds['Alpha'], name: 'Alpha' },
      { id: f.teamIds['Beta'], name: 'Beta' },
    ]);
    // The inverse side follows, as for any link write.
    const alpha = await ok<RecordData>(
      asOwner('GET', `/api/tables/${f.teams.id}/records/${f.teamIds['Alpha']}`)
    );
    const inverseId = (f.team.options as { inverseLinkFieldId: string }).inverseLinkFieldId;
    expect(alpha.fields[inverseId]).toEqual([{ id: records[0]?.id, name: 'Need access' }]);

    const other = await fixture();
    const otherTeam = other.teamIds['Alpha'];
    for (const bad of [
      [f.teamIds['Gamma']], // outside the view
      [otherTeam], // another base's record
      [f.teamIds['Alpha'], f.teamIds['Gamma']],
      [uuidv7()],
      ['Alpha'], // names aren't matched: pick from the list
      [{ name: 'Alpha' }],
    ]) {
      const refused = await submit(f.token, { [f.name.id]: 'x', [f.team.id]: bad });
      expect(await problemPaths(refused), JSON.stringify(bad)).toEqual([`fields.${f.team.id}`]);
    }
    // A request record can't be linked as a team either.
    const res2 = await submit(f.token, { [f.name.id]: 'x', [f.team.id]: [records[0]?.id] });
    expect(await problemPaths(res2)).toEqual([`fields.${f.team.id}`]);
    expect(
      (await ok<{ records: RecordData[] }>(asOwner('GET', `/api/tables/${f.requests.id}/records`)))
        .records
    ).toHaveLength(1);
  });

  it('honours "link to a single record" and the cap on picked records', async () => {
    const f = await fixture();
    await ok(
      asOwner('PATCH', `/api/fields/${f.team.id}`, {
        options: { linkedTableId: f.teams.id, prefersSingleRecordLink: true },
      })
    );
    const two = await submit(f.token, {
      [f.name.id]: 'x',
      [f.team.id]: [f.teamIds['Alpha'], f.teamIds['Beta']],
    });
    expect(await problemPaths(two)).toEqual([`fields.${f.team.id}`]);
    expect(
      (await submit(f.token, { [f.name.id]: 'x', [f.team.id]: [f.teamIds['Alpha']] })).status
    ).toBe(201);
  });

  it("follows the view: records leaving it, a deleted view, the field's own limit", async () => {
    const f = await fixture();
    // The field's own "limit record selection to a view" applies too.
    const limited = await ok<ViewMeta>(
      asOwner('POST', `/api/tables/${f.teams.id}/views`, { name: 'Alpha only' }),
      201
    );
    await ok(
      asOwner('PATCH', `/api/views/${limited.id}`, {
        query: {
          filter: { conditions: [{ fieldId: f.teamName.id, operator: 'is', value: 'Alpha' }] },
        },
      })
    );
    await ok(
      asOwner('PATCH', `/api/fields/${f.team.id}`, {
        options: { linkedTableId: f.teams.id, viewIdForRecordSelection: limited.id },
      })
    );
    const page = await ok<FormLinkRecords>(picker(f.token, f.team.id));
    expect(page.records.map((r) => r.name)).toEqual(['Alpha']);
    // The form's view goes to the trash: the field leaves the public form.
    expect((await asOwner('DELETE', `/api/views/${f.active.id}`)).status).toBe(204);
    expect((await picker(f.token, f.team.id)).status).toBe(404);
    const form = await ok<PublicForm>(request('GET', `/api/forms/${f.token}`));
    expect(form.fields.map((x) => x.id)).not.toContain(f.team.id);
    expect(
      await problemPaths(
        await submit(f.token, { [f.name.id]: 'x', [f.team.id]: [f.teamIds['Alpha']] })
      )
    ).toEqual([`fields.${f.team.id}`]);
  });

  it('only takes a collaborative view of the linked table as the picker view', async () => {
    const f = await fixture();
    const personal = await ok<ViewMeta>(
      asOwner('POST', `/api/tables/${f.teams.id}/views`, { name: 'Mine', personal: true }),
      201
    );
    const ownTable = await ok<ViewMeta>(
      asOwner('POST', `/api/tables/${f.requests.id}/views`, { name: 'Grid 2' }),
      201
    );
    const other = await fixture();
    for (const viewId of [personal.id, ownTable.id, other.active.id, f.form.id, uuidv7()]) {
      const res = await asOwner('PATCH', `/api/views/${f.form.id}`, {
        form: { fields: [{ fieldId: f.team.id, viewIdForRecordSelection: viewId }] },
      });
      expect(await problemPaths(res), viewId).toEqual(['form.fields.0.viewIdForRecordSelection']);
    }
    const res = await asOwner('PATCH', `/api/views/${f.form.id}`, {
      form: { fields: [{ fieldId: f.name.id, viewIdForRecordSelection: f.all.id }] },
    });
    expect(await problemPaths(res)).toEqual(['form.fields.0.viewIdForRecordSelection']);
    await ok(
      asOwner('PATCH', `/api/views/${f.form.id}`, {
        form: { fields: [{ fieldId: f.team.id, viewIdForRecordSelection: f.all.id }] },
      })
    );
    const page = await ok<FormLinkRecords>(picker(f.token, f.team.id));
    expect(page.records).toHaveLength(3);
  });

  it('puts a locked field on the public form only when it allows forms', async () => {
    const f = await fixture((x) => ({
      fields: [{ fieldId: x.name.id }, { fieldId: x.secret.id }],
    }));
    const lock = (permissions: unknown) =>
      ok<FieldMeta>(asOwner('PATCH', `/api/fields/${f.secret.id}`, { permissions }));
    await lock({ edit: { level: 'creators' } });
    let form = await ok<PublicForm>(request('GET', `/api/forms/${f.token}`));
    expect(form.fields.map((x) => x.id)).toEqual([f.name.id]);
    expect(await problemPaths(await submit(f.token, { [f.secret.id]: 3 }))).toEqual([
      `fields.${f.secret.id}`,
    ]);

    const field = await lock({ edit: { level: 'creators' }, allowForms: true });
    expect(field.permissions).toEqual({ edit: { level: 'creators' }, allowForms: true });
    form = await ok<PublicForm>(request('GET', `/api/forms/${f.token}`));
    expect(form.fields.map((x) => x.id)).toEqual([f.name.id, f.secret.id]);
    expect((await submit(f.token, { [f.name.id]: 'A', [f.secret.id]: 3 })).status).toBe(201);
    const { records } = await ok<{ records: RecordData[] }>(
      asOwner('GET', `/api/tables/${f.requests.id}/records`)
    );
    expect(records[0]?.fields[f.secret.id]).toBe(3);
  });

  it("needs the link's inverse field to be fillable too, or to allow forms", async () => {
    const f = await fixture();
    const inverseId = (f.team.options as { inverseLinkFieldId: string }).inverseLinkFieldId;
    await ok(
      asOwner('PATCH', `/api/fields/${inverseId}`, { permissions: { edit: { level: 'nobody' } } })
    );
    let form = await ok<PublicForm>(request('GET', `/api/forms/${f.token}`));
    expect(form.fields.map((x) => x.id)).toEqual([f.name.id]);
    await ok(
      asOwner('PATCH', `/api/fields/${inverseId}`, {
        permissions: { edit: { level: 'nobody' }, allowForms: true },
      })
    );
    form = await ok<PublicForm>(request('GET', `/api/forms/${f.token}`));
    expect(form.fields.map((x) => x.id)).toEqual([f.name.id, f.team.id]);
    expect(
      (await submit(f.token, { [f.name.id]: 'x', [f.team.id]: [f.teamIds['Beta']] })).status
    ).toBe(201);
  });
});
