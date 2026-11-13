import { describe, expect, it } from 'vitest';
import schema from './__fixtures__/schema.json' with { type: 'json' };
import type { AirtableTable } from './client.js';
import {
  cellInput,
  formulaProblem,
  mapColor,
  mapFieldType,
  missingFields,
  planTables,
  readableFormula,
  rollupFallbackMessage,
  rollupFunction,
  storedFormula,
  textOf,
} from './mapping.js';

const field = (type: string, options?: Record<string, unknown>) => ({
  id: 'fldAAAAAAAAAAAAAA',
  name: 'F',
  type,
  ...(options ? { options } : {}),
});

describe('Airtable type mapping', () => {
  it('maps every field type of the fixture base, or reports it', () => {
    const plans = planTables(schema.tables as AirtableTable[]);
    const projects = plans[0];
    expect(projects?.fields[0]).toMatchObject({ name: 'Name', isPrimary: true });
    expect(projects?.unsupported.map((u) => u.type)).toEqual(['externalSyncSource']);
    // Links, lookups and counts wait for their tables; attachments are copied.
    const planned = (name: string) => projects?.fields.find((f) => f.name === name);
    expect(planned('Tasks')).toMatchObject({
      type: 'link',
      link: {
        linkedTableId: 'tblTasks000000001',
        inverseLinkFieldId: 'fldTProject000000',
        prefersSingle: false,
      },
    });
    expect(planned('Task names')).toMatchObject({
      type: 'singleLineText',
      computed: {
        type: 'lookup',
        recordLinkFieldId: 'fldTasks000000000',
        fieldIdInLinkedTable: 'fldTTitle00000000',
      },
    });
    expect(planned('Task count')).toMatchObject({ type: 'number', computed: { type: 'count' } });
    // Airtable's API doesn't say which function a rollup uses: its values are kept.
    expect(planned('Effort')).toMatchObject({ type: 'number', converted: expect.any(String) });
    expect(planned('Effort')?.computed).toBeUndefined();
    expect(planned('Files')).toMatchObject({ type: 'attachment' });
    // A formula primary field is planned as text, with its formula for the job to report.
    const tasks = plans[1];
    expect(tasks?.fields[0]).toMatchObject({
      name: 'Task',
      isPrimary: true,
      type: 'singleLineText',
    });
    expect(tasks?.fields[0]?.formula).toContain('{fldTTitle');
    // Created time and created by are live; last modified and autonumber keep Airtable's values.
    expect(planned('Created')).toMatchObject({ type: 'createdTime', options: { timeZone: 'UTC' } });
    expect(planned('Created')?.converted).toBeUndefined();
    expect(planned('Created by')).toMatchObject({ type: 'createdBy' });
    expect(planned('Modified')).toMatchObject({
      type: 'date',
      converted: expect.stringContaining('only some fields'),
    });
    expect(planned('Modified by')).toMatchObject({ type: 'user', converted: expect.any(String) });
    expect(planned('No.')).toMatchObject({
      type: 'number',
      converted: expect.stringContaining("can't take Airtable's numbers"),
    });
  });

  it('makes created time and created by live, except as a primary field', () => {
    const dateOnly = { result: { type: 'date', options: { dateFormat: { name: 'iso' } } } };
    expect(mapFieldType(field('createdTime', dateOnly))).toEqual({
      type: 'createdTime',
      options: { dateFormat: 'iso', timeFormat: '12h', timeZone: 'UTC' },
      converted: expect.stringContaining('time of day'),
    });
    expect(mapFieldType(field('createdTime', dateOnly), { live: false })).toMatchObject({
      type: 'date',
      options: { dateFormat: 'iso' },
    });
    expect(mapFieldType(field('createdBy'))).toEqual({ type: 'createdBy' });
    expect(mapFieldType(field('createdBy'), { live: false })).toMatchObject({
      type: 'user',
      options: { multiple: false },
    });
    const [plan] = planTables([
      {
        id: 'tblAAAAAAAAAAAAAA',
        name: 'T',
        primaryFieldId: 'fldAAAAAAAAAAAAAA',
        fields: [
          {
            id: 'fldAAAAAAAAAAAAAA',
            name: 'Created',
            type: 'createdTime',
            options: { result: { type: 'dateTime', options: { timeZone: 'utc' } } },
          },
          { id: 'fldBBBBBBBBBBBBBB', name: 'By', type: 'createdBy' },
          { id: 'fldCCCCCCCCCCCCCC', name: 'No', type: 'autoNumber' },
        ],
        views: [],
      },
    ]);
    // A primary field can't be computed: it keeps Airtable's values.
    expect(plan?.fields.map((f) => [f.name, f.type])).toEqual([
      ['Created', 'dateTime'],
      ['By', 'createdBy'],
      ['No', 'number'],
    ]);
  });

  it('keeps a primary created by field as a plain user field', () => {
    const [plan] = planTables([
      {
        id: 'tblAAAAAAAAAAAAAA',
        name: 'T',
        primaryFieldId: 'fldAAAAAAAAAAAAAA',
        fields: [{ id: 'fldAAAAAAAAAAAAAA', name: 'By', type: 'createdBy' }],
        views: [],
      },
    ]);
    expect(plan?.fields[0]).toMatchObject({ type: 'user' });
  });

  it("keeps Airtable's options where ours have them", () => {
    expect(mapFieldType(field('currency', { precision: 1, symbol: '£' }))).toEqual({
      type: 'currency',
      options: { precision: 1, currencyCode: 'GBP' },
    });
    expect(mapFieldType(field('currency', { symbol: '¤' }))).toMatchObject({
      options: { currencyCode: 'USD' },
      converted: expect.stringContaining('USD'),
    });
    expect(mapFieldType(field('dateTime', { timeZone: 'client' }))).toMatchObject({
      options: { timeZone: 'UTC', timeFormat: '12h', dateFormat: 'local' },
    });
    expect(mapFieldType(field('duration', { durationFormat: 'h:mm:ss.SS' }))).toMatchObject({
      options: { format: 'h:mm:ss.ss' },
    });
    expect(mapFieldType(field('rating', { max: 20, icon: 'moon' }))).toMatchObject({
      options: { max: 10, icon: 'star' },
    });
    expect(mapFieldType(field('lastModifiedTime', { result: { type: 'date' } }))).toMatchObject({
      type: 'date',
    });
    expect(mapFieldType(field('somethingNew'))).toBeNull();
  });

  it("reads a rollup's function when Airtable gives one", () => {
    expect(rollupFunction('SUM(values)')).toEqual({ function: 'SUM' });
    expect(rollupFunction(' ARRAYJOIN( values , "; ") ')).toEqual({
      function: 'ARRAYJOIN',
      separator: '; ',
    });
    // Airtable's AVERAGE is our AVG; names in any case; escapes in the separator.
    expect(rollupFunction('AVERAGE(values)')).toEqual({ function: 'AVG' });
    expect(rollupFunction('max(values)')).toEqual({ function: 'MAX' });
    expect(rollupFunction("ARRAYJOIN(values, '\\n')")).toEqual({
      function: 'ARRAYJOIN',
      separator: '\n',
    });
    expect(rollupFunction('ARRAYJOIN(values)')).toEqual({ function: 'ARRAYJOIN' });
    for (const name of ['COUNTALL', 'ARRAYUNIQUE', 'ARRAYCOMPACT', 'CONCATENATE', 'XOR']) {
      expect(rollupFunction(`${name}(values)`)).toEqual({ function: name });
    }
    expect(rollupFunction('SUM(values) * 2')).toBeNull();
    expect(rollupFunction('SUM(values, ", ")')).toBeNull();
    expect(rollupFunction('MEDIAN(values)')).toBeNull();
    expect(rollupFunction(undefined)).toBeNull();
  });

  it("plans a rollup with a function we have as live, and says why others keep Airtable's values", () => {
    const rollup = (options: Record<string, unknown>) => {
      const [plan] = planTables([
        {
          id: 'tblAAAAAAAAAAAAAA',
          name: 'T',
          primaryFieldId: 'fldAAAAAAAAAAAAAA',
          fields: [
            { id: 'fldAAAAAAAAAAAAAA', name: 'Name', type: 'singleLineText' },
            { id: 'fldBBBBBBBBBBBBBB', name: 'R', type: 'rollup', options },
          ],
          views: [],
        },
      ]);
      return plan?.fields[1];
    };
    const reads = {
      recordLinkFieldId: 'fldLLLLLLLLLLLLLL',
      fieldIdInLinkedTable: 'fldXXXXXXXXXXXXXX',
      result: { type: 'number', options: { precision: 2 } },
    };
    expect(rollup({ ...reads, formula: 'AVERAGE(values)' })).toMatchObject({
      type: 'number',
      options: { precision: 2 },
      computed: { type: 'rollup', function: 'AVG' },
    });
    expect(rollup(reads)).toMatchObject({
      type: 'number',
      converted:
        "Airtable's API doesn't say which function this rollup uses: kept with Airtable's values.",
    });
    expect(rollup({ ...reads, formula: 'MEDIAN(values)' })?.converted).toBe(
      "Rollups here have no MEDIAN function: kept with Airtable's values."
    );
    expect(rollupFallbackMessage({ ...reads, formula: 'SUM(values) / 2' })).toContain(
      'SUM(values) / 2'
    );
    expect(rollupFallbackMessage({ formula: 'SUM(values)' })).toContain('which link and field');
  });

  it('maps colours by hue and falls back to the palette', () => {
    expect(mapColor('purpleDark1', 0)).toBe('violet');
    expect(mapColor('grayLight2', 0)).toBe('slate');
    expect(mapColor(undefined, 0)).toBe('green');
  });

  it('dedupes names case-insensitively', () => {
    const plans = planTables([
      {
        id: 'tblAAAAAAAAAAAAAA',
        name: 'T',
        primaryFieldId: 'fldAAAAAAAAAAAAAA',
        fields: [
          { id: 'fldAAAAAAAAAAAAAA', name: 'Name', type: 'singleLineText' },
          { id: 'fldBBBBBBBBBBBBBB', name: 'name', type: 'number' },
        ],
        views: [],
      },
      {
        id: 'tblBBBBBBBBBBBBBB',
        name: 't',
        primaryFieldId: 'fldCCCCCCCCCCCCCC',
        fields: [{ id: 'fldCCCCCCCCCCCCCC', name: ' ', type: 'singleLineText' }],
        views: [],
      },
    ]);
    expect(plans.map((p) => p.name)).toEqual(['T', 't (2)']);
    expect(plans[0]?.fields.map((f) => f.name)).toEqual(['Name', 'name (2)']);
    expect(plans[1]?.fields.map((f) => f.name)).toEqual(['Name']);
  });

  it('rewrites formula references', () => {
    const f = 'IF({fldAAAAAAAAAAAAAA} > 1, {fldBBBBBBBBBBBBBB})';
    const names = new Map([['fldAAAAAAAAAAAAAA', 'Price']]);
    expect(readableFormula(f, names)).toBe('IF({Price} > 1, {fldBBBBBBBBBBBBBB})');
    expect(storedFormula(f, new Map([['fldAAAAAAAAAAAAAA', 'id-a']]))).toBeNull();
    expect(
      storedFormula(
        f,
        new Map([
          ['fldAAAAAAAAAAAAAA', 'id-a'],
          ['fldBBBBBBBBBBBBBB', 'id-b'],
        ])
      )
    ).toBe('IF({id-a} > 1, {id-b})');
  });

  it('names the fields a formula reads that are missing', () => {
    const f = '{fldAAAAAAAAAAAAAA} & {fldBBBBBBBBBBBBBB} & {fldBBBBBBBBBBBBBB}';
    expect(missingFields(f, new Map([['fldAAAAAAAAAAAAAA', 'id-a']]))).toEqual([
      'fldBBBBBBBBBBBBBB',
    ]);
  });

  it("describes a refused formula's problem with field names and where it is", () => {
    const stored = '{11111111-1111-7111-8111-111111111111} - TODAY()';
    const nameOf = (id: string) =>
      id === '11111111-1111-7111-8111-111111111111' ? 'Due' : undefined;
    expect(
      formulaProblem(
        stored,
        {
          code: 'typeMismatch',
          message: '"-" needs numbers, but this is a date (use DATEADD or DATETIME_DIFF for dates)',
          range: { start: 0, end: 38 },
        },
        nameOf
      )
    ).toBe(
      '"-" needs numbers, but this is a date (use DATEADD or DATETIME_DIFF for dates), in {Due}'
    );
    expect(
      formulaProblem(
        'AUTONUMBER()',
        { code: 'unknownFunction', message: 'Unknown function AUTONUMBER' },
        nameOf
      )
    ).toBe('There is no AUTONUMBER function here.');
    // A range outside the formula: the message alone.
    expect(formulaProblem('1', { message: 'Bad.', range: { start: 5, end: 9 } }, nameOf)).toBe(
      'Bad.'
    );
  });

  it('turns cells into input for our fields', () => {
    const people = new Map([['ada@example.test', 'user-ada']]);
    const ada = { id: 'usr1', email: 'Ada@Example.test', name: 'Ada' };
    const grace = { id: 'usr2', email: 'grace@example.test', name: 'Grace' };
    expect(
      cellInput({ airtableType: 'multipleCollaborators', type: 'user' }, [ada, grace], people)
    ).toEqual(['user-ada']);
    expect(
      cellInput(
        { airtableType: 'button', type: 'url' },
        { label: 'Go', url: 'https://x.test' },
        people
      )
    ).toBe('https://x.test');
    expect(
      cellInput({ airtableType: 'barcode', type: 'barcode' }, { text: '1', type: 'weird' }, people)
    ).toEqual({ text: '1', type: '' });
    expect(
      cellInput({ airtableType: 'formula', type: 'singleLineText' }, ['a', 2, true], people)
    ).toBe('a, 2, true');
    expect(textOf({ name: 'Ada' })).toBe('Ada');
    expect(textOf([])).toBeNull();
  });
});
