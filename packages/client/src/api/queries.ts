import type {
  AirtableImportList,
  AssistantPlan,
  AutomationRunStatus,
  Comment,
  CommentList,
  CommentReaction,
  Contracts,
  CreateAutomationInput,
  CreateInterfacePageInput,
  CreateScriptInput,
  CreateSyncInput,
  CreateWebhookInput,
  DuplicateBaseInput,
  EndpointBody,
  EndpointDef,
  ExtensionInstallation,
  ExtensionList,
  InstallExtensionInput,
  InterfacePageDataQuery,
  InterfacePageRecordsQuery,
  InterfaceRole,
  InviteInterfaceCollaboratorInput,
  NoticeList,
  PreviewSyncInput,
  SharedRecord,
  TableSync,
  TestAutomationInput,
  UpdateAutomationInput,
  UpdateExtensionInput,
  UpdateInterfacePageInput,
  UpdateScriptInput,
  UpdateSyncInput,
  UpdateWebhookInput,
} from '@openrows/shared';
import { SHARED_LAYOUT_MAX_RECORDS, SHARED_PAGE_MAX } from '@openrows/shared';
import {
  infiniteQueryOptions,
  keepPreviousData,
  type QueryClient,
  queryOptions,
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query';
import { api, auditApi, fetchOpenApiDocument, scimApi, ssoApi, workspaceAdminApi } from './client';
import { newClientOpId } from './clientOps';
import { type ListQuery, queryKeys } from './keys';

/** The request body of `contracts[R][N]`, as the caller writes it (before defaults). */
export type Body<
  R extends keyof Contracts,
  N extends keyof Contracts[R],
> = Contracts[R][N] extends EndpointDef ? EndpointBody<Contracts[R][N]> : never;

/**
 * Server state per resource: `queryOptions` for loaders and `ensureQueryData`, `use*`
 * hooks for components, and mutations that invalidate what they change. Record edits, which
 * need optimistic updates, are in `records.ts`.
 */

export const workspaceQueries = {
  list: () =>
    queryOptions({ queryKey: queryKeys.workspaces.list(), queryFn: () => api.workspaces.list() }),
  detail: (workspaceId: string) =>
    queryOptions({
      queryKey: queryKeys.workspaces.detail(workspaceId),
      queryFn: () => api.workspaces.get({ params: { workspaceId } }),
    }),
  members: (workspaceId: string) =>
    queryOptions({
      queryKey: queryKeys.workspaces.members(workspaceId),
      queryFn: () => api.members.list({ params: { workspaceId } }),
    }),
  usage: (workspaceId: string) =>
    queryOptions({
      queryKey: queryKeys.workspaces.usage(workspaceId),
      queryFn: () => api.workspaces.usage({ params: { workspaceId } }),
    }),
  billing: (workspaceId: string) =>
    queryOptions({
      queryKey: queryKeys.workspaces.billing(workspaceId),
      queryFn: () => api.workspaces.billing({ params: { workspaceId } }),
    }),
  ai: (workspaceId: string) =>
    queryOptions({
      queryKey: queryKeys.workspaces.ai(workspaceId),
      queryFn: () => api.workspaces.ai({ params: { workspaceId } }),
      staleTime: 60_000,
    }),
  aiSettings: (workspaceId: string) =>
    queryOptions({
      queryKey: queryKeys.workspaces.aiSettings(workspaceId),
      queryFn: () => api.workspaces.aiSettings({ params: { workspaceId } }),
    }),
  /** Who user cells can name, cached per workspace for 5 minutes. */
  collaborators: (workspaceId: string) =>
    queryOptions({
      queryKey: queryKeys.workspaces.collaborators(workspaceId),
      queryFn: () => api.collaborators.list({ params: { workspaceId } }),
      staleTime: 5 * 60_000,
    }),
  invitations: (workspaceId: string) =>
    queryOptions({
      queryKey: queryKeys.workspaces.invitations(workspaceId),
      queryFn: () => api.invitations.list({ params: { workspaceId } }),
    }),
};

export const invitationQueries = {
  preview: (token: string) =>
    queryOptions({
      queryKey: queryKeys.invitations.preview(token),
      queryFn: () => api.invitations.preview({ params: { token } }),
      retry: false,
    }),
};

export const baseQueries = {
  list: (workspaceId: string) =>
    queryOptions({
      queryKey: queryKeys.bases.list(workspaceId),
      queryFn: () => api.bases.list({ params: { workspaceId } }),
    }),
  detail: (baseId: string) =>
    queryOptions({
      queryKey: queryKeys.bases.detail(baseId),
      queryFn: () => api.bases.get({ params: { baseId } }),
    }),
  /** Plan-limit warnings: refreshed every few minutes and when the tab comes back. */
  usageWarnings: (baseId: string) =>
    queryOptions({
      queryKey: queryKeys.bases.usageWarnings(baseId),
      queryFn: () => api.bases.usageWarnings({ params: { baseId } }),
      staleTime: 60_000,
      refetchInterval: 5 * 60_000,
    }),
};

export const tableQueries = {
  list: (baseId: string) =>
    queryOptions({
      queryKey: queryKeys.tables.list(baseId),
      queryFn: () => api.tables.list({ params: { baseId } }),
    }),
  detail: (tableId: string) =>
    queryOptions({
      queryKey: queryKeys.tables.detail(tableId),
      queryFn: () => api.tables.get({ params: { tableId } }),
    }),
  fieldTrash: (tableId: string) =>
    queryOptions({
      queryKey: queryKeys.fields.trash(tableId),
      queryFn: () => api.fields.trash({ params: { tableId } }),
    }),
};

export const viewQueries = {
  list: (tableId: string) =>
    queryOptions({
      queryKey: queryKeys.views.list(tableId),
      queryFn: () => api.views.list({ params: { tableId } }),
    }),
};

export const recordQueries = {
  list: (tableId: string, query: ListQuery = {}) =>
    queryOptions({
      queryKey: queryKeys.records.list(tableId, query),
      queryFn: () => api.records.list({ params: { tableId }, query }),
    }),
  /** A view query window; the previous window stays on screen while the next one loads. */
  query: (tableId: string, input: Body<'records', 'query'> = {}) =>
    queryOptions({
      queryKey: queryKeys.records.query(tableId, input),
      queryFn: () => api.records.query({ params: { tableId }, body: input }),
      placeholderData: keepPreviousData,
    }),
  /**
   * One page of the grid's windowed loading. No placeholder: a page must never show
   * another offset's records while it loads.
   */
  window: (tableId: string, input: Body<'records', 'query'>) =>
    queryOptions({
      queryKey: queryKeys.records.query(tableId, input),
      queryFn: () => api.records.query({ params: { tableId }, body: input }),
      staleTime: 30_000,
    }),
  detail: (tableId: string, recordId: string) =>
    queryOptions({
      queryKey: queryKeys.records.detail(tableId, recordId),
      queryFn: () => api.records.get({ params: { tableId, recordId } }),
    }),
  /** The link picker: records of the linked table matching `search`. */
  linkCandidates: (linkFieldId: string, search: string) =>
    queryOptions({
      queryKey: queryKeys.records.linkCandidates(linkFieldId, search),
      queryFn: () =>
        api.fields.linkCandidates({
          params: { linkFieldId },
          query: search ? { search, limit: 50 } : { limit: 50 },
        }),
      placeholderData: keepPreviousData,
      staleTime: 10_000,
    }),
  /** A link filter's record picker: every record of the linked table, 50 a page. */
  filterCandidates: (linkFieldId: string, search: string) =>
    infiniteQueryOptions({
      queryKey: queryKeys.records.filterCandidates(linkFieldId, search),
      queryFn: ({ pageParam }) =>
        api.fields.linkCandidates({
          params: { linkFieldId },
          query: { purpose: 'filter', limit: 50, offset: pageParam, ...(search ? { search } : {}) },
        }),
      initialPageParam: 0,
      getNextPageParam: (last) => last.nextOffset ?? undefined,
      placeholderData: keepPreviousData,
      staleTime: 10_000,
    }),
  /** Names of linked records by id (a link filter's chips); ids of no record are left out. */
  linkedNames: (linkFieldId: string, ids: readonly string[]) =>
    queryOptions({
      queryKey: queryKeys.records.linkedNames(linkFieldId, ids),
      queryFn: () =>
        api.fields.linkCandidates({ params: { linkFieldId }, query: { ids: ids.join(',') } }),
      placeholderData: keepPreviousData,
      staleTime: 30_000,
    }),
};

// Reads.

export const useWorkspaces = () => useQuery(workspaceQueries.list());
export const useWorkspace = (workspaceId: string) => useQuery(workspaceQueries.detail(workspaceId));
export const useMembers = (workspaceId: string) => useQuery(workspaceQueries.members(workspaceId));
export const useWorkspaceUsage = (workspaceId: string) =>
  useQuery(workspaceQueries.usage(workspaceId));
/** Owners only; polled while a checkout's payment is being confirmed. */
export const useWorkspaceBilling = (workspaceId: string, poll: (entitled: boolean) => boolean) =>
  useQuery({
    ...workspaceQueries.billing(workspaceId),
    refetchInterval: (q) => (poll(!!q.state.data?.subscription?.entitled) ? 3000 : false),
  });
/** Whether AI features are on in the workspace: hide them when `available` is false. */
export const useAiAvailability = (workspaceId: string | undefined) =>
  useQuery({ ...workspaceQueries.ai(workspaceId ?? ''), enabled: !!workspaceId });
/** Owners only. */
export const useAiSettings = (workspaceId: string) =>
  useQuery(workspaceQueries.aiSettings(workspaceId));
export const useCollaborators = (workspaceId: string | undefined) =>
  useQuery({ ...workspaceQueries.collaborators(workspaceId ?? ''), enabled: !!workspaceId });
export const useInvitations = (workspaceId: string, enabled = true) =>
  useQuery({ ...workspaceQueries.invitations(workspaceId), enabled });
export const useInvitationPreview = (token: string) => useQuery(invitationQueries.preview(token));
export const useBases = (workspaceId: string) => useQuery(baseQueries.list(workspaceId));
export const useBase = (baseId: string) => useQuery(baseQueries.detail(baseId));
export const useBaseUsageWarnings = (baseId: string, enabled: boolean) =>
  useQuery({ ...baseQueries.usageWarnings(baseId), enabled });
export const useTables = (baseId: string) =>
  useQuery({ ...tableQueries.list(baseId), enabled: !!baseId });
export const useTable = (tableId: string) =>
  useQuery({ ...tableQueries.detail(tableId), enabled: !!tableId });
export const useViews = (tableId: string) =>
  useQuery({ ...viewQueries.list(tableId), enabled: !!tableId });
export const useFieldTrash = (tableId: string) => useQuery(tableQueries.fieldTrash(tableId));
export const useRecords = (tableId: string, query?: ListQuery) =>
  useQuery(recordQueries.list(tableId, query));
export const useRecordQuery = (tableId: string, input?: Body<'records', 'query'>) =>
  useQuery(recordQueries.query(tableId, input));
export const useLinkCandidates = (linkFieldId: string, search: string) =>
  useQuery(recordQueries.linkCandidates(linkFieldId, search));
export const useFilterCandidates = (linkFieldId: string, search: string) =>
  useInfiniteQuery(recordQueries.filterCandidates(linkFieldId, search));
export const useLinkedNames = (linkFieldId: string, ids: readonly string[]) =>
  useQuery({ ...recordQueries.linkedNames(linkFieldId, ids), enabled: ids.length > 0 });
export const useRecord = (tableId: string, recordId: string) =>
  useQuery(recordQueries.detail(tableId, recordId));
/** An AI field's generation state, polled every 3 s while cells are pending. */
export const useAiFieldStatus = (fieldId: string, enabled = true) =>
  useQuery({
    queryKey: queryKeys.aiFields.status(fieldId),
    queryFn: () => api.fields.aiStatus({ params: { fieldId } }),
    enabled,
    refetchInterval: (q) => ((q.state.data?.counts.pending ?? 0) > 0 ? 3000 : false),
  });

// Writes. Each invalidates the lists and details it can change.

export function useCreateWorkspace() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: Body<'workspaces', 'create'>) => api.workspaces.create({ body }),
    onSuccess: () => qc.invalidateQueries({ queryKey: queryKeys.workspaces.all() }),
  });
}

