import type { FieldMeta, GalleryCardSize, GalleryLayout } from '@openrows/shared';

/**
 * The gallery's logic, apart from React: which fields a card shows, the card geometry of
 * each size (every card of a view has the same height, so rows virtualize simply), how many
 * cards fit a row, and where the arrow keys move the focus.
 */

/** The fields shown on cards: the saved ones that exist, else the first three after the title. */
export function galleryFieldsOf(fields: readonly FieldMeta[], layout: GalleryLayout): FieldMeta[] {
  const live = fields.filter((f) => !f.deletedAt && !f.isPrimary);
  if (layout.cardFields) {
    return layout.cardFields.flatMap((id) => live.find((f) => f.id === id) ?? []);
  }
  return live.filter((f) => f.id !== layout.coverFieldId).slice(0, 3);
}

/** Card widths and cover heights (px) per size. */
export const CARD_SIZES: Record<GalleryCardSize, { width: number; cover: number }> = {
  small: { width: 200, cover: 120 },
  medium: { width: 260, cover: 160 },
  large: { width: 340, cover: 220 },
};

export const GALLERY = { gap: 16, padding: 10, title: 20, label: 16, row: 24, pad: 16 } as const;

/** A card's height: the cover (when the view has one), the title, then a label and value per field. */
export function galleryCardHeight(size: GalleryCardSize, fieldCount: number, cover: boolean) {
  return (
    GALLERY.padding * 2 +
    (cover ? CARD_SIZES[size].cover + 8 : 0) +
    GALLERY.title +
    fieldCount * (GALLERY.label + GALLERY.row)
  );
}

/** How many cards of `size` fit a row `width` px wide (at least one). */
export function columnsFor(width: number, size: GalleryCardSize): number {
  const inner = width - GALLERY.pad * 2;
  return Math.max(1, Math.floor((inner + GALLERY.gap) / (CARD_SIZES[size].width + GALLERY.gap)));
}

/**
 * A card's width in a row `width` px wide: the size's, or the whole row when only one card fits
 * (phones), so a lone card doesn't leave a gap beside it.
 */
export function cardWidthFor(width: number, size: GalleryCardSize): number {
  if (columnsFor(width, size) > 1) return CARD_SIZES[size].width;
  return Math.max(MIN_SINGLE_CARD, Math.min(width - GALLERY.pad * 2, MAX_SINGLE_CARD));
}

/** The widest a lone card stretches, and the narrowest it shrinks to (a large card on a phone). */
const MAX_SINGLE_CARD = 560;
const MIN_SINGLE_CARD = 160;

/** The card index an arrow key (or Home/End) moves the focus to, `null` when it stays. */
export function nextCard(key: string, index: number, columns: number, total: number) {
  let next: number | null = null;
  if (key === 'ArrowRight') next = index + 1;
  else if (key === 'ArrowLeft') next = index - 1;
  else if (key === 'ArrowDown') next = index + columns;
  else if (key === 'ArrowUp') next = index - columns;
  else if (key === 'Home') next = 0;
  else if (key === 'End') next = total - 1;
  if (next === null || next < 0 || next >= total || next === index) return null;
  return next;
}
