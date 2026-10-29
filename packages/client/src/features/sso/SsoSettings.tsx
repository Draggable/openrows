import {
  SSO_JIT_ROLES,
  SSO_PROTOCOLS,
  type SsoDomain,
  type SsoProtocol,
  type SsoState,
} from '@openrows/shared';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useId, useState } from 'react';
import { ssoApi } from '../../api/client';
import { queryKeys } from '../../api/keys';
import { useSso } from '../../api/queries';
import { Button, Input, Skeleton, toast } from '../../components/ui';
import { cn } from '../../lib/utils';
import {
  errorText,
  formFrom,
  inputFrom,
  PROTOCOL_LABELS,
  ROLE_LABELS,
  type SsoForm,
  ssoUnavailable,
} from './model';

const section = 'rounded-lg border border-border bg-surface p-5 shadow-1';
const label = 'text-small text-text-2';
const selectClass =
  'h-8 rounded-sm border border-border bg-surface px-2 text-body text-text hover:border-border-strong';

/**
 * Settings → Single sign-on, for a workspace's owners on a plan with `sso`: the SAML or
 * OIDC identity provider (set up in OpenRows' Keycloak), its email domains with their DNS TXT
 * records, "require SSO" and JIT membership. Self-hosted servers have none (404) and other plans
 * are told what they need (403).
 */
export function SsoSettings({ workspaceId }: { workspaceId: string }) {
  const sso = useSso(workspaceId);
  if (sso.isError) {
    const why = ssoUnavailable(sso.error);
    return (
      <section className={section}>
        <h2 className="mb-1 text-heading font-semibold">Single sign-on</h2>
        <p className="text-text-2">
          {why === 'edition'
            ? "This OpenRows server doesn't offer single sign-on per workspace. Its operator can add identity providers to Keycloak directly."
            : why === 'plan'
              ? 'Single sign-on with your SAML or OIDC identity provider is part of the Business and Enterprise plans.'
              : "Couldn't load the single sign-on settings."}
        </p>
      </section>
    );
  }
  if (!sso.data) return <Skeleton className="h-64" />;
  return (
    <>
      <ProviderPanel workspaceId={workspaceId} state={sso.data} />
      <DomainsPanel workspaceId={workspaceId} state={sso.data} />
    </>
  );
}

function Copyable({ name, value }: { name: string; value: string }) {
  return (
    <div className="grid gap-1">
      <span className={label}>{name}</span>
      <div className="flex items-center gap-2">
        <code className="min-w-0 flex-1 break-all rounded-sm bg-app px-2 py-1 text-small">
          {value}
        </code>
        <Button
          variant="ghost"
          size="sm"
          aria-label={`Copy ${name}`}
          onClick={() => {
            void navigator.clipboard?.writeText(value).then(() => toast.success('Copied'));
          }}
        >
          Copy
        </Button>
      </div>
    </div>
  );
}

