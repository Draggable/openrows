import type { Collaborator } from '@openrows/shared';
import { cn } from '../../lib/utils';
import { useDirectory } from './context';
import { readUserIds } from './model';

/** A round avatar with the person's initials on their chip colour. */
export function Avatar({ person, className }: { person: Collaborator; className?: string }) {
  return (
    <span
      aria-hidden
      data-color={person.color}
      className={cn(
        'inline-flex size-5 shrink-0 items-center justify-center rounded-full text-[10px] font-semibold',
        className
      )}
      style={{
        background: `var(--chip-${person.color}-bg)`,
        color: `var(--chip-${person.color}-text)`,
      }}
    >
      {person.initials}
    </span>
  );
}

/**
 * A user chip: avatar and name. People no longer in the directory (removed from the workspace
 * ) show as "Former member".
 */
export function UserChip({ userId }: { userId: string }) {
  const { byId, loaded } = useDirectory();
  const person = byId.get(userId);
  if (!person) {
    if (!loaded) return null;
    return <span className="truncate text-text-3">Former member</span>;
  }
  return (
    <span
      data-testid="user-chip"
      title={person.email ?? person.name}
      className="inline-flex h-5 min-w-0 max-w-full shrink-0 items-center gap-1.5"
    >
      <Avatar person={person} />
      <span className="truncate">{person.name}</span>
    </span>
  );
}

/** A user cell's display: one chip per user id in the value. */
export function UserCell({ value }: { value: unknown }) {
  const ids = readUserIds(value);
  if (ids.length === 0) return null;
  return (
    <span className="flex min-w-0 gap-2 overflow-hidden">
      {ids.map((id) => (
        <UserChip key={id} userId={id} />
      ))}
    </span>
  );
}
