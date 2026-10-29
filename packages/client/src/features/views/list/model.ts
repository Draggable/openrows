import type { FieldMeta, ListLayout, RecordData } from '@openrows/shared';
import { linkedIds } from '../timeline/model';

/**
 * The list view's logic, apart from React: the tree of records nested by a parent link
 * (a record's parent is the first record its parent field links to, in the same table), and the
 * rows it shows with some branches collapsed.
 */

/** The fields shown beside the title: the saved ones that exist, else the first three. */
export function rowFieldsOf(fields: readonly FieldMeta[], layout: ListLayout): FieldMeta[] {
  const live = fields.filter((f) => !f.deletedAt && !f.isPrimary);
  if (layout.rowFields)
    return layout.rowFields.flatMap((id) => live.find((f) => f.id === id) ?? []);
  return live.filter((f) => f.id !== layout.parentFieldId).slice(0, 3);
}

export interface ListRow {
  record: RecordData;
  /** 1 for top-level records. */
  level: number;
  parentId: string | null;
  childCount: number;
  /** Position among its siblings (1-based) and how many siblings there are. */
  posInSet: number;
  setSize: number;
}

/**
 * The rows of the list in view order: each record right after its parent (or its previous
 * sibling's subtree), indented one level deeper. A record whose parent isn't among `records`
 * (filtered out, or another page) is top-level; a parent chain that loops is cut where it
 * loops, so every record shows once. Branches in `collapsed` hide their descendants.
 */
export function listRows(
  records: readonly RecordData[],
  parentField: FieldMeta | undefined,
  collapsed: ReadonlySet<string> = new Set()
): ListRow[] {
  const byId = new Map(records.map((r) => [r.id, r]));
  const parentOf = new Map<string, string | null>();
  for (const r of records) {
    const first = parentField ? linkedIds(r.fields[parentField.id])[0] : undefined;
    parentOf.set(r.id, first && first !== r.id && byId.has(first) ? first : null);
  }
  // Cut loops: walk up from each record; a chain that comes back to it makes it top-level.
  for (const r of records) {
    const seen = new Set<string>([r.id]);
    let at = parentOf.get(r.id) ?? null;
    while (at !== null) {
      if (seen.has(at)) {
        parentOf.set(r.id, null);
        break;
      }
      seen.add(at);
      at = parentOf.get(at) ?? null;
    }
  }
  const children = new Map<string | null, RecordData[]>();
  for (const r of records) {
    const p = parentOf.get(r.id) ?? null;
    const list = children.get(p) ?? [];
    list.push(r);
    children.set(p, list);
  }
  const out: ListRow[] = [];
  const visit = (parentId: string | null, level: number) => {
    const kids = children.get(parentId) ?? [];
    kids.forEach((record, i) => {
      const childCount = children.get(record.id)?.length ?? 0;
      out.push({ record, level, parentId, childCount, posInSet: i + 1, setSize: kids.length });
      if (childCount > 0 && !collapsed.has(record.id)) visit(record.id, level + 1);
    });
  };
  visit(null, 1);
  return out;
}

/** Where a tree key moves the focus (WAI-ARIA tree pattern), or what it toggles. */
export function treeKey(
  key: string,
  rows: readonly ListRow[],
  index: number,
  collapsed: ReadonlySet<string>
): { focus: number } | { toggle: string } | null {
  const row = rows[index];
  if (!row) return null;
  if (key === 'ArrowDown') return index + 1 < rows.length ? { focus: index + 1 } : null;
  if (key === 'ArrowUp') return index > 0 ? { focus: index - 1 } : null;
  if (key === 'Home') return { focus: 0 };
  if (key === 'End') return { focus: rows.length - 1 };
  if (key === 'ArrowRight' && row.childCount > 0) {
    return collapsed.has(row.record.id) ? { toggle: row.record.id } : { focus: index + 1 };
  }
  if (key === 'ArrowLeft') {
    if (row.childCount > 0 && !collapsed.has(row.record.id)) return { toggle: row.record.id };
    if (row.parentId !== null) {
      const parent = rows.findIndex((r) => r.record.id === row.parentId);
      return parent >= 0 ? { focus: parent } : null;
    }
  }
  return null;
}
