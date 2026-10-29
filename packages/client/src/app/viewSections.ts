import type { ViewMeta, ViewSection } from '@openrows/shared';
import { positionBetween } from './names';

/** A run of views in the sidebar: the views outside any section, or one section's. */
export type ViewGroup = { section: ViewSection | null; views: ViewMeta[] };

const byPosition = <T extends { position: number }>(a: T, b: T) => a.position - b.position;

/**
 * The sidebar's view groups: the views outside any section first, then each section in order
 * with its views. A view naming a section that isn't there sits outside any section.
 */
export function viewGroups(
  views: readonly ViewMeta[],
  sections: readonly ViewSection[]
): ViewGroup[] {
  const known = new Set(sections.map((s) => s.id));
  const of = (id: string | null) =>
    views
      .filter((v) => (v.sectionId !== null && known.has(v.sectionId) ? v.sectionId : null) === id)
      .sort(byPosition);
  return [
    { section: null, views: of(null) },
    ...[...sections].sort(byPosition).map((s) => ({ section: s, views: of(s.id) })),
  ];
}

/**
 * Where a view dropped on `target` goes: right before it, in its section (`target` null: at
 * the end of `group`). The moved view itself doesn't count as a neighbour.
 */
export function dropTarget(
  group: ViewGroup,
  movedId: string,
  target: ViewMeta | null
): { position: number; sectionId: string | null } {
  const others = group.views.filter((v) => v.id !== movedId);
  const at = target ? others.findIndex((v) => v.id === target.id) : others.length;
  const index = at < 0 ? others.length : at;
  return {
    position: positionBetween(others[index - 1]?.position, others[index]?.position),
    sectionId: group.section?.id ?? null,
  };
}

/** Where a section dropped on `target` goes: right before it (`null`: last). */
export function sectionDropPosition(
  sections: readonly ViewSection[],
  movedId: string,
  target: ViewSection | null
): number {
  const others = [...sections].sort(byPosition).filter((s) => s.id !== movedId);
  const at = target ? others.findIndex((s) => s.id === target.id) : others.length;
  const index = at < 0 ? others.length : at;
  return positionBetween(others[index - 1]?.position, others[index]?.position);
}

/**
 * The sidebar's two runs of groups: the collaborative views (every section shown, empty
 * ones too, so they stay drop targets), then the user's personal views under "My views", by
 * the same sections (only those holding one of them).
 */
export function sidebarGroups(
  views: readonly ViewMeta[],
  sections: readonly ViewSection[]
): { shared: ViewGroup[]; mine: ViewGroup[] } {
  return {
    shared: viewGroups(
      views.filter((v) => !v.personal),
      sections
    ),
    mine: viewGroups(
      views.filter((v) => v.personal),
      sections
    ).filter((g) => g.views.length > 0),
  };
}
