import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { GENERATED_PATH, generateV1Types, toTs } from './codegen.js';

describe('the generated v1 types', () => {
  it('match the contracts (run `npm run generate -w @openrows/sdk` after changing them)', () => {
    expect(readFileSync(GENERATED_PATH, 'utf8')).toBe(generateV1Types());
  });

  it('write JSON Schema as TypeScript', () => {
    expect(toTs({ type: ['string', 'null'] })).toBe('string | null');
    expect(
      toTs({ type: 'array', items: { anyOf: [{ type: 'string' }, { type: 'number' }] } })
    ).toBe('(string | number)[]');
    expect(toTs({ type: 'object', additionalProperties: {} })).toBe('Record<string, unknown>');
    expect(
      toTs({
        type: 'object',
        properties: { a: { type: 'string', enum: ['x', 'y'] }, 'b-c': { const: 1 } },
        required: ['a'],
        additionalProperties: false,
      })
    ).toBe('{\n  a: "x" | "y";\n  "b-c"?: 1;\n}');
    expect(toTs({})).toBe('unknown');
    expect(() => toTs({ $ref: '#/x' })).toThrow(/\$ref/);
  });
});
