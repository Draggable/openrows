import {
  MAX_SCRIPTS_PER_BASE,
  type MeResponse,
  roleAllows,
  SAMPLE_SCRIPTS,
  type Script,
} from '@openrows/shared';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate } from '@tanstack/react-router';
import { ArrowLeftIcon, CodeIcon, PlayIcon, PlusIcon, SquareIcon, Trash2Icon } from 'lucide-react';
import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { api } from '../../api/client';
import { queryKeys } from '../../api/keys';
import {
  baseQueries,
  tableQueries,
  useScriptMutations,
  useScripts,
  viewQueries,
} from '../../api/queries';
import { AccountRow, CommandHint, NavItem, SectionLabel, Shell, TopBar } from '../../app/Shell';
import { Button, Input, Skeleton, toast } from '../../components/ui';
import { cn } from '../../lib/utils';
import { RichText } from '../grid/cells/RichText';
import {
  callErrorMessage,
  type HostTable,
  type OutputEntry,
  type PromptAnswer,
  type RunStatus,
  type ScriptApi,
  type ScriptPrompt,
  type ScriptRun,
  scriptBase,
  startScript,
} from './host';
import { BLANK_SCRIPT } from './model';
import { ScriptEditor } from './ScriptEditor';

/** The records API as the signed-in person: what a run's calls go through. */
const scriptApi: ScriptApi = {
  query: (tableId, body) => api.records.query({ params: { tableId }, body }),
  get: (tableId, recordId) => api.records.get({ params: { tableId, recordId } }),
  create: async (tableId, records) => {
    const res = await api.records.create({ params: { tableId }, body: { records } });
    return 'records' in res ? res.records : [res];
  },
  update: async (tableId, records) =>
    (await api.records.updateMany({ params: { tableId }, body: { records } })).records,
  delete: async (tableId, recordIds) => {
    await api.records.deleteMany({ params: { tableId }, body: { recordIds } });
  },
};

/**
 * `/b/:baseId/scripts?s=<id>`: the base's saved scripts. Editors and up run them;
 * creators and owners also write them. A run happens in a sandboxed frame (host.ts) whose calls
 * go through the API as the signed-in person.
 */
