import { BRAND } from '@openrows/shared';
import { useEffect, useId, useMemo, useState } from 'react';
import { useOpenApiDocument } from '../../api/queries';
import { Logo } from '../../app/Logo';
import { Input, Skeleton } from '../../components/ui';
import { cn } from '../../lib/utils';
import { Code, FROM_AIRTABLE, GUIDES, type Guide, mcpGuide, Pre, SDK_GUIDE } from './guides';
import {
  type DocOperation,
  type DocResponse,
  fieldsOf,
  filterTags,
  type JsonSchema,
  readReference,
  refName,
  tagTitle,
  typeLabel,
  variantsOf,
} from './model';
import {
  docBlocks,
  filterReference,
  groupReference,
  inlineParts,
  itemId,
  type ReferenceItem,
  SDK_REFERENCE,
} from './sdk-model';

export const API_DOCS_PATH = '/docs/api';
export const FROM_AIRTABLE_PATH = '/docs/api/from-airtable';
export const SDK_PATH = '/docs/api/sdk';
export const MCP_PATH = '/docs/api/mcp';

type DocsPage = 'reference' | 'airtable' | 'sdk' | 'mcp';
const PAGE_TITLES: Record<DocsPage, string> = {
  reference: 'API reference',
  airtable: 'From Airtable',
  sdk: 'JavaScript SDK',
  mcp: 'MCP server',
};

const METHOD_CLASS = 'inline-block w-14 shrink-0 font-mono text-small font-semibold text-text-2';

/**
 * The API reference at /docs/api: guides (authentication, pagination, rate limits,
 * errors) and every operation of the server's OpenAPI document, rendered here from
 * `/api/openapi.json` with the app's own code and styles: no third-party viewer, nothing loaded
 * from elsewhere, so it works offline and under the app's CSP. Public, outside the app shell.
 * `page="airtable"` is the "From Airtable" page, `page="sdk"` the JavaScript SDK's,
 * `page="mcp"` the MCP server's.
 */
export function ApiDocsPage({ page = 'reference' }: { page?: DocsPage }) {
  useEffect(() => {
    document.title = `${PAGE_TITLES[page]} · ${BRAND}`;
  }, [page]);

  return (
    <div className="min-h-screen bg-app text-body text-text">
      <header className="sticky top-0 z-10 flex h-12 items-center gap-3 border-b border-border bg-surface px-4">
        <a href="/" aria-label={`${BRAND} home`} className="rounded-sm">
          <Logo />
        </a>
        <span className="text-text-2">API reference</span>
        <a href="/settings" className="ml-auto text-small text-text-2 hover:text-text">
          Personal access tokens
        </a>
      </header>
      {page === 'airtable' ? (
        <AirtablePage />
      ) : page === 'sdk' ? (
        <SdkPage />
      ) : page === 'mcp' ? (
        <McpPage />
      ) : (
        <ReferencePage />
      )}
    </div>
  );
}

function Nav({ children, label }: { children: React.ReactNode; label: string }) {
  return (
    <nav
      aria-label={label}
      className="border-b border-border p-4 md:sticky md:top-12 md:h-[calc(100vh-3rem)] md:w-64 md:shrink-0 md:overflow-y-auto md:border-r md:border-b-0"
    >
      {children}
    </nav>
  );
}

const navLink = 'block truncate rounded-sm px-2 py-1 text-text-2 hover:bg-hover hover:text-text';
const navHeading = 'mt-4 mb-1 px-2 text-caps font-semibold tracking-wide text-text-2 uppercase';

function GuideLinks({ current }: { current: DocsPage }) {
  const prefix = current === 'reference' ? '' : API_DOCS_PATH;
  return (
    <>
      <p className={cn(navHeading, 'mt-0')}>Guides</p>
      <ul>
        {GUIDES.map((g) => (
          <li key={g.id}>
            <a className={navLink} href={`${prefix}#${g.id}`}>
              {g.title}
            </a>
          </li>
        ))}
        <li>
          <a
            className={cn(navLink, current === 'airtable' && 'bg-hover text-text')}
            href={FROM_AIRTABLE_PATH}
            aria-current={current === 'airtable' ? 'page' : undefined}
          >
            {FROM_AIRTABLE.title}
          </a>
        </li>
        <li>
          <a
            className={cn(navLink, current === 'sdk' && 'bg-hover text-text')}
            href={SDK_PATH}
            aria-current={current === 'sdk' ? 'page' : undefined}
          >
            {SDK_GUIDE.title}
          </a>
        </li>
        <li>
          <a
            className={cn(navLink, current === 'mcp' && 'bg-hover text-text')}
            href={MCP_PATH}
            aria-current={current === 'mcp' ? 'page' : undefined}
          >
            MCP server (AI agents)
          </a>
        </li>
      </ul>
    </>
  );
}

