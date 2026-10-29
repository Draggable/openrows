import type { ComponentProps } from 'react';
import { clearOfflineData } from './offline';

/**
 * The sign-out form: a POST to /auth/logout (the server checks Origin, ends the session and
 * signs out at the provider), sent once this browser's offline data is deleted.
 */
export function SignOutForm(props: Omit<ComponentProps<'form'>, 'method' | 'action' | 'onSubmit'>) {
  return (
    <form
      {...props}
      method="post"
      action="/auth/logout"
      onSubmit={(e) => {
        e.preventDefault();
        const form = e.currentTarget;
        void clearOfflineData()
          .catch(() => undefined)
          .finally(() => form.submit());
      }}
    />
  );
}
