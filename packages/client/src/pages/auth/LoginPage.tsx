import type { AuthErrorCode } from '@openrows/shared';
import { useQuery } from '@tanstack/react-query';
import { type ReactNode, useId, useState } from 'react';
import { BRAND, LogoMark } from '../../app/Logo';
import { Button, buttonVariants } from '../../components/ui/Button';
import { Input } from '../../components/ui/Input';
import { API_DOCS_PATH } from '../../features/api-docs/ApiDocsPage';
import { loginHref, signInInfoQuery } from '../../lib/auth';
import { cn } from '../../lib/utils';

const MESSAGES: Record<AuthErrorCode, string> = {
  not_configured: "Sign-in isn't configured on this server.",
  login_expired: 'Your sign-in took too long or was started in another tab. Please try again.',
  state_mismatch: "We couldn't verify that sign-in request. Please try again.",
  access_denied: 'Sign-in was cancelled.',
  login_failed: 'Sign-in failed. Please try again.',
  email_unverified: 'Please verify your email address first, then sign in again.',
  account_deleted:
    'Your account has been deleted. Its data is permanently removed within 30 days, usually within minutes.',
  account_suspended:
    'This account is suspended. Contact support@openrows.io if you think this is a mistake.',
  sso_required:
    'Your organization requires single sign-on for this address. Use "Sign in with SSO" below.',
  sso_not_found:
    "We couldn't find single sign-on for that address. Check it, or sign in another way.",
  sso_domain_mismatch:
    "Your organization's sign-in vouched for an address outside its domains, so we can't sign you in with it. Contact your administrator.",
};

/** Errors after which the single sign-on form opens by itself. */
const SSO_ERRORS: readonly AuthErrorCode[] = ['sso_required', 'sso_not_found'];

/**
 * "Sign in with SSO": the address's domain finds its workspace's identity provider
 * (home-realm discovery on the server's /auth/login). A full-page navigation like the buttons,
 * not a form submission: CSP's form-action would also bind the redirects to the customer's
 * identity provider.
 */
function SsoSignIn({ returnTo, open: initiallyOpen }: { returnTo?: string; open: boolean }) {
  const id = useId();
  const [open, setOpen] = useState(initiallyOpen);
  if (!open) {
    return (
      <Button
        variant="ghost"
        size="lg"
        className={full}
        onClick={() => setOpen(true)}
        data-testid="sso-open"
      >
        Sign in with SSO
      </Button>
    );
  }
  return (
    <form
      className="grid gap-2 border-t border-border pt-4"
      onSubmit={(e) => {
        e.preventDefault();
        const email = new FormData(e.currentTarget).get('email');
        if (typeof email === 'string' && email.trim()) {
          window.location.assign(loginHref('login', returnTo, undefined, email.trim()));
        }
      }}
    >
      <label htmlFor={`${id}-email`} className="text-small text-text-2">
        Work email
      </label>
      <Input
        id={`${id}-email`}
        name="email"
        type="email"
        required
        autoComplete="email"
        maxLength={320}
        placeholder="you@company.com"
        autoFocus
      />
      <Button type="submit" variant="secondary" size="lg" className={full}>
        Continue with SSO
      </Button>
    </form>
  );
}

function GitHubIcon() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true" fill="currentColor">
      <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z" />
    </svg>
  );
}

function GoogleIcon() {
  return (
    <svg viewBox="0 0 18 18" aria-hidden="true">
      <path
        fill="#4285F4"
        d="M17.64 9.2c0-.64-.06-1.25-.16-1.84H9v3.48h4.84a4.14 4.14 0 01-1.8 2.72v2.26h2.92c1.7-1.57 2.68-3.88 2.68-6.62z"
      />
      <path
        fill="#34A853"
        d="M9 18c2.43 0 4.47-.8 5.96-2.18l-2.92-2.26c-.8.54-1.84.86-3.04.86-2.34 0-4.32-1.58-5.03-3.7H.96v2.33A9 9 0 009 18z"
      />
      <path fill="#FBBC05" d="M3.97 10.72a5.41 5.41 0 010-3.44V4.95H.96a9 9 0 000 8.1l3.01-2.33z" />
      <path
        fill="#EA4335"
        d="M9 3.58c1.32 0 2.5.45 3.44 1.35l2.58-2.58A9 9 0 00.96 4.95l3.01 2.33C4.68 5.16 6.66 3.58 9 3.58z"
      />
    </svg>
  );
}