export function ScriptsPage({
  me,
  baseId,
  scriptId,
}: {
  me: MeResponse;
  baseId: string;
  scriptId?: string | undefined;
}) {
  const base = useQuery(baseQueries.detail(baseId));
  const allowed = !!base.data && roleAllows(base.data.role, 'base:read_scripts');
  const list = useScripts(baseId, allowed);
  const scripts = list.data?.scripts ?? [];
  const canEdit = list.data?.canEdit === true;
  const current = scripts.find((s) => s.id === scriptId);
  const navigate = useNavigate();
  const { create } = useScriptMutations(baseId);
  const full = scripts.length >= MAX_SCRIPTS_PER_BASE;

  const onCreate = (name: string, code: string, description = '') =>
    create.mutate(
      { name, code, description },
      {
        onSuccess: (s) =>
          navigate({ to: '/b/$baseId/scripts', params: { baseId }, search: { s: s.id } }),
        onError: (err) => toast.error(callErrorMessage(err)),
      }
    );
  const newName = (name: string) => {
    const names = new Set(scripts.map((s) => s.name));
    if (!names.has(name)) return name;
    let i = 2;
    while (names.has(`${name} ${i}`)) i += 1;
    return `${name} ${i}`;
  };

  return (
    <Shell
      sidebar={
        <div className="flex h-full min-h-0 flex-col">
          <div className="px-3 pt-3">
            <Link
              to="/b/$baseId"
              params={{ baseId }}
              className="flex h-8 items-center gap-2 rounded-sm px-2 text-text-2 hover:bg-hover hover:text-text"
            >
              <ArrowLeftIcon className="size-4" aria-hidden />
              <span className="truncate">{base.data?.name ?? 'Back to the base'}</span>
            </Link>
          </div>
          <SectionLabel
            action={
              canEdit ? (
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label="New script"
                  disabled={full || create.isPending}
                  onClick={() => onCreate(newName('Untitled script'), BLANK_SCRIPT)}
                >
                  <PlusIcon />
                </Button>
              ) : undefined
            }
          >
            Scripts
          </SectionLabel>
          <nav aria-label="Scripts" className="flex min-h-0 flex-1 flex-col overflow-y-auto">
            <NavItem
              to="/b/$baseId/scripts"
              params={{ baseId }}
              search={{}}
              active={!scriptId}
              icon={<CodeIcon />}
            >
              All scripts
            </NavItem>
            {scripts.map((s) => (
              <NavItem
                key={s.id}
                to="/b/$baseId/scripts"
                params={{ baseId }}
                search={{ s: s.id }}
                active={s.id === scriptId}
              >
                {s.name}
              </NavItem>
            ))}
          </nav>
          <div className="mt-auto pt-2">
            <CommandHint />
            <AccountRow me={me} />
          </div>
        </div>
      }
    >
      {current ? (
        <ScriptWorkspace
          key={current.id}
          me={me}
          baseId={baseId}
          baseName={base.data?.name ?? ''}
          script={current}
          canEdit={canEdit}
          onDeleted={() => navigate({ to: '/b/$baseId/scripts', params: { baseId }, search: {} })}
        />
      ) : (
        <>
          <TopBar>
            <nav aria-label="Breadcrumb" className="flex min-w-0 items-center gap-2 text-[15px]">
              <Link
                to="/b/$baseId"
                params={{ baseId }}
                className="truncate text-text-2 hover:text-text max-sm:hidden"
              >
                {base.data?.name ?? <Skeleton className="h-4 w-24" />}
              </Link>
              <span className="text-text-3 max-sm:hidden">/</span>
              <h1 className="truncate font-[550]" aria-current="page">
                Scripts
              </h1>
            </nav>
          </TopBar>
          <main className="min-h-0 flex-1 overflow-y-auto">
            {base.isPending || (allowed && list.isPending) ? (
              <div className="grid gap-2 p-6" aria-busy="true">
                <Skeleton className="h-10" />
                <Skeleton className="h-10" />
              </div>
            ) : !allowed ? (
              <p className="p-6 text-text-2">
                Only the base's editors, creators and owners run scripts.
              </p>
            ) : list.isError ? (
              <p className="p-6 text-text-2">{callErrorMessage(list.error)}</p>
            ) : scriptId ? (
              <p className="p-6 text-text-2">This script doesn't exist any more.</p>
            ) : (
              <ScriptList
                baseId={baseId}
                scripts={scripts}
                canEdit={canEdit}
                full={full}
                creating={create.isPending}
                onCreate={(name, code, description) => onCreate(newName(name), code, description)}
              />
            )}
          </main>
        </>
      )}
    </Shell>
  );
}

