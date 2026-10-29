import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import './zod';

describe('zod config', () => {
  it('parses without generating code, so the CSP needs no unsafe-eval (#69)', () => {
    expect(z.config().jitless).toBe(true);
  });
});
