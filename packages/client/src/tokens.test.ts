/// <reference types="node" />
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// The design tokens of index.css (DESIGN.md §3) keep WCAG AA contrast
// in both themes: 4.5:1 for text, 3:1 for focus rings and other non-text marks.

function block(selector: string): Record<string, string> {
  const start = css.indexOf(`${selector} {`);
  const body = css.slice(start, css.indexOf('\n  }', start));
  return Object.fromEntries(
    [...body.matchAll(/--([\w-]+):\s*([^;]+);/g)].map((m) => [m[1] as string, m[2] as string])
  );
}

const css = readFileSync(`${import.meta.dirname}/index.css`, 'utf8');
const light = block(':root');
const dark = { ...light, ...block('.dark') };

/** A token's hex colour, through var() references. */
function hex(tokens: Record<string, string>, name: string): string {
  const value = tokens[name];
  if (value === undefined) throw new Error(`no --${name}`);
  const ref = /^var\(--([\w-]+)\)$/.exec(value);
  if (ref) return hex(tokens, ref[1] as string);
  if (!/^#[0-9a-f]{6}$/i.test(value)) throw new Error(`--${name} is not a hex colour: ${value}`);
  return value;
}

function luminance(color: string): number {
  const [r, g, b] = [1, 3, 5].map((i) => {
    const c = Number.parseInt(color.slice(i, i + 2), 16) / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

/** The HSL hue, in degrees. */
function hue(color: string): number {
  const [r, g, b] = [1, 3, 5].map((i) => Number.parseInt(color.slice(i, i + 2), 16) / 255) as [
    number,
    number,
    number,
  ];
  const max = Math.max(r, g, b);
  const d = max - Math.min(r, g, b);
  if (d === 0) return 0;
  const h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return (h * 60 + 360) % 360;
}

const hueDistance = (a: string, b: string) => {
  const d = Math.abs(hue(a) - hue(b));
  return Math.min(d, 360 - d);
};

const TEXT_ON = ['bg-app', 'bg-sidebar', 'bg-surface', 'bg-header', 'bg-hover'];

describe.each([
  ['light', light],
  ['dark', dark],
] as const)('%s theme tokens', (_name, t) => {
  it.each(['text', 'text-2', 'text-3', 'danger'])('--%s is AA text on every surface', (fg) => {
    for (const bg of TEXT_ON) expect(contrast(hex(t, fg), hex(t, bg))).toBeGreaterThanOrEqual(4.5);
  });

  it('the rose button, focus ring and nav bar', () => {
    expect(contrast(hex(t, 'brand-fg'), hex(t, 'brand'))).toBeGreaterThanOrEqual(4.5);
    expect(contrast(hex(t, 'brand-fg'), hex(t, 'brand-hover'))).toBeGreaterThanOrEqual(4.5);
    for (const bg of TEXT_ON)
      expect(contrast(hex(t, 'brand'), hex(t, bg))).toBeGreaterThanOrEqual(3);
  });

  it('the leaf accent of selected and active states', () => {
    expect(contrast(hex(t, 'accent-fg'), hex(t, 'accent'))).toBeGreaterThanOrEqual(4.5);
    expect(contrast(hex(t, 'danger-fg'), hex(t, 'danger'))).toBeGreaterThanOrEqual(4.5);
    for (const bg of ['bg-surface', 'bg-app']) {
      expect(contrast(hex(t, 'accent'), hex(t, bg))).toBeGreaterThanOrEqual(4.5);
    }
  });
});

describe('the brand', () => {
  it('is the logo rose, with rose text AA on the petal tint (light)', () => {
    expect(hex(light, 'brand').toLowerCase()).toBe('#e22651');
    expect(contrast(hex(light, 'brand-text'), hex(light, 'brand-tint'))).toBeGreaterThanOrEqual(
      4.5
    );
    expect(contrast(hex(dark, 'brand-text'), hex(dark, 'bg-sidebar'))).toBeGreaterThanOrEqual(4.5);
  });

  it('keeps errors and the red and pink chips off the brand hue (20° or more)', () => {
    for (const t of [light, dark]) {
      expect(hueDistance(hex(t, 'danger'), hex(t, 'brand'))).toBeGreaterThanOrEqual(20);
    }
    for (const chip of ['chip-red', 'chip-pink']) {
      expect(hueDistance(hex(light, chip), hex(light, 'brand'))).toBeGreaterThanOrEqual(20);
    }
  });
});