function ScriptList({
  baseId,
  scripts,
  canEdit,
  full,
  creating,
  onCreate,
}: {
  baseId: string;
  scripts: Script[];
  canEdit: boolean;
  full: boolean;
  creating: boolean;
  onCreate: (name: string, code: string, description?: string) => void;
}) {
  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-6 p-6">
      <section aria-labelledby="scripts-saved" className="flex flex-col gap-2">
        <h2 id="scripts-saved" className="font-[550]">
          Saved scripts
        </h2>
        {scripts.length === 0 ? (
          <p className="text-text-2">
            {canEdit
              ? 'No scripts yet. Start from a blank script or an example below.'
              : 'No scripts yet. The base’s creators write them; you can run them here.'}
          </p>
        ) : (
          <ul className="divide-y divide-border rounded-md border border-border bg-surface">
            {scripts.map((s) => (
              <li key={s.id}>
                <Link
                  to="/b/$baseId/scripts"
                  params={{ baseId }}
                  search={{ s: s.id }}
                  className="flex h-[34px] items-center gap-2 px-3 hover:bg-hover"
                >
                  <CodeIcon className="size-4 text-text-2" aria-hidden />
                  <span className="truncate">{s.name}</span>
                  {s.description && <span className="truncate text-text-2">— {s.description}</span>}
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>
      {canEdit && (
        <section aria-labelledby="scripts-new" className="flex flex-col gap-2">
          <h2 id="scripts-new" className="font-[550]">
            New script
          </h2>
          {full && (
            <p className="text-text-2">A base can have at most {MAX_SCRIPTS_PER_BASE} scripts.</p>
          )}
          <div className="grid gap-2 sm:grid-cols-2">
            <ScriptTile
              name="Blank script"
              description="Start from a few lines that read a table."
              disabled={full || creating}
              onClick={() => onCreate('Untitled script', BLANK_SCRIPT)}
            />
            {SAMPLE_SCRIPTS.map((sample) => (
              <ScriptTile
                key={sample.key}
                name={sample.name}
                description={sample.description}
                disabled={full || creating}
                onClick={() => onCreate(sample.name, sample.code, sample.description)}
              />
            ))}
          </div>
        </section>
      )}
    </div>
  );
}

function ScriptTile({
  name,
  description,
  disabled,
  onClick,
}: {
  name: string;
  description: string;
  disabled: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className="flex flex-col items-start gap-1 rounded-md border border-border bg-surface p-3 text-left hover:border-border-strong hover:bg-hover disabled:opacity-50"
    >
      <span className="font-[550]">{name}</span>
      <span className="text-text-2">{description}</span>
    </button>
  );
}

type PendingPrompt = { prompt: ScriptPrompt; resolve: (answer: PromptAnswer) => void };
type Entry = OutputEntry | { kind: 'answer'; label: string; text: string };

/** One script: its editor (creators) or code (editors), Run/Stop and the run's output. */
function ScriptWorkspace({
  me,
  baseId,
  baseName,
  script,
  canEdit,
  onDeleted,
}: {
  me: MeResponse;
  baseId: string;
  baseName: string;
  script: Script;
  canEdit: boolean;
  onDeleted: () => void;
}) {
  const qc = useQueryClient();
  const { update, remove } = useScriptMutations(baseId);
  const [code, setCode] = useState(script.code);
  const [name, setName] = useState(script.name);
  const dirty = code !== script.code || name.trim() !== script.name;
  const [entries, setEntries] = useState<Entry[]>([]);
  const [status, setStatus] = useState<RunStatus | 'idle' | 'starting'>('idle');
  const [pending, setPending] = useState<PendingPrompt | null>(null);
  const run = useRef<ScriptRun | null>(null);
  const sandbox = useRef<HTMLDivElement>(null);
  const tables = useQuery(tableQueries.list(baseId));
  const [hostTables, setHostTables] = useState<HostTable[]>([]);
  const nameId = useId();

  useEffect(() => () => run.current?.stop(), []);

  /** Every table with its fields and views, for the run and the editor's completions. */
  const loadTables = useCallback(async () => {
    const list = tables.data?.tables ?? (await qc.fetchQuery(tableQueries.list(baseId))).tables;
    const loaded = await Promise.all(
      list.map(async (t) => {
        const [detail, views] = await Promise.all([
          qc.fetchQuery(tableQueries.detail(t.id)),
          qc.fetchQuery(viewQueries.list(t.id)),
        ]);
        return {
          id: t.id,
          name: detail.name,
          description: detail.description,
          fields: detail.fields,
          views: views.views.map((v) => ({ id: v.id, name: v.name, type: v.type })),
        } satisfies HostTable;
      })
    );
    setHostTables(loaded);
    return loaded;
  }, [baseId, qc, tables.data]);
  useEffect(() => {
    loadTables().catch(() => {});
  }, [loadTables]);

  const save = () => {
    if (!canEdit || !dirty) return;
    update.mutate(
      {
        scriptId: script.id,
        ...(code !== script.code ? { code } : {}),
        ...(name.trim() !== script.name && name.trim() ? { name: name.trim() } : {}),
      },
      {
        onSuccess: () => toast.success('Script saved'),
        onError: (err) => toast.error(callErrorMessage(err)),
      }
    );
  };

  const onRun = async () => {
    if (run.current || !sandbox.current) return;
    setEntries([]);
    setStatus('starting');
    let loaded: HostTable[];
    try {
      loaded = await loadTables();
    } catch (err) {
      setEntries([{ kind: 'error', text: callErrorMessage(err) }]);
      setStatus('failed');
      return;
    }
    const container = sandbox.current;
    if (!container) return;
    const started = startScript({
      code,
      base: scriptBase({ id: baseId, name: baseName }, loaded),
      tables: loaded,
      session: {
        currentUser: {
          id: me.user.id,
          name: me.user.name ?? me.user.email ?? '',
          email: me.user.email ?? '',
        },
      },
      container,
      deps: {
        api: scriptApi,
        output: (entry) => setEntries((list) => (entry.kind === 'clear' ? [] : [...list, entry])),
        prompt: (prompt) => new Promise<PromptAnswer>((resolve) => setPending({ prompt, resolve })),
      },
    });
    run.current = started;
    setStatus('running');
    const result = await started.done;
    run.current = null;
    setPending(null);
    setStatus(result);
    if (result === 'stopped') {
      setEntries((list) => [...list, { kind: 'log', level: 'warn', text: 'Stopped.' }]);
    }
    // What the script changed shows in the grid (realtime too, but this tab skips nothing).
    void qc.invalidateQueries({ queryKey: queryKeys.records.all() });
  };

  const answer = (value: PromptAnswer, text: string) => {
    if (!pending) return;
    setEntries((list) => [...list, { kind: 'answer', label: pending.prompt.label, text }]);
    pending.resolve(value);
    setPending(null);
  };

  const running = status === 'running' || status === 'starting';

  return (
    <>
      <TopBar
        actions={
          <>
            {canEdit && (
              <>
                <Button
                  variant="ghost"
                  onClick={() => {
                    if (!window.confirm(`Delete the script "${script.name}"?`)) return;
                    remove.mutate(script.id, {
                      onSuccess: onDeleted,
                      onError: (err) => toast.error(callErrorMessage(err)),
                    });
                  }}
                >
                  <Trash2Icon />
                  <span className="max-sm:sr-only">Delete</span>
                </Button>
                <Button variant="outline" disabled={!dirty || update.isPending} onClick={save}>
                  {dirty ? 'Save' : 'Saved'}
                </Button>
              </>
            )}
            {running ? (
              <Button onClick={() => run.current?.stop()} disabled={status === 'starting'}>
                <SquareIcon />
                Stop
              </Button>
            ) : (
              <Button onClick={() => void onRun()}>
                <PlayIcon />
                Run
              </Button>
            )}
          </>
        }
      >
        <nav aria-label="Breadcrumb" className="flex min-w-0 items-center gap-2 text-[15px]">
          <Link
            to="/b/$baseId/scripts"
            params={{ baseId }}
            search={{}}
            className="truncate text-text-2 hover:text-text max-sm:hidden"
          >
            Scripts
          </Link>
          <span className="text-text-3 max-sm:hidden">/</span>
          <h1 className="truncate font-[550]" aria-current="page">
            {script.name}
          </h1>
        </nav>
      </TopBar>
      <main
        className="grid min-h-0 flex-1 grid-rows-[minmax(0,1fr)_minmax(0,1fr)] lg:grid-cols-[minmax(0,1fr)_minmax(320px,40%)] lg:grid-rows-1"
        onKeyDown={(e) => {
          if ((e.metaKey || e.ctrlKey) && e.key === 's') {
            e.preventDefault();
            save();
          }
          if ((e.metaKey || e.ctrlKey) && e.key === 'Enter' && !running) {
            e.preventDefault();
            void onRun();
          }
        }}
      >
        <section aria-label="Code" className="flex min-h-0 flex-col border-border lg:border-r">
          {canEdit && (
            <div className="flex h-[38px] items-center gap-2 border-b border-border px-3">
              <label htmlFor={nameId} className="text-text-2">
                Name
              </label>
              <Input
                id={nameId}
                value={name}
                maxLength={100}
                onChange={(e) => setName(e.target.value)}
                className="h-7 max-w-xs"
              />
            </div>
          )}
          <div className="min-h-0 flex-1">
            <ScriptEditor
              value={code}
              onChange={setCode}
              tables={hostTables}
              readOnly={!canEdit}
              label={`Code of ${script.name}`}
            />
          </div>
        </section>
        <section
          aria-label="Output"
          className="flex min-h-0 flex-col border-t border-border bg-app lg:border-t-0"
        >
          <div className="flex h-[38px] items-center justify-between border-b border-border px-3">
            <span className="font-[550]">Output</span>
            <span className="text-text-2" role="status" aria-live="polite">
              {STATUS_LABELS[status]}
            </span>
          </div>
          <div
            className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto p-3"
            data-testid="script-output"
          >
            {entries.length === 0 && !pending && status === 'idle' && (
              <p className="text-text-2">
                Run the script to see its output here. It runs with your permissions.
              </p>
            )}
            {entries.map((entry, i) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: output entries only ever append
              <OutputItem key={i} entry={entry} />
            ))}
            {pending && (
              <PromptForm
                key={entries.length}
                prompt={pending.prompt}
                tables={hostTables}
                onAnswer={answer}
              />
            )}
          </div>
          <div ref={sandbox} hidden />
        </section>
      </main>
    </>
  );
}

const STATUS_LABELS: Record<RunStatus | 'idle' | 'starting', string> = {
  idle: '',
  starting: 'Starting…',
  running: 'Running…',
  succeeded: 'Finished',
  failed: 'Failed',
  stopped: 'Stopped',
};

function OutputItem({ entry }: { entry: Entry }) {
  switch (entry.kind) {
    case 'text':
      return <p className="whitespace-pre-wrap break-words">{entry.text}</p>;
    case 'markdown':
      return <RichText text={entry.text} />;
    case 'inspect':
      return (
        <pre className="overflow-x-auto rounded-sm border border-border bg-surface p-2 text-[12px]">
          {entry.text}
        </pre>
      );
    case 'table':
      return (
        <div className="overflow-x-auto rounded-sm border border-border bg-surface">
          <table className="w-full border-collapse text-left">
            <thead>
              <tr>
                {entry.columns.map((c, i) => (
                  <th
                    // biome-ignore lint/suspicious/noArrayIndexKey: columns may repeat names
                    key={i}
                    scope="col"
                    className="h-[34px] border-b border-border px-2 font-[550]"
                  >
                    {c}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {entry.rows.map((row, r) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: rows have no identity but order
                <tr key={r} className="border-b border-border last:border-b-0">
                  {row.map((cell, c) => (
                    // biome-ignore lint/suspicious/noArrayIndexKey: cells by column
                    <td key={c} className="h-[34px] max-w-[24rem] truncate px-2">
                      {cell}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
    case 'log':
      return (
        <p
          className={cn(
            'whitespace-pre-wrap break-words font-mono text-[12px]',
            entry.level === 'error'
              ? 'text-danger'
              : entry.level === 'warn'
                ? 'text-warning'
                : 'text-text-2'
          )}
        >
          {entry.text}
        </p>
      );
    case 'error':
      return (
        <p role="alert" className="whitespace-pre-wrap break-words text-danger">
          {entry.text}
        </p>
      );
    case 'answer':
      return (
        <p className="text-text-2">
          {entry.label ? `${entry.label}: ` : ''}
          <span className="text-text">{entry.text}</span>
        </p>
      );
    case 'clear':
      return null;
  }
}

/** The script's question (`input.*Async`), answered inline as in Airtable's scripting. */
function PromptForm({
  prompt,
  tables,
  onAnswer,
}: {
  prompt: ScriptPrompt;
  tables: HostTable[];
  onAnswer: (value: PromptAnswer, text: string) => void;
}) {
  const id = useId();
  const [text, setText] = useState('');
  const [search, setSearch] = useState('');
  const table = 'tableId' in prompt ? tables.find((t) => t.id === prompt.tableId) : undefined;
  const choices =
    prompt.kind === 'table'
      ? tables.map((t) => ({ id: t.id, name: t.name }))
      : prompt.kind === 'view'
        ? (table?.views ?? [])
        : prompt.kind === 'field'
          ? (table?.fields ?? []).map((f) => ({ id: f.id, name: f.name }))
          : [];
  const [choice, setChoice] = useState(choices[0]?.id ?? '');

  const frame = 'flex flex-col gap-2 rounded-md border border-border bg-surface p-3';
  const label = (
    <label htmlFor={id} className="font-[550]">
      {prompt.label || 'Input'}
    </label>
  );

  if (prompt.kind === 'buttons') {
    return (
      <fieldset className={frame}>
        <legend className="sr-only">{prompt.label || 'Choose'}</legend>
        <span className="font-[550]" aria-hidden>
          {prompt.label}
        </span>
        <div className="flex flex-wrap gap-2">
          {prompt.options.map((o, i) => (
            <Button
              // biome-ignore lint/suspicious/noArrayIndexKey: options may repeat labels
              key={i}
              variant={
                o.variant === 'danger'
                  ? 'destructive'
                  : o.variant === 'primary'
                    ? 'default'
                    : 'outline'
              }
              onClick={() => onAnswer(i, o.label)}
            >
              {o.label}
            </Button>
          ))}
        </div>
      </fieldset>
    );
  }
  if (prompt.kind === 'text') {
    return (
      <form
        className={frame}
        onSubmit={(e) => {
          e.preventDefault();
          onAnswer(text, text);
        }}
      >
        {label}
        <div className="flex gap-2">
          <Input id={id} value={text} autoFocus onChange={(e) => setText(e.target.value)} />
          <Button type="submit">Continue</Button>
        </div>
      </form>
    );
  }
  if (prompt.kind === 'record') {
    const matches = prompt.records
      .filter((r) => r.name.toLowerCase().includes(search.trim().toLowerCase()))
      .slice(0, 100);
    return (
      <fieldset className={frame}>
        <legend className="font-[550]">{prompt.label || 'Pick a record'}</legend>
        <Input
          aria-label="Search records"
          value={search}
          autoFocus
          onChange={(e) => setSearch(e.target.value)}
        />
        <ul className="max-h-60 overflow-y-auto">
          {matches.map((r) => (
            <li key={r.id}>
              <button
                type="button"
                className="flex h-[34px] w-full items-center rounded-sm px-2 text-left hover:bg-hover"
                onClick={() => onAnswer(r.id, r.name)}
              >
                {r.name}
              </button>
            </li>
          ))}
        </ul>
        {matches.length === 0 && <p className="text-text-2">No records match.</p>}
        <div>
          <Button variant="outline" onClick={() => onAnswer(null, 'None')}>
            Skip
          </Button>
        </div>
      </fieldset>
    );
  }
  return (
    <form
      className={frame}
      onSubmit={(e) => {
        e.preventDefault();
        const picked = choices.find((c) => c.id === choice);
        if (picked) onAnswer(picked.id, picked.name);
      }}
    >
      {label}
      <div className="flex gap-2">
        <select
          id={id}
          value={choice}
          onChange={(e) => setChoice(e.target.value)}
          className="h-8 min-w-0 flex-1 rounded-sm border border-border bg-surface px-2"
        >
          {choices.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>
        <Button type="submit" disabled={!choice}>
          Continue
        </Button>
      </div>
    </form>
  );
}
