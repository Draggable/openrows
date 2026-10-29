import {
  type Automation,
  type AutomationAction,
  type AutomationListItem,
  type AutomationRun,
  type AutomationScripts,
  type AutomationTrigger,
  type FieldMeta,
  MAX_AUTOMATION_ACTIONS,
  MAX_AUTOMATIONS_PER_BASE,
  type MeResponse,
} from '@openrows/shared';
import { useQueries, useQuery } from '@tanstack/react-query';
import { Link, useNavigate } from '@tanstack/react-router';
import { ArrowLeftIcon, PlusIcon, Trash2Icon, ZapIcon } from 'lucide-react';
import { useEffect, useId, useMemo, useState } from 'react';
import {
  baseQueries,
  tableQueries,
  useAutomations,
  useCreateAutomation,
  useDeleteAutomation,
  useRotateAutomationWebhook,
  useTestAutomation,
  useUpdateAutomation,
} from '../../api/queries';
import { AccountRow, CommandHint, NavItem, SectionLabel, Shell, TopBar } from '../../app/Shell';
import { Button, Input, Skeleton, toast } from '../../components/ui';
import { cn } from '../../lib/utils';
import { CollaboratorsProvider } from '../collaborators/context';
import {
  canManageAutomations,
  cardErrors,
  defaultAction,
  defaultTrigger,
  generalErrors,
  moveItem,
  problemErrors,
  RUN_STATUS_LABELS,
  runWhen,
  TRIGGER_LABELS,
  tokensFor,
} from './model';
import { FailedRuns, RunHistory, StatusIcon, TestPanel } from './RunPanel';
import { ActionCard, AddAction, StepCard, TriggerEditor } from './steps';

type Table = { id: string; name: string };

/** An on/off switch (`role="switch"`), named by its label. */
export function Switch({
  checked,
  label,
  disabled,
  onChange,
}: {
  checked: boolean;
  label: string;
  disabled?: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={cn(
        'relative inline-flex h-5 w-9 shrink-0 items-center rounded-full border transition-colors disabled:opacity-50',
        checked ? 'border-primary bg-primary' : 'border-border-strong bg-hover'
      )}
    >
      <span
        aria-hidden
        className={cn(
          'block size-3.5 rounded-full bg-surface shadow-1 transition-transform',
          checked ? 'translate-x-[18px]' : 'translate-x-[2px]'
        )}
      />
    </button>
  );
}

/**
 * `/b/:baseId/automations`: the base's automations for its creators. Without `?a=` the
 * list (on/off, last run, runs); with it, that automation's builder, test and run history.
 */