function GuideSection({ guide }: { guide: Guide }) {
  return (
    <section id={guide.id} aria-labelledby={`${guide.id}-title`} className="scroll-mt-16 pb-8">
      <h2 id={`${guide.id}-title`} className="mb-2 text-title font-semibold">
        {guide.title}
      </h2>
      <div className="max-w-[72ch] leading-relaxed">{guide.body}</div>
    </section>
  );
}

function AirtablePage() {
  return (
    <div className="md:flex">
      <Nav label="API documentation">
        <GuideLinks current="airtable" />
        <p className={navHeading}>Reference</p>
        <a className={navLink} href={`${API_DOCS_PATH}#reference`}>
          Endpoints
        </a>
      </Nav>
      <main className="min-w-0 flex-1 px-4 py-6 md:px-10">
        <h1 className="mb-4 text-display font-semibold">Coming from Airtable</h1>
        <div className="max-w-[110ch] leading-relaxed">{FROM_AIRTABLE.body}</div>
      </main>
    </div>
  );
}

/** The MCP server: its tools and the Claude Code and Cursor settings, for this server. */
function McpPage() {
  const guide = useMemo(() => mcpGuide(window.location.origin), []);
  return (
    <div className="md:flex">
      <Nav label="API documentation">
        <GuideLinks current="mcp" />
        <p className={navHeading}>Reference</p>
        <a className={navLink} href={`${API_DOCS_PATH}#reference`}>
          Endpoints
        </a>
      </Nav>
      <main className="min-w-0 flex-1 px-4 py-6 md:px-10">
        <h1 className="mb-4 text-display font-semibold">{guide.title}</h1>
        <div className="max-w-[110ch] leading-relaxed">{guide.body}</div>
      </main>
    </div>
  );
}

