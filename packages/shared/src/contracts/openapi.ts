import { z } from 'zod';
import { ProblemDetailsSchema } from '../errors.js';
import { type EndpointDef, pathParamNames } from './endpoint.js';

/** A JSON Schema object as Zod emits it (draft 2020-12, which OpenAPI 3.1 uses). */
type JsonSchema = Record<string, unknown>;

export interface OpenApiOperation {
  endpoint: EndpointDef;
  /** Who may call it (the server's access rule), appended to the description. */
  access: string;
  /** The kind of access rule: public, any signed-in user, or a role on a resource. */
  kind: 'public' | 'session' | 'resource';
}

export interface OpenApiOptions {
  title: string;
  version: string;
  /** Name of the session cookie, for the security scheme. */
  sessionCookie: string;
  /** The server's origin (`APP_URL`), the document's one server. */
  serverUrl: string;
  /** Markdown shown at the top of the reference. */
  description?: string;
}

/** Where the server serves the document and the client's API reference reads it. */
export const OPENAPI_PATH = '/api/openapi.json';

/** The 429 every operation may answer: a rate limit, with when to try again. */
const rateLimitHeaders = {
  'Retry-After': {
    description: 'Seconds to wait before trying again.',
    schema: { type: 'integer' },
  },
  'RateLimit-Limit': {
    description: "The tightest bucket's size (its burst).",
    schema: { type: 'integer' },
  },
  'RateLimit-Remaining': {
    description: 'Requests left in that bucket now.',
    schema: { type: 'integer' },
  },
  'RateLimit-Reset': {
    description: 'Seconds until that bucket is full again.',
    schema: { type: 'integer' },
  },
};

/** Named schemas (a recursive one, like automation steps) collected for `components`. */
type Components = Record<string, JsonSchema>;

/** A named schema's component: its id, plus `Input` for a request's shape. */
const componentName = (id: string, io: 'input' | 'output') => (io === 'input' ? `${id}Input` : id);

/** Points `#/$defs/<id>` references at the document's `#/components/schemas/<name>`. */
function relink(value: unknown, io: 'input' | 'output'): unknown {
  if (Array.isArray(value)) return value.map((v) => relink(v, io));
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value).map(([k, v]) =>
      k === '$ref' && typeof v === 'string' && v.startsWith('#/$defs/')
        ? [k, `#/components/schemas/${componentName(v.slice('#/$defs/'.length), io)}`]
        : [k, relink(v, io)]
    )
  );
}

function jsonSchema(schema: z.ZodType, io: 'input' | 'output', components?: Components) {
  // `unrepresentable: 'any'`: a transform or custom check documents as "any value" rather than
  // failing the whole document.
  const {
    $schema: _,
    $defs,
    ...rest
  } = z.toJSONSchema(schema, { io, unrepresentable: 'any' }) as JsonSchema;
  // Named schemas go to `components` (OpenAPI resolves `$ref`s from the document's root).
  for (const [id, def] of Object.entries(($defs ?? {}) as Components)) {
    if (!components) throw new Error(`openapi: unexpected named schema ${id}`);
    components[componentName(id, io)] = relink(def, io) as JsonSchema;
  }
  return relink(rest, io) as JsonSchema;
}

/**
 * The REST API v1's error body, Airtable's shape: `type` is Airtable's error type where one
 * fits (`NOT_FOUND`, `INVALID_PERMISSIONS`, `INVALID_FILTER_BY_FORMULA`), `code` the OpenRows code.
 */
export const V1ErrorSchema = z.object({
  error: z.looseObject({
    type: z.string(),
    message: z.string(),
    code: z.string(),
    requestId: z.string(),
    errors: z.array(z.object({ path: z.string(), message: z.string() })).optional(),
  }),
});

/** Whether a path is the REST API v1's, which answers errors as `V1ErrorSchema`. */
export const isV1Path = (path: string) => path.startsWith('/api/v1/');

const errorResponse = (path: string) => (description: string) =>
  isV1Path(path)
    ? {
        description,
        content: { 'application/json': { schema: { $ref: '#/components/schemas/V1Error' } } },
      }
    : {
        description,
        content: {
          'application/problem+json': { schema: { $ref: '#/components/schemas/Problem' } },
        },
      };

