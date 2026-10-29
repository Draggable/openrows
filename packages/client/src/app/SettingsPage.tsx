import {
  DAILY_DIGEST_HOUR_UTC,
  downloads,
  type MeResponse,
  type NotificationEmailFrequency,
  type NotificationEmailPreference,
} from '@openrows/shared';
import { DownloadIcon } from 'lucide-react';
import { downloadUrl } from '../api/client';
import { useNotificationPreferences, useUpdateNotificationPreferences } from '../api/queries';
import { Button, toast } from '../components/ui';
import { DeleteAccount } from '../features/account/DeleteAccount';
import { SupportAccess } from '../features/admin/SupportAccess';
import { AuthorizedApps, OAuthApps } from '../features/oauth/Integrations';
import { SignOutForm } from '../features/offline/SignOutForm';
import { ConnectedAccounts } from '../features/syncs/ConnectedAccounts';
import { AccessTokens } from '../features/tokens/AccessTokens';
import { type ThemePreference, useTheme } from '../lib/theme';
import { cn } from '../lib/utils';
import { HomeSidebar } from './HomeSidebar';
import { Shell, TopBar } from './Shell';

const THEMES: { value: ThemePreference; label: string }[] = [
  { value: 'system', label: 'System' },
  { value: 'light', label: 'Light' },
  { value: 'dark', label: 'Dark' },
];

const EMAIL_PREFERENCES: { value: NotificationEmailPreference; label: string }[] = [
  { value: 'all', label: 'All notifications' },
  { value: 'mentions', label: 'Only mentions' },
  { value: 'none', label: 'Nothing' },
];

const EMAIL_FREQUENCIES: { value: NotificationEmailFrequency; label: string }[] = [
  { value: 'immediately', label: 'Right away' },
  { value: 'hourly', label: 'Hourly digest' },
  { value: 'daily', label: 'Daily digest' },
];

function Choices<T extends string>({
  title,
  options,
  current,
  onPick,
}: {
  title: string;
  options: readonly { value: T; label: string }[];
  current: T | undefined;
  onPick: (value: T) => void;
}) {
  return (
    <fieldset className="mt-3">
      <legend className="font-[550]">{title}</legend>
      <div className="mt-2 flex flex-wrap gap-2">
        {options.map((p) => (
          <button
            key={p.value}
            type="button"
            aria-pressed={current === p.value}
            onClick={() => onPick(p.value)}
            className={cn(
              'h-8 rounded-sm border border-border px-3 hover:bg-hover pointer-coarse:h-[40px]',
              current === p.value && 'border-primary bg-selected font-[550] text-primary'
            )}
          >
            {p.label}
          </button>
        ))}
      </div>
    </fieldset>
  );
}

/**
 * Which notifications are emailed and when (right away, or an hourly or daily
 * digest); the inbox always gets all of them.
 */
function NotificationSettings() {
  const prefs = useNotificationPreferences();
  const update = useUpdateNotificationPreferences();
  const pending = update.isPending ? update.variables : undefined;
  const email = pending?.email ?? prefs.data?.email;
  const frequency = pending?.frequency ?? prefs.data?.frequency;
  const save = (body: {
    email?: NotificationEmailPreference;
    frequency?: NotificationEmailFrequency;
  }) => update.mutate(body, { onError: () => toast.error("Couldn't save the email setting") });
  // The daily digest's hour in the viewer's time zone.
  const dailyAt = new Date(Date.UTC(2000, 0, 1, DAILY_DIGEST_HOUR_UTC)).toLocaleTimeString([], {
    hour: 'numeric',
    minute: '2-digit',
  });
  return (
    <section className="rounded-lg border border-border bg-surface p-5 shadow-1">
      <fieldset disabled={!prefs.data}>
        <legend className="text-heading font-semibold">Email notifications</legend>
        <p className="mt-1 text-text-2">
          Mentions, replies on records you commented on, and being added to a user field. The bell
          in the top bar always shows all of them.
        </p>
        <Choices
          title="What"
          options={EMAIL_PREFERENCES}
          current={email}
          onPick={(value) => save({ email: value })}
        />
        <Choices
          title="When"
          options={EMAIL_FREQUENCIES}
          current={frequency}
          onPick={(value) => save({ frequency: value })}
        />
        <p className="mt-2 text-small text-text-2">
          {frequency === 'hourly'
            ? 'One email an hour, on the hour, with everything new.'
            : frequency === 'daily'
              ? `One email a day, around ${dailyAt}, with everything new.`
              : 'One email per record, at most every 10 minutes.'}
        </p>
      </fieldset>
    </section>
  );
}

/**
 * `/settings`: account, appearance, notification emails, your data, access tokens and
 * deleting the account.
 */
export function SettingsPage({ me }: { me: MeResponse }) {
  const { preference, setPreference } = useTheme();
  return (
    <Shell sidebar={<HomeSidebar me={me} />}>
      <TopBar>
        <h1 className="text-heading font-semibold">Settings</h1>
      </TopBar>
      <main className="flex-1 overflow-y-auto px-4 py-6 md:px-8">
        <div className="grid max-w-xl grid-cols-[minmax(0,1fr)] gap-6">
          <section className="rounded-lg border border-border bg-surface p-5 shadow-1">
            <h2 className="text-heading font-semibold">Account</h2>
            <dl className="mt-3 grid grid-cols-[96px_minmax(0,1fr)] gap-y-2 sm:grid-cols-[120px_minmax(0,1fr)]">
              <dt className="text-text-2">Name</dt>
              <dd>{me.user.name ?? '—'}</dd>
              <dt className="text-text-2">Email</dt>
              <dd className="[overflow-wrap:anywhere]">{me.user.email ?? '—'}</dd>
            </dl>
            <SignOutForm className="mt-4">
              <Button type="submit" variant="secondary">
                Sign out
              </Button>
            </SignOutForm>
          </section>
          <section className="rounded-lg border border-border bg-surface p-5 shadow-1">
            <fieldset>
              <legend className="text-heading font-semibold">Appearance</legend>
              <div className="mt-3 flex gap-2">
                {THEMES.map((t) => (
                  <button
                    key={t.value}
                    type="button"
                    aria-pressed={preference === t.value}
                    onClick={() => setPreference(t.value)}
                    className={cn(
                      'h-8 rounded-sm border border-border px-3 hover:bg-hover pointer-coarse:h-[40px]',
                      preference === t.value && 'border-primary bg-selected font-[550] text-primary'
                    )}
                  >
                    {t.label}
                  </button>
                ))}
              </div>
            </fieldset>
          </section>
          <NotificationSettings />
          <section
            aria-labelledby="settings-your-data"
            className="rounded-lg border border-border bg-surface p-5 shadow-1"
          >
            <h2 id="settings-your-data" className="text-heading font-semibold">
              Your data
            </h2>
            <p className="mt-2 text-text-2">
              Download a ZIP of your profile, workspace memberships, the comments you wrote, and
              every base of the workspaces you own (CSV and JSON per table, with attachments).
            </p>
            <Button asChild variant="secondary" className="mt-4">
              <a href={downloadUrl(downloads.accountExport, { params: {} })} download>
                <DownloadIcon aria-hidden />
                Export my data
              </a>
            </Button>
          </section>
          <AuthorizedApps />
          <ConnectedAccounts />
          <AccessTokens />
          <OAuthApps />
          <SupportAccess />
          <DeleteAccount />
        </div>
      </main>
    </Shell>
  );
}
