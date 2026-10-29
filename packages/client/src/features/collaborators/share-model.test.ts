import { describe, expect, it } from 'vitest';
import { accessSource, baseRoleChoices, removeLabel } from './share-model';

describe('share dialog model (#91)', () => {
  it('offers every base role to a base-only collaborator, only raises to members', () => {
    expect(baseRoleChoices({ workspaceRole: null })).toEqual([
      'creator',
      'editor',
      'commenter',
      'read_only',
    ]);
    expect(baseRoleChoices({ workspaceRole: 'editor' })).toEqual(['creator', 'editor']);
    expect(baseRoleChoices({ workspaceRole: 'creator' })).toEqual(['creator']);
    expect(baseRoleChoices({ workspaceRole: 'owner' })).toEqual([]);
  });

  it('says where the access comes from', () => {
    expect(accessSource({ workspaceRole: null, baseRole: 'editor' })).toBe('Base only');
    expect(accessSource({ workspaceRole: 'editor', baseRole: null })).toBe('Workspace editor');
    expect(accessSource({ workspaceRole: 'editor', baseRole: 'creator' })).toBe(
      'Workspace editor, raised on this base'
    );
    // A lower base role changes nothing.
    expect(accessSource({ workspaceRole: 'creator', baseRole: 'read_only' })).toBe(
      'Workspace creator'
    );
    expect(removeLabel({ workspaceRole: null })).toBe('Remove from base');
    expect(removeLabel({ workspaceRole: 'read_only' })).toBe('Reset to workspace role');
  });
});