function operationId(e: EndpointDef): string {
  const words = e.path
    .replace(/^\/api\//, '')
    .split('/')
    .map((s) => (s.startsWith(':') ? `by-${s.slice(1)}` : s));
  return [e.method.toLowerCase(), ...words]
    .join('-')
    .replace(/-(\w)/g, (_, ch: string) => ch.toUpperCase());
}

function parameters(e: EndpointDef, components: Components): JsonSchema[] {
  const path = pathParamNames(e.path).map((name) => {
    const check = e.params?.[name];
    return {
      name,
      in: 'path',
      required: true,
      schema: check ? jsonSchema(check, 'input', components) : { type: 'string' },
    };
  });
  const query: JsonSchema[] = [];
  if (e.query) {
    const schema = jsonSchema(e.query, 'input', components);
    const props = (schema['properties'] ?? {}) as Record<string, JsonSchema>;
    const required = new Set((schema['required'] ?? []) as string[]);
    for (const [name, prop] of Object.entries(props)) {
      query.push({ name, in: 'query', required: required.has(name), schema: prop });
    }
  }
  return [...path, ...query];
}

/**
 * The OpenAPI 3.1 document for `operations`, generated from the endpoint contracts: path
 * parameters, query parameters, request bodies (input shape) and responses (output shape),
 * plus the problem+json error responses every route can give.
 */
export function buildOpenApiDocument(operations: OpenApiOperation[], options: OpenApiOptions) {
  const paths: Record<string, Record<string, unknown>> = {};
  const components: Components = {};
  for (const { endpoint: e, access, kind } of operations) {
    const authenticated = kind !== 'public';
    const openApiPath = e.path.replace(/:(\w+)/g, '{$1}');
    const problemResponse = errorResponse(e.path);
    const responses: Record<string, unknown> = {
      [e.status]: e.response
        ? {
            description: 'Success',
            content: {
              'application/json': { schema: jsonSchema(e.response, 'output', components) },
            },
          }
        : { description: 'Success, no content' },
      ...(authenticated ? { 401: problemResponse('Not signed in') } : {}),
      ...(kind === 'resource'
        ? {
            403: problemResponse('Signed in, but the role is too low'),
            404: problemResponse('No such resource, or no access to it'),
          }
        : {}),
      ...(e.body || e.query ? { 422: problemResponse('The request failed validation') } : {}),
      429: {
        ...problemResponse('Too many requests: a rate limit was reached (see Retry-After)'),
        headers: rateLimitHeaders,
      },
    };
    paths[openApiPath] ??= {};
    paths[openApiPath][e.method.toLowerCase()] = {
      operationId: operationId(e),
      summary: e.summary,
      description: `Access: ${access}.`,
      tags: [e.tag],
      parameters: parameters(e, components),
      ...(e.body
        ? {
            requestBody: {
              required: true,
              content: { 'application/json': { schema: jsonSchema(e.body, 'input', components) } },
            },
          }
        : {}),
      responses,
      ...(authenticated ? {} : { security: [] }),
    };
  }
  return {
    openapi: '3.1.0',
    info: {
      title: options.title,
      version: options.version,
      ...(options.description ? { description: options.description } : {}),
      license: { name: 'AGPL-3.0-only', identifier: 'AGPL-3.0-only' },
    },
    servers: [{ url: options.serverUrl }],
    paths,
    components: {
      schemas: {
        Problem: jsonSchema(ProblemDetailsSchema, 'output'),
        V1Error: jsonSchema(V1ErrorSchema, 'output'),
        ...components,
      },
      securitySchemes: {
        session: { type: 'apiKey', in: 'cookie', name: options.sessionCookie },
        // Personal access tokens: `Authorization: Bearer or_pat_…`; each operation's
        // description names the scope it needs.
        personalAccessToken: { type: 'http', scheme: 'bearer' },
      },
    },
    security: [{ session: [] }, { personalAccessToken: [] }],
  };
}

export type OpenApiDocument = ReturnType<typeof buildOpenApiDocument>;
