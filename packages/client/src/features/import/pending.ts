/**
 * A file picked before its table existed (Home's "Import a file"): the new-base flow puts
 * it here and the table's grid takes it once, opening the import dialog with it.
 */
const pending = new Map<string, File>();

export function stashImport(tableId: string, file: File) {
  pending.set(tableId, file);
}

/** The file waiting for this table, removed so it opens only once. */
export function takeImport(tableId: string): File | undefined {
  const file = pending.get(tableId);
  pending.delete(tableId);
  return file;
}
