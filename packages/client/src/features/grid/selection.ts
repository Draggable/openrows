/**
 * The grid's selection model: an anchor cell and a focus cell. A single cell is
 * anchor = focus; Shift extends the range from the anchor; `rows` and `columns` select whole
 * rows (by the row gutter) or whole columns (by the header). Pure, so it is unit-tested
 * without a DOM.
 */

export type Cell = { row: number; col: number };

export type Selection = {
  anchor: Cell;
  focus: Cell;
  mode: 'cells' | 'rows' | 'columns';
};

export type Range = { top: number; bottom: number; left: number; right: number };

export type GridSize = { rows: number; cols: number; pageRows: number };

export const cellSelection = (cell: Cell): Selection => ({
  anchor: cell,
  focus: cell,
  mode: 'cells',
});

export function clampCell(cell: Cell, size: GridSize): Cell {
  return {
    row: Math.max(0, Math.min(size.rows - 1, cell.row)),
    col: Math.max(0, Math.min(size.cols - 1, cell.col)),
  };
}

/** The selected rectangle, inclusive; whole rows/columns span the grid. */
export function selectionRange(sel: Selection, size: GridSize): Range {
  const top = Math.min(sel.anchor.row, sel.focus.row);
  const bottom = Math.max(sel.anchor.row, sel.focus.row);
  const left = Math.min(sel.anchor.col, sel.focus.col);
  const right = Math.max(sel.anchor.col, sel.focus.col);
  if (sel.mode === 'rows') return { top, bottom, left: 0, right: size.cols - 1 };
  if (sel.mode === 'columns') return { top: 0, bottom: size.rows - 1, left, right };
  return { top, bottom, left, right };
}

export function inRange(range: Range, row: number, col: number): boolean {
  return row >= range.top && row <= range.bottom && col >= range.left && col <= range.right;
}

export function isSingleCell(sel: Selection): boolean {
  return (
    sel.mode === 'cells' && sel.anchor.row === sel.focus.row && sel.anchor.col === sel.focus.col
  );
}

/** Clicking a row number selects the row; Shift extends the row range. */
export function selectRows(sel: Selection | null, row: number, extend: boolean): Selection {
  if (extend && sel)
    return { anchor: sel.anchor, focus: { row, col: sel.focus.col }, mode: 'rows' };
  return { anchor: { row, col: 0 }, focus: { row, col: 0 }, mode: 'rows' };
}

/** Selecting a column (from its header menu); Shift extends the column range. */
export function selectColumns(sel: Selection | null, col: number, extend: boolean): Selection {
  if (extend && sel) return { anchor: sel.anchor, focus: { row: 0, col }, mode: 'columns' };
  return { anchor: { row: 0, col }, focus: { row: 0, col }, mode: 'columns' };
}

export type NavKey = {
  key: string;
  shiftKey?: boolean;
  ctrlKey?: boolean;
  metaKey?: boolean;
};

/**
 * Where a navigation key takes the selection, or `null` if the key isn't one. Arrows move one
 * cell (Ctrl/⌘ + arrow to the edge), Tab/Shift+Tab move sideways and wrap to the next/previous
 * row, Home/End go to the first/last column (Ctrl/⌘ to the first/last row too), Page Up/Down
 * move by a screen. Shift extends the range from the anchor (not for Tab).
 */
export function navigate(sel: Selection, e: NavKey, size: GridSize): Selection | null {
  if (size.rows === 0 || size.cols === 0) return null;
  const mod = Boolean(e.ctrlKey || e.metaKey);
  const { row, col } = sel.focus;
  let next: Cell;
  switch (e.key) {
    case 'ArrowUp':
      next = { row: mod ? 0 : row - 1, col };
      break;
    case 'ArrowDown':
      next = { row: mod ? size.rows - 1 : row + 1, col };
      break;
    case 'ArrowLeft':
      next = { row, col: mod ? 0 : col - 1 };
      break;
    case 'ArrowRight':
      next = { row, col: mod ? size.cols - 1 : col + 1 };
      break;
    case 'Home':
      next = { row: mod ? 0 : row, col: 0 };
      break;
    case 'End':
      next = { row: mod ? size.rows - 1 : row, col: size.cols - 1 };
      break;
    case 'PageUp':
      next = { row: row - size.pageRows, col };
      break;
    case 'PageDown':
      next = { row: row + size.pageRows, col };
      break;
    case 'Tab': {
      const step = e.shiftKey ? -1 : 1;
      let c = col + step;
      let r = row;
      if (c >= size.cols) {
        if (r >= size.rows - 1) return null;
        c = 0;
        r += 1;
      } else if (c < 0) {
        if (r <= 0) return null;
        c = size.cols - 1;
        r -= 1;
      }
      return cellSelection({ row: r, col: c });
    }
    default:
      return null;
  }
  const focus = clampCell(next, size);
  if (e.shiftKey) return { anchor: sel.anchor, focus, mode: sel.mode };
  return cellSelection(focus);
}