export function useUpdateWorkspace(workspaceId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: Body<'workspaces', 'update'>) =>
      api.workspaces.update({ params: { workspaceId }, body }),
    onSuccess: (workspace) => {
      qc.setQueryData(queryKeys.workspaces.detail(workspaceId), workspace);
      return qc.invalidateQueries({ queryKey: queryKeys.workspaces.list() });
    },
  });
}

export function useDeleteWorkspace(workspaceId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api.workspaces.delete({ params: { workspaceId } }),
    onSuccess: () => qc.invalidateQueries({ queryKey: queryKeys.workspaces.all() }),
  });
}

export function useUpdateMember(workspaceId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ userId, ...body }: { userId: string } & Body<'members', 'update'>) =>
      api.members.update({ params: { workspaceId, userId }, body }),
    onSuccess: () => qc.invalidateQueries({ queryKey: queryKeys.workspaces.all() }),
  });
}

export function useRemoveMember(workspaceId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (userId: string) => api.members.remove({ params: { workspaceId, userId } }),
    onSuccess: () => qc.invalidateQueries({ queryKey: queryKeys.workspaces.all() }),
  });
}

export function useInvite(workspaceId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: Body<'invitations', 'create'>) =>
      api.invitations.create({ params: { workspaceId }, body }),
    onSuccess: () =>
      qc.invalidateQueries({ queryKey: queryKeys.workspaces.invitations(workspaceId) }),
  });
}

export function useResendInvitation(workspaceId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (invitationId: string) =>
      api.invitations.resend({ params: { workspaceId, invitationId } }),
    onSuccess: () =>
      qc.invalidateQueries({ queryKey: queryKeys.workspaces.invitations(workspaceId) }),
  });
}

export function useRevokeInvitation(workspaceId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (invitationId: string) =>
      api.invitations.revoke({ params: { workspaceId, invitationId } }),
    onSuccess: () =>
      qc.invalidateQueries({ queryKey: queryKeys.workspaces.invitations(workspaceId) }),
  });
}

export function useAcceptInvitation(token: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api.invitations.accept({ params: { token } }),
    onSuccess: () =>
      Promise.all([
        qc.invalidateQueries({ queryKey: queryKeys.workspaces.all() }),
        qc.invalidateQueries({ queryKey: queryKeys.bases.all() }),
      ]),
  });
}

// Base collaborators and invitations.

export const useBaseCollaborators = (baseId: string, enabled = true) =>
  useQuery({
    queryKey: queryKeys.bases.collaborators(baseId),
    queryFn: () => api.baseCollaborators.list({ params: { baseId } }),
    enabled,
  });

export const useBaseInvitations = (baseId: string, enabled = true) =>
  useQuery({
    queryKey: queryKeys.bases.invitations(baseId),
    queryFn: () => api.baseInvitations.list({ params: { baseId } }),
    enabled,
  });

/** After a base membership change: the base's people, and the directory user cells use. */
function invalidateBasePeople(qc: ReturnType<typeof useQueryClient>, baseId: string) {
  return Promise.all([
    qc.invalidateQueries({ queryKey: queryKeys.bases.collaborators(baseId) }),
    qc.invalidateQueries({ queryKey: queryKeys.bases.invitations(baseId) }),
    qc.invalidateQueries({ queryKey: queryKeys.workspaces.all() }),
  ]);
}

export function useSetBaseRole(baseId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ userId, ...body }: { userId: string } & Body<'baseCollaborators', 'update'>) =>
      api.baseCollaborators.update({ params: { baseId, userId }, body }),
    onSuccess: () => invalidateBasePeople(qc, baseId),
  });
}

export function useRemoveBaseRole(baseId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (userId: string) => api.baseCollaborators.remove({ params: { baseId, userId } }),
    onSuccess: () => invalidateBasePeople(qc, baseId),
  });
}

export function useInviteToBase(baseId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: Body<'baseInvitations', 'create'>) =>
      api.baseInvitations.create({ params: { baseId }, body }),
    onSuccess: () => qc.invalidateQueries({ queryKey: queryKeys.bases.invitations(baseId) }),
  });
}

export function useResendBaseInvitation(baseId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (invitationId: string) =>
      api.baseInvitations.resend({ params: { baseId, invitationId } }),
    onSuccess: () => qc.invalidateQueries({ queryKey: queryKeys.bases.invitations(baseId) }),
  });
}

export function useRevokeBaseInvitation(baseId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (invitationId: string) =>
      api.baseInvitations.revoke({ params: { baseId, invitationId } }),
    onSuccess: () => qc.invalidateQueries({ queryKey: queryKeys.bases.invitations(baseId) }),
  });
}

export function useCreateBase(workspaceId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: Body<'bases', 'create'>) =>
      api.bases.create({ params: { workspaceId }, body }),
    onSuccess: () => qc.invalidateQueries({ queryKey: queryKeys.bases.list(workspaceId) }),
  });
}

export function useUpdateBase(baseId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: Body<'bases', 'update'>) => api.bases.update({ params: { baseId }, body }),
    onSuccess: (base) => {
      qc.setQueryData(queryKeys.bases.detail(baseId), base);
      return qc.invalidateQueries({ queryKey: queryKeys.bases.list(base.workspaceId) });
    },
  });
}

export function useDeleteBase(baseId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api.bases.delete({ params: { baseId } }),
    onSuccess: () => {
      qc.removeQueries({ queryKey: queryKeys.bases.detail(baseId) });
      return qc.invalidateQueries({ queryKey: queryKeys.bases.all() });
    },
  });
}

export function useCreateTable(baseId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: Body<'tables', 'create'>) => api.tables.create({ params: { baseId }, body }),
    onSuccess: (table) => {
      qc.setQueryData(queryKeys.tables.detail(table.id), table);
      return qc.invalidateQueries({ queryKey: queryKeys.tables.list(baseId) });
    },
  });
}

export function useUpdateTable(tableId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: Body<'tables', 'update'>) =>
      api.tables.update({ params: { tableId }, body }),
    onSuccess: (table) => {
      qc.setQueryData(queryKeys.tables.detail(tableId), table);
      return qc.invalidateQueries({ queryKey: queryKeys.tables.list(table.baseId) });
    },
  });
}

