import type { ViewMeta, ViewType } from '@openrows/shared';
import { useQuery } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import {
  CalendarDaysIcon,
  ClipboardListIcon,
  Columns3Icon,
  GanttChartIcon,
  LayoutGridIcon,
  ListTreeIcon,
  PlusIcon,
} from 'lucide-react';
import { useState } from 'react';
import { ApiError } from '../api/client';
import { useCreateView, viewQueries } from '../api/queries';
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  toast,
} from '../components/ui';
import { nextFreeName } from './names';

/**
 * The view types a new view can have, in picker order, with their default names. A form
 * view opens the form builder.
 */
export const VIEW_TYPE_OPTIONS: readonly {
  type: ViewType;
  label: string;
  name: string;
  disabled?: boolean;
}[] = [
  { type: 'grid', label: 'Grid', name: 'Grid view' },
  { type: 'kanban', label: 'Kanban', name: 'Kanban' },
  { type: 'calendar', label: 'Calendar', name: 'Calendar' },
  { type: 'gallery', label: 'Gallery', name: 'Gallery' },
  { type: 'timeline', label: 'Timeline', name: 'Timeline' },
  { type: 'list', label: 'List', name: 'List' },
  { type: 'form', label: 'Form', name: 'Form' },
];

/** The icon of a view type in the sidebar and the picker. */
export function ViewTypeIcon({ type }: { type: ViewType }) {
  switch (type) {
    case 'kanban':
      return <Columns3Icon />;
    case 'calendar':
      return <CalendarDaysIcon />;
    case 'gallery':
      return <LayoutGridIcon />;
    case 'timeline':
      return <GanttChartIcon />;
    case 'list':
      return <ListTreeIcon />;
    case 'form':
      return <ClipboardListIcon />;
    default:
      return <GridIcon />;
  }
}

/** The grid view icon (a 3×3 grid, as in the mockup). */
function GridIcon() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true" fill="currentColor">
      {[0, 5.5, 11].flatMap((y) =>
        [0, 5.5, 11].map((x) => (
          <rect key={`${x}-${y}`} x={x} y={y} width="4.5" height="4.5" rx="1" />
        ))
      )}
    </svg>
  );
}

/** The default name of a new view of `type`: the type's name, numbered past the taken ones. */
export const newViewName = (type: ViewType, views: readonly Pick<ViewMeta, 'name'>[]) =>
  nextFreeName(
    VIEW_TYPE_OPTIONS.find((o) => o.type === type)?.name ?? 'Grid view',
    views.map((v) => v.name)
  );

/** Creates a view of the table under a free name and opens it. */
export function useCreateViewAction(baseId: string, tableId: string) {
  const navigate = useNavigate();
  const createView = useCreateView(tableId);
  const views = useQuery({ ...viewQueries.list(tableId), enabled: !!tableId });
  const create = (type: ViewType, personal: boolean) =>
    createView.mutate(
      {
        name: newViewName(type, views.data?.views ?? []),
        type,
        ...(personal ? { personal } : {}),
      },
      {
        onSuccess: (v) =>
          navigate({
            to: '/b/$baseId/$tableId/$viewId',
            params: { baseId, tableId, viewId: v.id },
          }),
        onError: (err) =>
          toast.error(err instanceof ApiError ? err.message : "Couldn't create the view"),
      }
    );
  return { create, pending: createView.isPending };
}

/**
 * The sidebar's "Create view" control: a menu of the view types, keyboard-first (arrows,
 * typeahead, Enter), with "Only me" to make the new view personal (it stays open on toggle).
 */
export function CreateViewMenu({ baseId, tableId }: { baseId: string; tableId: string }) {
  const [personal, setPersonal] = useState(false);
  const { create, pending } = useCreateViewAction(baseId, tableId);
  return (
    <DropdownMenu onOpenChange={(open) => !open && setPersonal(false)}>
      <DropdownMenuTrigger
        disabled={pending}
        className="mx-2 flex h-8 items-center gap-2.5 rounded-sm px-2.5 text-text-2 hover:bg-hover hover:text-text disabled:opacity-50 data-[state=open]:bg-hover data-[state=open]:text-text"
      >
        <PlusIcon className="size-4" />
        Create view
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" side="bottom" className="w-56" aria-label="Create view">
        <DropdownMenuLabel>Create view</DropdownMenuLabel>
        {VIEW_TYPE_OPTIONS.map((o) => (
          <DropdownMenuItem
            key={o.type}
            disabled={o.disabled}
            onSelect={() => create(o.type, personal)}
          >
            <ViewTypeIcon type={o.type} />
            {o.label}
            {o.disabled && <span className="ml-auto text-small text-text-2">Soon</span>}
          </DropdownMenuItem>
        ))}
        <DropdownMenuSeparator />
        <DropdownMenuCheckboxItem
          checked={personal}
          onCheckedChange={(on) => setPersonal(on)}
          onSelect={(e) => e.preventDefault()}
        >
          Only me
          <span className="ml-auto text-small text-text-2">Personal</span>
        </DropdownMenuCheckboxItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
