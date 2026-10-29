import type { ViewMeta } from '@openrows/shared';
import { describe, expect, it } from 'vitest';
import { canConfigureView, canLockViews } from './access';

const view = (locked: boolean) => ({ locked }) as ViewMeta;

describe('view access (#42)', () => {
  it('lets editors and up configure an unlocked view', () => {
    expect(canConfigureView('editor', view(false))).toBe(true);
    expect(canConfigureView('commenter', view(false))).toBe(false);
    expect(canConfigureView(undefined, view(false))).toBe(false);
  });

  it('keeps a locked view to creators and owners', () => {
    expect(canConfigureView('owner', view(true))).toBe(true);
    expect(canConfigureView('creator', view(true))).toBe(true);
    expect(canConfigureView('editor', view(true))).toBe(false);
    expect(canLockViews('editor')).toBe(false);
    expect(canLockViews('creator')).toBe(true);
  });
});