export function useDeleteTable(tableId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api.tables.delete({ params: { tableId } }),
    onSuccess: () => {
      qc.removeQueries({ queryKey: queryKeys.tables.detail(tableId) });
      qc.removeQueries({ queryKey: queryKeys.records.table(tableId) });
      return qc.invalidateQueries({ queryKey: queryKeys.tables.all() });
    },
  });
}

export function useDuplicateTable(tableId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: Body<'tables', 'duplicate'>) =>
      api.tables.duplicate({ params: { tableId }, body }),
    onSuccess: (table) => qc.invalidateQueries({ queryKey: queryKeys.tables.list(table.baseId) }),
  });
}

/** Field changes reshape the table and can rewrite every record (type conversions). */
function invalidateTable(qc: ReturnType<typeof useQueryClient>, tableId: string) {
  return Promise.all([
    qc.invalidateQueries({ queryKey: queryKeys.tables.detail(tableId) }),
    qc.invalidateQueries({ queryKey: queryKeys.fields.trash(tableId) }),
    qc.invalidateQueries({ queryKey: queryKeys.records.table(tableId) }),
  ]);
}

// CSV import: start a job, then poll it until it has finished.

export function useStartImport(tableId: string) {
  return useMutation({
    mutationFn: (body: Body<'imports', 'create'>) =>
      api.imports.create({ params: { tableId }, body }),
  });
}

/** How often a running import is polled. */
const IMPORT_POLL_MS = 750;

/** An import's progress, polled while it runs; the table reloads once it has finished. */
export function useImportJob(tableId: string, importId: string | undefined) {
  const qc = useQueryClient();
  return useQuery({
    queryKey: queryKeys.imports.detail(importId ?? ''),
    queryFn: async () => {
      const job = await api.imports.get({ params: { tableId, importId: importId ?? '' } });
      if (job.status !== 'running') await invalidateTable(qc, tableId);
      return job;
    },
    enabled: importId !== undefined,
    refetchInterval: (q) =>
      q.state.data?.status === 'running' || !q.state.data ? IMPORT_POLL_MS : false,
  });
}

export function useCreateField(tableId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: Body<'fields', 'create'>) =>
      api.fields.create({ params: { tableId }, body }),
    onSuccess: () => invalidateTable(qc, tableId),
  });
}

export function useUpdateField(tableId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ fieldId, ...body }: Body<'fields', 'update'> & { fieldId: string }) =>
      api.fields.update({ params: { fieldId }, body }),
    onSuccess: () => invalidateTable(qc, tableId),
  });
}

/** Regenerates an AI field's records or the whole field. */
export function useGenerateAiField(fieldId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: Body<'fields', 'aiGenerate'>) =>
      api.fields.aiGenerate({ params: { fieldId }, body }),
    onSuccess: () => qc.invalidateQueries({ queryKey: queryKeys.aiFields.status(fieldId) }),
  });
}

/** Stops an AI field's pending generations. */
export function useCancelAiField(fieldId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api.fields.aiCancel({ params: { fieldId } }),
    onSuccess: () => qc.invalidateQueries({ queryKey: queryKeys.aiFields.status(fieldId) }),
  });
}

export function useDeleteField(tableId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (fieldId: string) => api.fields.delete({ params: { fieldId } }),
    onSuccess: () => invalidateTable(qc, tableId),
  });
}

export function useRestoreField(tableId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (deletedFieldId: string) =>
      api.fields.restore({ params: { tableId, deletedFieldId } }),
    onSuccess: () => invalidateTable(qc, tableId),
  });
}

export function useCreateView(tableId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: Body<'views', 'create'>) => api.views.create({ params: { tableId }, body }),
    onSuccess: () => qc.invalidateQueries({ queryKey: queryKeys.views.list(tableId) }),
  });
}

export function useUpdateView(tableId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ viewId, ...body }: Body<'views', 'update'> & { viewId: string }) =>
      api.views.update({ params: { viewId }, body }),
    onSuccess: () => qc.invalidateQueries({ queryKey: queryKeys.views.list(tableId) }),
  });
}

export function useDuplicateView(tableId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (viewId: string) => api.views.duplicate({ params: { viewId }, body: {} }),
    onSuccess: () => qc.invalidateQueries({ queryKey: queryKeys.views.list(tableId) }),
  });
}

export function useDeleteView(tableId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (viewId: string) => api.views.delete({ params: { viewId } }),
    onSuccess: () => qc.invalidateQueries({ queryKey: queryKeys.views.list(tableId) }),
  });
}

/** Sidebar sections of a table's views. */
export function useCreateViewSection(tableId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: Body<'views', 'createSection'>) =>
      api.views.createSection({ params: { tableId }, body }),
    onSuccess: () => qc.invalidateQueries({ queryKey: queryKeys.views.list(tableId) }),
  });
}

export function useUpdateViewSection(tableId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ sectionId, ...body }: Body<'views', 'updateSection'> & { sectionId: string }) =>
      api.views.updateSection({ params: { tableId, sectionId }, body }),
    onSuccess: () => qc.invalidateQueries({ queryKey: queryKeys.views.list(tableId) }),
  });
}

export function useDeleteViewSection(tableId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (sectionId: string) => api.views.deleteSection({ params: { tableId, sectionId } }),
    onSuccess: () => qc.invalidateQueries({ queryKey: queryKeys.views.list(tableId) }),
  });
}

/** Comments per page of a thread. */
export const COMMENTS_PAGE = 50;

// Record comments. Realtime events (`comment.*`) patch the same caches. The record's list
// is the newest page; "Load earlier" prepends older pages to it (`loadEarlierComments`).
export const commentQueries = {
  record: (tableId: string, recordId: string) =>
    queryOptions({
      queryKey: queryKeys.comments.record(tableId, recordId),
      queryFn: async ({ client, queryKey }) => {
        const page = await api.comments.list({
          params: { tableId, recordId },
          query: { limit: COMMENTS_PAGE },
        });
        // A refetch keeps the earlier pages already loaded when they join up with the new page.
        const cached = client.getQueryData<CommentList>(queryKey);
        const oldest = page.comments[0];
        if (!cached || !oldest || !page.previousCursor) return page;
        const at = cached.comments.findIndex((c) => c.id === oldest.id);
        if (at <= 0) return page;
        return {
          comments: [...cached.comments.slice(0, at), ...page.comments],
          previousCursor: cached.previousCursor,
        };
      },
    }),
  counts: (tableId: string) =>
    queryOptions({
      queryKey: queryKeys.comments.counts(tableId),
      queryFn: () => api.comments.counts({ params: { tableId } }),
      staleTime: 30_000,
    }),
  mentionable: (tableId: string) =>
    queryOptions({
      queryKey: queryKeys.comments.mentionable(tableId),
      queryFn: () => api.comments.mentionable({ params: { tableId } }),
      staleTime: 60_000,
    }),
};

/** A record's revision history, newest first, a page at a time. */
/** The workspace audit log: pages newest first, per filter; its SIEM stream. */
export const auditQueries = {
  log: (workspaceId: string, filters: Record<string, string>) =>
    infiniteQueryOptions({
      queryKey: queryKeys.workspaces.auditLog(workspaceId, filters),
      queryFn: ({ pageParam }) =>
        auditApi.log.list({
          params: { workspaceId },
          query: { ...filters, limit: 50, ...(pageParam ? { before: pageParam } : {}) },
        }),
      initialPageParam: '',
      getNextPageParam: (last) => last.nextBefore ?? undefined,
      // 403 (plan) and 404 (edition) are answers, not glitches.
      retry: false,
      // A new filter keeps the rows on screen until its answer arrives.
      placeholderData: keepPreviousData,
    }),
  stream: (workspaceId: string) =>
    queryOptions({
      queryKey: queryKeys.workspaces.auditStream(workspaceId),
      queryFn: () => auditApi.stream.get({ params: { workspaceId } }),
      retry: false,
    }),
};
export const useAuditLog = (workspaceId: string, filters: Record<string, string>) =>
  useInfiniteQuery(auditQueries.log(workspaceId, filters));
export const useAuditStream = (workspaceId: string, enabled: boolean) =>
  useQuery({ ...auditQueries.stream(workspaceId), enabled });

/** The workspace's single sign-on (owners; hosted plans with `sso`). */
export const ssoQuery = (workspaceId: string) =>
  queryOptions({
    queryKey: queryKeys.workspaces.sso(workspaceId),
    queryFn: () => ssoApi.connection.get({ params: { workspaceId } }),
    // 403 (plan) and 404 (edition) are answers, not glitches.
    retry: false,
  });
export const useSso = (workspaceId: string) => useQuery(ssoQuery(workspaceId));

/** The workspace's SCIM provisioning (owners; hosted plans with `scim`). */
export const scimQuery = (workspaceId: string) =>
  queryOptions({
    queryKey: queryKeys.workspaces.scim(workspaceId),
    queryFn: () => scimApi.settings.get({ params: { workspaceId } }),
    // 403 (plan) and 404 (edition) are answers, not glitches.
    retry: false,
  });
export const useScim = (workspaceId: string) => useQuery(scimQuery(workspaceId));

