# ADR-007: Grid rendering with DOM virtualization (TanStack Virtual)

- **Status:** Accepted (2026-10-25)
- **Related:** [ADR-001](001-record-storage.md) (window paging over the record table),
  [ADR-003](003-realtime.md) (per-cell edits), [design/DESIGN.md](../design/DESIGN.md) ("Ledger")

## Context

The prototype grid rendered every record with `records.map`. An Airtable-class grid has to
show 100k+ rows smoothly, with a sticky header, row numbers, a pinned primary field, frozen
columns, range selection and full keyboard navigation, in the Ledger look (light and dark),
and stay accessible and testable with Playwright.

The two serious options were a canvas grid (Glide Data Grid) and DOM virtualization
(TanStack Virtual) with our own cells.

## Decision

1. **DOM virtualization with `@tanstack/react-virtual`**, rows and columns. Only the rows on
   screen plus 12 of overscan, and the scrolling columns on screen plus 3, are in the DOM. The
   gutter (row numbers), the primary field and `frozenCount` more columns are a
   `position: sticky; left: 0` pane in every row, so they are never virtualized away; the
   header and the summary bar are `position: sticky` top and bottom in the same scroll
   container, so they stay aligned with the columns without scroll syncing.
2. **ARIA grid pattern with real focusable cells.** `role="grid"` / `row` / `columnheader` /
   `rowheader` / `gridcell` with `aria-rowindex`/`aria-colindex` (counts on the grid), and a
   roving `tabIndex`: the active cell is the only tab stop and has DOM focus. Keyboard moves
   scroll the target into view (`scrollToIndex` with the sticky header, footer and frozen pane
   as scroll padding), then focus it once rendered. The divs need two Biome a11y rules
   (`useSemanticElements`, `useFocusableInteractive`) off for `src/features/grid/` only; a
   `<table>` can't be virtualized in two directions with sticky panes.
3. **Windowed loading** through the view query: pages of 100 records by `offset`, the
   pages covering the visible rows plus one page on each side, each cached by TanStack Query
   under its own key (`recordQueries.window`). The first page also asks for the total and the
   summary aggregates., which patch every
   cached page.
4. **The layout belongs to the view**: `config.grid` = `{ fieldOrder, columnWidths,
   frozenCount, rowHeight }`, saved with `PATCH /api/views/:viewId { grid }` (editors and up;
   lower roles keep their changes for the page only). The query engine ignores the key.
5. The pure parts (selection and keyboard model, column layout, page arithmetic) are plain
   modules with unit tests; the component is covered by Playwright specs against a mocked API.

## Consequences

- Cells are React components styled with the Ledger CSS variables, so dark mode, chips,
  focus rings and future editors are ordinary DOM and Tailwind, and Playwright and axe
  see real elements.
- Performance depends on keeping cells cheap: no per-cell hooks or contexts; formatting goes
  through the field-type registry on render.
- **Measured** (`E2E_PERF=1 npx playwright test e2e/grid-perf.spec.ts`, 100k rows from the
  mocked API, 1440×900, headless Chromium 1248 on the 8-core shared dev machine, 2026-10-25):
  steady wheel-like scrolling (120 px per frame for 4 s) **60.4 fps**, p95 frame 16.8 ms, no
  frame over 33 ms; flinging (2,000 px per frame for 4 s, to row ~14,500) **57.8 fps**, p95
  16.8 ms, 2 frames over 33 ms. The test asserts ≥ 50 fps for both. It measures the client
  only; server window queries are benchmarked in the integration suite. It is opt-in,
  because frame rates on shared CI runners are noise.
- Flinging fetches every page it passes (146 windows in the fling above); a debounce while
  scrolling fast is a cheap later improvement.
- Row and column virtualization with variable heights (wrapped text, the tall row heights with
  thumbnails) stays possible: TanStack Virtual measures elements when asked to.

## Alternatives considered

- **Glide Data Grid (canvas).** The fastest option at very large sizes and with built-in
  selection, resize and reorder. Rejected because: cells are drawn on a canvas, so the Ledger
  look (chips, focus rings, dark mode) would be re-implemented in canvas drawing code instead
  of using the CSS tokens; accessibility depends on its overlay of hidden elements rather than
  real cells; Playwright can't target cells or read their text without test hooks; and its
  React 19 support lagged. DOM virtualization reached the 50 fps target, so the canvas wasn't
  needed.
- **No virtualization, paging (100 rows per page).** Simple and accessible, but not the
  continuous scrolling users expect from a spreadsheet.
