import { type ErrorComponentProps, Link, useRouter } from '@tanstack/react-router';
import { ApiError } from '../api/client';
import { Button, buttonVariants } from '../components/ui';
import { Logo } from './Logo';

/** The router's error boundary: a missing resource reads as "not found", the rest can retry. */
export function ErrorPage({ error, reset }: ErrorComponentProps) {
  const router = useRouter();
  const notFound = error instanceof ApiError && error.status === 404;
  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-4 bg-app p-6 text-center">
      <Logo />
      <h1 className="text-title font-semibold">
        {notFound ? "This page doesn't exist or you don't have access" : 'Something went wrong'}
      </h1>
      <p className="max-w-md text-text-2">
        {notFound
          ? 'It may have been deleted, or it belongs to a workspace you are not a member of.'
          : 'Try again. If it keeps happening, reload the page.'}
      </p>
      <div className="flex gap-2">
        {!notFound && (
          <Button
            onClick={() => {
              reset();
              router.invalidate();
            }}
          >
            Try again
          </Button>
        )}
        <Link to="/" className={buttonVariants({ variant: 'secondary' })}>
          Go home
        </Link>
      </div>
    </main>
  );
}

export function NotFoundPage() {
  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-3 bg-app text-center">
      <h1 className="text-title font-semibold">Page not found</h1>
      <Link to="/" className="text-primary hover:underline">
        Go back home
      </Link>
    </main>
  );
}