/** Known providers get a proper name and mark; any other alias still gets a plain button. */
const PROVIDERS: Record<string, { name: string; icon: ReactNode }> = {
  github: { name: 'GitHub', icon: <GitHubIcon /> },
  google: { name: 'Google', icon: <GoogleIcon /> },
};

function providerLabel(alias: string) {
  return PROVIDERS[alias]?.name ?? alias.charAt(0).toUpperCase() + alias.slice(1);
}

const full = 'w-full';

export function LoginPage({ error, returnTo }: { error?: AuthErrorCode; returnTo?: string }) {
  // Configured on the server (AUTH_PROVIDERS); none means just the provider's own page. The
  // status page link (STATUS_PAGE_URL) helps when sign-in itself is what's broken.
  const { data } = useQuery(signInInfoQuery);
  const providers = data?.providers ?? [];
  const statusPageUrl = data?.statusPageUrl ?? null;
  return (
    <div className="flex min-h-screen flex-col bg-app px-4">
      <main className="flex flex-1 items-center justify-center">
        <div className="w-full max-w-sm rounded-lg border border-border bg-surface p-8 shadow-1">
          <LogoMark size={40} className="mx-auto mb-4 block" />
          <h1 className="mb-1 text-center text-title font-semibold text-text">{`Sign in to ${BRAND}`}</h1>
          <p className="mb-6 text-center text-small text-text-2">
            Open-source, privacy-first alternative to Airtable
          </p>
          {error && (
            <p
              role={error === 'account_deleted' ? 'status' : 'alert'}
              className={cn(
                'mb-4 rounded-sm p-3 text-small',
                error === 'account_deleted'
                  ? 'bg-hover text-text'
                  : 'bg-destructive/10 text-destructive'
              )}
            >
              {MESSAGES[error]}
            </p>
          )}
          {/* Plain links: sign-in is a full-page redirect through the server to the provider. */}
          {providers.length > 0 && (
            <>
              <div className="flex flex-col gap-2">
                {providers.map((alias) => (
                  <a
                    key={alias}
                    href={loginHref('login', returnTo, alias)}
                    data-provider={alias}
                    className={cn(buttonVariants({ variant: 'secondary', size: 'lg' }), full)}
                  >
                    {PROVIDERS[alias]?.icon}
                    Continue with {providerLabel(alias)}
                  </a>
                ))}
              </div>
              <div
                className="my-5 flex items-center gap-3 text-small text-text-2"
                aria-hidden="true"
              >
                <span className="h-px flex-1 bg-border" />
                or
                <span className="h-px flex-1 bg-border" />
              </div>
            </>
          )}
          <div className="flex flex-col gap-2">
            <a
              href={loginHref('login', returnTo)}
              className={cn(buttonVariants({ variant: 'default', size: 'lg' }), full)}
            >
              Sign in
            </a>
            <a
              href={loginHref('signup', returnTo)}
              className={cn(buttonVariants({ variant: 'ghost', size: 'lg' }), full)}
            >
              Create account
            </a>
            <SsoSignIn
              returnTo={returnTo}
              open={error !== undefined && SSO_ERRORS.includes(error)}
            />
          </div>
        </div>
      </main>
      <footer className="flex justify-center gap-4 py-4 text-small text-text-2">
        <a href={API_DOCS_PATH} className="hover:text-text">
          API docs
        </a>
        {statusPageUrl && (
          <a
            href={statusPageUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="hover:text-text"
          >
            Status
          </a>
        )}
      </footer>
    </div>
  );
}
