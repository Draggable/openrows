import { GRID_URL, mockApi } from './fixtures/mockApi.js';
import { expect, test } from './helpers/test.js';

// Scroll performance of the grid (ADR-007) on a 100k-row table. The records come from the
// mocked API (generated per window), so this measures the client: virtualization, rendering
// and windowed loading. Opt-in, because frame rates on shared CI runners are noise:
//   npm run build && E2E_PERF=1 npx playwright test e2e/grid-perf.spec.ts
// It prints the measured numbers; record them in docs/adr/007-grid-rendering.md.
test.skip(!process.env['E2E_PERF'], 'opt-in: E2E_PERF=1');

const ROWS = 100_000;
const MIN_FPS = Number(process.env['E2E_PERF_MIN_FPS'] ?? 50);

type Run = { fps: number; frames: number; p95: number; slowFrames: number; scrolledTo: number };

test('a 100k-row table scrolls at 50 fps or more', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const api = await mockApi(page, { rows: ROWS });
  await page.goto(GRID_URL);
  await expect(page.getByTestId('record-count')).toHaveText('100,000 records');
  await expect(page.locator('[data-cell="0:0"]')).toHaveText('Record 1');

  // Scrolls the grid every animation frame for `ms`, `step(i)` pixels at a time, and times the
  // frames with requestAnimationFrame.
  const scroll = (mode: 'steady' | 'fling', ms: number) =>
    page.evaluate(
      ({ mode, ms }) =>
        new Promise<Run>((resolve) => {
          const el = document.querySelector<HTMLElement>('[data-testid="grid"]');
          if (!el) throw new Error('no grid');
          const times: number[] = [];
          const start = performance.now();
          let last = start;
          let i = 0;
          const frame = (now: number) => {
            times.push(now - last);
            last = now;
            i += 1;
            // Steady: a wheel-like 120 px per frame. Fling: 2,000 px per frame (~60 rows).
            el.scrollTop += mode === 'steady' ? 120 : 2000;
            if (now - start < ms) requestAnimationFrame(frame);
            else {
              const sorted = [...times.slice(1)].sort((a, b) => a - b);
              resolve({
                fps: (i / (now - start)) * 1000,
                frames: i,
                p95: sorted[Math.floor(sorted.length * 0.95)] ?? 0,
                slowFrames: sorted.filter((t) => t > 1000 / 30).length,
                scrolledTo: el.scrollTop,
              });
            }
          };
          requestAnimationFrame(frame);
        }),
      { mode, ms }
    );

  const steady = await scroll('steady', 4000);
  const fling = await scroll('fling', 4000);
  const fmt = (r: Run) =>
    `${r.fps.toFixed(1)} fps, p95 frame ${r.p95.toFixed(1)} ms, ${r.slowFrames} frames > 33 ms, ` +
    `${r.frames} frames, row ${Math.round(r.scrolledTo / 34)}`;
  console.log(`steady scroll: ${fmt(steady)}`);
  console.log(`fling scroll:  ${fmt(fling)}`);
  console.log(`windows fetched: ${new Set(api.windows).size}`);

  // The rows it lands on load.
  const row = await page
    .locator('[role="row"][aria-rowindex]')
    .last()
    .getAttribute('aria-rowindex');
  expect(Number(row)).toBeGreaterThan(10_000);
  expect(steady.fps).toBeGreaterThanOrEqual(MIN_FPS);
  expect(fling.fps).toBeGreaterThanOrEqual(MIN_FPS);
});
