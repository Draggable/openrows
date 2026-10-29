import type { Base, UserRole } from '@openrows/shared';
import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { CreditCardIcon } from 'lucide-react';
import { useWorkspaces, workspaceQueries } from '../../api/queries';
import { Button } from '../../components/ui';
import { cn } from '../../lib/utils';
import { paymentAlert } from './billing-model';

/**
 * The payment-failed banner at the top of a workspace and its bases, for its owners while
 * the subscription is past due: in the grace period (amber: the plan stays until a date) and after
 * it (red: Free limits apply, nothing deleted). "Update payment" opens the Billing page. Not
 * dismissible: it goes away when the payment goes through. Ledger: a neutral fill with a 2 px top
 * accent, never a coloured left border.
 */
export function PaymentBanner({
  workspaceId,
  role,
}: {
  workspaceId: string;
  role: UserRole | null;
}) {
  const owner = role === 'owner';
  const billing = useQuery({ ...workspaceQueries.billing(workspaceId), enabled: owner });
  const alert = owner ? paymentAlert(billing.data) : null;
  if (!alert) return null;
  return (
    <div
      role="alert"
      data-testid="payment-banner"
      data-level={alert.level}
      className={cn(
        'flex shrink-0 items-start gap-2 border-b border-border border-t-2 bg-header px-3 py-2 md:px-6',
        alert.level === 'ended' ? 'border-t-danger' : 'border-t-warning'
      )}
    >
      <CreditCardIcon
        aria-hidden
        className={cn(
          'mt-0.5 size-4 shrink-0',
          alert.level === 'ended' ? 'text-danger' : 'text-[var(--warning)]'
        )}
      />
      <div className="min-w-0 flex-1">
        <p className="font-[550]">{alert.title}</p>
        <p className="text-text-2">{alert.text}</p>
      </div>
      <Button size="sm" asChild>
        <Link to="/w/$workspaceId/billing" params={{ workspaceId }}>
          Update payment
        </Link>
      </Button>
    </div>
  );
}

/** The banner on a base's pages, for the owners of its workspace. */
export function BasePaymentBanner({ base }: { base: Base | undefined }) {
  const workspaces = useWorkspaces();
  if (!base) return null;
  const role = workspaces.data?.workspaces.find((w) => w.id === base.workspaceId)?.role ?? null;
  return <PaymentBanner workspaceId={base.workspaceId} role={role} />;
}