export function AutomationsPage({
  me,
  baseId,
  automationId,
}: {
  me: MeResponse;
  baseId: string;
  automationId?: string | undefined;
}) {
  const base = useQuery(baseQueries.detail(baseId));
  const tables = useQuery(tableQueries.list(baseId));
  const allowed = canManageAutomations(base.data?.role);
  const list = useAutomations(baseId, allowed);
  const automations = list.data?.automations ?? [];
  const current = automations.find((a) => a.id === automationId);
  const navigate = useNavigate();
  const create = useCreateAutomation(baseId);
  const tableList: Table[] = tables.data?.tables ?? [];

  const onCreate = () => {
    const first = tableList[0]?.id;
    create.mutate(
      {
        name: `Automation ${automations.length + 1}`,
        trigger: first ? defaultTrigger('recordCreated', first) : defaultTrigger('scheduled', ''),
      },
      {
        onSuccess: (a) =>
          navigate({ to: '/b/$baseId/automations', params: { baseId }, search: { a: a.id } }),
        onError: (err) => toast.error(problemErrors(err, "Couldn't add the automation").message),
      }
    );
  };
  const full = automations.length >= MAX_AUTOMATIONS_PER_BASE;

  return (
    <CollaboratorsProvider workspaceId={base.data?.workspaceId} meId={me.user.id}>
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
                allowed ? (
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label="New automation"
                    disabled={full || create.isPending}
                    onClick={onCreate}
                  >
                    <PlusIcon />
                  </Button>
                ) : undefined
              }
            >
              Automations
            </SectionLabel>
            <nav aria-label="Automations" className="flex min-h-0 flex-1 flex-col overflow-y-auto">
              <NavItem
                to="/b/$baseId/automations"
                params={{ baseId }}
                search={{}}
                active={!automationId}
                icon={<ZapIcon />}
              >
                All automations
              </NavItem>
              {automations.map((a) => (
                <NavItem
                  key={a.id}
                  to="/b/$baseId/automations"
                  params={{ baseId }}
                  search={{ a: a.id }}
                  active={a.id === automationId}
                  icon={
                    <span
                      aria-hidden
                      className={cn(
                        'mx-1 size-2 shrink-0 rounded-full',
                        a.enabled ? 'bg-primary' : 'bg-border-strong'
                      )}
                    />
                  }
                >
                  {a.name}
                  <span className="sr-only">{a.enabled ? ' (on)' : ' (off)'}</span>
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
            {current ? (
              <>
                <Link
                  to="/b/$baseId/automations"
                  params={{ baseId }}
                  search={{}}
                  className="truncate text-text-2 hover:text-text"
                >
                  Automations
                </Link>
                <span className="text-text-3">/</span>
                <h1 className="truncate font-[550]" aria-current="page">
                  {current.name}
                </h1>
              </>
            ) : (
              <h1 className="truncate font-[550]" aria-current="page">
                Automations
              </h1>
            )}
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
              Only the base's creators and owners manage its automations.
            </p>
          ) : list.isError ? (
            <p className="p-6 text-text-2">
              {problemErrors(list.error, "Couldn't load the automations.").message}
            </p>
          ) : automationId && !current ? (
            <p className="p-6 text-text-2">This automation doesn't exist any more.</p>
          ) : current ? (
            <AutomationEditor
              key={current.id}
              automation={current}
              tables={tableList}
              scripts={list.data?.scripts}
              onDeleted={() =>
                navigate({ to: '/b/$baseId/automations', params: { baseId }, search: {} })
              }
            />
          ) : (
            <AutomationList
              baseId={baseId}
              automations={automations}
              full={full}
              creating={create.isPending}
              onCreate={onCreate}
            />
          )}
        </main>
      </Shell>
    </CollaboratorsProvider>
  );
}

function useToggle(baseId: string) {
  const update = useUpdateAutomation(baseId);
  const toggle = (a: Automation, enabled: boolean) =>
    update.mutate(
      { automationId: a.id, enabled },
      {
        onSuccess: (u) => toast.success(u.enabled ? `${u.name} is on` : `${u.name} is off`),
        onError: (err) => toast.error(problemErrors(err, "Couldn't change the automation").message),
      }
    );
  return { toggle, pending: update.isPending };
}

function lastRun(a: AutomationListItem | Automation) {
  if (!a.lastRunAt || !a.lastRunStatus) return 'Never run';
  return `${RUN_STATUS_LABELS[a.lastRunStatus]} · ${runWhen(a.lastRunAt)}`;
}