function ProviderPanel({ workspaceId, state }: { workspaceId: string; state: SsoState }) {
  const id = useId();
  const qc = useQueryClient();
  const connection = state.connection;
  const [form, setForm] = useState<SsoForm>(() => formFrom(connection));
  const set = <K extends keyof SsoForm>(key: K, value: SsoForm[K]) =>
    setForm((f) => ({ ...f, [key]: value }));
  const saved = (next: SsoState) => {
    qc.setQueryData(queryKeys.workspaces.sso(workspaceId), next);
    setForm(formFrom(next.connection));
  };
  const save = useMutation({
    mutationFn: () => ssoApi.connection.put({ params: { workspaceId }, body: inputFrom(form) }),
    onSuccess: (next) => {
      saved(next);
      toast.success('Single sign-on saved');
    },
    onError: (err) => toast.error(errorText(err, "Couldn't save single sign-on")),
  });
  const remove = useMutation({
    mutationFn: () => ssoApi.connection.delete({ params: { workspaceId } }),
    onSuccess: () => {
      saved({ ...state, connection: null, domains: [] });
      toast.success('Single sign-on removed');
    },
    onError: (err) => toast.error(errorText(err, "Couldn't remove single sign-on")),
  });
  const sp = state.serviceProvider;
  const oidc = form.protocol === 'oidc';
  const field = (key: keyof SsoForm) => `${id}-${key}`;

  return (
    <section aria-labelledby={`${id}-title`} className={section}>
      <h2 id={`${id}-title`} className="mb-1 text-heading font-semibold">
        Identity provider
      </h2>
      <p className="mb-4 text-text-2">
        People sign in with your organization's SAML or OpenID Connect provider (Okta, Microsoft
        Entra ID, Google Workspace, Keycloak and others). Add OpenRows as an app there with these
        details.
      </p>
      {!state.available && (
        <p
          role="alert"
          className="mb-4 rounded-sm bg-destructive/10 p-3 text-small text-destructive"
        >
          Single sign-on isn't set up on this server yet. Contact support@openrows.io.
        </p>
      )}
      <fieldset className="mb-4">
        <legend className={cn(label, 'mb-1')}>Protocol</legend>
        <div className="flex gap-2">
          {SSO_PROTOCOLS.map((p: SsoProtocol) => (
            <label
              key={p}
              className={cn(
                'cursor-pointer rounded-sm border border-border px-2.5 py-1 text-small has-focus-visible:outline-2 has-focus-visible:outline-brand',
                form.protocol === p
                  ? 'border-primary bg-selected font-[550] text-primary'
                  : 'text-text-2 hover:bg-hover'
              )}
            >
              <input
                type="radio"
                name={`${id}-protocol`}
                value={p}
                checked={form.protocol === p}
                onChange={() => set('protocol', p)}
                className="sr-only"
              />
              {PROTOCOL_LABELS[p]}
            </label>
          ))}
        </div>
      </fieldset>
      <div className="mb-5 grid gap-3 rounded-md border border-border p-3" data-testid="sso-sp">
        {oidc ? (
          <Copyable name="Redirect URI" value={sp.redirectUri} />
        ) : (
          <>
            <Copyable name="Entity ID (audience)" value={sp.entityId} />
            <Copyable name="ACS URL" value={sp.acsUrl} />
            <Copyable name="Metadata URL" value={sp.metadataUrl} />
            <p className="text-small text-text-2">
              Send the email address as the NameID (emailAddress format) and the attributes{' '}
              <code>email</code>, <code>firstName</code> and <code>lastName</code>; sign the
              response or the assertion.
            </p>
          </>
        )}
      </div>
      <form
        className="grid gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          save.mutate();
        }}
      >
        <div className="grid gap-1">
          <label htmlFor={field('displayName')} className={label}>
            Name
          </label>
          <Input
            id={field('displayName')}
            required
            maxLength={100}
            placeholder="Acme Okta"
            value={form.displayName}
            onChange={(e) => set('displayName', e.target.value)}
          />
        </div>
        {oidc ? (
          <>
            <div className="grid gap-1">
              <label htmlFor={field('issuer')} className={label}>
                Issuer URL
              </label>
              <Input
                id={field('issuer')}
                type="url"
                required
                maxLength={500}
                placeholder="https://acme.okta.com"
                value={form.issuer}
                onChange={(e) => set('issuer', e.target.value)}
              />
            </div>
            <div className="grid gap-3 md:grid-cols-2">
              <div className="grid gap-1">
                <label htmlFor={field('clientId')} className={label}>
                  Client ID
                </label>
                <Input
                  id={field('clientId')}
                  required
                  maxLength={200}
                  value={form.clientId}
                  onChange={(e) => set('clientId', e.target.value)}
                />
              </div>
              <div className="grid gap-1">
                <label htmlFor={field('clientSecret')} className={label}>
                  Client secret
                </label>
                <Input
                  id={field('clientSecret')}
                  type="password"
                  autoComplete="off"
                  required={connection?.protocol !== 'oidc'}
                  maxLength={500}
                  placeholder={connection?.protocol === 'oidc' ? 'Saved; enter to replace' : ''}
                  value={form.clientSecret}
                  onChange={(e) => set('clientSecret', e.target.value)}
                />
              </div>
            </div>
          </>
        ) : (
          <>
            <div className="grid gap-3 md:grid-cols-2">
              <div className="grid gap-1">
                <label htmlFor={field('entityId')} className={label}>
                  Identity provider entity ID
                </label>
                <Input
                  id={field('entityId')}
                  required
                  maxLength={500}
                  placeholder="http://www.okta.com/exk…"
                  value={form.entityId}
                  onChange={(e) => set('entityId', e.target.value)}
                />
              </div>
              <div className="grid gap-1">
                <label htmlFor={field('ssoUrl')} className={label}>
                  SSO URL
                </label>
                <Input
                  id={field('ssoUrl')}
                  type="url"
                  required
                  maxLength={500}
                  value={form.ssoUrl}
                  onChange={(e) => set('ssoUrl', e.target.value)}
                />
              </div>
            </div>
            <div className="grid gap-1">
              <label htmlFor={field('certificate')} className={label}>
                Signing certificate (PEM)
              </label>
              <textarea
                id={field('certificate')}
                required={connection?.protocol !== 'saml'}
                maxLength={20000}
                rows={4}
                placeholder={
                  connection?.saml
                    ? 'Saved; paste a new one to replace'
                    : '-----BEGIN CERTIFICATE-----'
                }
                value={form.certificate}
                onChange={(e) => set('certificate', e.target.value)}
                className="rounded-sm border border-border bg-surface px-2 py-1 font-mono text-small text-text hover:border-border-strong"
              />
              {connection?.saml?.certificateFingerprints.map((f) => (
                <span key={f} className="break-all text-small text-text-2">
                  SHA-256 {f}
                </span>
              ))}
            </div>
          </>
        )}
        <div className="grid gap-2">
          <label className="flex items-center gap-2 text-text">
            <input
              type="checkbox"
              checked={form.jit}
              onChange={(e) => set('jit', e.target.checked)}
              className="size-4 accent-[var(--accent)]"
            />
            <span>Add people of the verified domains to this workspace on their first sign-in</span>
          </label>
          <div className="flex items-center gap-2 pl-6">
            <label htmlFor={field('defaultRole')} className={label}>
              as
            </label>
            <select
              id={field('defaultRole')}
              className={selectClass}
              value={form.defaultRole}
              disabled={!form.jit}
              onChange={(e) => set('defaultRole', e.target.value as SsoForm['defaultRole'])}
            >
              {SSO_JIT_ROLES.map((r) => (
                <option key={r} value={r}>
                  {ROLE_LABELS[r]}
                </option>
              ))}
            </select>
          </div>
          <label className="flex items-center gap-2 text-text">
            <input
              type="checkbox"
              checked={form.requireSso}
              onChange={(e) => set('requireSso', e.target.checked)}
              className="size-4 accent-[var(--accent)]"
            />
            <span>Require single sign-on for addresses on the verified domains</span>
          </label>
          <p className="pl-6 text-small text-text-2">
            They can't sign in with a password, Google or GitHub. This workspace's owners keep every
            way in, so a broken provider can't lock them out.
          </p>
          <label className="flex items-center gap-2 text-text">
            <input
              type="checkbox"
              checked={form.enabled}
              onChange={(e) => set('enabled', e.target.checked)}
              className="size-4 accent-[var(--accent)]"
            />
            <span>On</span>
          </label>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button type="submit" disabled={save.isPending || !state.available}>
            {connection ? 'Save' : 'Connect'}
          </Button>
          {connection && (
            <Button
              type="button"
              variant="secondary"
              disabled={remove.isPending || !state.available}
              onClick={() => remove.mutate()}
            >
              Remove
            </Button>
          )}
        </div>
      </form>
    </section>
  );
}

