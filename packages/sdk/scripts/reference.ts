import { fileURLToPath } from 'node:url';
import {
  Application,
  Comment,
  type CommentDisplayPart,
  type DeclarationReflection,
  ReflectionKind,
  type SignatureReflection,
} from 'typedoc';
import { biomeFormat } from './format.js';

/**
 * The SDK's API reference, from TypeDoc: every export with its doc comment and, for
 * classes and interfaces, their public members and signatures, as compact JSON that the app's
 * `/docs/api/sdk` page renders with its own components (TypeDoc's HTML theme runs an inline
 * script the app's CSP refuses). `npm run reference -w @openrows/sdk` rewrites it;
 * `reference.test.ts` fails when it is out of date.
 */

export interface ReferenceMember {
  name: string;
  kind: 'constructor' | 'method' | 'property' | 'accessor';
  /** One line per overload, like `select(params?: SelectParams): Query<F>`. */
  signatures: string[];
  summary: string;
}

export interface ReferenceItem {
  name: string;
  kind: 'class' | 'interface' | 'type' | 'function' | 'variable';
  summary: string;
  /** A type's definition or a function's or variable's signatures. */
  signatures: string[];
  members: ReferenceMember[];
  /** Generated from the API's contracts (`src/generated/v1.ts`). */
  generated: boolean;
}

export interface Reference {
  package: string;
  version: string;
  items: ReferenceItem[];
}

export const REFERENCE_PATH = fileURLToPath(
  new URL('../../client/src/features/api-docs/sdk-reference.json', import.meta.url)
);
const SDK_DIR = fileURLToPath(new URL('..', import.meta.url));

const text = (parts: readonly CommentDisplayPart[] | undefined) =>
  parts ? Comment.combineDisplayParts(parts).trim() : '';

function summaryOf(r: { comment?: Comment } | undefined): string {
  return text(r?.comment?.summary);
}

function signature(s: SignatureReflection, name = s.name): string {
  const typeParams = s.typeParameters?.length
    ? `<${s.typeParameters.map((t) => t.name).join(', ')}>`
    : '';
  const params = (s.parameters ?? [])
    .map(
      (p) =>
        `${p.flags.isRest ? '...' : ''}${p.name}${p.flags.isOptional || p.defaultValue ? '?' : ''}: ${p.type?.toString() ?? 'unknown'}`
    )
    .join(', ');
  return `${name}${typeParams}(${params}): ${s.type?.toString() ?? 'void'}`;
}

function member(m: DeclarationReflection, owner: string): ReferenceMember | null {
  if (m.flags.isPrivate || m.flags.isProtected || m.inheritedFrom || m.name.startsWith('_')) {
    return null;
  }
  const sigs = m.signatures ?? [];
  if (m.kind === ReflectionKind.Constructor) {
    return {
      name: 'constructor',
      kind: 'constructor',
      signatures: sigs.map((s) => signature(s, `new ${owner}`).replace(/: [^:]+$/, '')),
      summary: summaryOf(sigs[0]) || summaryOf(m),
    };
  }
  if (m.kind === ReflectionKind.Method) {
    // Overloads: one line each; the implementation isn't a signature here.
    const summary = sigs.map((s) => summaryOf(s)).filter(Boolean);
    return {
      name: m.name,
      kind: 'method',
      signatures: sigs.map((s) => signature(s)),
      summary: [...new Set(summary)].join('\n\n'),
    };
  }
  if (m.kind === ReflectionKind.Accessor) {
    return {
      name: m.name,
      kind: 'accessor',
      signatures: [`${m.name}: ${m.getSignature?.type?.toString() ?? 'unknown'}`],
      summary: summaryOf(m.getSignature) || summaryOf(m),
    };
  }
  if (m.kind === ReflectionKind.Property) {
    const opt = m.flags.isOptional ? '?' : '';
    const ro = m.flags.isReadonly ? 'readonly ' : '';
    return {
      name: m.name,
      kind: 'property',
      signatures: [`${ro}${m.name}${opt}: ${m.type?.toString() ?? 'unknown'}`],
      summary: summaryOf(m),
    };
  }
  return null;
}

const KINDS: [ReflectionKind, ReferenceItem['kind']][] = [
  [ReflectionKind.Class, 'class'],
  [ReflectionKind.Function, 'function'],
  [ReflectionKind.Interface, 'interface'],
  [ReflectionKind.TypeAlias, 'type'],
  [ReflectionKind.Variable, 'variable'],
];
/** The client first, then the classes it hands out, in the order one meets them. */
const CLASS_ORDER = ['OpenRows', 'BaseClient', 'Tables', 'Table', 'Query', 'Comments', 'Webhooks'];

function item(r: DeclarationReflection, kind: ReferenceItem['kind']): ReferenceItem {
  const generated = r.sources?.some((s) => s.fileName.includes('generated/')) ?? false;
  const base = { name: r.name, kind, summary: summaryOf(r), generated, members: [] };
  switch (kind) {
    case 'class':
    case 'interface':
      return {
        ...base,
        signatures: [],
        members: (r.children ?? [])
          .map((m) => member(m, r.name))
          .filter((m): m is ReferenceMember => m !== null),
      };
    case 'function':
      return {
        ...base,
        summary: summaryOf(r.signatures?.[0]),
        signatures: (r.signatures ?? []).map((s) => signature(s)),
      };
    case 'type': // Generated types are whole response shapes: their summary names the endpoint instead.
      {
        const params = r.typeParameters?.length
          ? `<${r.typeParameters.map((t) => t.name).join(', ')}>`
          : '';
        return {
          ...base,
          signatures: generated ? [] : [`type ${r.name}${params} = ${r.type?.toString()}`],
        };
      }
    case 'variable':
      return { ...base, signatures: generated ? [] : [`const ${r.name}: ${r.type?.toString()}`] };
  }
}

export async function generateReference(): Promise<Reference> {
  const app = await Application.bootstrap({
    entryPoints: [`${SDK_DIR}/src/index.ts`],
    tsconfig: `${SDK_DIR}/tsconfig.build.json`,
    excludePrivate: true,
    excludeProtected: true,
    excludeInternal: true,
    excludeExternals: true,
    sort: ['source-order'],
    logLevel: 'Error',
  });
  const project = await app.convert();
  if (!project) throw new Error('TypeDoc could not read the SDK');
  const { version } = (await import('../package.json', { with: { type: 'json' } })).default;
  const items: ReferenceItem[] = [];
  for (const [kind, name] of KINDS) {
    const of = project.getChildrenByKind(kind).map((r) => item(r, name));
    if (name === 'class') {
      const rank = (n: string) => (CLASS_ORDER.indexOf(n) + 1 || CLASS_ORDER.length + 1) - 1;
      of.sort((a, b) => rank(a.name) - rank(b.name));
    }
    items.push(...of);
  }
  return { package: '@openrows/sdk', version, items };
}

export const serialize = (r: Reference) =>
  biomeFormat(JSON.stringify(r), 'packages/client/src/features/api-docs/sdk-reference.json');
