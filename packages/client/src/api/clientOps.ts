/**
 * Client operation ids (ADR-003 §7): every write is tagged with one, and the server echoes it on
 * the realtime events the write caused. The ids this tab sent are remembered (the latest
 * `MAX_REMEMBERED`), so the realtime layer can recognise its own echoes and skip them: the
 * optimistic update and the server's answer already put the change in the caches.
 */
const MAX_REMEMBERED = 1000;
const sent = new Set<string>();

/** A new id for one write, remembered as this tab's own. */
export function newClientOpId(): string {
  const id = crypto.randomUUID();
  sent.add(id);
  if (sent.size > MAX_REMEMBERED) {
    const oldest = sent.values().next().value;
    if (oldest !== undefined) sent.delete(oldest);
  }
  return id;
}

/** Whether `id` tags a write this tab sent. */
export function isOwnClientOp(id: string | null | undefined): boolean {
  return id != null && sent.has(id);
}
