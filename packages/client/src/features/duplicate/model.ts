import { type DuplicateJob, roleAllows, type UserRole, type Workspace } from '@openrows/shared';

/** Creators and owners of a base may duplicate it (the server checks the target too). */
export const canDuplicateBase = (role: UserRole | undefined) =>
  !!role && roleAllows(role, 'base:duplicate');

/** The workspaces a copy may go to: those where the person may add bases (creator and up). */
export function targetWorkspaces(workspaces: readonly Workspace[]): Workspace[] {
  return workspaces.filter((w) => w.role !== null && roleAllows(w.role, 'base:create'));
}

/** The default name of a copy, as the server gives it. */
export const copyName = (name: string) => `${name} copy`.slice(0, 255);

/** "Copying records… 1,200 of 2,000", or "Copying…" before there is anything to count. */
export function progressLabel(job: Pick<DuplicateJob, 'progress' | 'withRecords'> | undefined) {
  if (!job?.withRecords || !job.progress.totalRecords) return 'Copying…';
  const { records, totalRecords } = job.progress;
  return `Copying records… ${records.toLocaleString('en-US')} of ${totalRecords.toLocaleString('en-US')}`;
}
