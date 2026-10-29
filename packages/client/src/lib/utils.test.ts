import { describe, expect, it } from 'vitest';
import { cn } from './utils';

describe('cn', () => {
  it('keeps a text colour next to a Ledger font size', () => {
    expect(cn('text-primary-foreground', 'text-body')).toBe('text-primary-foreground text-body');
    expect(cn('text-small', 'text-body')).toBe('text-body');
    expect(cn('text-text', 'text-danger')).toBe('text-danger');
  });
});
