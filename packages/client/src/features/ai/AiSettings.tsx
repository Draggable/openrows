import { AI_PRESETS, type AiSettings, type AiTestResult } from '@openrows/shared';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useEffect, useId, useState } from 'react';
import { ApiError, api } from '../../api/client';
import { queryKeys } from '../../api/keys';
import { useAiSettings } from '../../api/queries';
import { Button, Input, Skeleton, toast } from '../../components/ui';
import {
  type AiForm,
  choosePreset,
  formProblem,
  initialForm,
  keyRequired,
  type PresetId,
  saveErrors,
  sourceText,
  toRequest,
} from './model';

const section = 'rounded-lg border border-border bg-surface p-5 shadow-1';
const selectClass =
  'h-8 w-full rounded-sm border border-border bg-surface px-2 text-body text-text hover:border-border-strong';

/**
 * Settings → AI, for the workspace's owners: where AI features get their provider (this
 * server's, the workspace's own key, or none and AI is hidden), and the form to bring your own
 * key for any OpenAI-compatible API. The key is write-only: once saved, the form only says one
 * is stored. "Test connection" sends one small request and shows what came back.
 */
export function AiSettingsPanels({ workspaceId }: { workspaceId: string }) {
  const settings = useAiSettings(workspaceId);
  if (!settings.data) {
    return settings.isError ? (
      <p role="alert" className="text-text-2">
        Couldn't load the AI settings.
      </p>
    ) : (
      <Skeleton className="h-60" />
    );
  }
  return <AiSettingsForm workspaceId={workspaceId} settings={settings.data} />;
}