function DomainsPanel({ workspaceId, state }: { workspaceId: string; state: SsoState }) {
  const id = useId();
  const qc = useQueryClient();
  const [domain, setDomain] = useState('');
  const key = queryKeys.workspaces.sso(workspaceId);
  const update = (fn: (domains: SsoDomain[]) => SsoDomain[]) =>
    qc.setQueryData<SsoState>(key, (s) => (s ? { ...s, domains: fn(s.domains) } : s));
  const add = useMutation({
    mutationFn: () => ssoApi.domains.add({ params: { workspaceId }, body: { domain } }),
    onSuccess: (d) => {
      update((ds) => [...ds, d].sort((a, b) => a.domain.localeCompare(b.domain)));
      setDomain('');
    },
    onError: (err) => toast.error(errorText(err, "Couldn't add the domain")),
  });
  const verify = useMutation({
    mutationFn: (domainId: string) => ssoApi.domains.verify({ params: { workspaceId, domainId } }),
    onSuccess: (d) => {
      update((ds) => ds.map((x) => (x.id === d.id ? d : x)));
      if (d.verifiedAt) toast.success(`${d.domain} is verified`);
      else toast.error(`The TXT record of ${d.domain} isn't there yet. DNS can take a while.`);
    },
    onError: (err) => toast.error(errorText(err, "Couldn't verify the domain")),
  });
  const remove = useMutation({
    mutationFn: (domainId: string) => ssoApi.domains.delete({ params: { workspaceId, domainId } }),
    onSuccess: (_r, domainId) => update((ds) => ds.filter((x) => x.id !== domainId)),
    onError: (err) => toast.error(errorText(err, "Couldn't remove the domain")),
  });

  return (
    <section aria-labelledby={`${id}-title`} className={section}>
      <h2 id={`${id}-title`} className="mb-1 text-heading font-semibold">
        Email domains
      </h2>
      <p className="mb-4 text-text-2">
        Single sign-on applies to addresses on these domains once each is verified: add its TXT
        record at your DNS provider, then select Verify. People find your provider with "Sign in
        with SSO" on the sign-in page.
      </p>
      <form
        className="mb-4 flex flex-wrap items-end gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          add.mutate();
        }}
      >
        <div className="grid min-w-64 flex-1 gap-1">
          <label htmlFor={`${id}-domain`} className={label}>
            Domain
          </label>
          <Input
            id={`${id}-domain`}
            required
            maxLength={253}
            placeholder="acme.com"
            value={domain}
            onChange={(e) => setDomain(e.target.value)}
          />
        </div>
        <Button type="submit" variant="secondary" disabled={add.isPending || !domain.trim()}>
          Add domain
        </Button>
      </form>
      {state.domains.length === 0 ? (
        <p className="text-text-2">No domains yet.</p>
      ) : (
        <ul className="grid gap-3">
          {state.domains.map((d) => (
            <li
              key={d.id}
              className="grid gap-3 rounded-md border border-border p-3"
              data-testid="sso-domain"
            >
              <div className="flex flex-wrap items-center gap-3">
                <span className="font-[550] text-text">{d.domain}</span>
                <span
                  className={cn(
                    'rounded-sm px-1.5 text-small',
                    d.verifiedAt ? 'bg-selected text-primary' : 'bg-hover text-text-2'
                  )}
                >
                  {d.verifiedAt ? 'Verified' : 'Not verified'}
                </span>
                <span className="ml-auto flex gap-2">
                  {!d.verifiedAt && (
                    <Button
                      size="sm"
                      variant="secondary"
                      disabled={verify.isPending}
                      onClick={() => verify.mutate(d.id)}
                    >
                      Verify
                    </Button>
                  )}
                  <Button
                    size="sm"
                    variant="ghost"
                    aria-label={`Remove ${d.domain}`}
                    disabled={remove.isPending}
                    onClick={() => remove.mutate(d.id)}
                  >
                    Remove
                  </Button>
                </span>
              </div>
              {!d.verifiedAt && (
                <div className="grid gap-2 md:grid-cols-2">
                  <Copyable name={`TXT record name for ${d.domain}`} value={d.txtName} />
                  <Copyable name={`TXT record value for ${d.domain}`} value={d.txtValue} />
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