export const revisionQueries = {
  record: (tableId: string, recordId: string) =>
    infiniteQueryOptions({
      queryKey: queryKeys.revisions.record(tableId, recordId),
      queryFn: ({ pageParam }) =>
        api.revisions.list({
          params: { tableId, recordId },
          query: { limit: 50, ...(pageParam ? { cursor: pageParam } : {}) },
        }),
      initialPageParam: '',
      getNextPageParam: (last) => last.nextCursor ?? undefined,
    }),
};

/** Puts `comment` in its record's list (replacing the one with its id), oldest first. */
export function upsertComment(qc: QueryClient, comment: Comment) {
  qc.setQueryData<CommentList>(
    queryKeys.comments.record(comment.tableId, comment.recordId),
    (data) => {
      if (!data) return data;
      const rest = data.comments.filter((c) => c.id !== comment.id);
      const comments = [...rest, comment].sort(
        (a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id)
      );
      return { ...data, comments };
    }
  );
}

/** Takes a comment out of its record's list. */
export function removeComment(qc: QueryClient, tableId: string, recordId: string, id: string) {
  qc.setQueryData<CommentList>(queryKeys.comments.record(tableId, recordId), (data) =>
    data ? { ...data, comments: data.comments.filter((c) => c.id !== id) } : data
  );
}

/**
 * Loads the page before the oldest loaded comment into the record's list. Resolves with
 * whether there are earlier ones still.
 */
export async function loadEarlierComments(
  qc: QueryClient,
  tableId: string,
  recordId: string
): Promise<boolean> {
  const key = queryKeys.comments.record(tableId, recordId);
  const before = qc.getQueryData<CommentList>(key)?.previousCursor;
  if (!before) return false;
  const page = await api.comments.list({
    params: { tableId, recordId },
    query: { limit: COMMENTS_PAGE, before },
  });
  const data = qc.setQueryData<CommentList>(key, (data) => {
    // Another page load (or a refetch) got here first.
    if (!data || data.previousCursor !== before) return data;
    const ids = new Set(data.comments.map((c) => c.id));
    return {
      comments: [...page.comments.filter((c) => !ids.has(c.id)), ...data.comments],
      previousCursor: page.previousCursor,
    };
  });
  return !!data?.previousCursor;
}

export function useCommentMutations(tableId: string, recordId: string) {
  const qc = useQueryClient();
  const counts = () => qc.invalidateQueries({ queryKey: queryKeys.comments.counts(tableId) });
  const params = { tableId, recordId };
  return {
    create: useMutation({
      mutationFn: (body: string) =>
        api.comments.create({ params, body: { body, clientOpId: newClientOpId() } }),
      onSuccess: (comment) => {
        upsertComment(qc, comment);
        return counts();
      },
    }),
    update: useMutation({
      mutationFn: ({ commentId, body }: { commentId: string; body: string }) =>
        api.comments.update({
          params: { ...params, commentId },
          body: { body, clientOpId: newClientOpId() },
        }),
      onSuccess: (comment) => upsertComment(qc, comment),
    }),
    remove: useMutation({
      mutationFn: (commentId: string) => api.comments.delete({ params: { ...params, commentId } }),
      onSuccess: (_r, commentId) => {
        removeComment(qc, tableId, recordId, commentId);
        return counts();
      },
    }),
    react: useMutation({
      mutationFn: ({
        commentId,
        reaction,
        on,
      }: {
        commentId: string;
        reaction: CommentReaction;
        on: boolean;
      }) =>
        on
          ? api.comments.react({ params: { ...params, commentId, reaction } })
          : api.comments.unreact({ params: { ...params, commentId, reaction } }),
      onSuccess: (comment) => upsertComment(qc, comment),
    }),
  };
}

// Data residency: the regions, read when the New workspace dialog opens.
export const useRegions = (enabled = true) =>
  useQuery({
    queryKey: queryKeys.regions.list(),
    queryFn: () => api.regions.list(),
    enabled,
    staleTime: 5 * 60_000,
    retry: false,
  });

/** Creates a workspace in another region's stack; the caller then opens its URL there. */
export function useCreateRegionWorkspace() {
  return useMutation({
    mutationFn: ({ regionId, name }: { regionId: string; name: string }) =>
      api.regions.createWorkspace({ params: { regionId }, body: { name } }),
  });
}

// Service notices: the banner's list, refreshed hourly; dismissing drops one at once.
export const useNotices = () =>
  useQuery({
    queryKey: queryKeys.notices.list(),
    queryFn: () => api.notices.list(),
    refetchInterval: 60 * 60_000,
    staleTime: 5 * 60_000,
    retry: false,
  });

export function useDismissNotice() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (noticeId: string) => api.notices.dismiss({ params: { noticeId } }),
    onMutate: (noticeId) => {
      qc.setQueryData<NoticeList>(queryKeys.notices.list(), (old) =>
        old ? { notices: old.notices.filter((n) => n.id !== noticeId) } : old
      );
    },
    onError: () => void qc.invalidateQueries({ queryKey: queryKeys.notices.list() }),
  });
}

// Notifications. The realtime `notifications` hint invalidates them all; without a socket
// (no base open) the unread count polls.
export const NOTIFICATIONS_POLL_MS = 60_000;

export const notificationQueries = {
  unread: () =>
    queryOptions({
      queryKey: queryKeys.notifications.unread(),
      queryFn: () => api.notifications.unread(),
      refetchInterval: NOTIFICATIONS_POLL_MS,
    }),
  list: () =>
    infiniteQueryOptions({
      queryKey: queryKeys.notifications.list(),
      queryFn: ({ pageParam }) =>
        api.notifications.list({ query: pageParam ? { cursor: pageParam } : {} }),
      initialPageParam: '' as string,
      getNextPageParam: (last) => last.nextCursor ?? undefined,
    }),
  preferences: () =>
    queryOptions({
      queryKey: queryKeys.notifications.preferences(),
      queryFn: () => api.notifications.preferences(),
    }),
};

export const useUnreadNotifications = () => useQuery(notificationQueries.unread());
export const useNotifications = (enabled: boolean) =>
  useInfiniteQuery({ ...notificationQueries.list(), enabled });
export const useNotificationPreferences = () => useQuery(notificationQueries.preferences());

export function useMarkNotificationRead() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (notificationId: string) =>
      api.notifications.markRead({ params: { notificationId } }),
    onSuccess: ({ unread }) => {
      qc.setQueryData(queryKeys.notifications.unread(), { unread });
      void qc.invalidateQueries({ queryKey: queryKeys.notifications.list() });
    },
  });
}

export function useMarkAllNotificationsRead() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api.notifications.markAllRead(),
    onSuccess: ({ unread }) => {
      qc.setQueryData(queryKeys.notifications.unread(), { unread });
      void qc.invalidateQueries({ queryKey: queryKeys.notifications.list() });
    },
  });
}

export function useUpdateNotificationPreferences() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: Body<'notifications', 'updatePreferences'>) =>
      api.notifications.updatePreferences({ body }),
    onSuccess: (prefs) => qc.setQueryData(queryKeys.notifications.preferences(), prefs),
  });
}

/** The signed-in user's personal access tokens. */
/** The OpenAPI document; it only changes with a deploy. */
export const useOpenApiDocument = () =>
  useQuery({
    queryKey: queryKeys.openApi(),
    queryFn: fetchOpenApiDocument,
    staleTime: Number.POSITIVE_INFINITY,
  });

/** What deleting the account would do; fresh each time the dialog opens. */
export const useAccountDeletion = (enabled: boolean) =>
  useQuery({
    queryKey: queryKeys.accountDeletion(),
    queryFn: () => api.me.deletion(),
    enabled,
    staleTime: 0,
  });

/** Deletes the signed-in user's account; the session ends with it. */
export function useDeleteAccount() {
  return useMutation({
    mutationFn: (body: Body<'me', 'delete'>) => api.me.delete({ body }),
  });
}

export const useAccessTokens = () =>
  useQuery({ queryKey: queryKeys.tokens.list(), queryFn: () => api.tokens.list() });

/** Creates a token; the answer carries its secret, shown once and never cached. */
export function useCreateAccessToken() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: Body<'tokens', 'create'>) => api.tokens.create({ body }),
    onSuccess: () => qc.invalidateQueries({ queryKey: queryKeys.tokens.list() }),
  });
}

export function useRevokeAccessToken() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (tokenId: string) => api.tokens.revoke({ params: { tokenId } }),
    onSuccess: () => qc.invalidateQueries({ queryKey: queryKeys.tokens.list() }),
  });
}

/** The OAuth apps the signed-in user registered. */
export const useOAuthApps = () =>
  useQuery({ queryKey: queryKeys.oauth.apps(), queryFn: () => api.oauthApps.list() });

/** Registers an app; the answer carries its client secret, shown once and never cached. */
export function useCreateOAuthApp() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: Body<'oauthApps', 'create'>) => api.oauthApps.create({ body }),
    onSuccess: () => qc.invalidateQueries({ queryKey: queryKeys.oauth.apps() }),
  });
}

/** Changes an app, or rotates its secret (answered once). */
export function useUpdateOAuthApp() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ appId, body }: { appId: string; body: Body<'oauthApps', 'update'> }) =>
      api.oauthApps.update({ params: { appId }, body }),
    onSuccess: () => qc.invalidateQueries({ queryKey: queryKeys.oauth.apps() }),
  });
}

