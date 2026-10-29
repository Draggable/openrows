import { describe, expect, it } from 'vitest';
import {
  fieldsOf,
  filterTags,
  readReference,
  slug,
  tagTitle,
  typeLabel,
  variantsOf,
} from './model';

const doc = {
  openapi: '3.1.0',
  info: { title: 'OpenRows API', version: '0.1.0' },
  servers: [{ url: 'https://app.openrows.io' }],
  paths: {
    '/api/me': {
      get: {
        operationId: 'getMe',
        summary: 'The signed-in user',
        description: 'Access: any signed-in user.',
        tags: ['auth'],
        parameters: [],
        responses: {
          200: {
            description: 'Success',
            content: { 'application/json': { schema: { type: 'object' } } },
          },
          401: {
            description: 'Not signed in',
            content: {
              'application/problem+json': { schema: { $ref: '#/components/schemas/Problem' } },
            },
          },
        },
      },
    },
    '/api/v1/{baseId}/{tableIdOrName}': {
      get: {
        operationId: 'getV1ByBaseIdByTableIdOrName',
        summary: 'List records',
        tags: ['v1'],
        parameters: [
          { name: 'baseId', in: 'path', required: true, schema: { type: 'string' } },
          { name: 'pageSize', in: 'query', required: false, schema: { type: 'integer' } },
        ],
        responses: { 200: { description: 'Success' } },
      },
      post: {
        summary: 'Create records',
        tags: ['v1'],
        requestBody: { content: { 'application/json': { schema: { type: 'object' } } } },
        responses: {},
      },
    },
    '/api/shared/{shareToken}': {
      get: { summary: 'A share', tags: ['shared'], security: [], responses: {} },
    },
  },
  components: { schemas: { Problem: { type: 'object' } } },
};

describe('readReference', () => {
  it('groups operations by tag, v1 first, with parameters, bodies and responses', () => {
    const ref = readReference(doc);
    expect(ref).toMatchObject({
      title: 'OpenRows API',
      version: '0.1.0',
      server: 'https://app.openrows.io',
      count: 4,
    });
    expect(ref.tags.map((t) => t.name)).toEqual(['v1', 'auth', 'shared']);
    const [list, create] = ref.tags[0]?.operations ?? [];
    expect(list).toMatchObject({
      id: 'getV1ByBaseIdByTableIdOrName',
      method: 'GET',
      path: '/api/v1/{baseId}/{tableIdOrName}',
      isPublic: false,
      parameters: [
        { name: 'baseId', in: 'path', required: true },
        { name: 'pageSize', in: 'query', required: false },
      ],
    });
    expect(create).toMatchObject({
      id: 'post-api-v1-baseid-tableidorname',
      body: { type: 'object' },
    });
    const me = ref.tags[1]?.operations[0];
    expect(me?.responses).toEqual([
      {
        status: '200',
        description: 'Success',
        schema: { type: 'object' },
        mediaType: 'application/json',
      },
      {
        status: '401',
        description: 'Not signed in',
        schema: { $ref: '#/components/schemas/Problem' },
        mediaType: 'application/problem+json',
      },
    ]);
    expect(ref.tags[2]?.operations[0]?.isPublic).toBe(true);
    expect(Object.keys(ref.schemas)).toEqual(['Problem']);
  });

  it('survives a malformed document', () => {
    expect(readReference(null)).toMatchObject({ title: 'API', tags: [], count: 0 });
    expect(readReference({ paths: { '/x': 'nope', '/y': { get: 3 } } }).count).toBe(0);
  });
});

describe('filterTags', () => {
  it('keeps operations matching every word', () => {
    const { tags } = readReference(doc);
    expect(
      filterTags(tags, 'records post').flatMap((t) => t.operations.map((o) => o.summary))
    ).toEqual(['Create records']);
    expect(filterTags(tags, '  ')).toHaveLength(3);
    expect(filterTags(tags, 'nothing-like-this')).toEqual([]);
  });
});

describe('typeLabel', () => {
  it('summarises a schema in one line', () => {
    expect(typeLabel({ type: 'string', format: 'uuid' })).toBe('string (uuid)');
    expect(typeLabel({ type: 'integer', minimum: 1, maximum: 100 })).toBe('integer, ≥ 1, ≤ 100');
    expect(typeLabel({ type: ['string', 'null'] })).toBe('string | null');
    expect(typeLabel({ enum: ['asc', 'desc'] })).toBe('"asc" | "desc"');
    expect(typeLabel({ type: 'array', items: { type: 'string' } })).toBe('string[]');
    expect(
      typeLabel({ type: 'array', items: { anyOf: [{ type: 'string' }, { type: 'number' }] } })
    ).toBe('(string | number)[]');
    expect(typeLabel({ $ref: '#/components/schemas/V1Error' })).toBe('V1Error');
    expect(typeLabel({ const: 'json' })).toBe('"json"');
    expect(typeLabel({})).toBe('any');
    expect(typeLabel({ enum: Array.from({ length: 10 }, (_, i) => i) })).toContain('… (10)');
  });
});

describe('fieldsOf and variantsOf', () => {
  it('lists properties, required first, through arrays', () => {
    const schema = {
      type: 'array',
      items: {
        type: 'object',
        properties: { b: { type: 'string', description: 'B' }, a: { type: 'number' } },
        required: ['a'],
      },
    };
    expect(fieldsOf(schema)).toEqual([
      { name: 'a', required: true, schema: { type: 'number' }, description: undefined },
      {
        name: 'b',
        required: false,
        schema: { type: 'string', description: 'B' },
        description: 'B',
      },
    ]);
    expect(fieldsOf({ type: 'string' })).toEqual([]);
    expect(
      variantsOf({
        anyOf: [{ type: 'null' }, { type: 'object', properties: { x: { type: 'string' } } }],
      })
    ).toHaveLength(1);
  });
});

describe('slug and tagTitle', () => {
  it('make anchors and headings', () => {
    expect(slug('From Airtable!')).toBe('from-airtable');
    expect(tagTitle('v1')).toBe('REST API v1');
    expect(tagTitle('records')).toBe('Records');
  });
});
