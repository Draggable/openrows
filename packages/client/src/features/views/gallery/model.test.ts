import type { FieldMeta } from '@openrows/shared';
import { describe, expect, it } from 'vitest';
import { cardWidthFor, columnsFor, galleryCardHeight, galleryFieldsOf, nextCard } from './model';

const field = (id: string, type: string, isPrimary = false): FieldMeta =>
  ({ id, type, isPrimary, deletedAt: null }) as unknown as FieldMeta;

describe('gallery', () => {
  it('fits as many cards as the width allows, at least one', () => {
    // 16 px padding each side, 16 px gaps, medium cards are 260 px.
    expect(columnsFor(32 + 260 * 3 + 16 * 2, 'medium')).toBe(3);
    expect(columnsFor(32 + 260 * 3 + 16 * 2 - 1, 'medium')).toBe(2);
    expect(columnsFor(100, 'large')).toBe(1);
  });

  it('stretches a lone card across the row on phones (#144)', () => {
    expect(cardWidthFor(1024, 'medium')).toBe(260);
    // 360 px: 16 px padding each side.
    expect(cardWidthFor(360, 'medium')).toBe(328);
    expect(cardWidthFor(412, 'small')).toBe(380);
    // A large card shrinks to fit rather than overflow.
    expect(cardWidthFor(360, 'large')).toBe(328);
    expect(cardWidthFor(690, 'large')).toBe(560);
  });

  it('gives every card of a view the same height', () => {
    expect(galleryCardHeight('medium', 2, true)).toBe(20 + 168 + 20 + 80);
    expect(galleryCardHeight('small', 0, false)).toBe(40);
  });

  it('shows the saved card fields, else the first three besides the cover', () => {
    const fields = [
      field('name', 'singleLineText', true),
      field('cover', 'attachment'),
      field('a', 'number'),
      field('b', 'number'),
      field('c', 'number'),
      field('d', 'number'),
    ];
    expect(galleryFieldsOf(fields, { coverFieldId: 'cover' }).map((f) => f.id)).toEqual([
      'a',
      'b',
      'c',
    ]);
    expect(galleryFieldsOf(fields, { cardFields: ['d', 'name'] }).map((f) => f.id)).toEqual(['d']);
  });

  it('moves the focus by the arrow keys across rows', () => {
    expect(nextCard('ArrowDown', 1, 4, 10)).toBe(5);
    expect(nextCard('ArrowDown', 7, 4, 10)).toBeNull();
    expect(nextCard('ArrowLeft', 0, 4, 10)).toBeNull();
    expect(nextCard('End', 2, 4, 10)).toBe(9);
  });
});