export function useDeleteOAuthApp() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (appId: string) => api.oauthApps.delete({ params: { appId } }),
    onSuccess: () => qc.invalidateQueries({ queryKey: queryKeys.oauth.apps() }),
  });
}

/** The OAuth apps the signed-in user authorized (Settings → Integrations). */
export const useOAuthAuthorizations = () =>
  useQuery({
    queryKey: queryKeys.oauth.authorizations(),
    queryFn: () => api.oauthAuthorizations.list(),
  });

export function useRevokeOAuthAuthorization() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (authorizationId: string) =>
      api.oauthAuthorizations.revoke({ params: { authorizationId } }),
    onSuccess: () => qc.invalidateQueries({ queryKey: queryKeys.oauth.authorizations() }),
  });
}

/** The consent screen's request, checked by the server (`search`: the page's query string). */
export const useOAuthRequest = (query: Record<string, string>) =>
  useQuery({
    queryKey: queryKeys.oauth.request(new URLSearchParams(query).toString()),
    queryFn: () => api.oauthAuthorizations.check({ query }),
    retry: false,
    staleTime: Number.POSITIVE_INFINITY,
  });

/** The person's answer on the consent screen: where to send the browser. */
export function useOAuthDecision() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: Body<'oauthAuthorizations', 'decide'>) =>
      api.oauthAuthorizations.decide({ body }),
    onSuccess: () => qc.invalidateQueries({ queryKey: queryKeys.oauth.authorizations() }),
  });
}

/** Whose share links a dialog manages: one view's, or a whole base's. */
export type ShareTarget = { kind: 'view'; viewId: string } | { kind: 'base'; baseId: string };

const sharesKey = (t: ShareTarget) =>
  t.kind === 'view' ? queryKeys.shares.list(t.viewId) : queryKeys.shares.listBase(t.baseId);

/** A view's or base's share links and a share link's public page. */
export const shareQueries = {
  list: (target: ShareTarget) =>
    queryOptions({
      queryKey: sharesKey(target),
      queryFn: () =>
        target.kind === 'view'
          ? api.shares.list({ params: { viewId: target.viewId } })
          : api.shares.listBase({ params: { baseId: target.baseId } }),
    }),
  share: (token: string) =>
    queryOptions({
      queryKey: queryKeys.shared.share(token),
      queryFn: () => api.shared.share({ params: { shareToken: token } }),
      retry: false,
    }),
  view: (token: string, viewId: string) =>
    queryOptions({
      queryKey: queryKeys.shared.view(token, viewId),
      queryFn: () => api.shared.view({ params: { shareToken: token, viewId } }),
      retry: false,
    }),
  records: (token: string, viewId: string, offset: number, limit: number) =>
    queryOptions({
      queryKey: queryKeys.shared.records(token, viewId, offset, limit),
      queryFn: () =>
        api.shared.records({ params: { shareToken: token, viewId }, query: { offset, limit } }),
      retry: false,
      staleTime: 60_000,
    }),
  /**
   * A shared kanban's, calendar's, gallery's, timeline's or list's records: pages of the
   * API's largest size, up to SHARED_LAYOUT_MAX_RECORDS, optionally in a date window.
   */
  layoutRecords: (token: string, viewId: string, window: { from: string; to: string } | null) =>
    queryOptions({
      queryKey: queryKeys.shared.layout(token, viewId, window?.from ?? null, window?.to ?? null),
      queryFn: async () => {
        const records: SharedRecord[] = [];
        let total = 0;
        while (records.length < SHARED_LAYOUT_MAX_RECORDS) {
          const page = await api.shared.records({
            params: { shareToken: token, viewId },
            query: {
              offset: records.length,
              limit: Math.min(SHARED_PAGE_MAX, SHARED_LAYOUT_MAX_RECORDS - records.length),
              ...(window ?? {}),
            },
          });
          records.push(...page.records);
          total = page.total;
          if (page.records.length === 0 || records.length >= total) break;
        }
        return { records, total };
      },
      retry: false,
      staleTime: 60_000,
      placeholderData: keepPreviousData,
    }),
};

export const useShares = (target: ShareTarget, enabled = true) =>
  useQuery({ ...shareQueries.list(target), enabled });

export function useCreateShare(target: ShareTarget) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: Body<'shares', 'create'>) =>
      target.kind === 'view'
        ? api.shares.create({ params: { viewId: target.viewId }, body })
        : api.shares.createBase({ params: { baseId: target.baseId }, body }),
    onSuccess: () => qc.invalidateQueries({ queryKey: sharesKey(target) }),
  });
}

export function useUpdateShare(target: ShareTarget) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ shareId, body }: { shareId: string; body: Body<'shares', 'update'> }) =>
      target.kind === 'view'
        ? api.shares.update({ params: { viewId: target.viewId, shareId }, body })
        : api.shares.updateBase({ params: { baseId: target.baseId, shareId }, body }),
    onSuccess: () => qc.invalidateQueries({ queryKey: sharesKey(target) }),
  });
}

export function useRevokeShare(target: ShareTarget) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (shareId: string) =>
      target.kind === 'view'
        ? api.shares.revoke({ params: { viewId: target.viewId, shareId } })
        : api.shares.revokeBase({ params: { baseId: target.baseId, shareId } }),
    onSuccess: () => qc.invalidateQueries({ queryKey: sharesKey(target) }),
  });
}

/** A public form by its link's token: no session, no retry of a dead link. */
export const formQueries = {
  form: (token: string) =>
    queryOptions({
      queryKey: queryKeys.forms.form(token),
      queryFn: () => api.forms.form({ params: { formToken: token } }),
      retry: false,
      staleTime: Number.POSITIVE_INFINITY,
    }),
  /** The records a link field on the form offers: the chosen view's, by primary field. */
  linkRecords: (token: string, fieldId: string, search: string) =>
    infiniteQueryOptions({
      queryKey: queryKeys.forms.linkRecords(token, fieldId, search),
      queryFn: ({ pageParam }) =>
        api.forms.linkRecords({
          params: { formToken: token, fieldId },
          query: { limit: 20, offset: pageParam, ...(search ? { search } : {}) },
        }),
      initialPageParam: 0,
      getNextPageParam: (last) => last.nextOffset ?? undefined,
      placeholderData: keepPreviousData,
      retry: false,
      staleTime: 10_000,
    }),
};

/** Enters a share link's password; the server sets the link's cookie, so refetch. */
export function useUnlockShare(token: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { password: string; captchaToken?: string }) =>
      api.shared.unlock({ params: { shareToken: token }, body }),
    onSuccess: () => qc.invalidateQueries({ queryKey: queryKeys.shared.all(token) }),
  });
}

// The trash: what was deleted, restore and delete permanently.

/** Something in a base's trash. */
export type TrashTarget =
  | { kind: 'record'; tableId: string; ids: string[] }
  | { kind: 'field'; tableId: string; id: string }
  | { kind: 'view'; tableId: string; id: string }
  | { kind: 'table'; id: string };

export const useBaseTrash = (baseId: string, enabled = true) =>
  useQuery({
    queryKey: queryKeys.trash.base(baseId),
    queryFn: () => api.trash.base({ params: { baseId } }),
    enabled,
  });

export const useRecordTrash = (tableId: string, enabled = true) =>
  useInfiniteQuery({
    queryKey: queryKeys.trash.records(tableId),
    queryFn: ({ pageParam }) =>
      api.trash.records({
        params: { tableId },
        query: pageParam ? { cursor: pageParam } : {},
      }),
    initialPageParam: '',
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    enabled: enabled && tableId !== '',
  });

export const useWorkspaceTrash = (workspaceId: string, enabled = true) =>
  useQuery({
    queryKey: queryKeys.trash.workspace(workspaceId),
    queryFn: () => api.trash.workspace({ params: { workspaceId } }),
    enabled,
  });

/** After a restore or purge: the trash, and the lists and tables it can change. */
function invalidateAfterTrash(qc: QueryClient, target: TrashTarget) {
  const tableId = target.kind === 'table' ? target.id : target.tableId;
  return Promise.all([
    qc.invalidateQueries({ queryKey: queryKeys.trash.all() }),
    qc.invalidateQueries({ queryKey: queryKeys.tables.all() }),
    qc.invalidateQueries({ queryKey: queryKeys.views.all() }),
    qc.invalidateQueries({ queryKey: queryKeys.fields.trash(tableId) }),
    qc.invalidateQueries({ queryKey: queryKeys.records.all() }),
  ]);
}

export function useRestoreFromTrash(baseId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (target: TrashTarget): Promise<unknown> => {
      switch (target.kind) {
        case 'record':
          return api.records.restoreMany({
            params: { tableId: target.tableId },
            body: { recordIds: target.ids },
          });
        case 'field':
          return api.fields.restore({
            params: { tableId: target.tableId, deletedFieldId: target.id },
          });
        case 'view':
          return api.trash.restoreView({
            params: { tableId: target.tableId, trashedViewId: target.id },
          });
        case 'table':
          return api.trash.restoreTable({ params: { baseId, trashedTableId: target.id } });
      }
    },
    onSuccess: (_data, target) => invalidateAfterTrash(qc, target),
  });
}

