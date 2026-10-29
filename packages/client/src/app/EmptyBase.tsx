import type { MeResponse } from '@openrows/shared';
import { useQuery } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { PlusIcon } from 'lucide-react';
import { ApiError } from '../api/client';
import { baseQueries, useCreateTable } from '../api/queries';
import { Button, toast } from '../components/ui';
import { BaseSidebar } from './BaseSidebar';
import { Shell, TopBar } from './Shell';

/** A base without tables (possible through the API): offer to add the first one. */
export function EmptyBase({ me, baseId }: { me: MeResponse; baseId: string }) {
  const navigate = useNavigate();
  const base = useQuery(baseQueries.detail(baseId));
  const create = useCreateTable(baseId);
  const canCreate = base.data?.role === 'owner' || base.data?.role === 'creator';
  return (
    <Shell sidebar={<BaseSidebar me={me} base={base.data} tables={[]} views={[]} tableId="" />}>
      <TopBar>
        <h1 className="text-[15px] font-[550]">{base.data?.name}</h1>
      </TopBar>
      <main className="flex flex-1 flex-col items-center justify-center gap-3 text-center">
        <h2 className="text-heading font-semibold">This base has no tables yet</h2>
        {canCreate && (
          <Button
            onClick={() =>
              create.mutate(
                { name: 'Table 1' },
                {
                  onSuccess: (t) =>
                    navigate({ to: '/b/$baseId/$tableId', params: { baseId, tableId: t.id } }),
                  onError: (err) =>
                    toast.error(err instanceof ApiError ? err.message : "Couldn't add the table"),
                }
              )
            }
          >
            <PlusIcon />
            Add a table
          </Button>
        )}
      </main>
    </Shell>
  );
}
