import { type EditPermission, MAX_PERMISSION_USERS, PERMISSION_ROLES } from '@openrows/shared';
import { useId, useState } from 'react';
import { ROLE_LABELS } from '../../app/names';
import { Input } from '../../components/ui';
import { useDirectory } from '../collaborators/context';
import { Avatar } from '../collaborators/UserChip';
import { LEVEL_LABELS, withLevel } from './model';

const selectClass =
  'h-8 w-full rounded-sm border border-border bg-surface px-2 text-body hover:bg-hover disabled:opacity-60 pointer-coarse:h-[40px]';

/**
 * One edit permission: a level, and for "Specific people" the roles and collaborators of
 * the base who may (at most MAX_PERMISSION_USERS people). Commenters and read-only members
 * listed here still can't edit: permissions narrow the base role, never widen it.
 */
export function PermissionPicker({
  label,
  value,
  onChange,
}: {
  label: string;
  value: EditPermission;
  onChange: (next: EditPermission) => void;
}) {
  const id = useId();
  const directory = useDirectory();
  const [search, setSearch] = useState('');
  const people = directory.list.filter((c) => {
    const q = search.trim().toLowerCase();
    return !q || c.name.toLowerCase().includes(q) || (c.email ?? '').toLowerCase().includes(q);
  });
  return (
    <div className="grid gap-2">
      <label htmlFor={id} className="font-[550]">
        {label}
      </label>
      <select
        id={id}
        value={value.level}
        onChange={(e) => onChange(withLevel(value, e.target.value as EditPermission['level']))}
        className={selectClass}
      >
        {(Object.keys(LEVEL_LABELS) as EditPermission['level'][]).map((level) => (
          <option key={level} value={level}>
            {LEVEL_LABELS[level]}
          </option>
        ))}
      </select>
      {value.level === 'specific' && (
        <fieldset className="grid gap-2 rounded-sm border border-border p-2">
          <legend className="px-1 text-text-2">Who can</legend>
          <div className="flex flex-wrap gap-3">
            {PERMISSION_ROLES.map((role) => (
              <label key={role} className="flex items-center gap-1.5">
                <input
                  type="checkbox"
                  checked={value.roles.includes(role)}
                  onChange={(e) =>
                    onChange({
                      ...value,
                      roles: e.target.checked
                        ? [...value.roles, role]
                        : value.roles.filter((r) => r !== role),
                    })
                  }
                />
                All {ROLE_LABELS[role].toLowerCase()}s
              </label>
            ))}
          </div>
          <Input
            aria-label="Find people"
            placeholder="Find people"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          <ul className="grid max-h-48 gap-0.5 overflow-y-auto" aria-label="People">
            {people.map((person) => {
              const checked = value.userIds.includes(person.id);
              return (
                <li key={person.id}>
                  <label className="flex h-8 items-center gap-2 rounded-xs px-1 hover:bg-hover">
                    <input
                      type="checkbox"
                      checked={checked}
                      disabled={!checked && value.userIds.length >= MAX_PERMISSION_USERS}
                      onChange={(e) =>
                        onChange({
                          ...value,
                          userIds: e.target.checked
                            ? [...value.userIds, person.id]
                            : value.userIds.filter((u) => u !== person.id),
                        })
                      }
                    />
                    <Avatar person={person} />
                    <span className="truncate">{person.name}</span>
                  </label>
                </li>
              );
            })}
            {people.length === 0 && <li className="px-1 text-text-2">No one found.</li>}
          </ul>
        </fieldset>
      )}
    </div>
  );
}