export function usePurgeFromTrash(baseId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (target: TrashTarget): Promise<unknown> => {
      switch (target.kind) {
        case 'record':
          return api.trash.purgeRecords({
            params: { tableId: target.tableId },
            body: { recordIds: target.ids },
          });
        case 'field':
          return api.trash.purgeField({
            params: { tableId: target.tableId, trashedFieldId: target.id },
          });
        case 'view':
          return api.trash.purgeView({
            params: { tableId: target.tableId, trashedViewId: target.id },
          });
        case 'table':
          return api.trash.purgeTable({ params: { baseId, trashedTableId: target.id } });
      }
    },
    onSuccess: (_data, target) => invalidateAfterTrash(qc, target),
  });
}

export function useRestoreBase(workspaceId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (trashedBaseId: string) =>
      api.trash.restoreBase({ params: { workspaceId, trashedBaseId } }),
    onSuccess: () =>
      Promise.all([
        qc.invalidateQueries({ queryKey: queryKeys.trash.workspace(workspaceId) }),
        qc.invalidateQueries({ queryKey: queryKeys.bases.all() }),
      ]),
  });
}

export function usePurgeBase(workspaceId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (trashedBaseId: string) =>
      api.trash.purgeBase({ params: { workspaceId, trashedBaseId } }),
    onSuccess: () => qc.invalidateQueries({ queryKey: queryKeys.trash.workspace(workspaceId) }),
  });
}

// Base snapshots: list, "Snapshot now", restore to a new base, delete, retention.

// ---- Webhooks, through the REST API v1's management routes ----

export const useWebhooks = (baseId: string, enabled = true) =>
  useQuery({
    queryKey: queryKeys.webhooks.base(baseId),
    queryFn: () => api.v1Webhooks.list({ params: { baseId } }),
    enabled: enabled && baseId !== '',
  });

export const useWebhookDeliveries = (baseId: string, webhookId: string, enabled = true) =>
  useQuery({
    queryKey: queryKeys.webhooks.deliveries(baseId, webhookId),
    queryFn: () => api.v1Webhooks.deliveries({ params: { baseId, webhookId }, query: {} }),
    enabled: enabled && baseId !== '' && webhookId !== '',
    // New attempts arrive from the worker while the log is open.
    refetchInterval: 5_000,
  });

export function useCreateWebhook(baseId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: CreateWebhookInput) => api.v1Webhooks.create({ params: { baseId }, body }),
    onSuccess: () => qc.invalidateQueries({ queryKey: queryKeys.webhooks.base(baseId) }),
  });
}

export function useUpdateWebhook(baseId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ webhookId, ...body }: UpdateWebhookInput & { webhookId: string }) =>
      api.v1Webhooks.update({ params: { baseId, webhookId }, body }),
    onSuccess: () => qc.invalidateQueries({ queryKey: queryKeys.webhooks.base(baseId) }),
  });
}

export function useDeleteWebhook(baseId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (webhookId: string) => api.v1Webhooks.delete({ params: { baseId, webhookId } }),
    onSuccess: () => qc.invalidateQueries({ queryKey: queryKeys.webhooks.base(baseId) }),
  });
}

export function usePingWebhook(baseId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (webhookId: string) => api.v1Webhooks.ping({ params: { baseId, webhookId } }),
    onSuccess: (_d, webhookId) =>
      qc.invalidateQueries({ queryKey: queryKeys.webhooks.deliveries(baseId, webhookId) }),
  });
}

/** Queues a logged delivery's event again; the worker's attempt shows in the log. */
export function useRedeliverWebhook(baseId: string, webhookId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (deliveryId: string) =>
      api.v1Webhooks.redeliver({ params: { baseId, webhookId, deliveryId } }),
    onSuccess: () =>
      qc.invalidateQueries({ queryKey: queryKeys.webhooks.deliveries(baseId, webhookId) }),
  });
}

// ---- Automations: the builder, test runs and run history ----

/** A base's interfaces: editors get drafts too, everyone else published pages only. */
export const useInterfaces = (baseId: string) =>
  useQuery({
    queryKey: queryKeys.interfaces.base(baseId),
    queryFn: () => api.interfaces.list({ params: { baseId } }),
    enabled: baseId !== '',
  });

/**
 * A page's numbers and charts, aggregated by the server: the published page's, or with
 * `draft` (editors) the saved draft's, narrowed by the viewer's filter elements.
 */
export const useInterfacePageData = (
  baseId: string,
  ids: { interfaceId: string; pageId: string },
  body: InterfacePageDataQuery,
  enabled = true
) =>
  useQuery({
    queryKey: queryKeys.interfaces.data(baseId, ids.pageId, body),
    queryFn: () => api.interfaces.pageData({ params: ids, body }),
    placeholderData: keepPreviousData,
    enabled,
  });

/** One interface as the viewer reaches it: interface-only collaborators too. */
export const useInterfaceAccess = (interfaceId: string) =>
  useQuery({
    queryKey: queryKeys.interfaces.access(interfaceId),
    queryFn: () => api.interfaces.get({ params: { interfaceId } }),
    enabled: interfaceId !== '',
    retry: false,
  });

/** The interfaces shared with the viewer alone, for Home. */
export const useSharedInterfaces = () =>
  useQuery({
    queryKey: queryKeys.interfaces.sharedWithMe(),
    queryFn: () => api.interfaces.sharedWithMe(),
  });

/**
 * A page's records as the viewer may see them: the page's filter on the server, only the
 * fields it shows. The first INTERFACE_RECORDS_PAGE_MAX (a window for calendars and timelines).
 */
export const interfaceRecordsQuery = (
  baseId: string,
  ids: { interfaceId: string; pageId: string },
  body: InterfacePageRecordsQuery
) =>
  queryOptions({
    queryKey: queryKeys.interfaces.records(baseId, ids.pageId, body),
    queryFn: () => api.interfaces.pageRecords({ params: ids, body }),
    placeholderData: keepPreviousData,
  });

/** An interface's interface-only collaborators and pending invitations (creators). */
export const useInterfaceCollaborators = (interfaceId: string, enabled = true) =>
  useQuery({
    queryKey: queryKeys.interfaces.collaborators(interfaceId),
    queryFn: () => api.interfaces.collaborators({ params: { interfaceId } }),
    enabled,
  });

export function useInterfaceCollaboratorMutations(interfaceId: string) {
  const qc = useQueryClient();
  const refresh = () =>
    qc.invalidateQueries({ queryKey: queryKeys.interfaces.collaborators(interfaceId) });
  return {
    invite: useMutation({
      mutationFn: (body: InviteInterfaceCollaboratorInput) =>
        api.interfaces.inviteCollaborator({ params: { interfaceId }, body }),
      onSuccess: refresh,
    }),
    setRole: useMutation({
      mutationFn: ({ userId, role }: { userId: string; role: InterfaceRole }) =>
        api.interfaces.updateCollaborator({ params: { interfaceId, userId }, body: { role } }),
      onSuccess: refresh,
    }),
    remove: useMutation({
      mutationFn: (userId: string) =>
        api.interfaces.removeCollaborator({ params: { interfaceId, userId } }),
      onSuccess: refresh,
    }),
    revoke: useMutation({
      mutationFn: (invitationId: string) =>
        api.interfaces.revokeInvitation({ params: { interfaceId, invitationId } }),
      onSuccess: refresh,
    }),
  };
}

/** The interface mutations; each refreshes the base's interface list. */
export function useInterfaceMutations(baseId: string) {
  const qc = useQueryClient();
  const refresh = () => qc.invalidateQueries({ queryKey: queryKeys.interfaces.base(baseId) });
  return {
    create: useMutation({
      mutationFn: (name: string) => api.interfaces.create({ params: { baseId }, body: { name } }),
      onSuccess: refresh,
    }),
    rename: useMutation({
      mutationFn: ({ interfaceId, name }: { interfaceId: string; name: string }) =>
        api.interfaces.update({ params: { baseId, interfaceId }, body: { name } }),
      onSuccess: refresh,
    }),
    remove: useMutation({
      mutationFn: (interfaceId: string) =>
        api.interfaces.delete({ params: { baseId, interfaceId } }),
      onSuccess: refresh,
    }),
    createPage: useMutation({
      mutationFn: ({ interfaceId, ...body }: CreateInterfacePageInput & { interfaceId: string }) =>
        api.interfaces.createPage({ params: { baseId, interfaceId }, body }),
      onSuccess: refresh,
    }),
    updatePage: useMutation({
      mutationFn: ({
        interfaceId,
        pageId,
        ...body
      }: UpdateInterfacePageInput & { interfaceId: string; pageId: string }) =>
        api.interfaces.updatePage({ params: { baseId, interfaceId, pageId }, body }),
      onSuccess: refresh,
    }),
    deletePage: useMutation({
      mutationFn: ({ interfaceId, pageId }: { interfaceId: string; pageId: string }) =>
        api.interfaces.deletePage({ params: { baseId, interfaceId, pageId } }),
      onSuccess: refresh,
    }),
    publish: useMutation({
      mutationFn: ({ interfaceId, pageId }: { interfaceId: string; pageId: string }) =>
        api.interfaces.publishPage({ params: { baseId, interfaceId, pageId } }),
      onSuccess: refresh,
    }),
    unpublish: useMutation({
      mutationFn: ({ interfaceId, pageId }: { interfaceId: string; pageId: string }) =>
        api.interfaces.unpublishPage({ params: { baseId, interfaceId, pageId } }),
      onSuccess: refresh,
    }),
  };
}

