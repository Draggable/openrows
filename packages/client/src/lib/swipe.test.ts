import { describe, expect, it } from 'vitest';
import { isEdgeSwipe, swipeDirection } from './swipe';

describe('swipes', () => {
  it('tells sideways swipes from scrolls and taps', () => {
    expect(swipeDirection({ x: 220, y: 300 }, { x: 60, y: 310 })).toBe('left');
    expect(swipeDirection({ x: 10, y: 300 }, { x: 120, y: 290 })).toBe('right');
    // Too short, or more down than across.
    expect(swipeDirection({ x: 10, y: 300 }, { x: 50, y: 300 })).toBeNull();
    expect(swipeDirection({ x: 10, y: 300 }, { x: 100, y: 450 })).toBeNull();
  });

  it('opens the drawer only from the left edge (#144)', () => {
    expect(isEdgeSwipe({ x: 8, y: 300 }, { x: 140, y: 310 })).toBe(true);
    expect(isEdgeSwipe({ x: 80, y: 300 }, { x: 220, y: 310 })).toBe(false);
    expect(isEdgeSwipe({ x: 8, y: 300 }, { x: 0, y: 310 })).toBe(false);
    // Past a safe-area inset (a notch in landscape).
    expect(isEdgeSwipe({ x: 50, y: 300 }, { x: 200, y: 300 }, 44)).toBe(true);
  });
});
