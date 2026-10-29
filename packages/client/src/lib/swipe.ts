/** A touch point. */
export type Point = { x: number; y: number };

/** How far a finger must travel sideways for a swipe. */
export const SWIPE_DISTANCE = 60;
/** How close to the left edge a swipe that opens the drawer must start. */
export const EDGE_WIDTH = 24;

/**
 * Which way a touch from `start` to `end` swiped: mostly sideways and at least SWIPE_DISTANCE
 * px, else null (a scroll or a tap).
 */
export function swipeDirection(start: Point, end: Point): 'left' | 'right' | null {
  const dx = end.x - start.x;
  if (Math.abs(dx) < SWIPE_DISTANCE || Math.abs(dx) <= Math.abs(end.y - start.y)) return null;
  return dx > 0 ? 'right' : 'left';
}

/**
 * Whether a touch from `start` to `end` opens the drawer: a swipe to the right that starts at
 * the screen's left edge (`inset`: the safe-area inset there, on phones in landscape).
 */
export function isEdgeSwipe(start: Point, end: Point, inset = 0): boolean {
  return start.x <= inset + EDGE_WIDTH && swipeDirection(start, end) === 'right';
}