export const useAutomations = (baseId: string, enabled = true) =>
  useQuery({
    queryKey: queryKeys.automations.base(baseId),
    queryFn: () => api.automations.list({ params: { baseId } }),
    enabled: enabled && baseId !== '',
    // Last runs and run counts change as the worker runs them.
    refetchInterval: 5_000,
  });

/** The base's failed runs not retried yet, every automation's. */
export const useFailedAutomationRuns = (baseId: string, enabled = true) =>
  useQuery({
    queryKey: queryKeys.automations.failed(baseId),
    queryFn: () => api.automations.failedRuns({ params: { baseId }, query: { limit: 50 } }),
    enabled: enabled && baseId !== '',
  });

export const useAutomationRuns = (
  baseId: string,
  automationId: string,
  status?: AutomationRunStatus
) =>
  useQuery({
    queryKey: queryKeys.automations.runs(baseId, automationId, status),
    queryFn: () =>
      api.automations.runs({
        params: { baseId, automationId },
        query: { limit: 50, ...(status ? { status } : {}) },
      }),
    enabled: baseId !== '' && automationId !== '',
    // Runs arrive from the worker while the history is open.
    refetchInterval: 5_000,
  });

export const useScripts = (baseId: string, enabled = true) =>
  useQuery({
    queryKey: queryKeys.scripts(baseId),
    queryFn: () => api.scripts.list({ params: { baseId } }),
    enabled: enabled && baseId !== '',
  });

/** Saving, renaming and deleting a base's scripts. */
export function useScriptMutations(baseId: string) {
  const qc = useQueryClient();
  const onSuccess = () => qc.invalidateQueries({ queryKey: queryKeys.scripts(baseId) });
  return {
    create: useMutation({
      mutationFn: (body: CreateScriptInput) => api.scripts.create({ params: { baseId }, body }),
      onSuccess,
    }),
    update: useMutation({
      mutationFn: ({ scriptId, ...body }: UpdateScriptInput & { scriptId: string }) =>
        api.scripts.update({ params: { baseId, scriptId }, body }),
      onSuccess,
    }),
    remove: useMutation({
      mutationFn: (scriptId: string) => api.scripts.delete({ params: { baseId, scriptId } }),
      onSuccess,
    }),
  };
}

export const useExtensions = (baseId: string, enabled = true) =>
  useQuery({
    queryKey: queryKeys.extensions(baseId),
    queryFn: () => api.extensions.list({ params: { baseId } }),
    enabled: enabled && baseId !== '',
  });

/** An installation's manifest and bundle (built-ins update with the app, so not forever). */
export const useExtensionBundle = (baseId: string, extensionId: string) =>
  useQuery({
    queryKey: queryKeys.extensionBundle(baseId, extensionId),
    queryFn: () => api.extensions.bundle({ params: { baseId, extensionId } }),
    staleTime: 5 * 60_000,
  });

/** Installing, arranging, resizing and removing a base's extensions. */
export function useExtensionMutations(baseId: string) {
  const qc = useQueryClient();
  const key = queryKeys.extensions(baseId);
  const onSuccess = () => qc.invalidateQueries({ queryKey: key, exact: true });
  return {
    install: useMutation({
      mutationFn: (body: InstallExtensionInput) =>
        api.extensions.install({ params: { baseId }, body }),
      onSuccess,
    }),
    update: useMutation({
      mutationFn: ({ extensionId, ...body }: UpdateExtensionInput & { extensionId: string }) =>
        api.extensions.update({ params: { baseId, extensionId }, body }),
      onSuccess,
    }),
    reorder: useMutation({
      mutationFn: (ids: string[]) => api.extensions.reorder({ params: { baseId }, body: { ids } }),
      onMutate: (ids: string[]) => {
        qc.setQueryData<ExtensionList>(key, (old) =>
          old
            ? {
                ...old,
                extensions: ids
                  .map((id) => old.extensions.find((e) => e.id === id))
                  .filter((e): e is ExtensionInstallation => !!e),
              }
            : old
        );
      },
      onSettled: onSuccess,
    }),
    settings: useMutation({
      mutationFn: ({
        extensionId,
        settings,
      }: {
        extensionId: string;
        settings: Record<string, unknown>;
      }) => api.extensions.settings({ params: { baseId, extensionId }, body: { settings } }),
      onSuccess: (updated) => {
        qc.setQueryData<ExtensionList>(key, (old) =>
          old
            ? {
                ...old,
                extensions: old.extensions.map((e) => (e.id === updated.id ? updated : e)),
              }
            : old
        );
      },
    }),
    remove: useMutation({
      mutationFn: (extensionId: string) =>
        api.extensions.delete({ params: { baseId, extensionId } }),
      onSuccess,
    }),
  };
}

export function useCreateAutomation(baseId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: CreateAutomationInput) =>
      api.automations.create({ params: { baseId }, body }),
    onSuccess: () => qc.invalidateQueries({ queryKey: queryKeys.automations.base(baseId) }),
  });
}

export function useUpdateAutomation(baseId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ automationId, ...body }: UpdateAutomationInput & { automationId: string }) =>
      api.automations.update({ params: { baseId, automationId }, body }),
    onSuccess: () => qc.invalidateQueries({ queryKey: queryKeys.automations.base(baseId) }),
  });
}

export function useDeleteAutomation(baseId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (automationId: string) =>
      api.automations.delete({ params: { baseId, automationId } }),
    onSuccess: () => qc.invalidateQueries({ queryKey: queryKeys.automations.base(baseId) }),
  });
}

export function useRotateAutomationWebhook(baseId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (automationId: string) =>
      api.automations.rotateWebhook({ params: { baseId, automationId } }),
    onSuccess: () => qc.invalidateQueries({ queryKey: queryKeys.automations.base(baseId) }),
  });
}

/** Runs the automation's test; its run joins the history. */
export function useTestAutomation(baseId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ automationId, ...body }: TestAutomationInput & { automationId: string }) =>
      api.automations.test({ params: { baseId, automationId }, body }),
    onSettled: () => qc.invalidateQueries({ queryKey: queryKeys.automations.base(baseId) }),
  });
}

export function useRetryAutomationRun(baseId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ automationId, runId }: { automationId: string; runId: string }) =>
      api.automations.retryRun({ params: { baseId, automationId, runId } }),
    onSettled: () => qc.invalidateQueries({ queryKey: queryKeys.automations.base(baseId) }),
  });
}

export const useSnapshots = (baseId: string, enabled = true) =>
  useQuery({
    queryKey: queryKeys.snapshots.base(baseId),
    queryFn: () => api.snapshots.list({ params: { baseId } }),
    enabled: enabled && baseId !== '',
  });

export function useTakeSnapshot(baseId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api.snapshots.create({ params: { baseId } }),
    onSuccess: () => qc.invalidateQueries({ queryKey: queryKeys.snapshots.base(baseId) }),
  });
}

export function useRestoreSnapshot(baseId: string) {
  return useMutation({
    mutationFn: (input: { snapshotId: string; name?: string }) =>
      api.snapshots.restore({
        params: { baseId, snapshotId: input.snapshotId },
        body: input.name ? { name: input.name } : {},
      }),
  });
}

/**
 * A snapshot restore running in the worker, polled until it has finished; the base list
 * reloads once the new base exists.
 */
export function useRestoreJob(baseId: string, restoreId: string | undefined) {
  const qc = useQueryClient();
  return useQuery({
    queryKey: queryKeys.snapshots.restore(restoreId ?? ''),
    queryFn: async () => {
      const job = await api.snapshots.restoreStatus({
        params: { baseId, restoreId: restoreId ?? '' },
      });
      if (job.status === 'done') await qc.invalidateQueries({ queryKey: queryKeys.bases.all() });
      return job;
    },
    enabled: restoreId !== undefined,
    refetchInterval: (q) =>
      q.state.data?.status === 'running' || !q.state.data ? IMPORT_POLL_MS : false,
  });
}

/** The template gallery: the summaries, then one template's whole document to preview. */
export const templateQueries = {
  list: () =>
    queryOptions({
      queryKey: queryKeys.templates.list(),
      queryFn: () => api.templates.list(),
      staleTime: Number.POSITIVE_INFINITY,
    }),
  detail: (slug: string) =>
    queryOptions({
      queryKey: queryKeys.templates.detail(slug),
      queryFn: () => api.templates.get({ params: { slug } }),
      staleTime: Number.POSITIVE_INFINITY,
    }),
};

export function useDuplicateBase(baseId: string) {
  return useMutation({
    mutationFn: (body: DuplicateBaseInput) => api.bases.duplicate({ params: { baseId }, body }),
  });
}

/**
 * A base duplicate running in the worker, polled with its progress until it has finished;
 * the base lists reload once the copy exists.
 */
export function useDuplicateJob(baseId: string, duplicateId: string | undefined) {
  const qc = useQueryClient();
  return useQuery({
    queryKey: queryKeys.duplicates.detail(duplicateId ?? ''),
    queryFn: async () => {
      const job = await api.bases.duplicateStatus({
        params: { baseId, duplicateId: duplicateId ?? '' },
      });
      if (job.status === 'done') await qc.invalidateQueries({ queryKey: queryKeys.bases.all() });
      return job;
    },
    enabled: duplicateId !== undefined,
    refetchInterval: (q) =>
      q.state.data?.status === 'running' || !q.state.data ? IMPORT_POLL_MS : false,
  });
}

