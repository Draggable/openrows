import type { MeResponse } from '@openrows/shared';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { ApiError, api } from '../api/client';
import { queryKeys } from '../api/keys';
import { toast } from '../components/ui';
import { readCsv } from '../features/import/model';
import { stashImport } from '../features/import/pending';

/** Thrown before anything is created when the picked file can't be imported. */
class UnreadableFile extends Error {}

/** The name a base imported from `file` gets: the file name without its extension. */
export function importedBaseName(fileName: string): string {
  const stem = fileName.replace(/\.[^.]*$/, '').trim();
  return (stem || 'Imported base').slice(0, 255);
}

/**
 * "Create a base" from anywhere: picks the workspace (the given one, else the first one the
 * user can create bases in, else a new "<name>'s workspace" on first run), creates the base
 * with one table, as Airtable's "Start from scratch" does, and opens it.
 *
 * With a `file` (Home's "Import a file") the base is named after the file, its table
 * starts with only the primary field (named after the first column) and the grid opens the
 * import dialog on the file, where the other columns become fields.
 */
export function useCreateBaseFlow(me: MeResponse) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  return useMutation({
    mutationFn: async ({
      name,
      workspaceId,
      file,
    }: {
      name?: string;
      workspaceId?: string;
      file?: File;
    }) => {
      let primaryFieldName: string | undefined;
      if (file) {
        const read = readCsv(await file.text(), file.size);
        if (!read.ok) throw new UnreadableFile(read.error);
        primaryFieldName = read.rows[0]?.[0]?.trim().slice(0, 255) || 'Name';
      }
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
      const baseName = name ?? (file ? importedBaseName(file.name) : 'Untitled base');
      const base = await api.bases.create({
        params: { workspaceId: wsId },
        body: { name: baseName },
      });
      const table = await api.tables.create({
        params: { baseId: base.id },
        body: file ? { name: baseName, primaryFieldName } : { name: 'Table 1' },
      });
      if (file) stashImport(table.id, file);
      return { base, table };
    },
    onSuccess: async ({ base, table }) => {
      await Promise.all([
        qc.invalidateQueries({ queryKey: queryKeys.workspaces.all() }),
        qc.invalidateQueries({ queryKey: queryKeys.bases.all() }),
      ]);
      toast.success(`Created ${base.name}`);
      await navigate({
        to: '/b/$baseId/$tableId',
        params: { baseId: base.id, tableId: table.id },
      });
    },
    onError: (err) => {
      toast.error(
        err instanceof ApiError || err instanceof UnreadableFile
          ? err.message
          : "Couldn't create the base"
      );
    },
  });
}