/** The JavaScript SDK: how to use it, then every export as TypeDoc describes it. */
function SdkPage() {
  const [query, setQuery] = useState('');
  const items = useMemo(() => filterReference(SDK_REFERENCE.items, query), [query]);
  const groups = useMemo(() => groupReference(items), [items]);
  const searchId = useId();

  useEffect(() => {
    if (!window.location.hash) return;
    document.getElementById(decodeURIComponent(window.location.hash.slice(1)))?.scrollIntoView();
  }, []);

  return (
    <div className="md:flex">
      <Nav label="API documentation">
        <GuideLinks current="sdk" />
        <p className={navHeading}>SDK reference</p>
        <label htmlFor={searchId} className="sr-only">
          Filter the SDK reference
        </label>
        <Input
          id={searchId}
          type="search"
          placeholder="Filter the reference"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          className="mb-2"
        />
        {groups.map((g) => (
          <div key={g.id}>
            <p className="mt-2 px-2 text-small text-text-2">{g.title}</p>
            <ul>
              {g.items.map((i) => (
                <li key={i.name}>
                  <a className={cn(navLink, 'font-mono text-small')} href={`#${itemId(i.name)}`}>
                    {i.name}
                  </a>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </Nav>
      <main className="min-w-0 flex-1 px-4 py-6 md:px-10">
        <h1 className="mb-1 text-display font-semibold">JavaScript SDK</h1>
        <p className="mb-8 text-text-2">
          {SDK_REFERENCE.package} {SDK_REFERENCE.version} · AGPL-3.0-only
        </p>
        <div className="max-w-[72ch] pb-8 leading-relaxed">{SDK_GUIDE.body}</div>
        <section aria-labelledby="sdk-reference-title">
          <h2 id="sdk-reference-title" className="mb-2 text-title font-semibold">
            Reference
          </h2>
          {groups.length === 0 && <p className="text-text-2">Nothing matches "{query}".</p>}
          {groups.map((g) => (
            <section key={g.id} id={g.id} aria-labelledby={`${g.id}-title`} className="pt-4">
              <h3
                id={`${g.id}-title`}
                className="mb-2 border-b border-border pb-1 text-heading font-semibold"
              >
                {g.title}
              </h3>
              {g.items.map((i) => (
                <SdkItem key={i.name} item={i} />
              ))}
            </section>
          ))}
        </section>
      </main>
    </div>
  );
}

function DocText({ summary, className }: { summary: string; className?: string }) {
  const blocks = docBlocks(summary);
  if (!blocks.length) return null;
  return (
    <div className={cn('max-w-[80ch]', className)}>
      {blocks.map((b, i) =>
        b.kind === 'code' ? (
          // biome-ignore lint/suspicious/noArrayIndexKey: the blocks of one fixed comment
          <Pre key={i} label="Example">
            {b.text}
          </Pre>
        ) : (
          // biome-ignore lint/suspicious/noArrayIndexKey: the blocks of one fixed comment
          <p key={i} className="my-1">
            {inlineParts(b.text).map((p, j) =>
              // biome-ignore lint/suspicious/noArrayIndexKey: the parts of one fixed paragraph
              p.code ? <Code key={j}>{p.text}</Code> : <span key={j}>{p.text}</span>
            )}
          </p>
        )
      )}
    </div>
  );
}

const SIGNATURE_CLASS = 'font-mono text-small [overflow-wrap:anywhere] whitespace-pre-wrap';

function SdkItem({ item }: { item: ReferenceItem }) {
  const id = itemId(item.name);
  return (
    <article
      id={id}
      aria-labelledby={`${id}-title`}
      className="scroll-mt-16 border-b border-border py-4"
    >
      <h4 id={`${id}-title`} className="flex items-baseline gap-2">
        <code className="font-mono font-[550]">{item.name}</code>
        <span className="rounded-xs border border-border px-1 text-small text-text-2">
          {item.kind}
        </span>
      </h4>
      <DocText summary={item.summary} className="mt-1" />
      {item.signatures.map((s) => (
        <p key={s} className={cn(SIGNATURE_CLASS, 'mt-1 text-text-2')}>
          {s}
        </p>
      ))}
      {item.members.length > 0 && (
        <ul className="mt-2">
          {item.members.map((m) => (
            <li key={m.name} className="border-t border-border py-1.5">
              {m.signatures.map((s) => (
                <p key={s} className={SIGNATURE_CLASS}>
                  {s}
                </p>
              ))}
              <DocText summary={m.summary} className="text-text-2" />
            </li>
          ))}
        </ul>
      )}
    </article>
  );
}

function ReferencePage() {
  const doc = useOpenApiDocument();
  const reference = useMemo(() => (doc.data ? readReference(doc.data) : undefined), [doc.data]);
  const [query, setQuery] = useState('');
  const tags = useMemo(() => filterTags(reference?.tags ?? [], query), [reference, query]);
  const searchId = useId();

  // A deep link (#getV1…) reaches its operation once the document has loaded.
  useEffect(() => {
    if (!reference || !window.location.hash) return;
    document.getElementById(decodeURIComponent(window.location.hash.slice(1)))?.scrollIntoView();
  }, [reference]);

  return (
    <div className="md:flex">
      <Nav label="API documentation">
        <GuideLinks current="reference" />
        <p className={navHeading}>Reference</p>
        <label htmlFor={searchId} className="sr-only">
          Filter endpoints
        </label>
        <Input
          id={searchId}
          type="search"
          placeholder="Filter endpoints"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          className="mb-2"
        />
        <ul>
          {tags.map((t) => (
            <li key={t.id}>
              <a className={navLink} href={`#${t.id}`}>
                {tagTitle(t.name)}{' '}
                <span className="text-text-2 tabular-nums">{t.operations.length}</span>
              </a>
            </li>
          ))}
        </ul>
      </Nav>
      <main className="min-w-0 flex-1 px-4 py-6 md:px-10">
        <h1 className="mb-1 text-display font-semibold">{BRAND} API</h1>
        <p className="mb-8 text-text-2">
          {reference
            ? `Version ${reference.version} · ${reference.count} endpoints${reference.server ? ` · ${reference.server}` : ''}`
            : 'The REST API v1 and every route of the app.'}
        </p>
        {GUIDES.map((g) => (
          <GuideSection key={g.id} guide={g} />
        ))}
        <section id="reference" aria-labelledby="reference-title" className="scroll-mt-16">
          <h2 id="reference-title" className="mb-2 text-title font-semibold">
            Endpoints
          </h2>
          {doc.isPending ? (
            <Skeleton className="h-40" />
          ) : doc.isError || !reference ? (
            <p role="alert" className="text-text-2">
              Couldn't load the API description. It is at <Code>GET /api/openapi.json</Code>.
            </p>
          ) : tags.length === 0 ? (
            <p className="text-text-2">No endpoint matches "{query}".</p>
          ) : (
            tags.map((t) => (
              <section
                key={t.id}
                id={t.id}
                aria-labelledby={`${t.id}-title`}
                className="scroll-mt-16 pt-4"
              >
                <h3
                  id={`${t.id}-title`}
                  className="mb-2 border-b border-border pb-1 text-heading font-semibold"
                >
                  {tagTitle(t.name)}
                </h3>
                {t.operations.map((op) => (
                  <Operation key={`${op.method} ${op.path}`} op={op} />
                ))}
              </section>
            ))
          )}
        </section>
      </main>
    </div>
  );
}

function Operation({ op }: { op: DocOperation }) {
  const titleId = `${op.id}-title`;
  return (
    <article
      id={op.id}
      aria-labelledby={titleId}
      className="scroll-mt-16 border-b border-border py-4"
    >
      <h4 id={titleId} className="font-[550]">
        {op.summary}
      </h4>
      <p className="mt-1 flex min-w-0 items-baseline gap-2">
        <span className={METHOD_CLASS}>{op.method}</span>
        <code className="font-mono text-small [overflow-wrap:anywhere]">{op.path}</code>
        {op.isPublic && (
          <span className="rounded-xs border border-border px-1 text-small text-text-2">
            Public
          </span>
        )}
      </p>
      {op.description && <p className="mt-1 text-small text-text-2">{withCode(op.description)}</p>}
      {op.parameters.length > 0 && (
        <table className="mt-3 w-full border-collapse text-left">
          <caption className="mb-1 text-left text-small font-[550]">Parameters</caption>
          <thead className="sr-only">
            <tr>
              <th scope="col">Name</th>
              <th scope="col">In</th>
              <th scope="col">Type</th>
            </tr>
          </thead>
          <tbody>
            {op.parameters.map((p) => (
              <tr key={`${p.in}-${p.name}`} className="border-t border-border align-top">
                <td className="w-56 py-1 pr-3 font-mono text-small">
                  {p.name}
                  {p.required && <span className="text-text-2"> *</span>}
                </td>
                <td className="w-16 py-1 pr-3 text-small text-text-2">{p.in}</td>
                <td className="py-1 font-mono text-small text-text-2 [overflow-wrap:anywhere]">
                  {typeLabel(p.schema)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {op.body && <SchemaDetails summary="Request body" schema={op.body} />}
      <div className="mt-3">
        <p className="text-small font-[550]">Responses</p>
        <ul>
          {op.responses.map((r) => (
            <ResponseRow key={r.status} response={r} />
          ))}
        </ul>
      </div>
    </article>
  );
}

/** Text with `backticks` as inline code (the document's descriptions are Markdown-ish). */
function withCode(text: string) {
  return text.split(/`([^`]+)`/).map((part, i) =>
    // biome-ignore lint/suspicious/noArrayIndexKey: the parts of one fixed string
    i % 2 ? <Code key={i}>{part}</Code> : <span key={i}>{part}</span>
  );
}

function ResponseRow({ response: r }: { response: DocResponse }) {
  const label = (
    <>
      <span className="inline-block w-10 font-mono font-semibold">{r.status}</span>
      {r.description}
      {r.schema && refName(r.schema) && <span className="text-text-2"> · {refName(r.schema)}</span>}
    </>
  );
  // Error bodies are the shared Problem/V1Error shapes (see Errors); success bodies expand.
  if (!r.schema || refName(r.schema) || Number(r.status) >= 400) {
    return <li className="py-0.5 text-small">{label}</li>;
  }
  return (
    <li className="py-0.5 text-small">
      <SchemaDetails summary={label} schema={r.schema} />
    </li>
  );
}

/** A schema behind a disclosure; its fields render only once opened (the document is large). */
function SchemaDetails({ summary, schema }: { summary: React.ReactNode; schema: JsonSchema }) {
  const [open, setOpen] = useState(false);
  return (
    <details className="mt-2" onToggle={(e) => setOpen(e.currentTarget.open)}>
      <summary className="w-fit cursor-pointer rounded-xs text-small hover:text-text">
        {summary}
        <span className="text-text-2"> · {typeLabel(schema)}</span>
      </summary>
      {open && <SchemaFields schema={schema} depth={0} />}
    </details>
  );
}

const MAX_DEPTH = 5;

function SchemaFields({ schema, depth }: { schema: JsonSchema; depth: number }) {
  const fields = fieldsOf(schema);
  const variants = fields.length === 0 ? variantsOf(schema) : [];
  if (depth >= MAX_DEPTH || (fields.length === 0 && variants.length === 0)) return null;
  if (variants.length > 0) {
    return (
      <ol className={cn('mt-1', depth > 0 && 'border-l border-border pl-3')}>
        {variants.map((v, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: the union's order is its identity
          <li key={i} className="mt-1">
            <span className="text-small text-text-2">One of ({i + 1})</span>
            <SchemaFields schema={v} depth={depth + 1} />
          </li>
        ))}
      </ol>
    );
  }
  return (
    <ul className={cn('mt-1', depth > 0 && 'border-l border-border pl-3')}>
      {fields.map((f) => (
        <li key={f.name} className="py-0.5">
          <span className="font-mono text-small">{f.name}</span>
          {f.required && <span className="text-text-2"> *</span>}{' '}
          <span className="font-mono text-small text-text-2 [overflow-wrap:anywhere]">
            {typeLabel(f.schema)}
          </span>
          {f.description && <span className="text-small text-text-2"> · {f.description}</span>}
          <SchemaFields schema={f.schema} depth={depth + 1} />
        </li>
      ))}
    </ul>
  );
}