export function useDeleteSnapshot(baseId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (snapshotId: string) => api.snapshots.delete({ params: { baseId, snapshotId } }),
    onSuccess: () => qc.invalidateQueries({ queryKey: queryKeys.snapshots.base(baseId) }),
  });
}

export function useUpdateSnapshotSettings(workspaceId: string, baseId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (retentionDays: number) =>
      api.snapshots.updateSettings({ params: { workspaceId }, body: { retentionDays } }),
    onSuccess: () => qc.invalidateQueries({ queryKey: queryKeys.snapshots.base(baseId) }),
  });
}

/** The Airtable bases a token can read; the token isn't kept by the server. */
export function useAirtableBases(workspaceId: string) {
  return useMutation({
    mutationFn: (token: string) => api.airtable.bases({ params: { workspaceId }, body: { token } }),
  });
}

/** Starts Airtable imports: a new base per Airtable base, filled by the worker. */
export function useStartAirtableImport(workspaceId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { token: string; baseIds: string[] }) =>
      api.airtable.create({ params: { workspaceId }, body: input }),
    // Not awaited: the dialog swaps the base picker for the progress list as soon as the
    // imports exist, without waiting for the refetches (the picker and the new import's item
    // were otherwise both on screen until the bases list came back).
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: queryKeys.airtableImports(workspaceId) });
      void qc.invalidateQueries({ queryKey: queryKeys.bases.all() });
    },
  });
}

/** Imports started in this browser, polled until each ends. */
export function useWatchedAirtableImports(watched: { id: string; workspaceId: string }[]) {
  return useQuery({
    queryKey: queryKeys.airtableWatch(watched.map((w) => w.id)),
    queryFn: () =>
      Promise.all(
        watched.map((w) =>
          api.airtable
            .get({ params: { workspaceId: w.workspaceId, importId: w.id } })
            .catch(() => null)
        )
      ),
    enabled: watched.length > 0,
    refetchInterval: WATCH_POLL_MS,
  });
}
const WATCH_POLL_MS = 3000;

/** Stops a running Airtable import; the base keeps what was imported. */
export function useCancelAirtableImport(workspaceId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (importId: string) => api.airtable.cancel({ params: { workspaceId, importId } }),
    onSuccess: () => qc.invalidateQueries({ queryKey: queryKeys.airtableImports(workspaceId) }),
  });
}

/**
 * The caller's Airtable imports in the workspace, polled while one runs; the bases reload
 * when one finishes.
 */
export function useAirtableImports(workspaceId: string, enabled: boolean) {
  const qc = useQueryClient();
  const key = queryKeys.airtableImports(workspaceId);
  return useQuery({
    queryKey: key,
    queryFn: async () => {
      const before = qc.getQueryData<AirtableImportList>(key);
      const list = await api.airtable.list({ params: { workspaceId } });
      const finished = list.imports.some(
        (i) =>
          i.status !== 'running' &&
          before?.imports.some((b) => b.id === i.id && b.status === 'running')
      );
      if (finished) await qc.invalidateQueries({ queryKey: queryKeys.bases.all() });
      return list;
    },
    enabled,
    refetchInterval: (q) =>
      q.state.data?.imports.some((i) => i.status === 'running') ? IMPORT_POLL_MS : false,
  });
}

/**
 * The AI assistant: a plan is only a proposal (nothing changes); applying it, after the
 * user confirms, changes the base's schema, so the base's tables, views and automations refetch.
 */
export function useAssistantPlan(baseId: string) {
  return useMutation({
    mutationFn: (body: { prompt: string; includeRecords: boolean }) =>
      api.bases.assistantPlan({ params: { baseId }, body }),
  });
}

export function useApplyAssistantPlan(baseId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (plan: AssistantPlan) =>
      api.bases.assistantApply({ params: { baseId }, body: { plan } }),
    onSuccess: async () => {
      await Promise.all([
        qc.invalidateQueries({ queryKey: queryKeys.tables.all() }),
        qc.invalidateQueries({ queryKey: queryKeys.views.all() }),
        qc.invalidateQueries({ queryKey: queryKeys.automations.base(baseId) }),
      ]);
    },
  });
}

/** "Describe it": a plan for a new base in the workspace, and creating it. */
export function useAssistantBasePlan(workspaceId: string) {
  return useMutation({
    mutationFn: (prompt: string) =>
      api.workspaces.assistantPlan({ params: { workspaceId }, body: { prompt } }),
  });
}

export function useApplyAssistantBasePlan(workspaceId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { name: string; plan: AssistantPlan }) =>
      api.workspaces.assistantApply({ params: { workspaceId }, body: input }),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: queryKeys.bases.all() });
    },
  });
}

/**
 * A synced table's sync: source, schedule, status and recent runs. Polled while a run is
 * queued or running; when one finishes, the table (synced choices) and its records refresh.
 */
export function useTableSync(tableId: string, enabled: boolean) {
  const qc = useQueryClient();
  return useQuery({
    queryKey: queryKeys.syncs.detail(tableId),
    enabled,
    queryFn: async () => {
      const previous = qc.getQueryData<TableSync>(queryKeys.syncs.detail(tableId));
      const sync = await api.syncs.get({ params: { tableId } });
      const wasBusy = previous?.runs.some((r) => r.status === 'queued' || r.status === 'running');
      const busy = sync.runs.some((r) => r.status === 'queued' || r.status === 'running');
      if (wasBusy && !busy) {
        void qc.invalidateQueries({ queryKey: queryKeys.tables.detail(tableId) });
        void qc.invalidateQueries({ queryKey: queryKeys.records.table(tableId) });
      }
      return sync;
    },
    refetchInterval: (query) =>
      query.state.data?.runs.some((r) => r.status === 'queued' || r.status === 'running')
        ? 2000
        : 60_000,
  });
}

export function useCreateSync(baseId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: CreateSyncInput) => api.syncs.create({ params: { baseId }, body }),
    onSuccess: (sync) => {
      qc.setQueryData(queryKeys.syncs.detail(sync.tableId), sync);
      return qc.invalidateQueries({ queryKey: queryKeys.tables.list(baseId) });
    },
  });
}

/** "Preview" a CSV URL or Postgres source's columns: nothing is saved. */
export function usePreviewSync(baseId: string) {
  return useMutation({
    mutationFn: (body: PreviewSyncInput) => api.syncs.preview({ params: { baseId }, body }),
  });
}

/** The instance's sync connectors and your connected accounts. */
export function useSyncConnectors(enabled = true) {
  return useQuery({
    queryKey: queryKeys.syncConnectors.list(),
    queryFn: async () => (await api.syncs.connectors()).connectors,
    enabled,
    staleTime: 30_000,
  });
}

/** A sync connector picker level's items (spreadsheets, then a spreadsheet's sheets). */
export function useConnectorItems(
  baseId: string,
  connector: string,
  path: readonly string[],
  search: string,
  enabled: boolean
) {
  return useQuery({
    queryKey: queryKeys.syncConnectors.items(baseId, connector, path, search),
    queryFn: () =>
      api.syncs.browse({
        params: { baseId },
        body: { connector, path: [...path], ...(search ? { search } : {}) },
      }),
    enabled,
    retry: false,
    staleTime: 30_000,
  });
}

/** Disconnects your account from a sync connector; its syncs pause at their next run. */
export function useDisconnectConnector() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (connectorId: string) => api.syncs.disconnect({ params: { connectorId } }),
    onSuccess: () => qc.invalidateQueries({ queryKey: queryKeys.syncConnectors.list() }),
  });
}

export function useSyncMutations(tableId: string) {
  const qc = useQueryClient();
  const put = (sync: TableSync) => qc.setQueryData(queryKeys.syncs.detail(tableId), sync);
  return {
    run: useMutation({
      mutationFn: () => api.syncs.run({ params: { tableId } }),
      onSuccess: put,
    }),
    update: useMutation({
      mutationFn: (body: UpdateSyncInput) => api.syncs.update({ params: { tableId }, body }),
      onSuccess: put,
    }),
    remove: useMutation({
      mutationFn: () => api.syncs.delete({ params: { tableId } }),
      onSuccess: () => {
        qc.removeQueries({ queryKey: queryKeys.syncs.detail(tableId) });
        return qc.invalidateQueries({ queryKey: queryKeys.tables.all() });
      },
    }),
  };
}

/** The workspace's policies (owners; the hosted edition). */
export const usePolicies = (workspaceId: string) =>
  useQuery({
    queryKey: queryKeys.workspaces.policies(workspaceId),
    queryFn: () => workspaceAdminApi.policies.get({ params: { workspaceId } }),
    retry: false,
  });

/** Everyone with access to the workspace (owners; hosted Enterprise plans). */
export const useAdminMembers = (workspaceId: string, enabled = true) =>
  useQuery({
    queryKey: queryKeys.workspaces.adminMembers(workspaceId),
    queryFn: () => workspaceAdminApi.members.list({ params: { workspaceId } }),
    retry: false,
    enabled,
  });
