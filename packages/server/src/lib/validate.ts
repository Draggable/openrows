import type { Context } from 'hono';
import type { z } from 'zod';
import { AppError } from './errors.js';

/** Parses the JSON body with `schema`: 400 when it isn't JSON, 422 (ZodError) when invalid. */
export async function readJson<T extends z.ZodType>(c: Context, schema: T): Promise<z.output<T>> {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    throw new AppError('BAD_REQUEST', { detail: 'The request body must be JSON.' });
  }
  return schema.parse(body);
}
