import type { MeResponse } from '@openrows/shared';
import { Link } from '@tanstack/react-router';
import { LayoutDashboardIcon } from 'lucide-react';
import { ApiError } from '../../api/client';
import { useInterfaceAccess } from '../../api/queries';
import { AccountRow, NavItem, SectionLabel, Shell, TopBar } from '../../app/Shell';
import { Skeleton } from '../../components/ui';
import { PageRuntime } from './PageRuntime';

/**
 * `/i/:interfaceId?p=<pageId>`: one interface on its own, without its base, which is
 * how its interface-only collaborators use it (everyone on the base may open it too). Its
 * published pages, read and written through the interface's own routes.
 */
export function InterfaceApp({
  me,
  interfaceId,
  pageId,
}: {
  me: MeResponse;
  interfaceId: string;
  pageId?: string | undefined;
}) {
  const access = useInterfaceAccess(interfaceId);
  const data = access.data;
  const pages = (data?.interface.pages ?? []).filter((p) => p.published !== null);
  const current = pageId ? pages.find((p) => p.id === pageId) : pages[0];
  const config = current?.published ?? null;

  return (
    <Shell
      sidebar={
        <div className="flex h-full min-h-0 flex-col">
          <SectionLabel>{data?.interface.name ?? 'Interface'}</SectionLabel>
          <nav aria-label="Pages" className="flex min-h-0 flex-1 flex-col overflow-y-auto">
            {pages.map((p) => (
              <NavItem
                key={p.id}
                active={p.id === current?.id}
                icon={<LayoutDashboardIcon />}
                to="/i/$interfaceId"
                params={{ interfaceId }}
                search={{ p: p.id }}
              >
                {p.name}
              </NavItem>
            ))}
          </nav>
          <div className="mt-auto pt-2">
            <AccountRow me={me} />
          </div>
        </div>
      }
    >
      <TopBar
        actions={
          data?.canEdit ? (
            <Link
              to="/b/$baseId/interfaces"
              params={{ baseId: data.interface.baseId }}
              search={current ? { p: current.id } : {}}
              className="text-small text-text-2 hover:text-text"
            >
              Open in the base
            </Link>
          ) : undefined
        }
      >
        <nav aria-label="Breadcrumb" className="flex min-w-0 items-center gap-2 text-[15px]">
          <span className="truncate text-text-2 max-sm:hidden">
            {data ? `${data.baseName} / ${data.interface.name}` : ''}
          </span>
          <span className="text-text-3 max-sm:hidden">/</span>
          <h1 className="truncate font-[550]" aria-current="page">
            {current?.name ?? 'Interface'}
          </h1>
        </nav>
      </TopBar>
      <main className="min-h-0 flex-1 overflow-y-auto p-4">
        {access.isPending ? (
          <div className="grid gap-2" aria-busy="true">
            <Skeleton className="h-10" />
            <Skeleton className="h-10" />
          </div>
        ) : access.isError ? (
          <p className="text-text-2">
            {access.error instanceof ApiError && access.error.status === 404
              ? "This interface doesn't exist, or it isn't shared with you."
              : "Couldn't load the interface."}
          </p>
        ) : current && config && data ? (
          <PageRuntime
            key={current.id}
            config={config}
            pageName={current.name}
            source={{
              baseId: data.interface.baseId,
              interfaceId,
              pageId: current.id,
              draft: false,
              interfaceOnly: data.access === 'interface',
            }}
          />
        ) : (
          <p className="text-text-2">
            {pageId ? "This page doesn't exist or isn't published." : 'No pages are published yet.'}
          </p>
        )}
      </main>
    </Shell>
  );
}