function AiSettingsForm({ workspaceId, settings }: { workspaceId: string; settings: AiSettings }) {
  const qc = useQueryClient();
  const id = useId();
  const [form, setForm] = useState<AiForm>(() => initialForm(settings));
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [test, setTest] = useState<AiTestResult | null>(null);
  const stored = settings.workspace;
  // The stored settings changed (saved or removed): the form follows them.
  const storedKey = stored ? `${stored.baseUrl}|${stored.model}|${stored.updatedAt}` : '';
  // biome-ignore lint/correctness/useExhaustiveDependencies: reset only when what's stored changes.
  useEffect(() => {
    setForm(initialForm(settings));
    setErrors({});
  }, [storedKey]);

  const refresh = (next: AiSettings) => {
    qc.setQueryData(queryKeys.workspaces.aiSettings(workspaceId), next);
    void qc.invalidateQueries({ queryKey: queryKeys.workspaces.ai(workspaceId), exact: true });
  };
  const save = useMutation({
    mutationFn: () =>
      api.workspaces.updateAiSettings({ params: { workspaceId }, body: toRequest(form) }),
    onSuccess: (next) => {
      refresh(next);
      setTest(null);
      toast.success('AI settings saved');
    },
    onError: (err) => {
      const { message, byField } = saveErrors(err);
      setErrors(byField);
      if (Object.keys(byField).length === 0) toast.error(message);
    },
  });
  const remove = useMutation({
    mutationFn: () => api.workspaces.deleteAiSettings({ params: { workspaceId } }),
    onSuccess: (next) => {
      refresh(next);
      setTest(null);
      toast.success("This workspace's key was removed");
    },
    onError: (err) =>
      toast.error(err instanceof ApiError ? err.message : "Couldn't remove the key"),
  });
  const runTest = useMutation({
    mutationFn: () => api.workspaces.testAiSettings({ params: { workspaceId } }),
    onSuccess: setTest,
    onError: (err) => {
      setTest(null);
      toast.error(err instanceof ApiError ? err.message : "Couldn't run the test");
    },
  });

  const problem = formProblem(form, settings);
  const needsKey = keyRequired(form, settings);
  const set = (patch: Partial<AiForm>) => setForm((f) => ({ ...f, ...patch }));
  const fieldError = (path: string) =>
    errors[path] ? (
      <p id={`${id}-${path}-error`} className="text-small text-danger">
        {errors[path]}
      </p>
    ) : null;

  return (
    <>
      <section aria-labelledby={`${id}-status`} className={section}>
        <h2 id={`${id}-status`} className="mb-1 text-heading font-semibold">
          AI provider
        </h2>
        <p className="text-text-2" data-testid="ai-source">
          {sourceText(settings)}
        </p>
        {settings.source !== null && (
          <div className="mt-4 flex flex-wrap items-center gap-3">
            <Button
              variant="secondary"
              onClick={() => runTest.mutate()}
              disabled={runTest.isPending}
            >
              {runTest.isPending ? 'Testing…' : 'Test connection'}
            </Button>
            {test && (
              <p role="status" className={test.ok ? 'text-text' : 'text-danger'}>
                {test.ok
                  ? `Connected: ${test.model} answered in ${test.latencyMs} ms (${test.usage?.totalTokens ?? 0} tokens).`
                  : `Test failed: ${test.error ?? 'no answer'}`}
              </p>
            )}
          </div>
        )}
      </section>

      <section aria-labelledby={`${id}-byo`} className={section}>
        <h2 id={`${id}-byo`} className="mb-1 text-heading font-semibold">
          Your own API key
        </h2>
        <p className="mb-4 text-text-2">
          Any OpenAI-compatible API works: OpenAI, Anthropic, OpenRouter or your own server. The key
          is encrypted and never shown again after you save it.
        </p>
        <form
          className="grid gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            if (!problem) save.mutate();
          }}
        >
          <div className="grid gap-1.5">
            <label htmlFor={`${id}-preset`} className="font-medium">
              Provider
            </label>
            <select
              id={`${id}-preset`}
              className={selectClass}
              value={form.preset}
              onChange={(e) => setForm((f) => choosePreset(f, e.target.value as PresetId))}
            >
              {AI_PRESETS.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
              <option value="custom">Other OpenAI-compatible API</option>
            </select>
          </div>
          <div className="grid gap-1.5">
            <label htmlFor={`${id}-url`} className="font-medium">
              API base URL
            </label>
            <Input
              id={`${id}-url`}
              type="url"
              inputMode="url"
              spellCheck={false}
              placeholder="https://api.example.com/v1"
              value={form.baseUrl}
              readOnly={form.preset !== 'custom'}
              onChange={(e) => set({ baseUrl: e.target.value })}
              aria-invalid={errors['baseUrl'] ? true : undefined}
              aria-describedby={`${id}-url-hint${errors['baseUrl'] ? ` ${id}-baseUrl-error` : ''}`}
            />
            <p id={`${id}-url-hint`} className="text-small text-text-2">
              Up to the version, without <code>/chat/completions</code>.
              {settings.allowedHosts &&
                ` This server reaches: ${settings.allowedHosts.join(', ')}.`}
            </p>
            {fieldError('baseUrl')}
          </div>
          <div className="grid gap-1.5">
            <label htmlFor={`${id}-model`} className="font-medium">
              Model
            </label>
            <Input
              id={`${id}-model`}
              spellCheck={false}
              autoComplete="off"
              value={form.model}
              onChange={(e) => set({ model: e.target.value })}
              aria-invalid={errors['model'] ? true : undefined}
              aria-describedby={errors['model'] ? `${id}-model-error` : undefined}
            />
            {fieldError('model')}
          </div>
          <div className="grid gap-1.5">
            <label htmlFor={`${id}-key`} className="font-medium">
              API key
            </label>
            <Input
              id={`${id}-key`}
              type="password"
              autoComplete="off"
              spellCheck={false}
              placeholder={needsKey ? 'sk-…' : 'A key is saved. Type a new one to replace it.'}
              value={form.apiKey}
              onChange={(e) => set({ apiKey: e.target.value })}
              aria-invalid={errors['apiKey'] ? true : undefined}
              aria-describedby={`${id}-key-hint${errors['apiKey'] ? ` ${id}-apiKey-error` : ''}`}
            />
            <p id={`${id}-key-hint`} className="text-small text-text-2">
              {stored && !needsKey
                ? 'Leave it empty to keep the saved key.'
                : stored
                  ? 'Enter the API key again to use it with a new URL.'
                  : 'Stored encrypted. Only the server uses it, to call the provider.'}
            </p>
            {fieldError('apiKey')}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Button type="submit" disabled={!!problem || save.isPending}>
              {save.isPending ? 'Saving…' : 'Save'}
            </Button>
            {stored && (
              <Button
                type="button"
                variant="ghost"
                onClick={() => remove.mutate()}
                disabled={remove.isPending}
              >
                Remove key
              </Button>
            )}
            {problem && <span className="text-small text-text-2">{problem}</span>}
          </div>
        </form>
      </section>
    </>
  );
}
