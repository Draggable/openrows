import type { MeResponse } from '@openrows/shared';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { api } from '../../api/client';
import { queryKeys } from '../../api/keys';
import { toast } from '../../components/ui';

/**
 * Installs a template into `workspaceId`, else the first workspace where the person creates
 * bases (a new one of theirs if none, as "Start from scratch" does), then opens the new base.
 */
export function useInstallTemplate(me: MeResponse) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  return useMutation({
    mutationFn: async ({ slug, workspaceId }: { slug: string; workspaceId?: string }) => {
      let wsId = workspaceId;
      if (!wsId) {
        const { workspaces } = await qc.fetchQuery({
          queryKey: queryKeys.workspaces.list(),
          queryFn: () => api.workspaces.list(),
        });
        wsId = workspaces.find((w) => w.role === 'owner' || w.role === 'creator')?.id;
      }
      if (!wsId) {
        const first = me.user.name?.split(' ')[0] ?? me.user.email?.split('@')[0] ?? 'My';
        const ws = await api.workspaces.create({ body: { name: `${first}'s workspace` } });
        wsId = ws.id;
      }
      return api.templates.install({ params: { workspaceId: wsId }, body: { slug } });
    },
    onSuccess: async (base) => {
      await Promise.all([
        qc.invalidateQueries({ queryKey: queryKeys.workspaces.all() }),
        qc.invalidateQueries({ queryKey: queryKeys.bases.all() }),
      ]);
      toast.success(`Created ${base.name}`);
      await navigate({ to: '/b/$baseId', params: { baseId: base.id } });
    },
  });
}
