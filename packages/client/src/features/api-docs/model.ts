/**
 * The API reference: the server's OpenAPI document (`/api/openapi.json`) read into
 * operations grouped by tag, and JSON Schemas summarised for display. Pure; ApiDocsPage renders it.
 */

export type JsonSchema = { [key: string]: unknown };

export interface DocParameter {
  name: string;
  in: 'path' | 'query';
  required: boolean;
  schema: JsonSchema;
}

export interface DocResponse {
  status: string;
  description: string;
  /** The JSON body's schema, if any. */
  schema: JsonSchema | undefined;
  /** application/json or application/problem+json. */
  mediaType: string | undefined;
}

export interface DocOperation {
  /** The anchor: the operationId. */
  id: string;
  method: string;
  path: string;
  summary: string;
  /** "Access: …": who may call it, and the token scope. */
  description: string;
  tag: string;
  isPublic: boolean;
  parameters: DocParameter[];
  body: JsonSchema | undefined;
  responses: DocResponse[];
}

export interface DocTag {
  name: string;
  /** Anchor of the tag's section. */
  id: string;
  operations: DocOperation[];
}

export interface ApiReference {
  title: string;
  version: string;
  server: string | undefined;
  tags: DocTag[];
  schemas: Record<string, JsonSchema>;
  /** Operations in the document, all tags together. */
  count: number;
}

const METHODS = ['get', 'post', 'put', 'patch', 'delete'] as const;

const isObject = (v: unknown): v is JsonSchema =>
  typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown, fallback = '') => (typeof v === 'string' ? v : fallback);