function AutomationList({
  baseId,
  automations,
  full,
  creating,
  onCreate,
}: {
  baseId: string;
  automations: readonly AutomationListItem[];
  full: boolean;
  creating: boolean;
  onCreate: () => void;
}) {
  const { toggle, pending } = useToggle(baseId);
  return (
    <div className="mx-auto flex max-w-[960px] flex-col gap-4 p-4 md:p-6">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 className="text-title font-semibold">Automations</h2>
          <p className="text-text-2">
            When something happens in this base, run actions: create or update records, send an
            email, a Slack message or a request.
          </p>
        </div>
        <Button onClick={onCreate} disabled={full || creating}>
          <PlusIcon />
          New automation
        </Button>
      </div>
      {automations.length === 0 ? (
        <div className="flex flex-col items-center gap-2 rounded-md border border-border bg-surface px-6 py-10 text-center">
          <ZapIcon className="size-6 text-text-2" aria-hidden />
          <p className="font-[550]">No automations yet</p>
          <p className="max-w-[440px] text-text-2">
            Start with a trigger, such as a new record or a form submission, then add the actions it
            runs. New automations are off until you turn them on.
          </p>
        </div>
      ) : (
        <table className="w-full border-separate border-spacing-0 rounded-md border border-border bg-surface">
          <thead>
            <tr className="text-left text-small text-text-2">
              <th className="border-b border-border px-3 py-2 font-[550]">Name</th>
              <th className="border-b border-border px-3 py-2 font-[550] max-md:hidden">Trigger</th>
              <th className="border-b border-border px-3 py-2 font-[550]">On</th>
              <th className="border-b border-border px-3 py-2 font-[550]">Last run</th>
              <th className="border-b border-border px-3 py-2 text-right font-[550]">Runs</th>
            </tr>
          </thead>
          <tbody>
            {automations.map((a) => (
              <tr key={a.id} className="hover:bg-hover">
                <td className="border-b border-border px-3 py-2">
                  <Link
                    to="/b/$baseId/automations"
                    params={{ baseId }}
                    search={{ a: a.id }}
                    className="font-[550] hover:underline"
                  >
                    {a.name}
                  </Link>
                  {a.disabledReason === 'creator_access' && (
                    <p className="text-small text-danger">
                      Turned off: the person it ran as lost access to the base.
                    </p>
                  )}
                </td>
                <td className="border-b border-border px-3 py-2 text-text-2 max-md:hidden">
                  {TRIGGER_LABELS[a.trigger.type]}
                </td>
                <td className="border-b border-border px-3 py-2">
                  <Switch
                    checked={a.enabled}
                    label={`${a.name} on`}
                    disabled={pending}
                    onChange={(on) => toggle(a, on)}
                  />
                </td>
                <td className="border-b border-border px-3 py-2">
                  <span className="flex items-center gap-1.5 text-small">
                    {a.lastRunStatus && <StatusIcon status={a.lastRunStatus} />}
                    {lastRun(a)}
                  </span>
                </td>
                <td className="border-b border-border px-3 py-2 text-right tabular-nums">
                  {a.runCount}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <FailedRuns baseId={baseId} />
      <p className="text-small text-text-2">
        {automations.length} of {MAX_AUTOMATIONS_PER_BASE} automations. Runs are kept for 30 days.
      </p>
    </div>
  );
}

interface Draft {
  name: string;
  trigger: AutomationTrigger;
  actions: AutomationAction[];
}

const draftOf = (a: Automation): Draft => ({
  name: a.name,
  trigger: a.trigger,
  actions: a.actions,
});
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

type Tab = 'test' | 'history';

/**
 * The builder: the trigger card, then the ordered actions (add, move, delete), a token
 * picker in every text, the server's validation errors on the card they concern; Save
 * (Ctrl/⌘ S), on/off, delete, and the Test and Run history tabs beside it.
 */
function AutomationEditor({
  automation,
  tables,
  scripts,
  onDeleted,
}: {
  automation: AutomationListItem;
  tables: readonly Table[];
  /** Whether this workspace may run scripts. */
  scripts: AutomationScripts | undefined;
  onDeleted: () => void;
}) {
  const baseId = automation.baseId;
  const [saved, setSaved] = useState<Draft>(() => draftOf(automation));
  const [draft, setDraft] = useState<Draft>(saved);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [tab, setTab] = useState<Tab>('test');
  const [result, setResult] = useState<AutomationRun | null>(null);
  const update = useUpdateAutomation(baseId);
  const remove = useDeleteAutomation(baseId);
  const rotate = useRotateAutomationWebhook(baseId);
  const test = useTestAutomation(baseId);
  const { toggle, pending: toggling } = useToggle(baseId);
  const nameId = useId();
  const tabsId = useId();
  const dirty = !same(draft, saved);

  // The fields of every table a step may name, for the token labels.
  const tableIds = useMemo(() => {
    const ids = new Set<string>();
    if ('tableId' in draft.trigger) ids.add(draft.trigger.tableId);
    for (const a of draft.actions) if ('tableId' in a) ids.add(a.tableId);
    return [...ids].filter(Boolean);
  }, [draft]);
  const fieldsByTable = useTablesFields(tableIds);
  const fieldsOf = (id: string) => fieldsByTable[id];

  const save = async (): Promise<boolean> => {
    if (!dirty) return true;
    const body = {
      ...(draft.name !== saved.name ? { name: draft.name } : {}),
      ...(!same(draft.trigger, saved.trigger) ? { trigger: draft.trigger } : {}),
      ...(!same(draft.actions, saved.actions) ? { actions: draft.actions } : {}),
    };
    try {
      const updated = await update.mutateAsync({ automationId: automation.id, ...body });
      const next = draftOf(updated);
      setSaved(next);
      setDraft(next);
      setErrors({});
      toast.success('Automation saved');
      return true;
    } catch (err) {
      const p = problemErrors(err, "Couldn't save the automation");
      setErrors(p.byPath);
      toast.error(p.message);
      return false;
    }
  };

  // Ctrl/⌘ S saves.
  const saveRef = useLatest(save);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
        e.preventDefault();
        void saveRef.current();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [saveRef]);

  const onTest = async (recordId: string | undefined) => {
    if (dirty && !(await save())) return;
    setResult(null);
    test.mutate(
      { automationId: automation.id, ...(recordId ? { recordId } : {}) },
      {
        onSuccess: (run) => setResult(run),
        onError: (err) => toast.error(problemErrors(err, "Couldn't run the test").message),
      }
    );
  };

  const onDelete = () => {
    if (!window.confirm(`Delete ${automation.name} and its run history?`)) return;
    remove.mutate(automation.id, {
      onSuccess: () => {
        toast.success('Automation deleted');
        onDeleted();
      },
      onError: (err) => toast.error(problemErrors(err, "Couldn't delete the automation").message),
    });
  };

  const onRotate = () => {
    if (!window.confirm('Make a new webhook URL? The current one stops working at once.')) return;
    rotate.mutate(automation.id, {
      onSuccess: () => toast.success('New webhook URL made'),
      onError: (err) => toast.error(problemErrors(err, "Couldn't make a new URL").message),
    });
  };

  const errorAt = (path: string) => errors[path];
  const setActions = (actions: AutomationAction[]) => setDraft({ ...draft, actions });
  const tokenCtx = {
    trigger: draft.trigger,
    actions: draft.actions,
    fieldsOf,
    webhookSample: automation.webhookSample,
  };
  const general = generalErrors(errors);

  return (
    <div className="flex flex-col gap-4 p-4 md:p-6 xl:flex-row xl:items-start">
      <div className="flex min-w-0 flex-1 flex-col gap-4">
        <div className="flex flex-wrap items-center gap-2">
          <label htmlFor={nameId} className="sr-only">
            Automation name
          </label>
          <Input
            id={nameId}
            value={draft.name}
            maxLength={255}
            onChange={(e) => setDraft({ ...draft, name: e.target.value })}
            className="h-9 max-w-[420px] min-w-0 flex-1 text-heading font-semibold"
          />
          <div className="flex items-center gap-2">
            <Switch
              checked={automation.enabled}
              label={`${automation.name} on`}
              disabled={toggling || dirty}
              onChange={(on) => toggle(automation, on)}
            />
            <span className="text-small text-text-2" aria-hidden>
              {automation.enabled ? 'On' : 'Off'}
            </span>
          </div>
          <div className="ml-auto flex items-center gap-1">
            <Button onClick={() => void save()} disabled={!dirty || update.isPending}>
              {update.isPending ? 'Saving…' : 'Save'}
            </Button>
            <Button
              variant="ghost"
              disabled={!dirty}
              onClick={() => {
                setDraft(saved);
                setErrors({});
              }}
            >
              Discard
            </Button>
            <Button
              variant="ghost"
              size="icon"
              aria-label={`Delete ${automation.name}`}
              onClick={onDelete}
            >
              <Trash2Icon />
            </Button>
          </div>
        </div>
        {automation.disabledReason === 'creator_access' && (
          <p className="text-small text-danger" role="note">
            Turned off: the person it ran as lost access to the base. Turning it on runs it as you.
          </p>
        )}
        {dirty && (
          <p className="text-small text-text-2">
            Unsaved changes. Save to turn it on or off; whoever saves becomes who it runs as.
          </p>
        )}
        {general.length > 0 && (
          <ul className="text-small text-danger" aria-label="Problems">
            {general.map((m) => (
              <li key={m}>{m}</li>
            ))}
          </ul>
        )}
        <StepCard
          label="When"
          title={TRIGGER_LABELS[draft.trigger.type]}
          errors={cardErrors(errors, 'trigger')}
        >
          <TriggerEditor
            automation={automation}
            trigger={draft.trigger}
            tables={tables}
            errorAt={errorAt}
            onChange={(trigger) => setDraft({ ...draft, trigger })}
            onRotateUrl={onRotate}
          />
        </StepCard>
        {draft.actions.length === 0 && (
          <p className="text-text-2">No actions yet. Add what the automation does.</p>
        )}
        <ol aria-label="Actions" className="flex flex-col gap-4">
          {draft.actions.map((action, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: steps are positional, like their tokens
            <li key={i}>
              <ActionCard
                index={i}
                count={draft.actions.length}
                action={action}
                tables={tables}
                tokens={tokensFor(tokenCtx, i + 1)}
                errors={cardErrors(errors, `actions.${i}`)}
                errorAt={errorAt}
                onChange={(next) => setActions(draft.actions.map((a, j) => (j === i ? next : a)))}
                onMove={(to) => setActions(moveItem(draft.actions, i, to))}
                onDelete={() => setActions(draft.actions.filter((_, j) => j !== i))}
                scripts={scripts}
              />
            </li>
          ))}
        </ol>
        <AddAction
          disabled={draft.actions.length >= MAX_AUTOMATION_ACTIONS}
          scripts={scripts}
          onAdd={(type) => {
            const tableId =
              ('tableId' in draft.trigger ? draft.trigger.tableId : null) ?? tables[0]?.id ?? '';
            const tableName = tables.find((t) => t.id === tableId)?.name;
            setActions([
              ...draft.actions,
              defaultAction(type, draft.trigger, tables[0]?.id ?? '', tableName),
            ]);
          }}
        />
      </div>
      <aside
        aria-label="Test and run history"
        className="flex w-full shrink-0 flex-col gap-3 rounded-md border border-border bg-surface p-4 xl:sticky xl:top-0 xl:w-[400px]"
      >
        <div
          role="tablist"
          aria-label="Test and run history"
          className="flex gap-1 border-b border-border"
        >
          {(['test', 'history'] as const).map((t) => (
            <button
              key={t}
              type="button"
              role="tab"
              id={`${tabsId}-${t}`}
              aria-selected={tab === t}
              aria-controls={`${tabsId}-${t}-panel`}
              tabIndex={tab === t ? 0 : -1}
              onClick={() => setTab(t)}
              onKeyDown={(e) => {
                if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
                  const next = t === 'test' ? 'history' : 'test';
                  setTab(next);
                  document.getElementById(`${tabsId}-${next}`)?.focus();
                }
              }}
              className={cn(
                '-mb-px h-9 border-b-2 px-3 font-[550]',
                tab === t
                  ? 'border-primary text-text'
                  : 'border-transparent text-text-2 hover:text-text'
              )}
            >
              {t === 'test' ? 'Test' : 'Run history'}
            </button>
          ))}
        </div>
        <div role="tabpanel" id={`${tabsId}-${tab}-panel`} aria-labelledby={`${tabsId}-${tab}`}>
          {tab === 'test' ? (
            <TestPanel
              automation={automation}
              trigger={draft.trigger}
              dirty={dirty}
              running={test.isPending || update.isPending}
              result={result}
              onTest={(recordId) => void onTest(recordId)}
            />
          ) : (
            <RunHistory automation={automation} />
          )}
        </div>
      </aside>
    </div>
  );
}

/** The fields of several tables at once, by table id (each from the table query cache). */
function useTablesFields(tableIds: readonly string[]) {
  const results = useQueries({ queries: tableIds.map((id) => tableQueries.detail(id)) });
  const out: Record<string, FieldMeta[]> = {};
  for (const q of results) if (q.data) out[q.data.id] = q.data.fields;
  return out;
}

function useLatest<T>(value: T) {
  const [ref] = useState(() => ({ current: value }));
  ref.current = value;
  return ref;
}