/** A URL fragment for a name: lowercase words joined by dashes. */
export function slug(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

/** v1 first (the public API), then the app's routes, alphabetically. */
function tagOrder(a: string, b: string): number {
  const v1 = (t: string) => (t === 'v1' ? 0 : 1);
  return v1(a) - v1(b) || a.localeCompare(b);
}

/** A tag as a heading: `v1` → "REST API v1", `records` → "Records". */
export function tagTitle(tag: string): string {
  return tag === 'v1' ? 'REST API v1' : tag.charAt(0).toUpperCase() + tag.slice(1);
}

function jsonBody(content: unknown): { schema: JsonSchema; mediaType: string } | undefined {
  if (!isObject(content)) return undefined;
  for (const [mediaType, entry] of Object.entries(content)) {
    if (isObject(entry) && isObject(entry['schema'])) return { schema: entry['schema'], mediaType };
  }
  return undefined;
}

/** Reads the OpenAPI document; anything malformed is skipped rather than thrown. */
export function readReference(doc: unknown): ApiReference {
  const root = isObject(doc) ? doc : {};
  const info = isObject(root['info']) ? root['info'] : {};
  const paths = isObject(root['paths']) ? root['paths'] : {};
  const components = isObject(root['components']) ? root['components'] : {};
  const servers = Array.isArray(root['servers']) ? root['servers'] : [];
  const byTag = new Map<string, DocOperation[]>();
  let count = 0;

  for (const [path, item] of Object.entries(paths)) {
    if (!isObject(item)) continue;
    for (const method of METHODS) {
      const op = item[method];
      if (!isObject(op)) continue;
      const tags = Array.isArray(op['tags']) ? op['tags'] : [];
      const tag = str(tags[0], 'Other');
      const parameters = (Array.isArray(op['parameters']) ? op['parameters'] : [])
        .filter(isObject)
        .map(
          (p): DocParameter => ({
            name: str(p['name']),
            in: p['in'] === 'path' ? 'path' : 'query',
            required: p['required'] === true,
            schema: isObject(p['schema']) ? p['schema'] : {},
          })
        );
      const requestBody = isObject(op['requestBody']) ? op['requestBody'] : {};
      const responses = Object.entries(isObject(op['responses']) ? op['responses'] : {})
        .filter((e): e is [string, JsonSchema] => isObject(e[1]))
        .map(([status, r]): DocResponse => {
          const body = jsonBody(r['content']);
          return {
            status,
            description: str(r['description']),
            schema: body?.schema,
            mediaType: body?.mediaType,
          };
        });
      const operation: DocOperation = {
        id: str(op['operationId'], `${method}-${slug(path)}`),
        method: method.toUpperCase(),
        path,
        summary: str(op['summary'], `${method.toUpperCase()} ${path}`),
        description: str(op['description']),
        tag,
        isPublic: Array.isArray(op['security']) && op['security'].length === 0,
        parameters,
        body: jsonBody(requestBody['content'])?.schema,
        responses,
      };
      byTag.set(tag, [...(byTag.get(tag) ?? []), operation]);
      count += 1;
    }
  }

  const tags = [...byTag.keys()].sort(tagOrder).map((name) => ({
    name,
    id: `tag-${slug(name)}`,
    operations: byTag.get(name) ?? [],
  }));
  const server = servers.find(isObject);
  return {
    title: str(info['title'], 'API'),
    version: str(info['version']),
    server: server ? str(server['url']) || undefined : undefined,
    tags,
    schemas: isObject(components['schemas'])
      ? (Object.fromEntries(
          Object.entries(components['schemas']).filter(([, s]) => isObject(s))
        ) as Record<string, JsonSchema>)
      : {},
    count,
  };
}

/** Operations whose method, path, summary or tag contain every word of `query`. */
export function filterTags(tags: readonly DocTag[], query: string): DocTag[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return [...tags];
  return tags
    .map((t) => ({
      ...t,
      operations: t.operations.filter((o) => {
        const text = `${o.method} ${o.path} ${o.summary} ${t.name}`.toLowerCase();
        return words.every((w) => text.includes(w));
      }),
    }))
    .filter((t) => t.operations.length > 0);
}

/** The component name of a `$ref` (`#/components/schemas/Problem` → `Problem`). */
export function refName(schema: JsonSchema): string | undefined {
  const ref = schema['$ref'];
  return typeof ref === 'string' ? ref.split('/').at(-1) : undefined;
}

const MAX_ENUM = 8;

/** A one-line type: `string (uuid)`, `"a" | "b"`, `Record[]`, `integer ≤ 100`, `string | null`. */
export function typeLabel(schema: JsonSchema, depth = 0): string {
  const ref = refName(schema);
  if (ref) return ref;
  if (depth > 3) return '…';
  if ('const' in schema) return JSON.stringify(schema['const']);
  if (Array.isArray(schema['enum'])) {
    const values = schema['enum'].map((v) => JSON.stringify(v));
    return values.length > MAX_ENUM
      ? `${values.slice(0, MAX_ENUM).join(' | ')} | … (${values.length})`
      : values.join(' | ');
  }
  for (const key of ['anyOf', 'oneOf'] as const) {
    const options = schema[key];
    if (Array.isArray(options)) {
      const labels = [...new Set(options.filter(isObject).map((o) => typeLabel(o, depth + 1)))];
      return labels.length > MAX_ENUM
        ? `one of ${labels.length} shapes`
        : labels.join(' | ') || 'any';
    }
  }
  if (Array.isArray(schema['allOf'])) return 'object';
  const type = schema['type'];
  if (Array.isArray(type)) {
    return type.map((t) => typeLabel({ ...schema, type: t }, depth + 1)).join(' | ');
  }
  if (type === 'array') {
    const items = isObject(schema['items']) ? schema['items'] : {};
    const inner = typeLabel(items, depth + 1);
    return inner.includes(' ') ? `(${inner})[]` : `${inner}[]`;
  }
  if (typeof type !== 'string') return 'any';
  const format = typeof schema['format'] === 'string' ? ` (${schema['format']})` : '';
  const bounds: string[] = [];
  for (const [key, sign] of [
    ['minimum', '≥'],
    ['maximum', '≤'],
    ['minLength', 'length ≥'],
    ['maxLength', 'length ≤'],
    ['maxItems', 'items ≤'],
  ] as const) {
    if (typeof schema[key] === 'number') bounds.push(`${sign} ${schema[key]}`);
  }
  return `${type}${format}${bounds.length ? `, ${bounds.join(', ')}` : ''}`;
}

export interface SchemaField {
  name: string;
  required: boolean;
  schema: JsonSchema;
  description: string | undefined;
}

/** The properties of an object schema (or of an array's items), required ones first. */
export function fieldsOf(schema: JsonSchema): SchemaField[] {
  const target = schema['type'] === 'array' && isObject(schema['items']) ? schema['items'] : schema;
  const props = isObject(target['properties']) ? target['properties'] : {};
  const required = new Set(Array.isArray(target['required']) ? target['required'] : []);
  return Object.entries(props)
    .filter((e): e is [string, JsonSchema] => isObject(e[1]))
    .map(([name, s]) => ({
      name,
      required: required.has(name),
      schema: s,
      description: typeof s['description'] === 'string' ? s['description'] : undefined,
    }))
    .sort((a, b) => Number(b.required) - Number(a.required));
}

/** The shapes of a union (`anyOf`/`oneOf`) that have fields of their own. */
export function variantsOf(schema: JsonSchema): JsonSchema[] {
  const options = schema['anyOf'] ?? schema['oneOf'];
  return Array.isArray(options)
    ? options.filter(isObject).filter((o) => fieldsOf(o).length > 0)
    : [];
}
